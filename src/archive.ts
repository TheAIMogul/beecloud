// The archive: one original-format JSON per item in R2 (forever, with edit history),
// readable markdown beside it, and a row plus full-text entry in D1.
import { getTz } from "./db";
import { DEFAULT_TZ, Env, Json } from "./env";
import { briefMarkdown, conversationMarkdown, dailyMarkdown, dateKey, factsMarkdown, insightMarkdown, journalMarkdown, minutesBetween, todosMarkdown } from "./format";

export type ItemType = "conversation" | "daily" | "insight" | "fact" | "todo" | "journal" | "visit" | "place" | "photo" | "suggestion" | "external" | "brief" | "profile" | "thread";

interface Spec {
  dir: string;
  history: boolean;
  id: (r: Json) => string;
  ts: (r: Json) => number;
  title: (r: Json) => string | null;
  body?: (r: Json) => string;
  state?: (r: Json) => string | null;
  place?: (r: Json) => string | null;
  minutes?: (r: Json) => number | null;
  meta?: (r: Json) => Json;
  md?: (r: Json, tz: string, day: string, id: string) => { key: string; text: string };
  sig?: (r: Json) => string | Json; // what a list row and a full fetch have in common
}

const MAX_BODY = 1_500_000; // D1 caps a row at 2 MB
const num = (v: any) => (v === null || v === undefined || v === "" ? Date.now() : Number(v));
const tenths = (ms: any) => (ms ? Math.round(Number(ms) / 6000) / 10 : null);
const utterances = (c: Json): Json[] => (c.transcriptions || []).flatMap((t: Json) => t.utterances || []);
const DAILY_SHARED = ["short_summary", "summary", "email_summary", "calendar_summary", "account_summaries", "locations", "photos", "corrections", "created_at"];

