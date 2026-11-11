// Webhooks are an outbox: events are written first, then delivered with retries.
import { ItemType, loadRaw } from "./archive";
import { getTz } from "./db";
import { Env, Json } from "./env";
import { conversationMarkdown, dailyMarkdown, insightMarkdown, journalMarkdown } from "./format";

const BACKOFF_MIN = [1, 5, 15, 60, 360, 1440];
const MAX_ATTEMPTS = BACKOFF_MIN.length + 1;
const MAX_PER_RUN = 50;
const CREATED_EVENTS: ItemType[] = ["daily", "insight", "fact", "todo", "journal", "photo"];

export interface BeeEvent {
  event: string;
  type: ItemType;
  id: string;
}

export function eventFor(type: ItemType, status: string, id: string, state: string | null | undefined, prevState: string | null | undefined): BeeEvent | null {
  if (type === "conversation") return state === "COMPLETED" && prevState !== "COMPLETED" ? { event: "conversation.completed", type, id } : null;
  return status === "new" && CREATED_EVENTS.includes(type) ? { event: `${type}.created`, type, id } : null;
}

export async function queueEvents(env: Env, events: BeeEvent[]): Promise<void> {
  if (!events.length) return;
  const { results: hooks } = await env.DB.prepare(`SELECT id, events FROM webhooks`).all<{ id: number; events: string }>();
  const now = Date.now();
  const stmts: D1PreparedStatement[] = [];
  for (const e of events) {
    for (const h of hooks) {
      const wanted = h.events.split(",");
      if (wanted.includes("*") || wanted.includes(e.event)) stmts.push(env.DB.prepare(`INSERT INTO deliveries (webhook_id, event, item_type, item_id, created_at) VALUES (?, ?, ?, ?, ?)`).bind(h.id, e.event, e.type, e.id, now));
    }
  }
  if (stmts.length) await env.DB.batch(stmts);
}

async function payloadFor(env: Env, event: string, type: ItemType, id: string, tz: string): Promise<Json> {
  const raw: Json = (await loadRaw(env, type, id)) || { id };
  if (type === "conversation") return { event, id: raw.id, title: raw.short_summary, start_time: raw.start_time, end_time: raw.end_time, summary: raw.summary, markdown: conversationMarkdown(raw, tz) };
  const markdown = type === "daily" ? dailyMarkdown(raw, tz) : type === "insight" ? insightMarkdown(raw, tz) : type === "journal" ? journalMarkdown(raw, tz) : undefined;
  return { event, id: raw.id, data: raw, markdown };
}

async function sign(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Returns how many reached their destination and how many gave up for good.
export async function deliverDue(env: Env): Promise<{ delivered: number; failed: number }> {
  const { results } = await env.DB.prepare(
    `SELECT d.id, d.event, d.item_type, d.item_id, d.attempts, w.url, w.secret
     FROM deliveries d JOIN webhooks w ON w.id = d.webhook_id
     WHERE d.status = 'pending' AND d.next_try <= ? ORDER BY d.next_try, d.id LIMIT ?`,
  )
    .bind(Date.now(), MAX_PER_RUN)
    .all<{ id: number; event: string; item_type: ItemType; item_id: string; attempts: number; url: string; secret: string }>();
  if (!results.length) return { delivered: 0, failed: 0 };
  const tz = await getTz(env);
  let delivered = 0;
  let failed = 0;
  for (const d of results) {
    let status = 0;
    let error = "";
    try {
      const body = JSON.stringify(await payloadFor(env, d.event, d.item_type, d.item_id, tz));
      const res = await fetch(d.url, {
        method: "POST",
        signal: AbortSignal.timeout(10_000),
        headers: { "Content-Type": "application/json", "X-Bee-Event": d.event, "X-Bee-Delivery": String(d.id), "X-Bee-Signature": `sha256=${await sign(d.secret, body)}` },
        body,
      });
      status = res.status;
      if (!res.ok) error = `HTTP ${res.status}`;
      await res.body?.cancel();
    } catch (e: any) {
      error = e.message;
    }
    const attempts = d.attempts + 1;
    if (!error) {
      delivered++;
      await env.DB.prepare(`UPDATE deliveries SET status = 'delivered', attempts = ?, last_status = ?, last_error = NULL, delivered_at = ? WHERE id = ?`).bind(attempts, status, Date.now(), d.id).run();
    } else if (attempts >= MAX_ATTEMPTS) {
      failed++;
      await env.DB.prepare(`UPDATE deliveries SET status = 'failed', attempts = ?, last_status = ?, last_error = ? WHERE id = ?`).bind(attempts, status, error, d.id).run();
    } else {
      await env.DB.prepare(`UPDATE deliveries SET attempts = ?, next_try = ?, last_status = ?, last_error = ? WHERE id = ?`).bind(attempts, Date.now() + BACKOFF_MIN[attempts - 1] * 60_000, status, error, d.id).run();
    }
  }
  return { delivered, failed };
}
