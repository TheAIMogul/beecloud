// One sync run: read Bee's change feed into a durable queue, drain the queue one item
// at a time so a bad item only costs itself, then top up the types the feed doesn't cover.
import { clear, raise } from "./alerts";
import { ItemType, Known, SPECS, TYPE_BY_DIR, ingest, loadKnown, signature, tombstone, writeSnapshots } from "./archive";
import { BeeError, bee, beeResponse, beeToken, qs, walk } from "./bee";
import { getKv, getTz, kvStatement, setKv } from "./db";
import { DAY_MS, Env, HOUR_MS, Json } from "./env";
import { addDays, dateKey } from "./format";
import { BeeEvent, deliverDue, eventFor, queueEvents } from "./webhooks";

// The lock is a heartbeat: a run renews it as it works, so a run that gets killed frees it within two minutes.
const LOCK_MS = 120_000;
const LOCK_RENEW_MS = 30_000;
const MAX_ITEMS_PER_RUN = 120;
const MAX_PHOTOS_PER_RUN = 20;
const MAX_BACKOFF_MS = 6 * HOUR_MS;
const STUCK_ATTEMPTS = 6;
const VISITS_PAGE = 100;
const WEARABLE_TYPES: ItemType[] = ["conversation", "journal", "daily", "insight", "fact", "todo", "visit", "photo"];
const FEED_TYPES: Record<string, ItemType> = { facts: "fact", todos: "todo", dailies: "daily", conversations: "conversation", journals: "journal", insights: "insight" };
const FEED_META = new Set(["next_cursor", "since", "until", "updated", "timezone"]);
const FULL_LISTS: { type: ItemType; path: string; key: string; complete: boolean }[] = [
  { type: "fact", path: "/v1/facts", key: "facts", complete: true },
  { type: "todo", path: "/v1/todos", key: "todos", complete: true },
  { type: "insight", path: "/v1/insights", key: "insights", complete: true },
  { type: "journal", path: "/v1/journals", key: "journals", complete: true },
  { type: "conversation", path: "/v1/conversations", key: "conversations", complete: false },
  { type: "daily", path: "/v1/daily", key: "daily_summaries", complete: false },
];

const unwrap = (r: Json, key: string): Json => ({ ...(r[key] || r), timezone: r.timezone });
const DETAIL: Partial<Record<ItemType, (env: Env, id: string) => Promise<Json>>> = {
  conversation: async (env, id) => unwrap(await bee(env, `/v1/conversations/${id}`), "conversation"),
  daily: async (env, id) => unwrap(await bee(env, `/v1/daily/${id}`), "daily_summary"),
  fact: (env, id) => bee(env, `/v1/facts/${id}`),
  todo: (env, id) => bee(env, `/v1/todos/${id}`),
  insight: (env, id) => bee(env, `/v1/insights/${id}`),
  journal: (env, id) => bee(env, `/v1/journals/${encodeURIComponent(id)}`),
};
export const fetchDetail = (env: Env, type: ItemType, id: string) => DETAIL[type]!(env, id);

export interface SyncReport extends Json {
  skipped?: string;
  saved: Record<string, number>;
  deleted: number;
  failed: number;
  pending: number;
  webhooks: number;
  errors: string[];
  lastSync?: string;
}

// Thrown when a run's time budget is spent. Everything saved so far is kept; the next run resumes.
class OutOfTime extends Error {}

class Run {
  saved: Record<string, number> = {};
  deleted = 0;
  failed = 0;
  errors: string[] = [];
  events: BeeEvent[] = [];
  touched = new Set<ItemType>();
  hardFailure = false;
  authFailure: BeeError | null = null;
  reconciled = false;
  constructor(public env: Env, public deadline: number, public tz: string) {}
  get outOfTime() {
    return Date.now() > this.deadline;
  }
  note(page: Json) {
    if (page.timezone) this.tz = page.timezone;
  }
  private lockedAt = Date.now();
  async save(type: ItemType, raw: Json, known?: Map<string, Known>) {
    if (this.outOfTime) throw new OutOfTime();
    if (Date.now() - this.lockedAt > LOCK_RENEW_MS) {
      this.lockedAt = Date.now();
      await setKv(this.env, "sync_lock", this.lockedAt + LOCK_MS);
    }
    const res = await ingest(this.env, type, raw, this.tz, { known });
    if (res.status === "same") return;
    this.saved[type] = (this.saved[type] || 0) + 1;
    this.touched.add(type);
    const event = eventFor(type, res.status, res.id, SPECS[type].state?.(raw), res.prev?.state);
    if (event) this.events.push(event);
  }
  fail(step: string, e: any) {
    if (e instanceof OutOfTime) return; // not a problem: the next run picks up where this one stopped
    if (e instanceof BeeError && e.authFailed) this.authFailure = e;
    this.errors.push(`${step}: ${e.message}`);
    console.error("sync step failed", step, e.message);
  }
}

