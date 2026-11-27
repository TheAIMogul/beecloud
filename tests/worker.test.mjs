import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { conv, daily, fact, insight, journal, makeBee, start, todo, visit } from "./harness.mjs";

const ORIGINAL_TOOLS = ["search_conversations", "list_conversations", "get_conversation", "list_daily_summaries", "list_insights", "list_todos", "list_facts", "list_archive", "read_archive", "sync_now"];

function withWorker(fn) {
  return async () => {
    const w = await start(makeBee());
    try {
      await fn(w);
    } finally {
      await w.stop();
    }
  };
}

function seed(bee) {
  bee.conversations = [conv(1), conv(2), conv(3)];
  bee.dailies = [daily(10)];
  bee.facts = [fact(20), fact(21, { confirmed: false })];
  bee.todos = [todo(30)];
  bee.insights = [insight(40)];
  bee.journals = [journal("j1")];
  bee.visits = [visit("v1")];
  bee.suggestions = [{ id: 50, text: "suggested", emoji: "x", details: "d", alarm_at: null, created_at: 1 }];
  bee.external = [{ id: "e1", uses_connected_account: false, service: "Svc", type: "t", description: "read", summary: "s", created_at: 1, updated_at: 1 }];
}

describe("keys", () => {
  test("no key is refused, and a key inside a link is refused", withWorker(async (w) => {
    assert.equal((await w.api("/api/status", { key: null })).status, 401);
    assert.equal((await w.api("/api/status?token=admin-key", { key: null })).status, 401);
    assert.equal((await w.api("/api/status", { key: "wrong" })).status, 401);
    assert.equal((await w.api("/health", { key: null })).status, 200);
  }));

  test("an agent key sees the agent tools and never the admin ones", withWorker(async (w) => {
    const agent = (await w.tool("create_key", { name: "agent" })).text;
    const r = await w.mcp("tools/list", {}, agent);
    const names = r.result.tools.map((t) => t.name);
    for (const t of ORIGINAL_TOOLS) assert.ok(names.includes(t), t);
    assert.ok(!names.includes("create_key"), "admin tools are hidden from agents");
  }));

  test("agent keys work, are limited by scope, and can be revoked alone", withWorker(async (w) => {
    const alpha = (await w.tool("create_key", { name: "alpha" })).text;
    const beta = (await w.tool("create_key", { name: "beta", scope: "read" })).text;
    assert.equal((await w.api("/api/status", { key: alpha })).status, 200);
    assert.equal((await w.tool("create_todo", { text: "x" }, beta)).status, 403, "read keys can't write");
    assert.equal((await w.tool("create_key", { name: "evil" }, alpha)).status, 403, "agents can't make keys");
    assert.ok(!(await w.tool("list_keys")).text.includes(alpha), "keys are never shown again");
    await w.tool("revoke_key", { name: "alpha" });
    assert.equal((await w.api("/api/status", { key: alpha })).status, 401);
    assert.equal((await w.api("/api/status", { key: beta })).status, 200);
  }));
});

describe("mcp", () => {
  test("handshake, tool call and bad calls", withWorker(async (w) => {
    const init = await w.mcp("initialize", { protocolVersion: "2025-06-18" });
    assert.equal(init.result.protocolVersion, "2025-06-18");
    assert.equal(init.result.serverInfo.name, "beecloud");
    const bad = await w.mcp("tools/call", { name: "get_conversation", arguments: { id: "abc" } });
    assert.equal(bad.result.isError, true);
    assert.equal((await w.mcp("nope")).error.code, -32601);
  }));
});

