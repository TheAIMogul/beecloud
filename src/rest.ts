// Plain web links over the same tools. POST /api/tools/<name> reaches any of them.
import { ItemType, loadRaw, pageItems } from "./archive";
import { Caller } from "./auth";
import { Env, HttpError, Json, badRequest, notFound } from "./env";
import { asText, invoke } from "./tools";

const md = (text: string) => new Response(text, { headers: { "Content-Type": "text/markdown; charset=utf-8" } });

const GET_ROUTES: Record<string, string> = {
  "/search": "search_conversations",
  "/search/all": "search_all",
  "/conversations": "list_conversations",
  "/daily": "list_daily_summaries",
  "/insights": "list_insights",
  "/todos": "list_todos",
  "/todos/suggestions": "list_todo_suggestions",
  "/facts": "list_facts",
  "/voice-notes": "list_voice_notes",
  "/visits": "list_visits",
  "/places": "list_places",
  "/photos": "list_photos",
  "/brief": "get_today_brief",
  "/external-access": "list_external_access",
  "/archive": "list_archive",
};

export async function handleRest(url: URL, req: Request, env: Env, caller: Caller): Promise<Response> {
  const p = url.pathname.replace(/^\/api/, "");
  const q: Json = Object.fromEntries(url.searchParams);
  const call = async (name: string, args: Json) => md(asText(await invoke(env, caller, name, args)));

  const tool = p.match(/^\/tools\/([a-z_]+)$/);
  if (tool) {
    if (req.method !== "POST") throw new HttpError(405, "Use POST");
    const args = await req.json<Json>().catch(() => {
      throw badRequest("Body must be JSON");
    });
    return call(tool[1], args);
  }
  if (p === "/sync") {
    if (req.method !== "POST") throw new HttpError(405, "Use POST");
    return Response.json(JSON.parse(asText(await invoke(env, caller, "sync_now", {}))));
  }
  if (req.method !== "GET") throw new HttpError(405, "Use GET");

  if (p === "/status") return Response.json(JSON.parse(asText(await invoke(env, caller, "get_status", {}))));
  if (p === "/conversations" && q.format === "json") {
    const { rows, next } = await pageItems(env, "conversation", { limit: Math.min(Number(q.limit) || 20, 100), cursor: q.cursor });
    return Response.json({ conversations: rows, next_cursor: next });
  }
  const conv = p.match(/^\/conversations\/(\d+)(\.json|\.md)?$/);
  if (conv) {
    if (conv[2] === ".json" || q.format === "json") {
      const raw = await loadRaw(env, "conversation" as ItemType, conv[1]);
      if (!raw) throw notFound(`No conversation ${conv[1]}`);
      return Response.json(raw);
    }
    return call("get_conversation", { id: conv[1], include_transcript: q.transcript !== "false" });
  }
  const day = p.match(/^\/day(?:\/(\d{4}-\d{2}-\d{2}))?$/);
  if (day) return call("get_day", { date: day[1], summaries: q.summaries !== "false" });
  const voice = p.match(/^\/voice-notes\/([^/]+)$/);
  if (voice) return call("get_voice_note", { id: decodeURIComponent(voice[1]) });
  const photo = p.match(/^\/photos\/([^/]+)$/);
  if (photo) {
    const o = await env.ARCHIVE.get(`files/photos/${decodeURIComponent(photo[1])}`);
    if (!o) throw notFound(`No photo ${photo[1]}`);
    return new Response(o.body, { headers: { "Content-Type": o.httpMetadata?.contentType || "application/octet-stream" } });
  }
  if (p.startsWith("/archive/")) return call("read_archive", { key: decodeURIComponent(p.slice("/archive/".length)) });
  if (GET_ROUTES[p]) return call(GET_ROUTES[p], q);
  throw notFound("not found");
}
