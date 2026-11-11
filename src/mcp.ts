// MCP over Streamable HTTP: stateless, JSON responses.
import { Caller } from "./auth";
import { getKv } from "./db";
import { Env, Json } from "./env";
import { invoke, toolList } from "./tools";

const VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const INSTRUCTIONS =
  "Bee wearable, archived in their own Cloudflare account: conversations with transcripts, daily recaps, insights, voice notes, todos, facts, places visited, photos and calendar briefs. " +
  "Use get_day for 'what happened on <date>'. Use search_conversations or search_all, then get_conversation, for 'what did we say about X'. Reads come from the archive (at most 15 minutes behind) and keep working if Bee is down; call sync_now if you need the very latest. " +
  "Transcripts are raw speech-to-text: speakers are often Unknown and wording can be garbled.";

async function ownerPossessive(env: Env): Promise<string> {
  const name = await getKv(env, "owner_name");
  return name ? `${name}'s` : "The owner's";
}

async function handleRpc(env: Env, caller: Caller, msg: Json): Promise<Json | null> {
  const { id, method, params = {} } = msg;
  const ok = (result: Json) => ({ jsonrpc: "2.0", id, result });
  if (id === undefined || id === null) return null; // notification
  try {
    switch (method) {
      case "initialize":
        return ok({
          protocolVersion: VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "beecloud", version: "1.0.0" },
          instructions: `${await ownerPossessive(env)} ${INSTRUCTIONS}`,
        });
      case "ping":
        return ok({});
      case "tools/list":
        return ok({ tools: toolList(caller) });
      case "tools/call":
        try {
          const result = await invoke(env, caller, params.name, params.arguments || {});
          return ok({ content: typeof result === "string" ? [{ type: "text", text: result }] : result });
        } catch (e: any) {
          return ok({ content: [{ type: "text", text: `Error: ${e.message}` }], isError: true });
        }
      default:
        return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } };
    }
  } catch (e: any) {
    return { jsonrpc: "2.0", id, error: { code: -32603, message: e.message } };
  }
}

export async function handleMcp(req: Request, env: Env, caller: Caller): Promise<Response> {
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
  let body: any;
  try {
    body = await req.json();
  } catch {
    return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, { status: 400 });
  }
  const msgs = Array.isArray(body) ? body : [body];
  const replies = (await Promise.all(msgs.map((m) => handleRpc(env, caller, m)))).filter(Boolean);
  if (!replies.length) return new Response(null, { status: 202 });
  return Response.json(Array.isArray(body) ? replies : replies[0]);
}
