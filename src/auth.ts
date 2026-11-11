// One key per agent, stored only as a hash. Keys come from headers, except /mcp/<key>
// for MCP clients that can't send headers (claude.ai custom connectors). Admin keys
// are never accepted in a URL.
import { sha256 } from "./archive";
import { Env, badRequest } from "./env";

export type Scope = "read" | "write" | "admin";
export interface Caller {
  name: string;
  scope: Scope;
}

const RANK: Record<Scope, number> = { read: 0, write: 1, admin: 2 };
export const allowed = (have: Scope, need: Scope) => RANK[have] >= RANK[need];

const USED_RESOLUTION_MS = 3_600_000;

function sameSecret(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  return x.length === y.length && crypto.subtle.timingSafeEqual(x, y);
}

export const MCP_KEY_PATH = /^\/mcp\/([A-Za-z0-9_-]{16,})$/;

export async function authenticate(req: Request, env: Env, exec?: ExecutionContext): Promise<Caller | null> {
  const header = req.headers.get("Authorization") || "";
  const pathKey = new URL(req.url).pathname.match(MCP_KEY_PATH)?.[1];
  const given = pathKey || (header.startsWith("Bearer ") ? header.slice(7).trim() : req.headers.get("x-api-key") || "");
  if (!given) return null;
  if (!pathKey && env.ADMIN_TOKEN && sameSecret(given, env.ADMIN_TOKEN)) return { name: "admin", scope: "admin" };
  const hash = await sha256(given);
  const row = await env.DB.prepare(`SELECT name, scope, last_used_at FROM api_keys WHERE hash = ? AND revoked_at IS NULL`).bind(hash).first<{ name: string; scope: Scope; last_used_at: number | null }>();
  if (!row || (pathKey && row.scope === "admin")) return null;
  const now = Date.now();
  if (now - (row.last_used_at ?? 0) > USED_RESOLUTION_MS) {
    const touch = env.DB.prepare(`UPDATE api_keys SET last_used_at = ? WHERE name = ?`).bind(now, row.name).run();
    if (exec) exec.waitUntil(touch);
    else await touch;
  }
  return { name: row.name, scope: row.scope };
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