async function due(env: Env, key: string, every: number): Promise<boolean> {
  const last = await getKv(env, key);
  return !last || Date.now() - Number(last) >= every;
}

async function enqueue(env: Env, rows: [ItemType, string][]): Promise<void> {
  for (let i = 0; i < rows.length; i += 50) {
    await env.DB.batch(rows.slice(i, i + 50).map(([t, id]) => env.DB.prepare(`INSERT INTO pending (type, id) VALUES (?, ?) ON CONFLICT (type, id) DO UPDATE SET next_try = 0`).bind(t, id)));
  }
}

async function readFeed(run: Run): Promise<void> {
  const { env } = run;
  const cursor = await getKv(env, "changes_cursor");
  let feed: Json;
  try {
    feed = await bee(env, `/v1/changes${qs({ cursor })}`);
  } catch (e) {
    if (e instanceof BeeError && e.body.includes("cursor_too_old")) {
      // Down for over a week: the feed can't catch us up, so the full check will.
      await env.DB.batch([env.DB.prepare(`DELETE FROM kv WHERE key = 'changes_cursor'`), env.DB.prepare(`DELETE FROM kv WHERE key = 'last_reconcile'`)]);
      return;
    }
    throw e;
  }
  run.note(feed);
  const rows: [ItemType, string][] = [];
  const unknown: string[] = [];
  for (const [key, ids] of Object.entries(feed)) {
    if (FEED_META.has(key) || !Array.isArray(ids) || !ids.length) continue;
    if (FEED_TYPES[key]) rows.push(...ids.map((id): [ItemType, string] => [FEED_TYPES[key], String(id)]));
    else unknown.push(key);
  }
  await enqueue(env, rows);
  const stmts = [kvStatement(env, "changes_cursor", feed.next_cursor)];
  if (unknown.length) stmts.push(kvStatement(env, "unhandled_feed_types", unknown.join(",")));
  await env.DB.batch(stmts);
}

// Nightly full comparison: catches anything the feed missed, and anything deleted.
async function reconcile(run: Run): Promise<void> {
  const { env } = run;
  for (const list of FULL_LISTS) {
    const known = await loadKnown(env, list.type);
    const seen = new Set<string>();
    const toFetch: [ItemType, string][] = [];
    let cutShort = false;
    await walk(env, list.path, list.key, async (rows, page) => {
      run.note(page);
      for (const row of rows) {
        const id = SPECS[list.type].id(row);
        seen.add(id);
        if (list.complete) await run.save(list.type, row, known);
        else if (known.get(id)?.sig !== (await signature(list.type, row))) toFetch.push([list.type, id]);
      }
      if (run.outOfTime) cutShort = true;
      return !cutShort;
    });
    if (cutShort) {
      // Out of time: keep what was found and pick the check up again next run.
      // The list wasn't fully seen, so nothing may be judged missing.
      await enqueue(env, toFetch);
      return;
    }
    for (const [id, k] of known) {
      if (seen.has(id) || k.deleted_at) continue;
      // Bee's list hides dismissed insights but can still return them by id.
      if (list.type === "insight") await tombstone(env, "insight", id);
      else toFetch.push([list.type, id]);
    }
    await enqueue(env, toFetch);
  }
  run.reconciled = true;
  await setKv(env, "last_reconcile", Date.now());
}