export const SPECS: Record<ItemType, Spec> = {
  conversation: {
    dir: "conversations",
    history: true,
    id: (c) => String(c.id),
    ts: (c) => num(c.start_time),
    title: (c) => c.short_summary || null,
    body: (c) => [c.summary, ...utterances(c).map((u) => u.text)].filter(Boolean).join("\n"),
    state: (c) => c.state,
    place: (c) => c.primary_location?.address || null,
    minutes: (c) => minutesBetween(c.start_time, c.end_time),
    meta: (c) => ({ utterances: c.transcriptions ? utterances(c).length : (c.utterances_count ?? null), summary: String(c.summary || "").slice(0, 1200) }),
    md: (c, tz, day, id) => ({ key: `md/conversations/${day}/${id}.md`, text: conversationMarkdown(c, tz) }),
    sig: (c) => String(c.updated_at),
  },
  daily: {
    dir: "daily",
    history: true,
    id: (d) => String(d.id),
    ts: (d) => num(d.date_time),
    title: (d) => d.short_summary || null,
    body: (d) => [d.summary, d.email_summary, d.calendar_summary].filter(Boolean).join("\n"),
    md: (d, tz, day) => ({ key: `md/daily/${day}.md`, text: dailyMarkdown(d, tz) }),
    sig: (d) => Object.fromEntries(DAILY_SHARED.map((k) => [k, d[k] ?? null])),
  },
  insight: {
    dir: "insights",
    history: true,
    id: (i) => String(i.id),
    ts: (i) => num(i.generated_at),
    title: (i) => i.title,
    body: (i) => [i.description, ...(i.suggested_actions || []).map((a: any) => (typeof a === "string" ? a : a.text || a.title || ""))].filter(Boolean).join("\n"),
    md: (i, tz, day, id) => ({ key: `md/insights/${day}/${id}.md`, text: insightMarkdown(i, tz) }),
  },
  fact: {
    dir: "facts",
    history: true,
    id: (f) => String(f.id),
    ts: (f) => num(f.created_at),
    title: (f) => f.text,
    meta: (f) => ({ tags: f.tags || [], confirmed: !!f.confirmed }),
  },
  todo: {
    dir: "todos",
    history: true,
    id: (t) => String(t.id),
    ts: (t) => num(t.created_at),
    title: (t) => t.text,
    meta: (t) => ({ completed: !!t.completed, alarm_at: t.alarm_at ?? null }),
  },
  journal: {
    dir: "journals",
    history: true,
    id: (j) => String(j.id),
    ts: (j) => num(j.created_at),
    title: (j) => String(j.text || "").slice(0, 120),
    body: (j) => j.text || "",
    state: (j) => j.state,
    md: (j, tz, day, id) => ({ key: `md/journals/${day}/${id}.md`, text: journalMarkdown(j, tz) }),
  },
  visit: {
    dir: "visits",
    history: false,
    id: (v) => String(v.visit_id),
    ts: (v) => num(v.start_at),
    title: (v) => v.address || null,
    place: (v) => v.address || null,
    minutes: (v) => tenths(v.duration_ms),
    meta: (v) => ({ end_at: v.end_at ?? null, lat: v.latitude ?? null, lon: v.longitude ?? null }),
  },
  place: {
    dir: "places",
    history: false,
    id: (p) => String(p.cluster_id),
    ts: (p) => num(p.last_visit_at),
    title: (p) => p.representative_address || null,
    place: (p) => p.representative_address || null,
    minutes: (p) => tenths(p.total_dwell_ms),
    meta: (p) => ({ visits: p.visit_count ?? null, first_visit_at: p.first_visit_at ?? null, lat: p.latitude ?? null, lon: p.longitude ?? null }),
  },
  photo: {
    dir: "photos",
    history: false,
    id: (p) => String(p.id),
    ts: (p) => num(p.captured_at ?? p.created_at),
    title: (p) => p.caption || p.description || null,
    meta: (p) => ({ conversation_id: p.conversation_id ?? null }),
  },
  suggestion: {
    dir: "todo-suggestions",
    history: false,
    id: (s) => String(s.id),
    ts: (s) => num(s.created_at),
    title: (s) => s.text,
    meta: (s) => ({ emoji: s.emoji ?? null, details: s.details ?? null, alarm_at: s.alarm_at ?? null }),
  },
  external: {
    dir: "external-access",
    history: false,
    id: (e) => String(e.id),
    ts: (e) => num(e.created_at),
    title: (e) => `${e.service || "?"}: ${e.description || e.type || ""}`,
    meta: (e) => ({ type: e.type ?? null, summary: e.summary ?? null }),
  },
  brief: {
    dir: "briefs",
    history: false,
    id: (b) => String(b.date),
    ts: (b) => Date.parse(`${b.date}T12:00:00Z`),
    title: (b) => `Brief ${b.date}`,
    meta: (b) => ({ events: (b.calendar_events || []).map((e: Json) => e.summary), emails: (b.emails || []).length }),
    md: (b, tz, _day, id) => ({ key: `md/briefs/${id}.md`, text: briefMarkdown(b, tz, id) }),
  },
  profile: {
    dir: "profile",
    history: true,
    id: () => "me",
    ts: () => 0,
    title: (p) => [p.first_name, p.last_name].filter(Boolean).join(" "),
  },
  thread: {
    dir: "threads",
    history: true,
    id: (t) => String(t.thread_id ?? t.id),
    ts: (t) => num(t.created_at),
    title: (t) => t.name || null,
    body: (t) => (t.messages || []).map((m: Json) => m.text || m.content || "").filter(Boolean).join("\n"),
    state: (t) => t.state ?? null,
    sig: (t) => String(t.updated_at),
  },
};

// R2 directory -> type, for walking the archive when rebuilding the index.
export const TYPE_BY_DIR = Object.fromEntries(Object.entries(SPECS).map(([t, s]) => [s.dir, t as ItemType]));

