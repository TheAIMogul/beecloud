// Every capability is one tool, shared by MCP and REST. Reads come from the archive,
// so they keep working when Bee is down; writes go to Bee and update the archive at once.
import { sendTestAlert } from "./alerts";
import { ItemType, ROW_COLUMNS, Row, factOf, ingest, loadRaw, metaOf, pageItems, todoOf, tombstone, writeSnapshots } from "./archive";
import { Caller, Scope, allowed, createKey } from "./auth";
import { BeeError, bee } from "./bee";
import { getKv, getTz } from "./db";
import { Env, HttpError, Json, badRequest, notFound } from "./env";
import { briefMarkdown, conversationMarkdown, dailyMarkdown, dateKey, factLine, fmtTime, insightMarkdown, journalMarkdown, todoLine } from "./format";
import { fetchDetail, rebuildIndex, runSync } from "./sync";

const HTTP_SYNC_BUDGET_MS = 25_000;

export type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
type Result = string | Content[];
interface Tool {
  name: string;
  description: string;
  scope?: Scope;
  destructive?: boolean;
  properties?: Json;
  required?: string[];
  run: (env: Env, a: Json) => Promise<Result>;
}

// ---------- Arguments ----------

function limitOf(v: any, fallback: number, max: number): number {
  if (v === undefined || v === null || v === "") return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 1) throw badRequest("limit must be a positive number");
  return Math.min(Math.floor(n), max);
}
function dayOf(v: any, name: string): string | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v))) throw badRequest(`${name} must look like 2026-10-30`);
  return String(v);
}
function numericId(v: any): string {
  const id = String(v ?? "");
  if (!/^\d+$/.test(id)) throw badRequest("id must be a number");
  return id;
}
function text(v: any, name: string): string {
  const s = String(v ?? "").trim();
  if (!s) throw badRequest(`${name} is required`);
  return s;
}
function cursorOf(v: any): string | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  if (!/^\d+_\d+$/.test(String(v))) throw badRequest("cursor is not valid; use the next_cursor from the previous page");
  return String(v);
}
const pageOf = (a: Json, fallback = 20, max = 100) => ({ from: dayOf(a.from, "from"), to: dayOf(a.to, "to"), place: a.place ? String(a.place) : undefined, limit: limitOf(a.limit, fallback, max), cursor: cursorOf(a.cursor) });
const more = (next: string | null) => (next ? `\n\nnext_cursor: ${next}` : "");

const PAGE_PROPS = {
  from: { type: "string", description: "Earliest day, YYYY-MM-DD" },
  to: { type: "string", description: "Latest day, YYYY-MM-DD" },
  limit: { type: "number" },
  cursor: { type: "string", description: "next_cursor from the previous page" },
};
const PLACE_PROP = { place: { type: "string", description: "Part of an address, such as Main St" } };
const REMOVED_PROP = { include_removed: { type: "boolean", description: "Also include items that were deleted from Bee but are kept in the archive" } };
const truthy = (v: any) => v === true || v === "true";
const ID_PROP = { id: { type: "string" } };

// ---------- Rendering ----------

function conversationRow(r: Row, tz: string): string {
  const m = metaOf(r);
  const parts = [r.id, fmtTime(r.ts, tz), r.title || "(no title)", `${m.utterances ?? "?"} utterances`, r.deleted_at ? "removed from Bee" : r.state || ""];
  if (r.minutes) parts.push(`${r.minutes} min`);
  if (r.place) parts.push(r.place);
  return `- ${parts.join(" | ")}`;
}
const visitRow = (r: Row, tz: string) => `- ${fmtTime(r.ts, tz)} | ${r.place || "(unknown place)"}${r.minutes ? ` | ${r.minutes} min` : ""} — id ${r.id}`;
const placeRow = (r: Row, tz: string) => {
  const m = metaOf(r);
  return `- ${r.place || "(unknown place)"} | ${m.visits ?? "?"} visits | last ${fmtTime(r.ts, tz)} — id ${r.id}`;
};
const noteRow = (r: Row, tz: string) => `- ${fmtTime(r.ts, tz)} | ${r.title || "(empty)"} — id ${r.id}`;

async function rendered(env: Env, type: ItemType, rows: Row[], render: (raw: Json) => string): Promise<string[]> {
  const raws = await Promise.all(rows.map((r) => loadRaw(env, type, r.id)));
  return raws.filter((r): r is Json => !!r).map(render);
}

// ---------- Search ----------

export interface SearchHit extends Row {
  snip: string;
  score: number;
}