describe("sync", () => {
  test("first run archives every data type, in Bee's original format", withWorker(async (w) => {
    seed(w.bee);
    const report = await w.sync();
    assert.deepEqual(report.errors, []);
    for (const key of ["raw/conversations/1.json", "raw/daily/10.json", "raw/facts/20.json", "raw/todos/30.json", "raw/insights/40.json", "raw/journals/j1.json", "raw/visits/v1.json", "raw/places/c1.json", "raw/todo-suggestions/50.json", "raw/external-access/e1.json", "raw/profile/me.json", "md/conversations/2026-10-20/1.md", "md/daily/2026-10-20.md", "md/insights/2026-10-20/40.md", "md/journals/2026-10-20/j1.md", "md/facts.md", "md/todos.md"]) {
      assert.ok(await w.readR2(key), `missing ${key}`);
    }
    assert.ok(JSON.parse(await w.readR2("raw/daily/10.json")).account_summaries, "recaps keep the fields markdown drops");
    const status = await (await w.api("/api/status")).json();
    assert.equal(status.archived.conversations, 3);
    assert.equal(status.backfillDone, true);
    assert.equal(status.threadsAccess, "no");
    assert.equal(status.pending, 0);
  }));

  test("a later run with no changes writes nothing and calls Bee once", withWorker(async (w) => {
    seed(w.bee);
    await w.sync();
    w.bee.calls.length = 0;
    const report = await w.sync();
    assert.deepEqual(report.saved, {});
    assert.deepEqual(w.bee.calls, ["GET /v1/changes"]);
  }));

  test("one broken conversation doesn't block anything else, and retries until it saves", withWorker(async (w) => {
    seed(w.bee);
    w.bee.failDetail.set("/v1/conversations/2", 400);
    const first = await w.sync();
    assert.equal(first.failed, 1);
    assert.equal(first.pending, 1);
    assert.ok(await w.readR2("raw/conversations/1.json"));
    assert.ok(await w.readR2("raw/conversations/3.json"));
    assert.ok(await w.readR2("md/facts.md"), "everything else still saved");
    assert.equal(await w.readR2("raw/conversations/2.json"), null);

    w.bee.failDetail.clear();
    await w.retryNow();
    const second = await w.sync();
    assert.equal(second.pending, 0);
    assert.ok(await w.readR2("raw/conversations/2.json"));
  }));

  test("more than 100 facts and todos are all kept", withWorker(async (w) => {
    w.bee.facts = Array.from({ length: 130 }, (_, i) => fact(i + 1));
    w.bee.todos = Array.from({ length: 120 }, (_, i) => todo(i + 1));
    await w.sync();
    const facts = await w.readR2("md/facts.md");
    assert.equal(facts.split("\n").filter((l) => l.startsWith("- ")).length, 130);
    assert.equal((await w.readR2("md/todos.md")).split("\n").filter((l) => l.startsWith("- ")).length, 120);
    assert.ok((await w.tool("list_facts")).text.includes("fact 1 "));
    assert.ok(await w.readR2("raw/facts/130.json"));
  }));

  test("edits are picked up from the feed and earlier versions are kept", withWorker(async (w) => {
    seed(w.bee);
    await w.sync();
    w.bee.insights[0] = { ...w.bee.insights[0], title: "edited insight" };
    w.bee.dailies[0] = { ...w.bee.dailies[0], summary: "edited recap" };
    w.bee.facts[0] = { ...w.bee.facts[0], text: "edited fact" };
    w.bee.feed = { insights: [40], dailies: [10], facts: [20] };
    const report = await w.sync();
    assert.deepEqual(report.saved, { insight: 1, daily: 1, fact: 1 });
    assert.ok((await w.readR2("md/insights/2026-10-20/40.md")).includes("edited insight"));
    assert.ok((await w.readR2("md/daily/2026-10-20.md")).includes("edited recap"));
    assert.ok((await w.readR2("md/facts.md")).includes("edited fact"));
    for (const dir of ["insights/40", "daily/10", "facts/20"]) {
      const { objects } = await w.r2.list({ prefix: `history/${dir}/` });
      assert.equal(objects.length, 1, dir);
    }
    assert.ok((await (await w.r2.get((await w.r2.list({ prefix: "history/facts/20/" })).objects[0].key)).text()).includes("fact 20"));
  }));

  test("the nightly check catches changes the feed missed", withWorker(async (w) => {
    seed(w.bee);
    await w.sync();
    w.bee.conversations[0] = { ...w.bee.conversations[0], short_summary: "quietly edited", updated_at: 200 };
    w.bee.facts[1] = { ...w.bee.facts[1], text: "quietly edited fact" };
    await w.sync();
    assert.ok(!(await w.readR2("raw/conversations/1.json")).includes("quietly edited"), "not yet");
    await w.forceDue();
    await w.sync();
    assert.ok((await w.readR2("raw/conversations/1.json")).includes("quietly edited"));
    assert.ok((await w.readR2("raw/facts/21.json")).includes("quietly edited fact"));
  }));

  test("an expired feed cursor triggers a full check", withWorker(async (w) => {
    seed(w.bee);
    await w.sync();
    w.bee.conversations.push(conv(4));
    w.bee.cursorTooOld = true;
    const report = await w.sync();
    assert.equal(report.saved.conversation, 1, "the full check runs in the same sync");
    assert.ok(await w.readR2("raw/conversations/4.json"));
    w.bee.cursorTooOld = false;
    assert.deepEqual((await w.sync()).errors, []);
  }));

  test("items deleted from Bee stay readable in the archive", withWorker(async (w) => {
    seed(w.bee);
    await w.sync();
    w.bee.conversations = w.bee.conversations.filter((c) => c.id !== 1);
    w.bee.feed = { conversations: [1] };
    const report = await w.sync();
    assert.equal(report.deleted, 1);
    assert.ok(!(await w.tool("list_conversations")).text.includes("Conversation number 1"));
    assert.ok((await w.tool("list_conversations", { include_removed: true })).text.includes("removed from Bee"));
    assert.ok((await w.tool("search_conversations", { query: "talk 1", include_removed: true })).text.includes("Conversation number 1"));
    const got = await w.tool("get_conversation", { id: "1" });
    assert.equal(got.status, 200);
    assert.ok(got.text.includes("Deleted from Bee"));
    assert.ok(got.text.includes("spoken words in talk 1"));
  }));

  test("photos are saved as image files", withWorker(async (w) => {
    w.bee.photos = [{ id: 11, captured_at: Date.parse("2026-10-20T20:00:00Z"), conversation_id: null }];
    await w.sync();
    const res = await w.api("/api/photos/11");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/jpeg");
    assert.deepEqual([...new Uint8Array(await res.arrayBuffer())], [1, 2, 3, 4]);
    const image = await w.mcp("tools/call", { name: "get_photo", arguments: { id: "11" } });
    assert.equal(image.result.content[0].type, "image");
    w.bee.calls.length = 0;
    await w.forceDue();
    await w.sync();
    assert.ok(!w.bee.calls.includes("GET /v1/photos/11"), "not downloaded twice");
  }));

  test("threads save automatically if the account ever gets access", withWorker(async (w) => {
    await w.sync();
    assert.equal((await (await w.api("/api/status")).json()).threadsAccess, "no");
    w.bee.threads = [{ thread_id: "t1", name: "Trip", state: "idle", created_at: 1, updated_at: 2 }];
    await w.forceDue();
    await w.sync();
    assert.equal((await (await w.api("/api/status")).json()).threadsAccess, "yes");
    assert.ok((await w.readR2("raw/threads/t1.json")).includes("thread words here"));
  }));

  test("two syncs at once don't collide", withWorker(async (w) => {
    await w.db.prepare(`INSERT INTO kv (key, value) VALUES ('schema_version', '0')`).run().catch(() => {});
    await w.sync();
    await w.db.prepare(`INSERT INTO kv (key, value) VALUES ('sync_lock', ?)`).bind(String(Date.now() + 60000)).run();
    assert.ok((await w.sync()).skipped);
  }));

  test("the 15-minute schedule runs a sync", withWorker(async (w) => {
    seed(w.bee);
    const worker = await w.mf.getWorker();
    await worker.scheduled({ cron: "*/15 * * * *" });
    for (let i = 0; i < 50 && !(await w.readR2("md/facts.md")); i++) await new Promise((r) => setTimeout(r, 100));
    assert.ok(await w.readR2("md/facts.md"));
  }));
});

