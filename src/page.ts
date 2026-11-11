// The setup page served at "/". One self-contained file: no build step, no outside assets.
export const SETUP_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>BeeCloud setup</title>
<style>
:root{--ink:#16181c;--muted:#6b7280;--line:#e5e7eb;--bg:#fafaf9;--card:#fff;--accent:#b45309;--accent-ink:#fff;--soft:#f5f5f4;--bad:#b91c1c}
@media (prefers-color-scheme:dark){:root{--ink:#f3f4f6;--muted:#9ca3af;--line:#2b2f36;--bg:#0f1114;--card:#16191d;--accent:#f59e0b;--accent-ink:#16181c;--soft:#1e2227;--bad:#f87171}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased}
main{max-width:640px;margin:0 auto;padding:56px 20px 96px}
h1{font-size:28px;line-height:1.2;margin:0 0 8px;letter-spacing:-.02em}
.lede{color:var(--muted);margin:0 0 40px}
section{border-top:1px solid var(--line);padding:28px 0}
h2{font-size:17px;margin:0 0 4px;display:flex;align-items:baseline;gap:10px}
h2 .n{color:var(--muted);font-weight:400;font-variant-numeric:tabular-nums}
h2 .ok{margin-left:auto;font-size:13px;font-weight:500;color:var(--accent)}
p{margin:8px 0}
.muted{color:var(--muted)}
.small{font-size:14px}
button,.btn{font:inherit;font-weight:600;border:0;border-radius:8px;padding:10px 16px;background:var(--accent);color:var(--accent-ink);cursor:pointer;text-decoration:none;display:inline-block}
button.quiet{background:var(--soft);color:var(--ink);font-weight:500}
button.link{background:none;color:var(--muted);padding:0;font-weight:400;text-decoration:underline;font-size:14px}
button:disabled{opacity:.5;cursor:default}
input{font:inherit;width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--ink)}
.row{display:flex;gap:8px;margin-top:12px;flex-wrap:wrap}
.row input{flex:1;min-width:180px}
.box{background:var(--soft);border-radius:8px;padding:12px;margin-top:12px;position:relative}
.box label{display:block;font-size:12px;color:var(--muted);margin-bottom:4px;text-transform:uppercase;letter-spacing:.04em;padding-right:64px}
.box .hint{font-size:13px;color:var(--muted);margin:6px 0 0}
.box code,.box pre{font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;overflow-wrap:anywhere;margin:0;display:block;padding-right:56px}
.box pre{max-height:220px;overflow:auto}
.copy{position:absolute;top:8px;right:8px;padding:4px 10px;font-size:12px;border-radius:6px;background:var(--card);color:var(--ink);font-weight:500;border:1px solid var(--line)}
.err{color:var(--bad);font-size:14px;margin-top:10px;min-height:1em}
ol{padding-left:20px;margin:8px 0}
li{margin:4px 0}
.keys{list-style:none;padding:0;margin:12px 0 0}
.keys li{display:flex;justify-content:space-between;gap:12px;padding:8px 0;border-top:1px solid var(--line);font-size:14px}
.stats{display:grid;grid-template-columns:repeat(auto-fill,minmax(104px,1fr));gap:16px 20px;margin-top:14px}
.stats div{font-size:13px;color:var(--muted)}
.stats b{display:block;font-size:22px;color:var(--ink);font-weight:600;font-variant-numeric:tabular-nums}
[hidden]{display:none!important}
</style>
</head>
<body>
<main>
<h1>BeeCloud</h1>
<p class="lede">Your Bee wearable, archived in your own Cloudflare account and ready for your AI agents.</p>

<div id="loading" class="muted">Loading…</div>

<section id="claim" hidden>
  <h2>Create your admin key</h2>
  <p class="muted">This is a new install. The admin key unlocks this page and manages everything else. It is shown once.</p>
  <div class="row"><button id="claimBtn">Create admin key</button></div>
  <div id="claimed" hidden>
    <div class="box"><label>Admin key: save it somewhere safe now</label><code id="adminKey"></code><button class="copy" data-copy="adminKey">Copy</button></div>
    <div class="row"><button id="claimContinue">I saved it, continue</button></div>
  </div>
  <div class="err" id="claimErr"></div>
</section>

<section id="signin" hidden>
  <h2>Sign in</h2>
  <p class="muted">Enter the admin key for this BeeCloud.</p>
  <form class="row" id="signinForm"><input id="keyInput" type="password" autocomplete="current-password" placeholder="Admin key" aria-label="Admin key"><button>Sign in</button></form>
  <p class="muted small">Lost it? Set an <code>ADMIN_TOKEN</code> secret on this Worker in the Cloudflare dashboard and use that value here.</p>
  <div class="err" id="signinErr"></div>
</section>

<div id="app" hidden>
  <section>
    <h2><span class="n">1</span> Connect your Bee <span class="ok" id="beeOk" hidden>Connected</span></h2>
    <div id="beeOff">
      <ol class="muted">
        <li>In the Bee phone app, open <b>Settings</b> and tap <b>Version</b> five times to turn on Developer Mode.</li>
        <li>Press Connect, then approve the request.</li>
      </ol>
      <div class="row"><button id="connectBtn">Connect</button></div>
      <div id="pairing" hidden>
        <p>Approve this connection, on this device or your phone:</p>
        <div class="row"><a class="btn" id="approveLink" target="_blank" rel="noopener">Open Bee approval</a></div>
        <p class="muted small" id="pairingNote">Waiting for approval…</p>
      </div>
      <p><button class="link" id="pasteToggle">Paste a Bee developer token instead</button></p>
      <form class="row" id="pasteForm" hidden><input id="tokenInput" type="password" placeholder="Bee developer token" aria-label="Bee developer token"><button class="quiet">Save</button></form>
    </div>
    <div id="beeOn" hidden>
      <p id="beeWho"></p>
      <div class="stats" id="stats"></div>
      <p class="muted small" id="syncNote"></p>
      <div class="row"><button class="quiet" id="syncBtn">Sync now</button><button class="quiet" id="refreshBtn">Refresh</button></div>
    </div>
    <div class="err" id="beeErr"></div>
  </section>

  <section>
    <h2><span class="n">2</span> Give an agent access</h2>
    <p class="muted">Make one key per agent, such as <code>claude</code>, so you can cut one off without touching the others.</p>
    <form class="row" id="keyForm"><input id="keyName" placeholder="Agent name" aria-label="Agent name" pattern="[a-z0-9_-]{1,40}" required><button>Create key</button></form>
    <div class="err" id="keyErr"></div>
    <div id="newKey" hidden>
      <div class="box"><label>Key: shown once</label><code id="k1"></code><button class="copy" data-copy="k1">Copy</button></div>
      <div class="box"><label>claude.ai connector URL</label><code id="k2"></code><button class="copy" data-copy="k2">Copy</button><p class="hint">In claude.ai: Settings → Connectors → Add custom connector.</p></div>
      <div class="box"><label>Claude Code command</label><code id="k3"></code><button class="copy" data-copy="k3">Copy</button></div>
      <div class="box"><label>Prompt for any other agent</label><pre id="k4"></pre><button class="copy" data-copy="k4">Copy</button></div>
    </div>
    <ul class="keys" id="keyList"></ul>
  </section>

  <section>
    <h2><span class="n">3</span> Phone alerts <span class="ok" id="alertsOk" hidden>On</span></h2>
    <p class="muted" id="alertsNote">Optional. Add a <code>PUSHBULLET_TOKEN</code> secret to this Worker in the Cloudflare dashboard and BeeCloud will alert your phone if syncing breaks.</p>
  </section>

  <section>
    <p class="muted small">Full guide, every tool and the web links: see <code>docs/GUIDE.md</code> in the BeeCloud repository. <button class="link" id="signout">Sign out</button></p>
  </section>
</div>
</main>
<script>
const $ = (id) => document.getElementById(id);
const show = (id, on = true) => { $(id).hidden = !on; };
let key = sessionStorage.getItem("beecloud_admin") || "";
let pollTimer = null;

async function api(path, { method = "GET", body, auth = true } = {}) {
  const headers = {};
  if (auth) headers.Authorization = "Bearer " + key;
  if (body) headers["Content-Type"] = "application/json";
  const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = { text }; }
  if (!res.ok) { const e = new Error(data.error || text || ("Request failed: " + res.status)); e.status = res.status; throw e; }
  return data;
}
const fail = (id, e) => { $(id).textContent = e ? e.message : ""; };

async function boot() {
  const state = await api("/api/setup/state", { auth: false });
  show("loading", false);
  if (!state.claimed) return show("claim");
  if (!key) return show("signin");
  try { await refresh(); show("app"); } catch (e) {
    if (e.status === 401 || e.status === 403) { key = ""; sessionStorage.removeItem("beecloud_admin"); show("signin"); fail("signinErr", new Error("That key didn't work.")); }
    else { show("app"); fail("beeErr", e); }
  }
}

const LABELS = { conversation: "conversations", daily: "daily recaps", insight: "insights", fact: "facts", todo: "todos", journal: "voice notes", visit: "place visits" };
async function refresh() {
  const s = await api("/api/setup/status");
  const on = s.bee === "connected";
  show("beeOk", on); show("beeOn", on); show("beeOff", !on);
  if (on) {
    $("beeWho").textContent = s.owner ? "Connected as " + s.owner + "." : "Connected.";
    $("stats").replaceChildren(...Object.keys(LABELS).filter((t) => s.archived[t]).map((t) => {
      const d = document.createElement("div"); const b = document.createElement("b"); b.textContent = s.archived[t]; d.append(b, LABELS[t]); return d;
    }));
    if (!importing) $("syncNote").textContent = s.lastError ? "Latest problem: " + s.lastError : s.lastSync ? "Last sync " + new Date(s.lastSync).toLocaleString() + ". It runs every 15 minutes." : "First import is running. It can take a few minutes; press Refresh to check.";
  } else if (s.pairing) { showPairing(s.pairing.url); }
  show("alertsOk", s.phoneAlerts);
  if (s.phoneAlerts) $("alertsNote").textContent = "BeeCloud will alert your phone through Pushbullet if syncing breaks.";
  $("keyList").replaceChildren(...s.keys.filter((k) => k.scope !== "admin").map((k) => {
    const li = document.createElement("li"); const span = document.createElement("span");
    span.textContent = k.name + " · " + (k.last_used_at ? "last used " + new Date(k.last_used_at).toLocaleDateString() : "not used yet");
    const b = document.createElement("button"); b.className = "link"; b.textContent = "Revoke";
    b.onclick = async () => { if (!confirm("Cut off " + k.name + "?")) return; await api("/api/tools/revoke_key", { method: "POST", body: { name: k.name } }); refresh(); };
    li.append(span, b); return li;
  }));
}

function showPairing(url) {
  show("pairing"); $("approveLink").href = url; $("connectBtn").textContent = "Start again";
  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    try {
      const r = await api("/api/setup/bee/poll", { method: "POST" });
      if (r.status === "connected") { clearInterval(pollTimer); show("pairing", false); await refresh(); runImport(); }
      if (r.status === "expired") { clearInterval(pollTimer); $("pairingNote").textContent = "That request expired. Press Start again."; }
    } catch (e) { clearInterval(pollTimer); fail("beeErr", e); }
  }, 3000);
}