export async function ftsSearch(env: Env, query: string, o: { types?: string[]; from?: string; to?: string; place?: string; limit: number; includeRemoved?: boolean }): Promise<SearchHit[]> {
  const terms = query.match(/[\p{L}\p{N}_']+/gu)?.map((t) => `"${t.replace(/"/g, "")}"`) ?? [];
  if (!terms.length) throw badRequest("query needs at least one word");
  const where = ["items_fts MATCH ?"];
  if (!o.includeRemoved) where.push("i.deleted_at IS NULL");
  const filters: any[] = [];
  if (o.types?.length) {
    where.push(`i.type IN (${o.types.map(() => "?").join(",")})`);
    filters.push(...o.types);
  }
  if (o.from) (where.push("i.day >= ?"), filters.push(o.from));
  if (o.to) (where.push("i.day <= ?"), filters.push(o.to));
  if (o.place) (where.push("i.place LIKE ?"), filters.push(`%${o.place}%`));
  const columns = ROW_COLUMNS.split(", ").map((c) => `i.${c}`).join(", ");
  const sql = `SELECT ${columns}, snippet(items_fts, 1, '**', '**', '…', 40) AS snip, bm25(items_fts, 8.0, 1.0) AS score
    FROM items_fts JOIN items i ON i.rid = items_fts.rowid WHERE ${where.join(" AND ")} ORDER BY score LIMIT ?`;
  const run = (match: string) => env.DB.prepare(sql).bind(match, ...filters, o.limit).all<SearchHit>();
  let { results } = await run(terms.join(" "));
  if (!results.length && terms.length > 1) ({ results } = await run(terms.join(" OR ")));
  return results;
}

const hitLine = (h: SearchHit, tz: string) => `## [${h.type}] ${h.id}${h.title ? ` — ${h.title}` : ""} (${fmtTime(h.ts, tz)}, score ${Math.abs(h.score).toFixed(2)})\n${h.snip || ""}`;

// ---------- Helpers ----------

async function conversationRaw(env: Env, id: string): Promise<{ raw: Json; note: string }> {
  const row = await env.DB.prepare(`SELECT state, deleted_at FROM items WHERE type = 'conversation' AND id = ?`).bind(id).first<{ state: string; deleted_at: number | null }>();
  if (row?.state === "COMPLETED" || row?.deleted_at) {
    const raw = await loadRaw(env, "conversation", id);
    if (raw) return { raw, note: row.deleted_at ? "> Deleted from Bee; this is the archived copy.\n\n" : "" };
  }
  try {
    const raw = await fetchDetail(env, "conversation", id);
    await ingest(env, "conversation", raw, await getTz(env));
    return { raw, note: "" };
  } catch (e) {
    const raw = await loadRaw(env, "conversation", id);
    if (raw) return { raw, note: e instanceof BeeError && !e.notFound ? "> Bee is unreachable; this is the archived copy.\n\n" : "" };
    if (e instanceof BeeError && e.notFound) throw notFound(`No conversation ${id}`);
    throw e;
  }
}

async function refresh(env: Env, type: ItemType, id: string): Promise<Json> {
  const raw = await fetchDetail(env, type, id);
  await ingest(env, type, raw, await getTz(env));
  await writeSnapshots(env, [type]);
  return raw;
}

async function removed(env: Env, type: ItemType, id: string): Promise<void> {
  await tombstone(env, type, id);
  await writeSnapshots(env, [type]);
}

async function status(env: Env): Promise<Json> {
  const { results: counts } = await env.DB.prepare(`SELECT type, COUNT(*) AS n, SUM(deleted_at IS NOT NULL) AS gone FROM items GROUP BY type`).all<{ type: string; n: number; gone: number }>();
  const { results: kv } = await env.DB.prepare(`SELECT key, value FROM kv WHERE key IN ('last_sync','last_error','sync_failures','threads_access','unhandled_feed_types','last_reconcile','webhooks_armed') OR key LIKE 'alert:%'`).all<{ key: string; value: string }>();
  const values = Object.fromEntries(kv.map((r) => [r.key, r.value]));
  const pending = await env.DB.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(attempts > 0), 0) AS retrying FROM pending`).first<{ n: number; retrying: number }>();
  const byType = Object.fromEntries(counts.map((c) => [c.type, c.n]));
  return {
    backfillDone: !!values.webhooks_armed,
    lastSync: values.last_sync ?? null,
    lastError: values.last_error ?? null,
    syncFailuresInARow: Number(values.sync_failures ?? 0),
    lastFullCheck: values.last_reconcile ? new Date(Number(values.last_reconcile)).toISOString() : null,
    archived: { conversations: byType.conversation ?? 0, dailies: byType.daily ?? 0, insights: byType.insight ?? 0, ...Object.fromEntries(Object.entries(byType).filter(([t]) => !["conversation", "daily", "insight"].includes(t))) },
    keptAfterLeavingBee: counts.reduce((sum, c) => sum + (c.gone || 0), 0),
    pending: pending?.n ?? 0,
    retrying: pending?.retrying ?? 0,
    threadsAccess: values.threads_access ?? "not checked yet",
    unhandledFeedTypes: values.unhandled_feed_types ?? null,
    activeAlerts: Object.keys(values).filter((k) => k.startsWith("alert:")).map((k) => k.slice(6)),
  };
}

async function brief(env: Env, a: Json): Promise<string> {
  const tz = await getTz(env);
  const today = dateKey(Date.now(), tz);
  const day = dayOf(a.date, "date") ?? today;
  if (day === today) {
    try {
      const live = await bee(env, "/v1/todayBrief");
      const raw = { ...live, date: today };
      await ingest(env, "brief", raw, tz);
      return briefMarkdown(raw, tz, today);
    } catch (e) {
      if (!(e instanceof BeeError) || e.authFailed) throw e;
    }
  }
  const raw = await loadRaw(env, "brief", day);
  if (!raw) throw notFound(`No brief archived for ${day}`);
  return briefMarkdown(raw, tz, day);
}

async function getDay(env: Env, a: Json): Promise<string> {
  const tz = await getTz(env);
  const day = dayOf(a.date, "date") ?? dateKey(Date.now(), tz);
  const { results } = await env.DB.prepare(`SELECT ${ROW_COLUMNS} FROM items WHERE day = ? AND deleted_at IS NULL ORDER BY ts`).bind(day).all<Row>();
  const of = (t: ItemType) => results.filter((r) => r.type === t);
  const out: string[] = [`# ${day}`, ""];
  const recap = of("daily")[0];
  const raw = recap ? await loadRaw(env, "daily", recap.id) : null;
  out.push("## Recap", "", raw ? dailyMarkdown(raw, tz).trim() : "(no recap yet)", "");
  const section = (title: string, rows: Row[], render: (r: Row) => string) => {
    if (rows.length) out.push(`## ${title}`, "", ...rows.map(render), "");
  };
  section("Conversations", of("conversation"), (r) => {
    const summary = metaOf(r).summary;
    return `${conversationRow(r, tz)}${summary && a.summaries !== false ? `\n  ${String(summary).replace(/\s+/g, " ").slice(0, 400)}` : ""}`;
  });
  section("Voice notes", of("journal"), (r) => noteRow(r, tz));
  section("Insights", of("insight"), (r) => `- ${r.title} — id ${r.id}`);
  section("Places visited", of("visit"), (r) => visitRow(r, tz));
  section("Calendar", of("brief"), (r) => (metaOf(r).events || []).map((e: string) => `- ${e}`).join("\n") || "(none)");
  section("Photos", of("photo"), (r) => `- ${fmtTime(r.ts, tz, false)}${r.title ? ` ${r.title}` : ""} — id ${r.id}`);
  section("New todos", of("todo"), (r) => todoLine(todoOf(r), tz));
  section("New facts", of("fact"), (r) => factLine(factOf(r)));
  return out.join("\n");
}

function base64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

// ---------- The tools ----------

export const TOOLS: Tool[] = [
  // Read: conversations
  {
    name: "search_conversations",
    description: "Search the owner's Bee conversations (recorded meetings/talks). mode 'keyword' (default) searches the archive and works even if Bee is down; 'neural' uses Bee's meaning-based search. Returns conversation ids with summaries.",
    properties: { query: { type: "string" }, mode: { type: "string", enum: ["keyword", "neural"] }, limit: { type: "number" }, from: PAGE_PROPS.from, to: PAGE_PROPS.to, ...PLACE_PROP, ...REMOVED_PROP },
    required: ["query"],
    run: async (env, a) => {
      const query = text(a.query ?? a.q, "query");
      const limit = limitOf(a.limit, 10, 50);
      const tz = await getTz(env);
      let note = "";
      if (a.mode === "neural") {
        try {
          const r = await bee(env, "/v1/search/conversations/neural", { method: "POST", body: JSON.stringify({ query, limit }) });
          const results: Json[] = r.results || [];
          if (!results.length) return "No matches.";
          return results.map((x) => `## ${x.id}${x.short_summary ? ` — ${x.short_summary}` : ""} (score ${Number(x.score ?? 0).toFixed(2)})\n${String(x.summary || "").slice(0, 1200)}`).join("\n\n");
        } catch (e) {
          if (!(e instanceof BeeError) || e.authFailed) throw e;
          note = "> Bee's meaning-based search is unavailable; these are keyword matches from the archive.\n\n";
        }
      }
      const hits = await ftsSearch(env, query, { types: ["conversation"], from: dayOf(a.from, "from"), to: dayOf(a.to, "to"), place: a.place, limit, includeRemoved: truthy(a.include_removed) });
      if (!hits.length) return `${note}No matches.`;
      return note + hits.map((h) => `## ${h.id}${h.title ? ` — ${h.title}` : ""} (${fmtTime(h.ts, tz)}, score ${Math.abs(h.score).toFixed(2)})\n${metaOf(h).summary || h.snip || ""}`).join("\n\n");
    },
  },
  {
    name: "search_all",
    description: "Keyword search across everything in the archive: conversations, recaps, insights, facts, todos and voice notes. Works even if Bee is down.",
    properties: { query: { type: "string" }, types: { type: "array", items: { type: "string", enum: ["conversation", "daily", "insight", "fact", "todo", "journal", "suggestion", "visit"] } }, limit: { type: "number" }, from: PAGE_PROPS.from, to: PAGE_PROPS.to, ...PLACE_PROP, ...REMOVED_PROP },
    required: ["query"],
    run: async (env, a) => {
      const types = typeof a.types === "string" ? a.types.split(",") : a.types;
      const hits = await ftsSearch(env, text(a.query ?? a.q, "query"), { types, from: dayOf(a.from, "from"), to: dayOf(a.to, "to"), place: a.place, limit: limitOf(a.limit, 15, 50), includeRemoved: truthy(a.include_removed) });
      const tz = await getTz(env);
      return hits.length ? hits.map((h) => hitLine(h, tz)).join("\n\n") : "No matches.";
    },
  },
  {
    name: "list_conversations",
    description: "List Bee conversations, newest first: id, time, title, length, place. Filter by date range, place and minimum length. Paginate with cursor.",
    properties: { ...PAGE_PROPS, ...PLACE_PROP, ...REMOVED_PROP, min_minutes: { type: "number", description: "Only conversations at least this long" }, state: { type: "string", description: "Such as COMPLETED or CAPTURING" } },
    run: async (env, a) => {
      const minMinutes = a.min_minutes === undefined || a.min_minutes === "" ? undefined : Number(a.min_minutes);
      if (minMinutes !== undefined && !Number.isFinite(minMinutes)) throw badRequest("min_minutes must be a number");
      const { rows, next } = await pageItems(env, "conversation", { ...pageOf(a), minMinutes, state: a.state, includeRemoved: truthy(a.include_removed) });
      const tz = await getTz(env);
      return (rows.map((r) => conversationRow(r, tz)).join("\n") || "No conversations.") + more(next);
    },
  },
  {
    name: "get_conversation",
    description: "Get one Bee conversation as markdown: summary, takeaways, action items, and (by default) the full timestamped transcript. Still works for conversations later deleted from Bee.",
    properties: { ...ID_PROP, include_transcript: { type: "boolean" } },
    required: ["id"],
    run: async (env, a) => {
      const { raw, note } = await conversationRaw(env, numericId(a.id));
      const include = a.include_transcript !== false && a.include_transcript !== "false";
      return note + conversationMarkdown(raw, await getTz(env), include);
    },
  },
  {
    name: "get_related_conversations",
    description: "Ask Bee which conversations are related to this one. Needs Bee to be reachable.",
    properties: ID_PROP,
    required: ["id"],
    run: async (env, a) => JSON.stringify(await bee(env, `/v1/conversations/${numericId(a.id)}/related`), null, 2),
  },
  {
    name: "get_day",
    description: "Everything for one date in a single call: recap, conversations, voice notes, insights, places visited, calendar, photos, new todos and facts. Defaults to today.",
    properties: { date: { type: "string", description: "YYYY-MM-DD" }, summaries: { type: "boolean", description: "Include each conversation's summary (default true)" } },
    run: (env, a) => getDay(env, a),
  },
  // Read: everything else
  {
    name: "list_daily_summaries",
    description: "Bee daily recaps (what happened each day, incl. email/calendar summaries), newest first.",
    properties: PAGE_PROPS,
    run: async (env, a) => {
      const { rows, next } = await pageItems(env, "daily", pageOf(a, 7, 30));
      const tz = await getTz(env);
      return ((await rendered(env, "daily", rows, (d) => dailyMarkdown(d, tz))).join("\n---\n\n") || "No recaps.") + more(next);
    },
  },
  {
    name: "list_insights",
    description: "Bee insights and suggested actions, newest first.",
    properties: PAGE_PROPS,
    run: async (env, a) => {
      const { rows, next } = await pageItems(env, "insight", pageOf(a, 20, 50));
      const tz = await getTz(env);
      return ((await rendered(env, "insight", rows, (i) => insightMarkdown(i, tz))).join("\n---\n\n") || "No insights.") + more(next);
    },
  },
  {
    name: "list_todos",
    description: "Bee todos (action items captured from conversations). Use show='open' or 'completed' to filter.",
    properties: { show: { type: "string", enum: ["all", "open", "completed"] }, limit: { type: "number" }, cursor: PAGE_PROPS.cursor },
    run: async (env, a) => {
      const { rows, next } = await pageItems(env, "todo", { limit: limitOf(a.limit, 200, 500), cursor: cursorOf(a.cursor) });
      const tz = await getTz(env);
      const todos = rows.map(todoOf).filter((t) => (a.show === "open" ? !t.completed : a.show === "completed" ? t.completed : true));
      return ["# Bee todos", "", ...todos.map((t) => todoLine(t, tz)), ""].join("\n") + more(next);
    },
  },
  {
    name: "list_facts",
    description: "Facts Bee has learned about the owner.",
    properties: { limit: { type: "number" }, cursor: PAGE_PROPS.cursor },
    run: async (env, a) => {
      const { rows, next } = await pageItems(env, "fact", { limit: limitOf(a.limit, 200, 500), cursor: cursorOf(a.cursor) });
      return ["# Bee facts", "", ...rows.map(factOf).map(factLine), ""].join("\n") + more(next);
    },
  },
  {
    name: "list_voice_notes",
    description: "Bee voice notes (Bee also calls these journals), newest first. Text only; Bee doesn't expose the audio.",
    properties: PAGE_PROPS,
    run: async (env, a) => {
      const { rows, next } = await pageItems(env, "journal", pageOf(a));
      const tz = await getTz(env);
      return (rows.map((r) => noteRow(r, tz)).join("\n") || "No voice notes.") + more(next);
    },
  },
  {
    name: "get_voice_note",
    description: "Read one Bee voice note in full.",
    properties: ID_PROP,
    required: ["id"],
    run: async (env, a) => {
      const raw = await loadRaw(env, "journal", text(a.id, "id"));
      if (!raw) throw notFound(`No voice note ${a.id}`);
      return journalMarkdown(raw, await getTz(env));
    },
  },
  {
    name: "list_visits",
    description: "Places the owner visited, newest first: time, address, length. Filter by date range and address.",
    properties: { ...PAGE_PROPS, ...PLACE_PROP },
    run: async (env, a) => {
      const { rows, next } = await pageItems(env, "visit", pageOf(a, 30));
      const tz = await getTz(env);
      return (rows.map((r) => visitRow(r, tz)).join("\n") || "No visits.") + more(next);
    },
  },
  {
    name: "list_places",
    description: "The owner's frequent places: address, number of visits, last visit.",
    properties: { limit: { type: "number" }, cursor: PAGE_PROPS.cursor, ...PLACE_PROP },
    run: async (env, a) => {
      const { rows, next } = await pageItems(env, "place", { limit: limitOf(a.limit, 50, 100), cursor: cursorOf(a.cursor), place: a.place });
      const tz = await getTz(env);
      return (rows.map((r) => placeRow(r, tz)).join("\n") || "No places.") + more(next);
    },
  },
  {
    name: "list_photos",
    description: "Photos synced to Bee, newest first. Use get_photo to see one.",
    properties: PAGE_PROPS,
    run: async (env, a) => {
      const { rows, next } = await pageItems(env, "photo", pageOf(a));
      const tz = await getTz(env);
      return (rows.map((r) => `- ${r.id} | ${fmtTime(r.ts, tz)}${r.title ? ` | ${r.title}` : ""}`).join("\n") || "No photos.") + more(next);
    },
  },
  {
    name: "get_photo",
    description: "Get one archived photo as an image.",
    properties: ID_PROP,
    required: ["id"],
    run: async (env, a) => {
      const o = await env.ARCHIVE.get(`files/photos/${text(a.id, "id")}`);
      if (!o) throw notFound(`No photo ${a.id}`);
      return [{ type: "image", data: base64(await o.arrayBuffer()), mimeType: o.httpMetadata?.contentType || "image/jpeg" }];
    },
  },
  {
    name: "get_today_brief",
    description: "Calendar events and emails for a date, as Bee prepared them. Defaults to today. Earlier dates come from the archive.",
    properties: { date: { type: "string", description: "YYYY-MM-DD" } },
    run: (env, a) => brief(env, a),
  },
  {
    name: "list_todo_suggestions",
    description: "Todos Bee suggests that haven't been accepted yet. Accept or dismiss them by id.",
    properties: { limit: { type: "number" }, cursor: PAGE_PROPS.cursor },
    run: async (env, a) => {
      const { rows, next } = await pageItems(env, "suggestion", { limit: limitOf(a.limit, 50, 200), cursor: cursorOf(a.cursor) });
      return (rows.map((r) => `- ${r.title} — id ${r.id}`).join("\n") || "No suggestions.") + more(next);
    },
  },
  {
    name: "list_external_access",
    description: "Log of outside services that read the owner's Bee data.",
    properties: { limit: { type: "number" }, cursor: PAGE_PROPS.cursor },
    run: async (env, a) => {
      const { rows, next } = await pageItems(env, "external", { limit: limitOf(a.limit, 50, 200), cursor: cursorOf(a.cursor) });
      const tz = await getTz(env);
      return (rows.map((r) => `- ${fmtTime(r.ts, tz)} | ${r.title}`).join("\n") || "No outside access logged.") + more(next);
    },
  },
  {
    name: "list_archive",
    description: "List archived files in Cloudflare R2: md/ (readable), raw/ (Bee's original data), history/ (earlier versions of edited items), files/ (photos).",
    properties: { prefix: { type: "string" }, limit: { type: "number" } },
    run: async (env, a) => {
      const limit = limitOf(a.limit, 200, 2000);
      const keys: string[] = [];
      let cursor: string | undefined;
      do {
        const r = await env.ARCHIVE.list({ prefix: a.prefix ?? "md/", cursor, limit: 1000 });
        keys.push(...r.objects.map((o) => o.key));
        cursor = r.truncated ? r.cursor : undefined;
      } while (cursor && keys.length < limit);
      return keys.sort().reverse().slice(0, limit).join("\n") || "Archive empty.";
    },
  },
  {
    name: "read_archive",
    description: "Read one archived text file from R2 by key (from list_archive). Works even if Bee is unavailable.",
    properties: { key: { type: "string" } },
    required: ["key"],
    run: async (env, a) => {
      const key = text(a.key, "key");
      if (key.startsWith("files/")) throw badRequest("That's a binary file; use get_photo");
      const o = await env.ARCHIVE.get(key);
      if (!o) throw notFound(`No archived file at ${key}`);
      return o.text();
    },
  },
  {
    name: "get_status",
    description: "Health of the archive: last sync, counts, anything waiting or failing, active alerts.",
    run: async (env) => JSON.stringify(await status(env), null, 2),
  },
  // Write
  {
    name: "sync_now",
    scope: "write",
    description: "Pull the latest Bee data into the archive immediately (normally runs every 15 minutes).",
    run: async (env) => JSON.stringify(await runSync(env, HTTP_SYNC_BUDGET_MS), null, 2),
  },
  {
    name: "create_todo",
    scope: "write",
    description: "Add a todo to Bee.",
    properties: { text: { type: "string" }, alarm_at: { type: "string", description: "Reminder time, ISO 8601" } },
    required: ["text"],
    run: async (env, a) => {
      const r = await bee(env, "/v1/todos", { method: "POST", body: JSON.stringify({ text: text(a.text, "text"), ...(a.alarm_at ? { alarm_at: a.alarm_at } : {}) }) });
      const id = String(r.id ?? r.todo?.id ?? "");
      if (id) await refresh(env, "todo", id);
      return `Created todo ${id}: ${a.text}`;
    },
  },
  {
    name: "update_todo",
    scope: "write",
    description: "Change a Bee todo's text, completed state or reminder. Set alarm_at to null to clear the reminder.",
    properties: { ...ID_PROP, text: { type: "string" }, completed: { type: "boolean" }, alarm_at: { type: ["string", "null"] } },
    required: ["id"],
    run: async (env, a) => {
      const id = numericId(a.id);
      const body: Json = {};
      if (a.text !== undefined) body.text = text(a.text, "text");
      if (a.completed !== undefined) body.completed = a.completed === true || a.completed === "true";
      if (a.alarm_at !== undefined) body.alarm_at = a.alarm_at;
      if (!Object.keys(body).length) throw badRequest("Nothing to change");
      await bee(env, `/v1/todos/${id}`, { method: "PUT", body: JSON.stringify(body) });
      return todoLine(await refresh(env, "todo", id), await getTz(env));
    },
  },
  {
    name: "complete_todo",
    scope: "write",
    description: "Mark a Bee todo as done.",
    properties: ID_PROP,
    required: ["id"],
    run: async (env, a) => {
      const id = numericId(a.id);
      await bee(env, `/v1/todos/${id}`, { method: "PUT", body: JSON.stringify({ completed: true }) });
      return todoLine(await refresh(env, "todo", id), await getTz(env));
    },
  },
  {
    name: "delete_todo",
    scope: "write",
    destructive: true,
    description: "Delete a todo from Bee. The archive keeps a copy.",
    properties: ID_PROP,
    required: ["id"],
    run: async (env, a) => {
      const id = numericId(a.id);
      await bee(env, `/v1/todos/${id}`, { method: "DELETE" });
      await removed(env, "todo", id);
      return `Deleted todo ${id}.`;
    },
  },
  {
    name: "create_fact",
    scope: "write",
    description: "Teach Bee a fact about the owner.",
    properties: { text: { type: "string" } },
    required: ["text"],
    run: async (env, a) => {
      const r = await bee(env, "/v1/facts", { method: "POST", body: JSON.stringify({ text: text(a.text, "text") }) });
      const id = String(r.id ?? r.fact?.id ?? "");
      if (id) await refresh(env, "fact", id);
      return `Created fact ${id}: ${a.text}`;
    },
  },
  {
    name: "update_fact",
    scope: "write",
    description: "Change a Bee fact's text or confirmed state.",
    properties: { ...ID_PROP, text: { type: "string" }, confirmed: { type: "boolean" } },
    required: ["id"],
    run: async (env, a) => {
      const id = numericId(a.id);
      const body: Json = {};
      if (a.text !== undefined) body.text = text(a.text, "text");
      if (a.confirmed !== undefined) body.confirmed = a.confirmed === true || a.confirmed === "true";
      if (!Object.keys(body).length) throw badRequest("Nothing to change");
      await bee(env, `/v1/facts/${id}`, { method: "PUT", body: JSON.stringify(body) });
      return factLine(await refresh(env, "fact", id));
    },
  },
  {
    name: "confirm_fact",
    scope: "write",
    description: "Mark a fact Bee is unsure about as confirmed.",
    properties: ID_PROP,
    required: ["id"],
    run: async (env, a) => {
      const id = numericId(a.id);
      await bee(env, `/v1/facts/${id}`, { method: "PUT", body: JSON.stringify({ confirmed: true }) });
      return factLine(await refresh(env, "fact", id));
    },
  },
  {
    name: "delete_fact",
    scope: "write",
    destructive: true,
    description: "Delete a fact from Bee. The archive keeps a copy.",
    properties: ID_PROP,
    required: ["id"],
    run: async (env, a) => {
      const id = numericId(a.id);
      await bee(env, `/v1/facts/${id}`, { method: "DELETE" });
      await removed(env, "fact", id);
      return `Deleted fact ${id}.`;
    },
  },
  {
    name: "accept_todo_suggestion",
    scope: "write",
    description: "Turn one of Bee's suggested todos into a real todo.",
    properties: ID_PROP,
    required: ["id"],
    run: async (env, a) => {
      const id = numericId(a.id);
      const r = await bee(env, `/v1/todoSuggestions/${id}/accept`, { method: "POST", body: "{}" });
      await tombstone(env, "suggestion", id);
      const todoId = r.id ?? r.todo?.id;
      if (todoId) await refresh(env, "todo", String(todoId));
      return `Accepted suggestion ${id}${todoId ? ` as todo ${todoId}` : ""}.`;
    },
  },
  {
    name: "dismiss_todo_suggestion",
    scope: "write",
    destructive: true,
    description: "Dismiss one of Bee's suggested todos.",
    properties: ID_PROP,
    required: ["id"],
    run: async (env, a) => {
      const id = numericId(a.id);
      await bee(env, `/v1/todoSuggestions/${id}/dismiss`, { method: "POST", body: "{}" });
      await tombstone(env, "suggestion", id);
      return `Dismissed suggestion ${id}.`;
    },
  },
  // Admin
  {
    name: "create_key",
    scope: "admin",
    description: "Create (or replace) an agent's access key. Shown once.",
    properties: { name: { type: "string" }, scope: { type: "string", enum: ["read", "write", "admin"] } },
    required: ["name"],
    run: async (env, a) => createKey(env, text(a.name, "name"), (a.scope ?? "write") as Scope),
  },
  {
    name: "list_keys",
    scope: "admin",
    description: "List access keys: who has one, what it can do, when it was last used. Never shows the keys themselves.",
    run: async (env) => {
      const { results } = await env.DB.prepare(`SELECT name, scope, created_at, last_used_at, revoked_at FROM api_keys ORDER BY name`).all<Json>();
      const stamp = (v: any) => (v ? new Date(v).toISOString() : null);
      return JSON.stringify(results.map((r) => ({ ...r, created_at: stamp(r.created_at), last_used_at: stamp(r.last_used_at), revoked_at: stamp(r.revoked_at) })), null, 2);
    },
  },
  {
    name: "revoke_key",
    scope: "admin",
    destructive: true,
    description: "Cut off one agent's key immediately, without touching the others.",
    properties: { name: { type: "string" } },
    required: ["name"],
    run: async (env, a) => {
      const r = await env.DB.prepare(`UPDATE api_keys SET revoked_at = ? WHERE name = ? AND revoked_at IS NULL`).bind(Date.now(), text(a.name, "name")).run();
      if (!r.meta.changes) throw notFound(`No active key named ${a.name}`);
      return `Revoked ${a.name}.`;
    },
  },
  {
    name: "add_webhook",
    scope: "admin",
    description: "Register an address to receive events as new data arrives (within 15 minutes). Events: conversation.completed (default), daily.created, insight.created, fact.created, todo.created, journal.created, photo.created, or * for all. Each delivery is signed with the returned secret in the X-Bee-Signature header.",
    properties: { url: { type: "string" }, events: { type: "array", items: { type: "string" } } },
    required: ["url"],
    run: async (env, a) => {
      const url = text(a.url, "url");
      if (!/^https:\/\//.test(url)) throw badRequest("url must start with https://");
      const events = (Array.isArray(a.events) ? a.events : String(a.events ?? "conversation.completed").split(",")).join(",");
      const bytes = crypto.getRandomValues(new Uint8Array(24));
      const secret = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
      await env.DB.prepare(`INSERT INTO webhooks (url, secret, events, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (url) DO UPDATE SET secret = excluded.secret, events = excluded.events`).bind(url, secret, events, Date.now()).run();
      return JSON.stringify({ url, events, secret }, null, 2);
    },
  },
  {
    name: "list_webhooks",
    scope: "admin",
    description: "List registered webhook addresses and recent delivery results.",
    run: async (env) => {
      const { results } = await env.DB.prepare(
        `SELECT w.id, w.url, w.events,
           SUM(d.status = 'delivered') AS delivered, SUM(d.status = 'pending') AS waiting, SUM(d.status = 'failed') AS failed, MAX(d.delivered_at) AS last_delivered
         FROM webhooks w LEFT JOIN deliveries d ON d.webhook_id = w.id GROUP BY w.id ORDER BY w.id`,
      ).all<Json>();
      return JSON.stringify(results, null, 2);
    },
  },
  {
    name: "remove_webhook",
    scope: "admin",
    destructive: true,
    description: "Stop sending events to a webhook address.",
    properties: { id: { type: "number" } },
    required: ["id"],
    run: async (env, a) => {
      const id = numericId(a.id);
      await env.DB.batch([env.DB.prepare(`DELETE FROM deliveries WHERE webhook_id = ?`).bind(id), env.DB.prepare(`DELETE FROM webhooks WHERE id = ?`).bind(id)]);
      return `Removed webhook ${id}.`;
    },
  },
  {
    name: "list_webhook_deliveries",
    scope: "admin",
    description: "The webhook delivery log, newest first.",
    properties: { limit: { type: "number" }, status: { type: "string", enum: ["pending", "delivered", "failed"] } },
    run: async (env, a) => {
      const filter = a.status ? "WHERE status = ?" : "";
      const args = a.status ? [a.status, limitOf(a.limit, 20, 200)] : [limitOf(a.limit, 20, 200)];
      const { results } = await env.DB.prepare(`SELECT id, webhook_id, event, item_type, item_id, status, attempts, last_status, last_error, created_at, delivered_at FROM deliveries ${filter} ORDER BY id DESC LIMIT ?`).bind(...args).all<Json>();
      return JSON.stringify(results, null, 2);
    },
  },
  {
    name: "rebuild_index",
    scope: "admin",
    description: "Recovery: rebuild the search index from the R2 archive without calling Bee. Pass back the returned cursor until done is true.",
    properties: { cursor: { type: "string" } },
    run: async (env, a) => JSON.stringify(await rebuildIndex(env, HTTP_SYNC_BUDGET_MS, a.cursor), null, 2),
  },
  {
    name: "send_test_alert",
    scope: "admin",
    description: "Send a test alert to the owner's phone through Pushbullet.",
    run: async (env) => ((await sendTestAlert(env, "Alerts are working. You can ignore this.")) ? "Sent." : "Not sent: set the PUSHBULLET_TOKEN secret to turn on phone alerts."),
  },
];

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

export function toolList(caller: Caller) {
  return TOOLS.filter((t) => allowed(caller.scope, t.scope ?? "read")).map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: { type: "object", properties: t.properties ?? {}, ...(t.required ? { required: t.required } : {}) },
    annotations: { readOnlyHint: (t.scope ?? "read") === "read", destructiveHint: !!t.destructive, openWorldHint: false },
  }));
}

export async function invoke(env: Env, caller: Caller, name: string, args: Json): Promise<Result> {
  const tool = BY_NAME.get(name);
  if (!tool) throw notFound(`Unknown tool: ${name}`);
  if (!allowed(caller.scope, tool.scope ?? "read")) throw new HttpError(403, `This key can't use ${name}`);
  return tool.run(env, args);
}

export const asText = (r: Result): string => (typeof r === "string" ? r : r.map((c) => (c.type === "text" ? c.text : `[image ${c.mimeType}]`)).join("\n"));