describe("independent of Bee", () => {
  test("search, lists, todos, facts and get_day all work with Bee down", withWorker(async (w) => {
    seed(w.bee);
    await w.sync();
    w.bee.failAll = 503;
    for (const [name, args, expected] of [
      ["search_conversations", { query: "spoken talk" }, "Conversation number"],
      ["search_all", { query: "harbor" }, "[journal]"],
      ["list_conversations", {}, "Conversation number 3"],
      ["get_conversation", { id: "2" }, "spoken words in talk 2"],
      ["list_daily_summaries", {}, "What happened on day 10"],
      ["list_insights", {}, "insight 40"],
      ["list_todos", {}, "todo 30"],
      ["list_facts", {}, "fact 20"],
      ["list_voice_notes", {}, "harbor"],
      ["get_voice_note", { id: "j1" }, "harbor"],
      ["list_visits", {}, "Riverside"],
      ["list_places", {}, "Home, Austin"],
      ["list_todo_suggestions", {}, "suggested"],
      ["get_day", { date: "2026-10-20" }, "What happened on day 10"],
      ["get_status", {}, "lastSync"],
    ]) {
      const r = await w.tool(name, args);
      assert.equal(r.status, 200, `${name}: ${r.text}`);
      assert.ok(r.text.includes(expected), `${name}: ${r.text}`);
    }
    const neural = await w.tool("search_conversations", { query: "spoken", mode: "neural" });
    assert.ok(neural.text.includes("keyword matches from the archive"));
    assert.ok(neural.text.includes("Conversation number"));
  }));

  test("get_day brings a date together", withWorker(async (w) => {
    seed(w.bee);
    await w.sync();
    const { text } = await w.tool("get_day", { date: "2026-10-20" });
    for (const section of ["## Recap", "## Conversations", "## Voice notes", "## Insights", "## Places visited"]) assert.ok(text.includes(section), section);
    assert.ok(text.includes("Riverside"));
    assert.ok((await (await w.api("/api/day/2026-10-20")).text()).includes("## Recap"));
    assert.equal((await w.tool("get_day", { date: "nope" })).status, 400);
  }));

  test("the index rebuilds from the archive alone", withWorker(async (w) => {
    seed(w.bee);
    await w.sync();
    await w.db.batch([w.db.prepare("DELETE FROM items"), w.db.prepare("DELETE FROM items_fts")]);
    w.bee.failAll = 503;
    w.bee.calls.length = 0;
    const r = JSON.parse((await w.tool("rebuild_index")).text);
    assert.equal(r.done, true);
    assert.ok(r.indexed >= 10);
    assert.deepEqual(w.bee.calls, []);
    assert.ok((await w.tool("search_conversations", { query: "spoken" })).text.includes("Conversation number"));
  }));
});

describe("filters", () => {
  test("date, place, length and paging", withWorker(async (w) => {
    w.bee.conversations = [
      conv(1, { start_time: Date.parse("2026-10-01T15:00:00Z"), end_time: Date.parse("2026-10-01T15:05:00Z"), primary_location: { address: "Denver" } }),
      conv(2, { start_time: Date.parse("2026-10-10T15:00:00Z"), end_time: Date.parse("2026-10-10T16:00:00Z") }),
      conv(3, { start_time: Date.parse("2026-10-20T15:00:00Z"), end_time: Date.parse("2026-10-20T15:10:00Z") }),
    ];
    await w.sync();
    const has = async (args, ...ids) => {
      const { text } = await w.tool("list_conversations", args);
      for (const id of [1, 2, 3]) assert.equal(text.includes(`Conversation number ${id}`), ids.includes(id), `${JSON.stringify(args)} -> ${text}`);
      return text;
    };
    await has({ from: "2026-10-05" }, 2, 3);
    await has({ to: "2026-10-05" }, 1);
    await has({ place: "Denver" }, 1);
    await has({ min_minutes: 30 }, 2);
    const page1 = await has({ limit: 1 }, 3);
    const cursor = page1.match(/next_cursor: (\S+)/)[1];
    await has({ limit: 1, cursor }, 2);
    assert.equal((await w.tool("list_conversations", { cursor: "bad" })).status, 400);
    assert.ok((await w.tool("search_conversations", { query: "spoken", place: "Denver" })).text.includes("Conversation number 1"));
  }));
});

