// BeeCloud: keeps a permanent archive of a Bee wearable's data in the owner's own Cloudflare
// account and serves it to AI agents over MCP and REST. Nothing runs on a local machine.
import { MCP_KEY_PATH, authenticate, pruneAuthFailures } from "./auth";
import { BeeError } from "./bee";
import { ensureSchema } from "./db";
import { publicResponse } from "./discover";
import { Env, HttpError } from "./env";
import { handleMcp } from "./mcp";
import { OAUTH_PATHS, OAUTH_TOKEN, oauthEnabled, oauthProvider, withMainResource } from "./oauth";
import { SETUP_PAGE } from "./page";
import { handleRest } from "./rest";
import { handleSetup } from "./setup";
import { runSync } from "./sync";

const CRON_BUDGET_MS = 240_000;

const HELP = `BeeCloud: a Bee wearable archive
Setup: open / in a browser. Instructions for agents: /llms.txt (or /guide in a browser)
Auth:  Authorization: Bearer <key or password>  (or x-api-key, or Basic). Apps that can't send headers sign in with OAuth.
MCP:   POST /mcp  (Streamable HTTP), or POST /mcp/<agent key> for clients that can't send headers
REST:  GET  /api/day/<date> | /api/conversations[/<id>[.json]] | /api/search?q= [&mode=neural] | /api/search/all?q=
       GET  /api/daily | /api/insights | /api/todos | /api/todos/suggestions | /api/facts | /api/voice-notes[/<id>]
       GET  /api/visits | /api/places | /api/photos[/<id>] | /api/brief | /api/external-access | /api/status
       GET  /api/archive?prefix=md/ | /api/archive/<key>
       POST /api/sync | /api/tools/<tool name> with a JSON body
`;

function errorResponse(e: any): Response {
  if (e instanceof HttpError) return Response.json({ error: e.message }, { status: e.status });
  if (e instanceof BeeError && e.notFound) return Response.json({ error: e.message }, { status: 404 });
  if (e instanceof BeeError) return Response.json({ error: e.message }, { status: 502 });
  console.error("request failed", e?.stack || e?.message);
  return Response.json({ error: e?.message || "internal error" }, { status: 500 });
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const base = url.origin;
    const oauthOn = oauthEnabled(env, url);
    if (url.pathname === "/health") return new Response("ok");
    // Standard sign-in for apps that can't send a key in a header (the Gemini app, claude.ai).
    if (oauthOn && OAUTH_PATHS.some((p) => url.pathname === p || url.pathname.startsWith(`${p}/`))) {
      await ensureSchema(env);
      return oauthProvider(base).fetch(await withMainResource(req, base), env, ctx);
    }
    if (url.pathname.startsWith("/.well-known/")) return new Response("not found", { status: 404 });
    // An MCP client pointed at the main address opens with GET for an event stream; there isn't one.
    if (url.pathname === "/" && req.method === "GET" && (req.headers.get("Accept") || "").startsWith("text/event-stream")) return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
    const open = publicResponse(url, req);
    if (open) return open;
    if (url.pathname === "/" && req.method === "GET") {
      return new Response(SETUP_PAGE, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY" } });
    }
    try {
      await ensureSchema(env);
      if (url.pathname.startsWith("/api/setup/")) return await handleSetup(url, req, env, ctx);
      const authHeader = req.headers.get("Authorization") || "";
      if (oauthOn) {
        const isApi = url.pathname === "/mcp" || url.pathname.startsWith("/api/");
        // A signed-in app's token, or an MCP client with no credential yet (it gets the sign-in challenge).
        if (isApi && (OAUTH_TOKEN.test(authHeader) || (url.pathname === "/mcp" && !authHeader && !req.headers.get("x-api-key")))) return await oauthProvider(base).fetch(req, env, ctx);
        // A signed-in app pointed at the main address: serve it as MCP.
        if (url.pathname === "/" && req.method === "POST" && OAUTH_TOKEN.test(authHeader)) return await oauthProvider(base).fetch(new Request(new URL("/mcp", url), req), env, ctx);
      }
      const caller = await authenticate(req, env, ctx);
      if (!caller) {
        const headers: Record<string, string> = oauthOn ? { "WWW-Authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"` } : {};
        return Response.json({ error: "unauthorized" }, { status: 401, headers });
      }
      if (url.pathname === "/mcp" || url.pathname === "/" || MCP_KEY_PATH.test(url.pathname)) return await handleMcp(req, env, caller);
      if (url.pathname === "/api") return new Response(HELP, { headers: { "Content-Type": "text/plain" } });
      if (url.pathname.startsWith("/api/")) return await handleRest(url, req, env, caller);
      return Response.json({ error: "not found" }, { status: 404 });
    } catch (e) {
      return errorResponse(e);
    }
  },

  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    // Awaited directly: a cron run may take minutes, longer than waitUntil allows.
    try {
      await ensureSchema(env);
      await pruneAuthFailures(env);
      if (env.OAUTH_KV) {
        try {
          await oauthProvider("https://beecloud.invalid").purgeExpiredData(env); // the address doesn't matter for cleanup
        } catch (e: any) {
          console.error("oauth purge failed", e?.message); // never blocks the sync
        }
      }
      console.log("sync", JSON.stringify(await runSync(env, CRON_BUDGET_MS)));
    } catch (e: any) {
      console.error("sync crashed", e?.stack || e?.message);
    }
  },
} satisfies ExportedHandler<Env>;
