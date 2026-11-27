// One key per agent, stored only as a hash, plus an optional shared password (ACCESS_PASSWORD).
// Credentials come from headers (Bearer, x-api-key or Basic). Agent keys may also ride in the
// URL as /mcp/<key> for MCP clients that can't send headers; admin keys and the password never do.
// Wrong password guesses lock out the address for a while. Long random keys can't be guessed,
// so they skip the lockout: a stale key can't lock every agent on the same network out.
import { sha256 } from "./archive";
import { Env, HttpError, badRequest } from "./env";

export type Scope = "read" | "write" | "admin";
export interface Caller {
  name: string;
  scope: Scope;
}

const RANK: Record<Scope, number> = { read: 0, write: 1, admin: 2 };
export const allowed = (have: Scope, need: Scope) => RANK[have] >= RANK[need];

const USED_RESOLUTION_MS = 3_600_000;
const LOCKOUT_FAILURES = 10;
const LOCKOUT_WINDOW_MS = 15 * 60_000;

export function sameSecret(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  return x.length === y.length && crypto.subtle.timingSafeEqual(x, y);
}

export const MCP_KEY_PATH = /^\/mcp\/([A-Za-z0-9_-]{16,})$/;

// Keys made by BeeCloud are long random strings, not guessable.
const KEY_LIKE = /^(bee_[a-z_]*[0-9a-f]{40,}|[0-9a-f]{64})$/;

function headerCredential(req: Request): string {
  const header = req.headers.get("Authorization") || "";
  if (header.startsWith("Bearer ")) return header.slice(7).trim();
  if (header.startsWith("Basic ")) {
    try {
      const decoded = atob(header.slice(6).trim());
      return decoded.slice(decoded.indexOf(":") + 1);
    } catch {
      return "";
    }
  }
  return req.headers.get("x-api-key") || "";
}

export const clientIp = (req: Request) => req.headers.get("CF-Connecting-IP") || "unknown";

export async function lockedOut(env: Env, ip: string): Promise<boolean> {
  const row = await env.DB.prepare(`SELECT failures, first_at FROM auth_failures WHERE ip = ?`).bind(ip).first<{ failures: number; first_at: number }>();
  return !!row && row.failures >= LOCKOUT_FAILURES && Date.now() - row.first_at < LOCKOUT_WINDOW_MS;
}

export async function recordFailure(env: Env, ip: string): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO auth_failures (ip, failures, first_at) VALUES (?1, 1, ?2)
     ON CONFLICT (ip) DO UPDATE SET
       failures = CASE WHEN ?2 - first_at >= ?3 THEN 1 ELSE failures + 1 END,
       first_at = CASE WHEN ?2 - first_at >= ?3 THEN ?2 ELSE first_at END`,
  )
    .bind(ip, now, LOCKOUT_WINDOW_MS)
    .run();
}

export const pruneAuthFailures = (env: Env) => env.DB.prepare(`DELETE FROM auth_failures WHERE first_at < ?`).bind(Date.now() - LOCKOUT_WINDOW_MS).run();

async function identify(env: Env, given: string, inUrl: boolean, exec?: ExecutionContext): Promise<Caller | null> {
  if (!inUrl && env.ACCESS_PASSWORD && sameSecret(given, env.ACCESS_PASSWORD)) return { name: "password", scope: "write" };
  if (!inUrl && env.ADMIN_TOKEN && sameSecret(given, env.ADMIN_TOKEN)) return { name: "admin", scope: "admin" };
  const hash = await sha256(given);
  const row = await env.DB.prepare(`SELECT name, scope, last_used_at FROM api_keys WHERE hash = ? AND revoked_at IS NULL`).bind(hash).first<{ name: string; scope: Scope; last_used_at: number | null }>();
  if (!row || (inUrl && row.scope === "admin")) return null;
  const now = Date.now();
  if (now - (row.last_used_at ?? 0) > USED_RESOLUTION_MS) {
    const touch = env.DB.prepare(`UPDATE api_keys SET last_used_at = ? WHERE name = ?`).bind(now, row.name).run();
    if (exec) exec.waitUntil(touch);
    else await touch;
  }
  return { name: row.name, scope: row.scope };
}

// Returns the caller, or null for a missing or wrong credential. Throws 429 while the address is locked out.
export async function authenticate(req: Request, env: Env, exec?: ExecutionContext): Promise<Caller | null> {
  const fromUrl = new URL(req.url).pathname.match(MCP_KEY_PATH)?.[1] ?? null;
  const fromHeader = headerCredential(req);
  const tries: [string, boolean][] = [];
  if (fromUrl) tries.push([fromUrl, true]);
  if (fromHeader) tries.push([fromHeader, false]);
  if (!tries.length) return null;
  const guessable = tries.some(([given]) => !KEY_LIKE.test(given));
  const ip = clientIp(req);
  if (guessable && (await lockedOut(env, ip))) throw new HttpError(429, "Too many wrong passwords from this address. Try again in 15 minutes.");
  for (const [given, inUrl] of tries) {
    const caller = await identify(env, given, inUrl, exec);
    if (caller) return caller;
  }
  if (guessable) await recordFailure(env, ip);
  return null;
}

// The sign-in page accepts the password or an admin key: every install has an admin key from setup.
export async function isOwnerSecret(env: Env, given: string): Promise<boolean> {
  if (!given) return false;
  if (env.ACCESS_PASSWORD && sameSecret(given, env.ACCESS_PASSWORD)) return true;
  if (env.ADMIN_TOKEN && sameSecret(given, env.ADMIN_TOKEN)) return true;
  return !!(await env.DB.prepare(`SELECT 1 FROM api_keys WHERE hash = ? AND scope = 'admin' AND revoked_at IS NULL`).bind(await sha256(given)).first());
}

export async function createKey(env: Env, name: string, scope: Scope): Promise<string> {
  if (!/^[a-z0-9_-]{1,40}$/.test(name)) throw badRequest("name must be lowercase letters, numbers, - or _");
  if (!(scope in RANK)) throw badRequest("scope must be read, write or admin");
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const key = `bee_${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
  await env.DB.prepare(
    `INSERT INTO api_keys (name, hash, scope, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (name) DO UPDATE SET hash = excluded.hash, scope = excluded.scope, created_at = excluded.created_at, last_used_at = NULL, revoked_at = NULL`,
  )
    .bind(name, await sha256(key), scope, Date.now())
    .run();
  return key;
}