export const rawKey = (type: ItemType, id: string) => `raw/${SPECS[type].dir}/${id}.json`;

function canon(v: any): string {
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(",")}}`;
  return JSON.stringify(v) ?? "null";
}

export async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const stripTz = ({ timezone: _tz, ...rest }: Json) => rest;

export async function signature(type: ItemType, raw: Json): Promise<string> {
  const sig = SPECS[type].sig?.(raw);
  if (typeof sig === "string") return sig;
  return sha256(canon(sig ?? stripTz(raw)));
}

export interface Known {
  hash: string;
  sig: string;
  state: string | null;
  deleted_at: number | null;
}

export async function loadKnown(env: Env, type: ItemType): Promise<Map<string, Known>> {
  const { results } = await env.DB.prepare(`SELECT id, hash, sig, state, deleted_at FROM items WHERE type = ?`).bind(type).all<Known & { id: string }>();
  return new Map(results.map((r) => [r.id, r]));
}

export type IngestStatus = "new" | "changed" | "same";

export async function ingest(env: Env, type: ItemType, rawIn: Json, tz: string, opts: { known?: Map<string, Known>; indexOnly?: boolean } = {}): Promise<{ status: IngestStatus; id: string; prev?: Known }> {
  const spec = SPECS[type];
  const raw = stripTz(rawIn);
  const id = spec.id(raw);
  const hash = await sha256(canon(raw));
  const prev = opts.known ? opts.known.get(id) : ((await env.DB.prepare(`SELECT hash, sig, state, deleted_at FROM items WHERE type = ? AND id = ?`).bind(type, id).first<Known>()) ?? undefined);
  if (prev && prev.hash === hash && (!prev.deleted_at || opts.indexOnly)) return { status: "same", id, prev };

  const ts = spec.ts(raw);
  const day = dateKey(ts, tz || DEFAULT_TZ);
  const key = rawKey(type, id);
  if (!opts.indexOnly) {
    const keepHistory = prev && spec.history && (type !== "conversation" || prev.state === "COMPLETED");
    if (keepHistory) {
      const current = await env.ARCHIVE.get(key);
      if (current) await env.ARCHIVE.put(`history/${spec.dir}/${id}/${Date.now()}.json`, await current.arrayBuffer(), { httpMetadata: { contentType: "application/json" } });
    }
    await env.ARCHIVE.put(key, JSON.stringify(raw), { httpMetadata: { contentType: "application/json" } });
    const md = spec.md?.(raw, tz, day, id);
    if (md) await env.ARCHIVE.put(md.key, md.text, { httpMetadata: { contentType: "text/markdown; charset=utf-8" } });
  }

  const now = Date.now();
  const sig = await signature(type, raw);
  const title = spec.title(raw);
  const state = spec.state?.(raw) ?? null;
  const db = env.DB;
  const rowId = `(SELECT rid FROM items WHERE type = ? AND id = ?)`;
  await db.batch([
    db.prepare(`DELETE FROM items_fts WHERE rowid = ${rowId}`).bind(type, id),
    db
      .prepare(
        `INSERT INTO items (type, id, ts, day, title, state, place, minutes, meta, hash, sig, first_seen, updated_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT (type, id) DO UPDATE SET ts = excluded.ts, day = excluded.day, title = excluded.title, state = excluded.state,
           place = excluded.place, minutes = excluded.minutes, meta = excluded.meta, hash = excluded.hash, sig = excluded.sig,
           updated_at = excluded.updated_at, deleted_at = NULL`,
      )
      .bind(type, id, ts, day, title, state, spec.place?.(raw) ?? null, spec.minutes?.(raw) ?? null, spec.meta ? JSON.stringify(spec.meta(raw)) : null, hash, sig, now, now),
    db.prepare(`INSERT INTO items_fts (rowid, title, body) VALUES (${rowId}, ?, ?)`).bind(type, id, title ?? "", (spec.body?.(raw) ?? "").slice(0, MAX_BODY)),
  ]);
  opts.known?.set(id, { hash, sig, state, deleted_at: null });
  return { status: prev ? "changed" : "new", id, prev };
}

// Gone from Bee (deleted, dismissed, accepted). The archive keeps it and marks it.
export async function tombstone(env: Env, type: ItemType, id: string): Promise<void> {
  await env.DB.prepare(`UPDATE items SET deleted_at = ? WHERE type = ? AND id = ? AND deleted_at IS NULL`).bind(Date.now(), type, id).run();
}

export async function loadRaw(env: Env, type: ItemType, id: string): Promise<Json | null> {
  const o = await env.ARCHIVE.get(rawKey(type, id));
  return o ? o.json<Json>() : null;
}

export interface Row {
  rid: number;
  type: ItemType;
  id: string;
  ts: number;
  day: string;
  title: string | null;
  state: string | null;
  place: string | null;
  minutes: number | null;
  meta: string | null;
  deleted_at: number | null;
}

export const ROW_COLUMNS = "rid, type, id, ts, day, title, state, place, minutes, meta, deleted_at";
export const metaOf = (r: Row): Json => (r.meta ? JSON.parse(r.meta) : {});
export const factOf = (r: Row): Json => ({ id: r.id, text: r.title, ...metaOf(r) });
export const todoOf = (r: Row): Json => ({ id: r.id, text: r.title, ...metaOf(r) });

export interface PageQuery {
  from?: string;
  to?: string;
  place?: string;
  minMinutes?: number;
  state?: string;
  limit: number;
  cursor?: string;
  includeRemoved?: boolean; // also show items that are gone from Bee but kept here
}

// Newest first, with a cursor that stays stable as new items arrive.
export async function pageItems(env: Env, type: ItemType, q: PageQuery): Promise<{ rows: Row[]; next: string | null }> {
  const where = ["type = ?"];
  const args: any[] = [type];
  if (!q.includeRemoved) where.push("deleted_at IS NULL");
  const add = (sql: string, ...vals: any[]) => {
    where.push(sql);
    args.push(...vals);
  };
  if (q.from) add("day >= ?", q.from);
  if (q.to) add("day <= ?", q.to);
  if (q.place) add("place LIKE ?", `%${q.place}%`);
  if (q.minMinutes !== undefined) add("minutes >= ?", q.minMinutes);
  if (q.state) add("state = ?", q.state);
  if (q.cursor) {
    const [ts, rid] = q.cursor.split("_").map(Number);
    add("(ts < ? OR (ts = ? AND rid < ?))", ts, ts, rid);
  }
  const { results } = await env.DB.prepare(`SELECT ${ROW_COLUMNS} FROM items WHERE ${where.join(" AND ")} ORDER BY ts DESC, rid DESC LIMIT ?`).bind(...args, q.limit + 1).all<Row>();
  const rows = results.slice(0, q.limit);
  const last = rows[rows.length - 1];
  return { rows, next: results.length > q.limit ? `${last.ts}_${last.rid}` : null };
}

// md/facts.md and md/todos.md: every live item, never capped.
export async function writeSnapshots(env: Env, types: Iterable<ItemType>, tz?: string): Promise<void> {
  const zone = tz || (await getTz(env));
  for (const type of types) {
    if (type !== "fact" && type !== "todo") continue;
    const { results } = await env.DB.prepare(`SELECT ${ROW_COLUMNS} FROM items WHERE type = ? AND deleted_at IS NULL ORDER BY ts DESC, rid DESC`).bind(type).all<Row>();
    const text = type === "fact" ? factsMarkdown(results.map(factOf)) : todosMarkdown(results.map(todoOf), zone);
    await env.ARCHIVE.put(type === "fact" ? "md/facts.md" : "md/todos.md", text, { httpMetadata: { contentType: "text/markdown; charset=utf-8" } });
  }
}
