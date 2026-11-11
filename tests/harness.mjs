// Runs the real Worker in Cloudflare's local runtime with real D1 and R2.
// Bee, Pushbullet and webhook receivers are fakes behind the Worker's outbound fetch.
import { build } from "esbuild";
import { Miniflare, Response as MfResponse } from "miniflare";
import nacl from "tweetnacl";

const { outputFiles } = await build({ entryPoints: [new URL("../src/index.ts", import.meta.url).pathname], bundle: true, format: "esm", write: false, target: "esnext" });
const script = outputFiles[0].text;

export const conv = (id, over = {}) => ({
  id,
  start_time: Date.parse("2026-10-20T15:00:00Z") + id * 1000,
  end_time: Date.parse("2026-10-20T15:30:00Z") + id * 1000,
  device_type: "bee",
  short_summary: `Conversation number ${id}`,
  summary: `Summary of talk ${id} about general topics`,
  state: "COMPLETED",
  created_at: 1,
  updated_at: 100,
  primary_location: { address: "100 Main St, Austin" },
  suggested_links: [],
  transcriptions: [{ utterances: [{ speaker: "Unknown", text: `spoken words in talk ${id}`, spoken_at: Date.parse("2026-10-20T15:01:00Z") }] }],
  ...over,
});
export const fact = (id, over = {}) => ({ id, text: `fact ${id}`, tags: ["general"], created_at: 1000 + id, confirmed: true, ...over });
export const todo = (id, over = {}) => ({ id, text: `todo ${id}`, alarm_at: null, completed: false, created_at: 1000 + id, corrections: [], ...over });
export const insight = (id, over = {}) => ({ id, title: `insight ${id}`, description: "desc", suggested_actions: ["act"], generated_at: Date.parse("2026-10-20T16:00:00Z"), timezone: "America/New_York", corrections: [], ...over });
export const journal = (id, over = {}) => ({ id, text: `voice note ${id} about the harbor`, state: "COMPLETED", created_at: Date.parse("2026-10-20T17:00:00Z"), updated_at: 5, corrections: [], ...over });
export const daily = (id, over = {}) => ({
  id,
  date_time: Date.parse("2026-10-20T12:00:00Z"),
  short_summary: `Recap ${id}`,
  summary: `What happened on day ${id}`,
  email_summary: "emails",
  calendar_summary: "calendar",
  account_summaries: {},
  locations: [],
  photos: [],
  created_at: 7,
  corrections: [],
  ...over,
});
export const visit = (id, over = {}) => ({ visit_id: id, start_at: Date.parse("2026-10-20T18:00:00Z"), end_at: Date.parse("2026-10-20T19:00:00Z"), duration_ms: 3_600_000, latitude: 25.7, longitude: -80.1, sample_count: 3, address: "Riverside Park, Austin", source_device_ids: [], ...over });

