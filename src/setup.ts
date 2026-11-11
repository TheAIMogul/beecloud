// First-run setup, driven by the page at "/": claim the admin key, then connect Bee.
// Bee sign-in is the same app-pairing flow the open-source Bee CLI (`bee login`) uses:
// we send a public key, the owner approves in the Bee app, and Bee returns the developer
// token encrypted to that key.
import nacl from "tweetnacl";
import { sha256 } from "./archive";
import { Caller, authenticate } from "./auth";
import { forgetBeeToken } from "./bee";
import { getKv, kvStatement } from "./db";
import { Env, HttpError, Json, badRequest } from "./env";
import { runSync } from "./sync";

const PAIRING_URL = "https://auth.beeai-services.com/apps/pairing/request";
const BEE_CLI_APP_ID = "ph9fssu1kv1b0hns69fxf7rx";
const APPROVE_URL = "https://bee.computer/connect#";
const FIRST_SYNC_BUDGET_MS = 20_000; // waitUntil gives a request 30 seconds after it answers

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

export async function isClaimed(env: Env): Promise<boolean> {
  if (env.ADMIN_TOKEN) return true;
  return !!(await env.DB.prepare(`SELECT 1 FROM api_keys WHERE scope = 'admin' AND revoked_at IS NULL LIMIT 1`).first());
}

// Whoever opens a fresh install first makes the admin key. It is shown once and stored as a hash.
async function claim(env: Env): Promise<Json> {
  if (await isClaimed(env)) throw new HttpError(409, "This BeeCloud already has an admin key.");
  const key = `bee_admin_${hex(crypto.getRandomValues(new Uint8Array(32)))}`;
  const made = await env.DB.prepare(`INSERT INTO api_keys (name, hash, scope, created_at) VALUES ('admin', ?, 'admin', ?) ON CONFLICT (name) DO NOTHING`)
    .bind(await sha256(key), Date.now())
    .run();
  if (!made.meta.changes) throw new HttpError(409, "This BeeCloud already has an admin key.");
  return { admin_key: key };
}

async function pairingRequest(publicKey: string): Promise<Json> {
  const res = await fetch(PAIRING_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: BEE_CLI_APP_ID, publicKey }),
    signal: AbortSignal.timeout(15_000),
  });
  const data = await res.json<Json>().catch(() => ({}) as Json);
  if (!res.ok || data.ok !== true) throw new HttpError(502, `Bee sign-in service answered ${res.status}${data.error ? `: ${data.error}` : ""}`);
  return data;
}

function decryptToken(encrypted: string, secretKey: Uint8Array): string {
  const packed = unb64(encrypted);
  if (packed.length < 1 + 24 + 32 + 16 || packed[0] !== 1) throw new HttpError(502, "Bee sent a sign-in reply this version can't read.");
  const opened = nacl.box.open(packed.subarray(57), packed.subarray(1, 25), packed.subarray(25, 57), secretKey);
  const token = opened ? new TextDecoder().decode(opened).trim() : "";
  if (!token) throw new HttpError(502, "Bee's sign-in reply couldn't be decrypted. Start the connection again.");
  return token;
}