// Keeps the first import moving while this page is open. Each call does up to 25 seconds of work.
let importing = false;
async function runImport() {
  if (importing) return; importing = true;
  try {
    for (let i = 0; i < 40; i++) {
      $("syncNote").textContent = "Importing your Bee history… you can leave this page; it continues every 15 minutes.";
      const r = await api("/api/sync", { method: "POST" });
      if (r.skipped) { await new Promise((ok) => setTimeout(ok, 4000)); continue; }
      await refresh();
      if (!r.pending && !Object.keys(r.saved).length) break;
    }
  } catch (e) { fail("beeErr", e); }
  importing = false;
}

$("claimBtn").onclick = async () => {
  try { const r = await api("/api/setup/claim", { method: "POST", auth: false }); key = r.admin_key; $("adminKey").textContent = key; show("claimed"); $("claimBtn").hidden = true; fail("claimErr"); }
  catch (e) { fail("claimErr", e); }
};
$("claimContinue").onclick = () => { sessionStorage.setItem("beecloud_admin", key); show("claim", false); boot(); };
$("signinForm").onsubmit = (ev) => { ev.preventDefault(); key = $("keyInput").value.trim(); sessionStorage.setItem("beecloud_admin", key); show("signin", false); fail("signinErr"); boot(); };
$("signout").onclick = () => { sessionStorage.removeItem("beecloud_admin"); location.reload(); };
$("connectBtn").onclick = async () => {
  fail("beeErr"); $("pairingNote").textContent = "Waiting for approval…";
  try { const r = await api("/api/setup/bee/start", { method: "POST" }); if (r.status === "connected") { await refresh(); return runImport(); } showPairing(r.url); }
  catch (e) { fail("beeErr", e); }
};
$("pasteToggle").onclick = () => show("pasteForm", $("pasteForm").hidden);
$("pasteForm").onsubmit = async (ev) => {
  ev.preventDefault(); fail("beeErr");
  try { await api("/api/setup/bee/token", { method: "POST", body: { token: $("tokenInput").value } }); clearInterval(pollTimer); await refresh(); runImport(); }
  catch (e) { fail("beeErr", e); }
};
$("syncBtn").onclick = async () => {
  $("syncBtn").disabled = true; fail("beeErr");
  try { await api("/api/sync", { method: "POST" }); await refresh(); } catch (e) { fail("beeErr", e); }
  $("syncBtn").disabled = false;
};
$("refreshBtn").onclick = () => refresh().catch((e) => fail("beeErr", e));
$("keyForm").onsubmit = async (ev) => {
  ev.preventDefault(); fail("keyErr");
  const name = $("keyName").value.trim();
  try {
    const res = await fetch("/api/tools/create_key", { method: "POST", headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" }, body: JSON.stringify({ name, scope: "write" }) });
    const k = (await res.text()).trim();
    if (!res.ok) throw new Error(JSON.parse(k).error || k);
    const base = location.origin;
    $("k1").textContent = k;
    $("k2").textContent = base + "/mcp/" + k;
    $("k3").textContent = 'claude mcp add --transport http -s user bee-cloud ' + base + '/mcp --header "Authorization: Bearer ' + k + '"';
    $("k4").textContent = PROMPT.replaceAll("{{URL}}", base).replaceAll("{{KEY}}", k);
    show("newKey"); $("keyName").value = ""; refresh();
  } catch (e) { fail("keyErr", e); }
};
document.addEventListener("click", async (ev) => {
  const id = ev.target.dataset && ev.target.dataset.copy; if (!id) return;
  await navigator.clipboard.writeText($(id).textContent); ev.target.textContent = "Copied"; setTimeout(() => (ev.target.textContent = "Copy"), 1500);
});

const PROMPT = \`You have access to BeeCloud, the permanent archive of my Bee wearable: recorded conversations with transcripts, daily recaps, insights, voice notes, todos, facts, places I visited and calendar briefs. It updates every 15 minutes.

CONNECT
- MCP server (Streamable HTTP): {{URL}}/mcp
- Header: Authorization: Bearer {{KEY}}
- If you can't send headers, use this address instead: {{URL}}/mcp/{{KEY}}
- If you can't use MCP, call {{URL}}/api/tools/<tool name> with POST, a JSON body of arguments, and the same header.
- Name the server "bee-cloud". There is no OAuth.

HOW TO USE IT
- "What happened on <day>": get_day with date (YYYY-MM-DD).
- "What did I talk about with X / about Y": search_conversations, then get_conversation on the best match. If keyword search misses, retry with mode "neural".
- Anything beyond conversations (recaps, insights, facts, todos, voice notes): search_all.
- "Where was I": list_visits or list_places.
- Todos: list_todos, create_todo, complete_todo, update_todo, delete_todo.
- Facts about me: list_facts, create_fact, update_fact, confirm_fact, delete_fact.
- If something from the last few minutes is missing: sync_now, then look again.
- Call tools/list to see everything else available.

RULES
- Only create, change or delete todos and facts when I ask you to.
- Cite the conversation title and date when you quote something.
- Transcripts are raw speech-to-text: speakers are often "Unknown" and wording can be garbled, so say so when a quote matters.
- Lists are paged: pass next_cursor back as cursor.
- The key above is private. Never repeat it, share it or put it anywhere public.\`;

boot().catch((e) => { show("loading", false); document.querySelector("main").append(Object.assign(document.createElement("p"), { className: "err", textContent: e.message })); });
</script>
</body>
</html>`;