async function drain(run: Run): Promise<void> {
  const { env } = run;
  const { results } = await env.DB.prepare(`SELECT type, id, attempts FROM pending WHERE next_try <= ? ORDER BY next_try, attempts LIMIT ?`).bind(Date.now(), MAX_ITEMS_PER_RUN).all<{ type: ItemType; id: string; attempts: number }>();
  let unreachable = 0;
  for (const item of results) {
    if (run.outOfTime || unreachable >= 5) break;
    try {
      try {
        const raw = await fetchDetail(env, item.type, item.id);
        run.note(raw);
        await run.save(item.type, raw);
      } catch (e) {
        if (!(e instanceof BeeError && e.notFound)) throw e;
        await tombstone(env, item.type, item.id);
        run.deleted++;
        run.touched.add(item.type);
      }
      await env.DB.prepare(`DELETE FROM pending WHERE type = ? AND id = ?`).bind(item.type, item.id).run();
      unreachable = 0;
    } catch (e: any) {
      if (e instanceof OutOfTime) return;
      if (e instanceof BeeError && e.authFailed) throw e;
      if (e instanceof BeeError && e.unavailable) unreachable++;
      run.failed++;
      const wait = Math.min(MAX_BACKOFF_MS, 5 * 60_000 * 2 ** item.attempts);
      await env.DB.prepare(`UPDATE pending SET attempts = attempts + 1, next_try = ?, last_error = ? WHERE type = ? AND id = ?`).bind(Date.now() + wait, String(e.message).slice(0, 500), item.type, item.id).run();
      console.error("item failed", item.type, item.id, e.message);
    }
  }
}

async function fetchVisits(run: Run, from: string, to: string, known: Map<string, Known>): Promise<number> {
  const page = await bee(run.env, `/v1/locations/recent${qs({ from, to, limit: VISITS_PAGE })}`);
  const visits: Json[] = page.visits || [];
  if (visits.length >= VISITS_PAGE && from < to) {
    // A full page may have been cut off, so split the window.
    const span = Math.floor((Date.parse(to) - Date.parse(from)) / DAY_MS);
    const mid = addDays(from, Math.floor(span / 2));
    return (await fetchVisits(run, from, mid, known)) + (await fetchVisits(run, addDays(mid, 1), to, known));
  }
  for (const v of visits) await run.save("visit", v, known);
  return visits.length;
}

async function syncVisits(run: Run): Promise<void> {
  const { env } = run;
  const known = await loadKnown(env, "visit");
  const today = dateKey(Date.now(), run.tz);
  await fetchVisits(run, addDays(today, -3), today, known);
  // Walk history back in two-week steps until a long stretch comes back empty.
  if (await getKv(env, "visits_backfill_done")) return;
  let before = (await getKv(env, "visits_backfill_before")) || addDays(today, -4);
  let empty = Number((await getKv(env, "visits_backfill_empty")) || 0);
  for (let i = 0; i < 6 && !run.outOfTime && empty < 6; i++) {
    const found = await fetchVisits(run, addDays(before, -13), before, known);
    empty = found ? 0 : empty + 1;
    before = addDays(before, -14);
  }
  await env.DB.batch([kvStatement(env, "visits_backfill_before", before), kvStatement(env, "visits_backfill_empty", empty), ...(empty >= 6 ? [kvStatement(env, "visits_backfill_done", 1)] : [])]);
}

async function syncSuggestions(run: Run): Promise<void> {
  const page = await bee(run.env, "/v1/todoSuggestions");
  const known = await loadKnown(run.env, "suggestion");
  const seen = new Set<string>();
  for (const s of page.todoSuggestions || []) {
    seen.add(String(s.id));
    await run.save("suggestion", s, known);
  }
  for (const [id, k] of known) if (!seen.has(id) && !k.deleted_at) await tombstone(run.env, "suggestion", id);
}

async function syncBrief(run: Run): Promise<void> {
  const page = await bee(run.env, "/v1/todayBrief");
  run.note(page);
  await run.save("brief", { ...page, date: dateKey(Date.now(), run.tz) });
}

async function syncPhotos(run: Run): Promise<void> {
  const { env } = run;
  const known = await loadKnown(env, "photo");
  let fetched = 0;
  await walk(env, "/v1/photos", "photos", async (rows) => {
    let fresh = 0;
    for (const p of rows) {
      const id = String(p.id);
      if (known.has(id)) {
        await run.save("photo", p, known);
        continue;
      }
      fresh++;
      if (fetched >= MAX_PHOTOS_PER_RUN || run.outOfTime) return false;
      try {
        const res = await beeResponse(env, `/v1/photos/${encodeURIComponent(id)}`);
        await env.ARCHIVE.put(`files/photos/${id}`, await res.arrayBuffer(), { httpMetadata: { contentType: res.headers.get("content-type") || "application/octet-stream" } });
        await run.save("photo", p, known);
        fetched++;
      } catch (e: any) {
        if (e instanceof OutOfTime || (e instanceof BeeError && e.authFailed)) throw e;
        run.failed++;
        console.error("photo failed", id, e.message);
      }
    }
    return fresh > 0; // a page with nothing new means everything older is already here
  });
}