describe("writes", () => {
  test("todos and facts: create, change, delete, and the archive follows at once", withWorker(async (w) => {
    await w.sync();
    const made = await w.tool("create_todo", { text: "call the bank" });
    assert.equal(made.status, 200);
    const id = made.text.match(/todo (\d+)/)[1];
    assert.ok((await w.tool("list_todos")).text.includes("call the bank"));
    assert.ok((await w.readR2("md/todos.md")).includes("call the bank"));
    assert.ok((await w.tool("complete_todo", { id })).text.includes("[x]"));
    assert.ok((await w.tool("update_todo", { id, text: "call the credit union" })).text.includes("credit union"));
    const { objects } = await w.r2.list({ prefix: `history/todos/${id}/` });
    assert.equal(objects.length, 2, "both edits leave a prior version");
    await w.tool("delete_todo", { id });
    assert.ok(!(await w.tool("list_todos")).text.includes("credit union"));
    assert.ok(await w.readR2(`raw/todos/${id}.json`), "archive keeps a copy");
    assert.equal(w.bee.todos.length, 0);

    const f = await w.tool("create_fact", { text: "likes cider" });
    const fid = f.text.match(/fact (\d+)/)[1];
    assert.ok((await w.tool("list_facts")).text.includes("(unconfirmed)"));
    assert.ok(!(await w.tool("confirm_fact", { id: fid })).text.includes("(unconfirmed)"));
    await w.tool("delete_fact", { id: fid });
    assert.equal(w.bee.facts.length, 0);
  }));

  test("suggestions can be accepted and dismissed", withWorker(async (w) => {
    w.bee.suggestions = [{ id: 50, text: "one", created_at: 1 }, { id: 51, text: "two", created_at: 2 }];
    await w.sync();
    assert.ok((await w.tool("accept_todo_suggestion", { id: "50" })).text.includes("as todo"));
    await w.tool("dismiss_todo_suggestion", { id: "51" });
    assert.equal((await w.tool("list_todo_suggestions")).text, "No suggestions.");
    assert.ok((await w.tool("list_todos")).text.includes("accepted"));
  }));
});

describe("errors", () => {
  test("wrong requests get honest answers", withWorker(async (w) => {
    assert.equal((await w.api("/api/search")).status, 400);
    assert.equal((await w.api("/api/conversations/999")).status, 404);
    assert.equal((await w.tool("get_conversation", { id: "999" })).status, 404);
    assert.equal((await w.api("/api/nope")).status, 404);
    assert.equal((await w.api("/api/sync")).status, 405);
    assert.equal((await w.tool("no_such_tool")).status, 404);
    assert.equal((await w.tool("read_archive", { key: "nope" })).status, 404);
    assert.equal((await w.tool("update_todo", { id: "1" })).status, 400);
  }));

  test("Bee being down on a live call is a 502, not a 404", withWorker(async (w) => {
    w.bee.failAll = 500;
    assert.equal((await w.tool("get_related_conversations", { id: "1" })).status, 502);
  }));
});

describe("alerts", () => {
  test("a dead Bee key alerts once, then says when it's fixed", withWorker(async (w) => {
    seed(w.bee);
    await w.sync();
    assert.equal(w.bee.pushes.length, 0, "no alert while healthy");
    w.bee.failAll = 401;
    await w.sync();
    await w.sync();
    assert.equal(w.bee.pushes.length, 1);
    assert.ok(w.bee.pushes[0].title.includes("key stopped working"));
    w.bee.failAll = 0;
    await w.sync();
    assert.equal(w.bee.pushes.length, 2);
    assert.ok(w.bee.pushes[1].title.includes("recovered"));
  }));

  test("three failed syncs alert; one failure doesn't", withWorker(async (w) => {
    seed(w.bee);
    await w.sync();
    w.bee.failAll = 500;
    await w.sync();
    await w.sync();
    assert.equal(w.bee.pushes.length, 0);
    await w.sync();
    assert.equal(w.bee.pushes.length, 1);
    assert.ok(w.bee.pushes[0].title.includes("sync failing"));
  }));

  test("an item that keeps failing alerts, and syncing carries on", withWorker(async (w) => {
    seed(w.bee);
    w.bee.failDetail.set("/v1/conversations/2", 400);
    await w.sync();
    await w.db.prepare(`UPDATE pending SET attempts = 6, next_try = 0`).run();
    await w.sync();
    assert.ok(w.bee.pushes.some((p) => p.title.includes("items not saving")));
  }));

  test("24 hours of nothing new alerts", withWorker(async (w) => {
    seed(w.bee);
    await w.sync();
    await w.db.prepare(`UPDATE kv SET value = ? WHERE key = 'last_new_at'`).bind(String(Date.now() - 25 * 3600_000)).run();
    await w.sync();
    assert.ok(w.bee.pushes.some((p) => p.title.includes("nothing new")));
  }));
});

