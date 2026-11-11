// BeeCloud: keeps a permanent archive of a Bee wearable's data in the owner's own Cloudflare
// account and serves it to AI agents over MCP and REST. Nothing runs on a local machine.
import { MCP_KEY_PATH, authenticate } from "./auth";
import { BeeError } from "./bee";
import { ensureSchema } from "./db";
import { Env, HttpError } from "./env";
import { handleMcp } from "./mcp";
import { SETUP_PAGE } from "./page";
import { handleRest } from "./rest";
import { handleSetup } from "./setup";
import { runSync } from "./sync";

const CRON_BUDGET_MS = 240_000;

const HELP = `BeeCloud: a Bee wearable archive
Setup: open / in a browser
Auth:  Authorization: Bearer <key>  (or x-api-key header)
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
    if (url.pathname === "/health") return new Response("ok");
    // Tell OAuth-probing clients (claude.ai) there's no OAuth here, so they connect without it.
    if (url.pathname.startsWith("/.well-known/")) return new Response("not found", { status: 404 });
    if (url.pathname === "/" && req.method === "GET") {
      return new Response(SETUP_PAGE, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY" } });
    }
    try {
      await ensureSchema(env);
      if (url.pathname.startsWith("/api/setup/")) return await handleSetup(url, req, env, ctx);
      const caller = await authenticate(req, env, ctx);
      if (!caller) return Response.json({ error: "unauthorized" }, { status: 401 });
      if (url.pathname === "/mcp" || MCP_KEY_PATH.test(url.pathname)) return await handleMcp(req, env, caller);
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
      console.log("sync", JSON.stringify(await runSync(env, CRON_BUDGET_MS)));
    } catch (e: any) {
      console.error("sync crashed", e?.stack || e?.message);
    }
  },
} satisfies ExportedHandler<Env>;