async function syncPlaces(run: Run): Promise<void> {
  const page = await bee(run.env, `/v1/locations/clusters${qs({ limit: 100, min_visits: 1, include_visits: "false" })}`);
  const known = await loadKnown(run.env, "place");
  for (const p of page.clusters || []) await run.save("place", p, known);
}

async function syncExternal(run: Run): Promise<void> {
  const known = await loadKnown(run.env, "external");
  await walk(run.env, "/v1/external-access", "external_access", async (rows) => {
    for (const e of rows) await run.save("external", e, known);
    return !run.outOfTime;
  });
}

async function syncProfile(run: Run): Promise<void> {
  const page = await bee(run.env, "/v1/me");
  run.note(page);
  if (page.first_name) await setKv(run.env, "owner_name", page.first_name);
  await run.save("profile", page);
}

// Threads are test-users-only today. Checked daily so they start saving if that changes.
async function syncThreads(run: Run): Promise<void> {
  const { env } = run;
  let page: Json;
  try {
    page = await bee(env, "/v1/threads");
  } catch (e) {
    if (e instanceof BeeError && (e.status === 403 || e.status === 404)) {
      await setKv(env, "threads_access", "no");
      return;
    }
    throw e;
  }
  await setKv(env, "threads_access", "yes");
  const known = await loadKnown(env, "thread");
  for (const t of page.threads || []) {
    const id = SPECS.thread.id(t);
    if (known.get(id)?.sig === String(t.updated_at) || run.outOfTime) continue;
    const messages = await bee(env, `/v1/threads/${encodeURIComponent(id)}/messages`);
    await run.save("thread", { ...t, messages: messages.messages || [] }, known);
  }
}

const HOURLY: [string, (run: Run) => Promise<void>][] = [
  ["visits", syncVisits],
  ["suggestions", syncSuggestions],
  ["brief", syncBrief],
  ["photos", syncPhotos],
];
const DAILY: [string, (run: Run) => Promise<void>][] = [
  ["places", syncPlaces],
  ["external", syncExternal],
  ["profile", syncProfile],
  ["threads", syncThreads],
];

async function runExtras(run: Run, steps: typeof HOURLY, every: number): Promise<void> {
  for (const [name, step] of steps) {
    if (run.outOfTime || run.authFailure) return;
    const key = `last_${name}`;
    if (!(await due(run.env, key, every))) continue;
    try {
      await step(run);
      if (run.outOfTime) return; // may be unfinished: leave it due so the next run continues
      await setKv(run.env, key, Date.now());
    } catch (e) {
      run.fail(name, e);
    }
  }
}

async function evaluateHealth(run: Run, webhookFailures: number): Promise<void> {
  const { env } = run;
  const failures = run.hardFailure ? Number((await getKv(env, "sync_failures")) || 0) + 1 : 0;
  const stmts = [kvStatement(env, "sync_failures", failures), kvStatement(env, "timezone", run.tz)];
  if (!run.hardFailure) stmts.push(kvStatement(env, "last_sync", new Date().toISOString()));
  // Only what the wearable itself produces counts; calendar briefs change all day on their own.
  if (WEARABLE_TYPES.some((t) => run.saved[t]) || !(await getKv(env, "last_new_at"))) stmts.push(kvStatement(env, "last_new_at", Date.now()));
  if (run.errors.length) stmts.push(kvStatement(env, "last_error", `${new Date().toISOString()} ${run.errors[0]}`));
  else if (!run.failed) stmts.push(env.DB.prepare(`DELETE FROM kv WHERE key = 'last_error'`));
  await env.DB.batch(stmts);

  if (run.authFailure) await raise(env, "bee-auth", "Bee key stopped working", `Bee rejected the saved key (${run.authFailure.status}). Nothing new is being archived until it's replaced. Old data is safe.`);
  else await clear(env, "bee-auth", "Bee accepted the key again. Syncing has resumed.");

  if (failures >= 3) await raise(env, "sync-failing", "sync failing", `${failures} syncs in a row have failed. Latest: ${run.errors[0] || "unknown"}`);
  else if (!failures) await clear(env, "sync-failing", "Syncing is working again.");

  const stuck = await env.DB.prepare(`SELECT COUNT(*) AS n, MIN(last_error) AS sample FROM pending WHERE attempts >= ?`).bind(STUCK_ATTEMPTS).first<{ n: number; sample: string }>();
  if (stuck?.n) await raise(env, "stuck-items", "items not saving", `${stuck.n} item(s) keep failing. Everything else is still syncing. Latest: ${stuck.sample}`);
  else await clear(env, "stuck-items", "The items that kept failing have saved.");

  const lastNew = Number((await getKv(env, "last_new_at")) || 0);
  if (lastNew && Date.now() - lastNew > DAY_MS) await raise(env, "no-new-data", "nothing new in 24 hours", "Bee hasn't produced anything new in a day. If you've been wearing it, check the device.");
  else if (lastNew) await clear(env, "no-new-data", "New Bee data is arriving again.");

  if (webhookFailures) await raise(env, "webhook-failing", "webhook gave up", `${webhookFailures} delivery attempt(s) failed for good after a day of retries.`);
}