describe("webhooks", () => {
  test("a new finished conversation is delivered, signed; old ones never fire", withWorker(async (w) => {
    seed(w.bee);
    const added = JSON.parse((await w.tool("add_webhook", { url: "https://hook.test/in" })).text);
    await w.sync();
    assert.equal(w.bee.hooks.length, 0, "the first import stays quiet");

    w.bee.conversations.unshift(conv(4));
    w.bee.feed = { conversations: [4] };
    const report = await w.sync();
    assert.equal(report.webhooks, 1);
    const [hit] = w.bee.hooks;
    assert.equal(hit.body.event, "conversation.completed");
    assert.equal(hit.body.id, 4);
    assert.ok(hit.body.markdown.includes("spoken words in talk 4"));
    assert.ok(hit.headers["x-bee-signature"].startsWith("sha256="));
    assert.ok(added.secret.length > 20);
  }));

  test("still-recording conversations wait until they finish", withWorker(async (w) => {
    seed(w.bee);
    await w.tool("add_webhook", { url: "https://hook.test/in" });
    await w.sync();
    w.bee.conversations.unshift(conv(5, { state: "CAPTURING" }));
    w.bee.feed = { conversations: [5] };
    await w.sync();
    assert.equal(w.bee.hooks.length, 0);
    w.bee.conversations[0] = { ...w.bee.conversations[0], state: "COMPLETED", updated_at: 300 };
    w.bee.feed = { conversations: [5] };
    await w.sync();
    assert.equal(w.bee.hooks.length, 1);
  }));

  test("failed deliveries retry and are logged", withWorker(async (w) => {
    seed(w.bee);
    await w.tool("add_webhook", { url: "https://hook.test/in", events: ["*"] });
    await w.sync();
    w.bee.hookStatus = 500;
    w.bee.conversations.unshift(conv(6));
    w.bee.feed = { conversations: [6] };
    await w.sync();
    let log = JSON.parse((await w.tool("list_webhook_deliveries")).text);
    assert.equal(log[0].status, "pending");
    assert.equal(log[0].attempts, 1);
    assert.equal(log[0].last_status, 500);

    w.bee.hookStatus = 200;
    await w.db.prepare(`UPDATE deliveries SET next_try = 0`).run();
    await w.sync();
    log = JSON.parse((await w.tool("list_webhook_deliveries")).text);
    assert.equal(log[0].status, "delivered");
    const hooks = JSON.parse((await w.tool("list_webhooks")).text);
    assert.equal(hooks[0].delivered, 1);
    await w.tool("remove_webhook", { id: hooks[0].id });
    assert.deepEqual(JSON.parse((await w.tool("list_webhooks")).text), []);
    assert.equal((await w.tool("add_webhook", { url: "http://insecure.test" })).status, 400);
  }));
});