export function makeBee() {
  const state = {
    conversations: [],
    dailies: [],
    facts: [],
    todos: [],
    insights: [],
    journals: [],
    visits: [],
    clusters: [{ cluster_id: "c1", latitude: 25, longitude: -80, representative_address: "Home, Austin", visit_count: 9, sample_count: 9, total_dwell_ms: 600000, first_visit_at: 1, last_visit_at: Date.parse("2026-10-20T00:00:00Z") }],
    suggestions: [],
    photos: [],
    photoBytes: new Uint8Array([1, 2, 3, 4]),
    external: [],
    me: { id: 1, first_name: "Alex", last_name: "R", timezone: "America/New_York" },
    threads: null,
    feed: {},
    failDetail: new Map(), // "/v1/conversations/5" -> status
    failAll: 0,
    cursorTooOld: false,
    pairing: { approved: false, expired: false, token: "paired-token", requests: 0 },
    onlyToken: null, // when set, the fake Bee rejects every other key
    calls: [],
    pushes: [],
    hooks: [],
    hookStatus: 200,
    nextId: 90000,
  };
  const json = (body, status = 200) => new MfResponse(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const list = (url, key, rows) => {
    const limit = Number(url.searchParams.get("limit") || 50);
    const start = Number(url.searchParams.get("cursor") || 0);
    const next = start + limit < rows.length ? String(start + limit) : null;
    return json({ [key]: rows.slice(start, start + limit), next_cursor: next, timezone: "America/New_York" });
  };
  state.handle = async (req) => {
    const url = new URL(req.url);
    if (url.host === "api.pushbullet.com") {
      state.pushes.push(await req.json());
      return json({});
    }
    if (url.host === "auth.beeai-services.com") {
      // Bee's sign-in service: pending until `pairing.approved`, then the token encrypted to the caller's key.
      const { publicKey } = await req.json();
      state.pairing.requests++;
      if (state.pairing.expired) return json({ ok: true, status: "expired", requestId: "req1" });
      if (!state.pairing.approved) return json({ ok: true, status: "pending", requestId: "req1", expiresAt: new Date(Date.now() + 300000).toISOString() });
      const eph = nacl.box.keyPair();
      const nonce = nacl.randomBytes(24);
      const cipher = nacl.box(new TextEncoder().encode(state.pairing.token), nonce, Buffer.from(publicKey, "base64"), eph.secretKey);
      const packed = Buffer.concat([Buffer.from([1]), nonce, eph.publicKey, cipher]);
      return json({ ok: true, status: "completed", requestId: "req1", result: { encryptedToken: packed.toString("base64") } });
    }
    if (url.host === "hook.test") {
      state.hooks.push({ body: await req.json(), headers: Object.fromEntries(req.headers) });
      return new MfResponse("ok", { status: state.hookStatus });
    }
    const p = url.pathname;
    state.calls.push(`${req.method} ${p}`);
    state.lastAuth = req.headers.get("authorization");
    if (state.onlyToken && state.lastAuth !== `Bearer ${state.onlyToken}`) return json({ error: "unauthorized" }, 401);
    if (state.failAll) return json({ error: "nope" }, state.failAll);
    if (state.failDetail.has(p)) return json({ error: "broken" }, state.failDetail.get(p));
    const byId = (rows, id) => rows.find((r) => String(r.id) === id);
    let m;
    if (p === "/v1/changes") {
      if (state.cursorTooOld) return json({ error: "cursor_too_old" }, 400);
      const feed = state.feed;
      state.feed = {};
      return json({ facts: [], todos: [], dailies: [], conversations: [], journals: [], insights: [], ...feed, next_cursor: `v1-${Date.now()}`, since: 0, until: 1, updated: true, timezone: "America/New_York" });
    }
    if (p === "/v1/conversations") return list(url, "conversations", state.conversations.map(({ transcriptions, suggested_links, ...c }) => ({ ...c, utterances_count: 1 })));
    if ((m = p.match(/^\/v1\/conversations\/(\d+)$/))) {
      const c = byId(state.conversations, m[1]);
      return c ? json({ conversation: c, timezone: "America/New_York" }) : json({ error: "Conversation not found" }, 404);
    }
    if (p === "/v1/daily") return list(url, "daily_summaries", state.dailies.map(({ conversations, soundtrack, date, ...d }) => ({ ...d, conversations_count: 2 })));
    if ((m = p.match(/^\/v1\/daily\/(\d+)$/))) {
      const d = byId(state.dailies, m[1]);
      return d ? json({ daily_summary: { ...d, conversations: [], soundtrack: null, date: "x" }, timezone: "America/New_York" }) : json({ error: "not found" }, 404);
    }
    for (const [path, key, rows] of [["facts", "facts", state.facts], ["todos", "todos", state.todos], ["insights", "insights", state.insights], ["journals", "journals", state.journals]]) {
      if (p === `/v1/${path}` && req.method === "GET") return list(url, key, rows);
      if (p === `/v1/${path}` && req.method === "POST") {
        const body = await req.json();
        const made = path === "facts" ? fact(++state.nextId, { text: body.text, confirmed: false }) : todo(++state.nextId, { text: body.text });
        rows.unshift(made);
        return json(made);
      }
      if ((m = p.match(new RegExp(`^/v1/${path}/([^/]+)$`)))) {
        const i = rows.findIndex((r) => String(r.id) === m[1]);
        if (i < 0) return json({ message: "not found" }, 404);
        if (req.method === "DELETE") {
          rows.splice(i, 1);
          return json({ success: true });
        }
        if (req.method === "PUT") {
          rows[i] = { ...rows[i], ...(await req.json()) };
          return json(rows[i]);
        }
        return json({ ...rows[i], timezone: "America/New_York" });
      }
    }
    if (p === "/v1/locations/recent") {
      const from = url.searchParams.get("from");
      const to = url.searchParams.get("to");
      const inRange = state.visits.filter((v) => {
        const d = new Date(v.start_at).toISOString().slice(0, 10);
        return (!from || d >= from) && (!to || d <= to);
      });
      return json({ visits: inRange.slice(0, Number(url.searchParams.get("limit") || 20)), timezone: "America/New_York" });
    }
    if (p === "/v1/locations/clusters") return json({ clusters: state.clusters, timezone: "America/New_York" });
    if (p === "/v1/todoSuggestions") return json({ todoSuggestions: state.suggestions, timezone: "America/New_York" });
    if ((m = p.match(/^\/v1\/todoSuggestions\/(\d+)\/(accept|dismiss)$/))) {
      state.suggestions = state.suggestions.filter((s) => String(s.id) !== m[1]);
      if (m[2] === "accept") {
        const made = todo(++state.nextId, { text: "accepted" });
        state.todos.unshift(made);
        return json(made);
      }
      return json({ success: true });
    }
    if (p === "/v1/todayBrief") return json({ calendar_events: [{ id: 1, summary: "Standup", start_time: "2026-10-20T15:00:00Z", end_time: "2026-10-20T15:30:00Z", is_all_day: false }], emails: [{ id: 1, from: "a@b.c", subject: "Hello", snippet: "hi", concise_summary: null }], timezone: "America/New_York" });
    if (p === "/v1/photos") return list(url, "photos", state.photos);
    if ((m = p.match(/^\/v1\/photos\/(.+)$/))) return new MfResponse(state.photoBytes, { headers: { "Content-Type": "image/jpeg" } });
    if (p === "/v1/external-access") return list(url, "external_access", state.external);
    if (p === "/v1/me") return json(state.me);
    if (p === "/v1/threads") return state.threads ? json({ threads: state.threads }) : json({ error: "test_user_required" }, 403);
    if ((m = p.match(/^\/v1\/threads\/(.+)\/messages$/))) return json({ messages: [{ id: "m1", text: "thread words here" }] });
    if (p === "/v1/search/conversations/neural") return json({ results: [{ id: 1, short_summary: "neural hit", summary: "s", score: 0.9 }] });
    return json({ error: `fake bee has no route for ${p}` }, 404);
  };
  return state;
}

// `bindings` overrides the defaults; pass a value of undefined to leave a secret unset.
export async function start(beeState = makeBee(), bindings = {}) {
  const all = { BEE_API: "https://bee.test", BEE_TOKEN: "bee-token", ADMIN_TOKEN: "admin-key", PUSHBULLET_TOKEN: "pb-token", ...bindings };
  for (const k of Object.keys(all)) if (all[k] === undefined) delete all[k];
  const mf = new Miniflare({
    workers: [
      {
        name: "beecloud",
        modules: true,
        script,
        compatibilityDate: "2026-08-01",
        r2Buckets: ["ARCHIVE"],
        d1Databases: ["DB"],
        bindings: all,
        outboundService: (req) => beeState.handle(req),
      },
    ],
  });
  const url = await mf.ready;
  const db = await mf.getD1Database("DB");
  const r2 = await mf.getR2Bucket("ARCHIVE");
  const api = (path, { key = "admin-key", method = "GET", body, headers = {} } = {}) =>
    mf.dispatchFetch(`http://x${path}`, { method, headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const tool = async (name, args = {}, key = "admin-key") => {
    const res = await api(`/api/tools/${name}`, { method: "POST", body: args, key });
    return { status: res.status, text: await res.text() };
  };
  const mcp = async (method, params = {}, key = "admin-key") => (await api("/mcp", { method: "POST", key, body: { jsonrpc: "2.0", id: 1, method, params } })).json();
  const sync = async () => (await api("/api/sync", { method: "POST" })).json();
  // Make the next sync run every "due" step, as if a day had passed.
  const forceDue = () => db.prepare(`DELETE FROM kv WHERE key LIKE 'last_%' AND key NOT IN ('last_sync','last_error','last_new_at')`).run();
  const retryNow = () => db.prepare(`UPDATE pending SET next_try = 0`).run();
  const readR2 = async (key) => (await (await r2.get(key))?.text()) ?? null;
  return { mf, db, r2, bee: beeState, api, tool, mcp, sync, forceDue, retryNow, readR2, stop: () => mf.dispose() };
}