export async function runSync(env: Env, budgetMs: number): Promise<SyncReport> {
  if (!(await beeToken(env))) return { skipped: "Bee isn't connected yet", saved: {}, deleted: 0, failed: 0, pending: 0, webhooks: 0, errors: [] };
  const lock = await env.DB.prepare(`INSERT INTO kv (key, value) VALUES ('sync_lock', ?1) ON CONFLICT (key) DO UPDATE SET value = ?1 WHERE CAST(kv.value AS INTEGER) < ?2`)
    .bind(String(Date.now() + LOCK_MS), Date.now())
    .run();
  if (!lock.meta.changes) return { skipped: "a sync is already running", saved: {}, deleted: 0, failed: 0, pending: 0, webhooks: 0, errors: [] };

  const run = new Run(env, Date.now() + budgetMs, await getTz(env));
  try {
    try {
      await readFeed(run);
    } catch (e) {
      run.hardFailure = true;
      run.fail("change feed", e);
    }
    if (!run.authFailure && (await due(env, "last_reconcile", DAY_MS))) {
      try {
        await reconcile(run);
      } catch (e) {
        run.fail("full check", e);
      }
    }
    if (!run.authFailure) {
      try {
        await drain(run);
      } catch (e) {
        run.hardFailure = true;
        run.fail("queue", e);
      }
    }
    await runExtras(run, HOURLY, HOUR_MS);
    await runExtras(run, DAILY, DAY_MS);
    await writeSnapshots(env, run.touched, run.tz);

    // Nothing is announced until the first full archive exists, or every old item would fire.
    const pendingNow = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM pending`).first<number>("n")) ?? 0;
    if (await getKv(env, "webhooks_armed")) await queueEvents(env, run.events);
    else if (!pendingNow && (run.reconciled || (await getKv(env, "last_reconcile")))) await setKv(env, "webhooks_armed", 1);
    const webhooks = await deliverDue(env);
    await evaluateHealth(run, webhooks.failed);
    return { saved: run.saved, deleted: run.deleted, failed: run.failed, pending: pendingNow, webhooks: webhooks.delivered, errors: run.errors, lastSync: new Date().toISOString() };
  } finally {
    await env.DB.prepare(`DELETE FROM kv WHERE key = 'sync_lock'`).run();
  }
}

// Recovery: rebuild the D1 index from R2 alone, no Bee calls. Resumable.
export async function rebuildIndex(env: Env, budgetMs: number, startAfter?: string): Promise<{ indexed: number; done: boolean; cursor: string | null }> {
  const deadline = Date.now() + budgetMs;
  const tz = await getTz(env);
  let indexed = 0;
  let cursor: string | undefined;
  let after = startAfter;
  do {
    const page = await env.ARCHIVE.list({ prefix: "raw/", cursor, startAfter: cursor ? undefined : after, limit: 100 });
    for (const o of page.objects) {
      if (Date.now() > deadline) return { indexed, done: false, cursor: after ?? null };
      const type = TYPE_BY_DIR[o.key.split("/")[1]];
      const body = type ? await env.ARCHIVE.get(o.key) : null;
      if (body) {
        await ingest(env, type, await body.json<Json>(), tz, { indexOnly: true });
        indexed++;
      }
      after = o.key;
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  await writeSnapshots(env, ["fact", "todo"], tz);
  return { indexed, done: true, cursor: null };
}