describe("claude.ai connector", () => {
  test("an agent key works in the address; the admin key never does", withWorker(async (w) => {
    const agent = (await w.tool("create_key", { name: "claude-web" })).text;
    const post = (path) => w.api(path, { key: null, method: "POST", body: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
    const ok = await post(`/mcp/${agent}`);
    assert.equal(ok.status, 200);
    const names = (await ok.json()).result.tools.map((t) => t.name);
    assert.ok(names.includes("create_todo") && !names.includes("create_key"));
    assert.equal((await post("/mcp/admin-key-padded-to-16")).status, 401);
    const dbAdmin = (await w.tool("create_key", { name: "second-admin", scope: "admin" })).text;
    assert.equal((await post(`/mcp/${dbAdmin}`)).status, 401, "admin keys are refused in a URL");
    assert.equal((await w.api("/api/status", { key: dbAdmin })).status, 200, "but work in a header");
    assert.equal((await post("/mcp/wrong-key-1234567890")).status, 401);
    assert.equal((await w.api("/.well-known/security.txt", { key: null })).status, 404);
  }));
});

describe("first-time setup", () => {
  const fresh = (fn) => async () => {
    const w = await start(makeBee(), { BEE_TOKEN: undefined, ADMIN_TOKEN: undefined, PUSHBULLET_TOKEN: undefined });
    try {
      await fn(w);
    } finally {
      await w.stop();
    }
  };
  const setup = async (w, path, { key = null, method = "POST", body } = {}) => {
    const res = await w.api(`/api/setup${path}`, { key, method, body });
    return { status: res.status, json: await res.json() };
  };

  test("the page loads without a key and gives nothing away", fresh(async (w) => {
    const page = await w.api("/", { key: null, headers: { Accept: "text/html" } });
    assert.equal(page.status, 200);
    assert.ok((await page.text()).includes("BeeCloud setup"), "browsers get the owner's setup page");
    assert.deepEqual((await setup(w, "/state", { method: "GET" })).json, { claimed: false });
    assert.equal((await setup(w, "/status", { method: "GET" })).status, 401);
    assert.equal((await w.api("/api/todos", { key: null })).status, 401);
  }));

  test("the first visitor makes the admin key, exactly once", fresh(async (w) => {
    const first = await setup(w, "/claim");
    assert.equal(first.status, 200);
    assert.ok(first.json.admin_key.startsWith("bee_admin_"));
    assert.equal((await setup(w, "/claim")).status, 409);
    assert.deepEqual((await setup(w, "/state", { method: "GET" })).json, { claimed: true });
    assert.equal((await setup(w, "/status", { key: first.json.admin_key, method: "GET" })).status, 200);
    assert.equal((await w.api(`/mcp/${first.json.admin_key}`, { key: null, method: "POST", body: {} })).status, 401);
  }));

  test("an ADMIN_TOKEN secret blocks claiming", async () => {
    const w = await start(makeBee());
    try {
      assert.equal((await setup(w, "/claim")).status, 409);
    } finally {
      await w.stop();
    }
  });

  test("before Bee is connected, syncs wait and tools say what to do", fresh(async (w) => {
    const admin = (await setup(w, "/claim")).json.admin_key;
    const report = await (await w.api("/api/sync", { key: admin, method: "POST" })).json();
    assert.ok(report.skipped.includes("isn't connected"));
    assert.deepEqual(w.bee.calls, []);
    const r = await w.tool("create_todo", { text: "x" }, admin);
    assert.equal(r.status, 503);
    assert.ok(r.text.includes("finish setup"));
    assert.equal((await setup(w, "/status", { key: admin, method: "GET" })).json.bee, "not connected");
  }));

  test("connecting Bee: approve in the app, the key arrives encrypted, the first import starts", fresh(async (w) => {
    seed(w.bee);
    w.bee.onlyToken = "paired-token";
    const admin = (await setup(w, "/claim")).json.admin_key;
    assert.equal((await setup(w, "/bee/start", { key: null })).status, 401, "needs the admin key");

    const started = await setup(w, "/bee/start", { key: admin });
    assert.equal(started.json.status, "pending");
    assert.equal(started.json.url, "https://bee.computer/connect#req1");
    assert.equal((await setup(w, "/bee/poll", { key: admin })).json.status, "pending");
    assert.equal((await setup(w, "/status", { key: admin, method: "GET" })).json.pairing.url, started.json.url);

    w.bee.pairing.approved = true;
    const done = await setup(w, "/bee/poll", { key: admin });
    assert.deepEqual(done.json, { status: "connected", owner: "Alex" });
    assert.equal(w.bee.lastAuth, "Bearer paired-token", "the decrypted key is the one Bee issued");

    for (let i = 0; i < 80 && !(await w.readR2("md/facts.md")); i++) await new Promise((r) => setTimeout(r, 100));
    assert.ok(await w.readR2("raw/conversations/1.json"), "first import ran on its own");
    const status = (await setup(w, "/status", { key: admin, method: "GET" })).json;
    assert.equal(status.bee, "connected");
    assert.equal(status.owner, "Alex");
    assert.equal(status.pairing, null);
    const init = await w.mcp("initialize", {}, admin);
    assert.ok(init.result.instructions.startsWith("Alex's Bee wearable"));
  }));

  test("an expired request can be started again; a pasted key also works; disconnect stops syncing", fresh(async (w) => {
    const admin = (await setup(w, "/claim")).json.admin_key;
    await setup(w, "/bee/start", { key: admin });
    w.bee.pairing.expired = true;
    assert.equal((await setup(w, "/bee/poll", { key: admin })).json.status, "expired");
    assert.equal((await setup(w, "/bee/poll", { key: admin })).json.status, "none");

    w.bee.onlyToken = "good-token";
    assert.equal((await setup(w, "/bee/token", { key: admin, body: { token: "bad-token" } })).status, 400);
    assert.equal((await setup(w, "/bee/token", { key: admin, body: { token: " good-token " } })).json.status, "connected");

    assert.equal((await setup(w, "/bee/disconnect", { key: admin })).json.status, "disconnected");
    await new Promise((r) => setTimeout(r, 300));
    assert.ok((await (await w.api("/api/sync", { key: admin, method: "POST" })).json()).skipped);
  }));

  test("agent keys can't use setup", fresh(async (w) => {
    const admin = (await setup(w, "/claim")).json.admin_key;
    const agent = (await w.tool("create_key", { name: "agent" }, admin)).text;
    assert.equal((await setup(w, "/status", { key: agent, method: "GET" })).status, 403);
    assert.equal((await setup(w, "/bee/start", { key: agent })).status, 403);
  }));
});

describe("instructions for agents", () => {
  const PW = "Pw-test#123";
  const withPw = (fn) => async () => {
    const w = await start(makeBee(), { ACCESS_PASSWORD: PW });
    try {
      await fn(w);
    } finally {
      await w.stop();
    }
  };

  test("public pages describe every agent tool and never show a credential", withPw(async (w) => {
    for (const path of ["/llms.txt", "/AGENTS.md", "/skill.md", "/SKILL.md", "/openapi.json", "/guide"]) {
      const res = await w.api(path, { key: null });
      assert.equal(res.status, 200, path);
      const body = await res.text();
      for (const secret of [PW, "admin-key", "bee-token", "pb-token"]) assert.ok(!body.includes(secret), `${path} leaks ${secret}`);
      assert.ok(body.includes(path === "/openapi.json" ? '"url":"https://x"' : "https://x/mcp"), `${path} uses the address it was reached on`);
    }
    const llms = await (await w.api("/llms.txt", { key: null })).text();
    for (const t of ["get_day", "search_conversations", "create_todo", "gemini mcp add", "claude mcp add", "Gemini app"]) assert.ok(llms.includes(t), t);
    assert.ok(!llms.includes("create_key"), "admin tools stay unlisted");
    assert.ok((await (await w.api("/skill.md", { key: null })).text()).startsWith("---\nname: beecloud\n"));
    const ops = Object.keys((await (await w.api("/openapi.json", { key: null })).json()).paths);
    assert.ok(ops.includes("/api/tools/get_day") && !ops.includes("/api/tools/create_key") && !ops.includes("/api/tools/get_photo"));
    assert.equal((await w.api("/api/status", { key: null })).status, 401, "data still needs a login");
  }));

  test("the main address: setup page for browsers, instructions for agents, MCP for MCP clients", withPw(async (w) => {
    assert.ok((await (await w.api("/", { key: null, headers: { Accept: "text/html" } })).text()).includes("BeeCloud setup"));
    assert.equal(await (await w.api("/", { key: null, headers: { Accept: "*/*" } })).text(), await (await w.api("/llms.txt", { key: null })).text());
    const mcp = (key) => w.api("/", { key, method: "POST", body: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
    assert.equal((await mcp(null)).status, 401);
    const ok = await mcp("admin-key");
    assert.equal(ok.status, 200);
    assert.ok((await ok.json()).result.tools.some((t) => t.name === "get_day"));
    assert.equal((await w.api("/", { key: null, headers: { Accept: "text/event-stream" } })).status, 405);
  }));
});

describe("password", () => {
  const PW = "Pw-test#123";
  const withPw = (fn) => async () => {
    const w = await start(makeBee(), { ACCESS_PASSWORD: PW });
    try {
      await fn(w);
    } finally {
      await w.stop();
    }
  };
  const from = (ip) => ({ "CF-Connecting-IP": ip });

  test("works in every header form, never as admin, never in a URL", withPw(async (w) => {
    assert.equal((await w.api("/api/status", { key: PW })).status, 200);
    assert.equal((await w.api("/api/status", { key: null, headers: { "x-api-key": PW } })).status, 200);
    assert.equal((await w.api("/api/status", { key: null, headers: { Authorization: `Basic ${Buffer.from(`me:${PW}`).toString("base64")}` } })).status, 200);
    assert.equal((await w.tool("create_key", { name: "x" }, PW)).status, 403);
    assert.equal((await w.api(`/mcp/${encodeURIComponent(PW)}`, { key: null, method: "POST", body: { jsonrpc: "2.0", id: 1, method: "ping" } })).status, 401);
    const agent = (await w.tool("create_key", { name: "hermes" })).text;
    assert.equal((await w.api(`/mcp/${agent}`, { key: null, method: "POST", body: { jsonrpc: "2.0", id: 1, method: "ping" } })).status, 200, "agent keys still work in the URL");
  }));

  test("without ACCESS_PASSWORD there is no password", async () => {
    const w = await start(makeBee());
    try {
      assert.equal((await w.api("/api/status", { key: "anything" })).status, 401);
    } finally {
      await w.stop();
    }
  });

  test("ten wrong guesses lock out one address for 15 minutes; keys skip the lockout", withPw(async (w) => {
    for (let i = 0; i < 10; i++) assert.equal((await w.api("/api/status", { key: `guess-${i}`, headers: from("1.2.3.4") })).status, 401);
    assert.equal((await w.api("/api/status", { key: PW, headers: from("1.2.3.4") })).status, 429);
    assert.equal((await w.api("/api/status", { key: PW, headers: from("5.6.7.8") })).status, 200, "other addresses are unaffected");
    const agent = (await w.tool("create_key", { name: "hermes" })).text;
    assert.equal((await w.api("/api/status", { key: agent, headers: from("1.2.3.4") })).status, 200, "agents keep working");
    const stale = "bee_" + "ab".repeat(32);
    for (let i = 0; i < 15; i++) await w.api("/api/status", { key: stale, headers: from("7.7.7.7") });
    assert.equal((await w.api("/api/status", { key: PW, headers: from("7.7.7.7") })).status, 200, "a stale key never counts as a guess");
    await w.db.prepare(`UPDATE auth_failures SET first_at = first_at - 16 * 60000`).run();
    assert.equal((await w.api("/api/status", { key: PW, headers: from("1.2.3.4") })).status, 200, "lockout ends");
  }));
});

describe("sign-in for apps that can't send a key (Gemini app, claude.ai)", () => {
  const PW = "Pw-test#123";
  const REDIRECT = "https://gemini.test/callback";
  const b64url = (buf) => Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const withW = (fn, bindings = { ACCESS_PASSWORD: PW }) => async () => {
    const w = await start(makeBee(), bindings);
    try {
      await fn(w);
    } finally {
      await w.stop();
    }
  };
  const raw = (w, path, init = {}) => w.mf.dispatchFetch(`https://x${path}`, { redirect: "manual", ...init });
  const cookiesFrom = (res) => (res.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).filter((c) => !c.endsWith("="));
  const handleIn = (html) => html.match(/name="handle" value="([^"]+)"/)?.[1].replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n));
  async function register(w, name = "Gemini") {
    const res = await raw(w, "/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_name: name, redirect_uris: [REDIRECT], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }) });
    assert.equal(res.status, 201, await res.clone().text());
    return (await res.json()).client_id;
  }
  async function openLogin(w, clientId, resource = "https://x/mcp") {
    const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
    const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
    const path = `/authorize?${new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT, scope: "beecloud offline_access", state: "st8", code_challenge: challenge, code_challenge_method: "S256", resource })}`;
    const res = await raw(w, path);
    return { path, verifier, res, html: await res.text(), cookies: cookiesFrom(res) };
  }
  const submit = (w, path, cookies, fields, ip = "4.4.4.4") =>
    raw(w, path, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookies.join("; "), Origin: "https://x", "CF-Connecting-IP": ip }, body: new URLSearchParams(fields).toString() });
  const exchange = (w, clientId, code, verifier, resource = "https://x/mcp") =>
    raw(w, "/oauth/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier, resource }).toString() });
  const mcpList = (w, path, token) => raw(w, path, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });

  test("apps discover the sign-in from the address alone", withW(async (w) => {
    const challenge = await raw(w, "/mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal(challenge.status, 401);
    assert.match(challenge.headers.get("WWW-Authenticate") ?? "", /resource_metadata="https:\/\/x\/\.well-known\/oauth-protected-resource/);
    assert.match((await raw(w, "/", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).headers.get("WWW-Authenticate") ?? "", /resource_metadata=/);
    const prm = await (await raw(w, "/.well-known/oauth-protected-resource")).json();
    assert.equal(prm.resource, "https://x");
    const as = await (await raw(w, "/.well-known/oauth-authorization-server")).json();
    assert.equal(as.authorization_endpoint, "https://x/authorize");
    assert.equal(as.registration_endpoint, "https://x/register");
    assert.ok(as.code_challenge_methods_supported.includes("S256"));
  }));

  test("the owner signs in once with the password, then the app reads BeeCloud", withW(async (w) => {
    const clientId = await register(w);
    const login = await openLogin(w, clientId);
    assert.equal(login.res.status, 200);
    assert.ok(login.html.includes("Allow Gemini to use BeeCloud?") && login.html.includes("gemini.test"));
    const wrong = await submit(w, login.path, login.cookies, { handle: handleIn(login.html), decision: "approve", password: "nope" });
    assert.equal(wrong.status, 401);
    const wrongHtml = await wrong.text();
    assert.ok(wrongHtml.includes("the password or an admin key"));
    const ok = await submit(w, login.path, [...login.cookies, ...cookiesFrom(wrong)], { handle: handleIn(wrongHtml), decision: "approve", password: PW });
    assert.equal(ok.status, 302, await ok.clone().text());
    const back = new URL(ok.headers.get("Location"));
    assert.equal(back.searchParams.get("state"), "st8");
    const tokenRes = await exchange(w, clientId, back.searchParams.get("code"), login.verifier);
    assert.equal(tokenRes.status, 200, await tokenRes.clone().text());
    const tokens = await tokenRes.json();
    for (const path of ["/mcp", "/"]) {
      const res = await mcpList(w, path, tokens.access_token);
      assert.equal(res.status, 200, path);
      const names = (await res.json()).result.tools.map((t) => t.name);
      assert.ok(names.includes("create_todo") && !names.includes("create_key"), `${path}: write, never admin`);
    }
    assert.equal((await raw(w, "/api/status", { headers: { Authorization: `Bearer ${tokens.access_token}` } })).status, 200);
    assert.equal((await mcpList(w, "/mcp", tokens.access_token.slice(0, -2) + "zz")).status, 401, "a forged token fails");
    const refreshed = await raw(w, "/oauth/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: clientId }).toString() });
    assert.equal(refreshed.status, 200, "the app stays signed in");
  }));

  test("without a password, the admin key from setup signs in; agent keys don't", withW(async (w) => {
    const agent = (await w.tool("create_key", { name: "hermes" })).text;
    const dbAdmin = (await w.tool("create_key", { name: "owner2", scope: "admin" })).text;
    const clientId = await register(w);
    const login = await openLogin(w, clientId, "https://x");
    const no = await submit(w, login.path, login.cookies, { handle: handleIn(login.html), decision: "approve", password: agent });
    assert.equal(no.status, 401, "an agent key can't approve apps");
    const html = await no.text();
    const ok = await submit(w, login.path, [...login.cookies, ...cookiesFrom(no)], { handle: handleIn(html), decision: "approve", password: dbAdmin });
    assert.equal(ok.status, 302);
    const tokenRes = await exchange(w, clientId, new URL(ok.headers.get("Location")).searchParams.get("code"), login.verifier, "https://x");
    assert.equal(tokenRes.status, 200, await tokenRes.clone().text());
    assert.equal((await mcpList(w, "/mcp", (await tokenRes.json()).access_token)).status, 200);
  }, {}));

  test("Deny sends the app away with nothing, and wrong guesses share the lockout", withW(async (w) => {
    const login = await openLogin(w, await register(w));
    const denied = await submit(w, login.path, login.cookies, { handle: handleIn(login.html), decision: "deny" });
    assert.equal(denied.status, 302);
    assert.equal(new URL(denied.headers.get("Location")).searchParams.get("error"), "access_denied");
    const again = await openLogin(w, await register(w));
    let html = again.html;
    let cookies = again.cookies;
    for (let i = 0; i < 10; i++) {
      const res = await submit(w, again.path, cookies, { handle: handleIn(html), decision: "approve", password: `guess-${i}` }, "8.8.8.8");
      html = await res.text();
      cookies = [...cookies, ...cookiesFrom(res)];
    }
    assert.equal((await submit(w, again.path, cookies, { handle: handleIn(html), decision: "approve", password: PW }, "8.8.8.8")).status, 429);
  }));

  test("an app's name can't inject anything into the page", withW(async (w) => {
    const login = await openLogin(w, await register(w, "<img src=x onerror=alert(1)>"));
    assert.ok(!login.html.includes("<img src=x") && login.html.includes("&#60;img"));
  }));

  test("sign-in stays off over plain HTTP or without its storage; keys still work", async () => {
    for (const opts of [{ origin: "http://x" }, { kv: false }]) {
      const w = await start(makeBee(), { ACCESS_PASSWORD: PW }, opts);
      try {
        assert.equal((await w.api("/.well-known/oauth-authorization-server", { key: null })).status, 404);
        assert.notEqual((await w.api("/authorize", { key: null })).status, 200, "no sign-in page");
        assert.equal((await w.api("/mcp", { key: null, method: "POST", body: {} })).status, 401);
        assert.equal((await w.api("/api/status", { key: PW })).status, 200);
      } finally {
        await w.stop();
      }
    }
  });
});