async function saveToken(env: Env, token: string): Promise<Json> {
  const res = await fetch(`${env.BEE_API}/v1/me`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw badRequest(`Bee rejected that key (${res.status}). Check Developer Mode is on, then try again.`);
  const me = await res.json<Json>();
  const stmts = [kvStatement(env, "bee_token", token), env.DB.prepare(`DELETE FROM kv WHERE key IN ('pairing', 'alert:bee-auth')`)];
  if (me.first_name) stmts.push(kvStatement(env, "owner_name", me.first_name));
  if (me.timezone) stmts.push(kvStatement(env, "timezone", me.timezone));
  await env.DB.batch(stmts);
  forgetBeeToken();
  return { status: "connected", owner: me.first_name ?? null };
}

async function startPairing(env: Env): Promise<Json> {
  const pair = nacl.box.keyPair();
  const publicKey = b64(pair.publicKey);
  const data = await pairingRequest(publicKey);
  if (data.status === "completed") return saveToken(env, decryptToken(data.result?.encryptedToken, pair.secretKey));
  if (data.status !== "pending") throw new HttpError(502, "Bee didn't start a sign-in. Try again.");
  await kvStatement(env, "pairing", JSON.stringify({ publicKey, secretKey: b64(pair.secretKey), requestId: data.requestId, expiresAt: data.expiresAt })).run();
  return { status: "pending", url: APPROVE_URL + data.requestId, expiresAt: data.expiresAt };
}

async function pollPairing(env: Env): Promise<Json> {
  const saved = await getKv(env, "pairing");
  if (!saved) return { status: (await getKv(env, "bee_token")) ? "connected" : "none" };
  const state = JSON.parse(saved);
  const data = await pairingRequest(state.publicKey);
  if (data.status === "completed") return saveToken(env, decryptToken(data.result?.encryptedToken, unb64(state.secretKey)));
  if (data.status === "expired") {
    await env.DB.prepare(`DELETE FROM kv WHERE key = 'pairing'`).run();
    return { status: "expired" };
  }
  return { status: "pending", url: APPROVE_URL + state.requestId, expiresAt: state.expiresAt };
}

async function status(env: Env): Promise<Json> {
  const { results } = await env.DB.prepare(`SELECT key, value FROM kv WHERE key IN ('bee_token', 'owner_name', 'last_sync', 'last_error', 'pairing')`).all<{ key: string; value: string }>();
  const kv = Object.fromEntries(results.map((r) => [r.key, r.value]));
  const { results: counts } = await env.DB.prepare(`SELECT type, COUNT(*) AS n FROM items WHERE deleted_at IS NULL GROUP BY type`).all<{ type: string; n: number }>();
  const { results: keys } = await env.DB.prepare(`SELECT name, scope, created_at, last_used_at FROM api_keys WHERE revoked_at IS NULL ORDER BY created_at`).all<Json>();
  const pairing = kv.pairing ? JSON.parse(kv.pairing) : null;
  return {
    bee: env.BEE_TOKEN || kv.bee_token ? "connected" : "not connected",
    beeKeyFrom: env.BEE_TOKEN ? "BEE_TOKEN secret" : kv.bee_token ? "setup page" : null,
    owner: kv.owner_name ?? null,
    pairing: pairing ? { url: APPROVE_URL + pairing.requestId, expiresAt: pairing.expiresAt } : null,
    lastSync: kv.last_sync ?? null,
    lastError: kv.last_error ?? null,
    archived: Object.fromEntries(counts.map((c) => [c.type, c.n])),
    keys,
    phoneAlerts: !!env.PUSHBULLET_TOKEN,
  };
}

export async function handleSetup(url: URL, req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const p = url.pathname.slice("/api/setup".length);
  if (p === "/state" && req.method === "GET") return Response.json({ claimed: await isClaimed(env) });
  if (req.method !== "POST" && p !== "/status") throw new HttpError(405, "Use POST");
  if (p === "/claim") return Response.json(await claim(env));

  const caller: Caller | null = await authenticate(req, env, ctx);
  if (!caller) throw new HttpError(401, "unauthorized");
  if (caller.scope !== "admin") throw new HttpError(403, "Setup needs the admin key");

  if (p === "/status") return Response.json(await status(env));
  let result: Json;
  if (p === "/bee/start") result = await startPairing(env);
  else if (p === "/bee/poll") result = await pollPairing(env);
  else if (p === "/bee/token") {
    const body = await req.json<Json>().catch(() => ({}) as Json);
    if (!body.token) throw badRequest("token is required");
    result = await saveToken(env, String(body.token).trim());
  } else if (p === "/bee/disconnect") {
    if (env.BEE_TOKEN) throw badRequest("The Bee key comes from the BEE_TOKEN secret. Remove that secret to disconnect.");
    await env.DB.prepare(`DELETE FROM kv WHERE key IN ('bee_token', 'pairing')`).run();
    forgetBeeToken();
    result = { status: "disconnected" };
  } else throw new HttpError(404, "not found");

  // Start the first import right away instead of waiting for the next 15-minute run.
  if (result.status === "connected") ctx.waitUntil(runSync(env, FIRST_SYNC_BUDGET_MS).catch((e) => console.error("first sync failed", e?.message)));
  return Response.json(result);
}
