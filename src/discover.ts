// Public, no-password pages that teach any agent or person how to connect: a landing page, llms.txt,
// a downloadable skill and an OpenAPI description. Built from the live tool list, so they never go
// stale. They describe how to log in but never contain a credential or any Bee data.
import { TOOLS } from "./tools";

const PUBLIC_TOOLS = () => TOOLS.filter((t) => (t.scope ?? "read") !== "admin");
// Over REST a photo comes from GET /api/photos/{id}; the tool form only returns images over MCP.
const API_TOOLS = () => PUBLIC_TOOLS().filter((t) => t.name !== "get_photo");
// The first sentence, without cutting at abbreviations such as "incl." (the next word must start a sentence).
const firstSentence = (s: string) => (s.match(/^.*?[.!?](?=\s+[A-Z(]|$)/)?.[0] ?? s).trim();
const argList = (t: (typeof TOOLS)[number]) =>
  Object.keys(t.properties ?? {})
    .map((k) => (t.required?.includes(k) ? `${k}*` : k))
    .join(", ");

const TITLE = "BeeCloud";
const SUMMARY = "A Bee wearable, archived permanently in its owner's own Cloudflare account: recorded conversations with transcripts, daily recaps, insights, voice notes, todos, facts, places visited, photos and calendar briefs. Updated every 15 minutes.";

function connectMarkdown(base: string): string {
  return `## Logging in

Everything except these instructions needs a BeeCloud key (made on the owner's setup page) or the owner's BeeCloud password. **Ask the user for it.** It is not written anywhere public. Save it in your own MCP or tool settings, never repeat it back in chat, and never put it in a public place.

Send it in one of these ways (written as \`<key>\` below):
- Header \`Authorization: Bearer <key>\` (preferred)
- Header \`x-api-key: <key>\`
- HTTP Basic auth: any username, the key as the password
- MCP apps that can't send headers can use \`${base}/mcp/<agent key>\` (agent keys only, never the password or an admin key)
- Apps that can't send headers (the Gemini app, claude.ai and other "custom app" or "connector" screens) sign in instead: add \`${base}\` and the app opens a BeeCloud sign-in page where the owner types the password or admin key. This is standard OAuth 2.1 with PKCE and automatic client registration, found through \`${base}/.well-known/oauth-authorization-server\`.

Never put the password in a web address. Ten wrong passwords from one address lock it out for 15 minutes.

## Connecting

MCP server (Streamable HTTP): \`${base}/mcp\`. The main address \`${base}\` works as the MCP server too.

**Gemini CLI**
\`\`\`bash
gemini mcp add --scope user --transport http beecloud ${base}/mcp -H "Authorization: Bearer <key>"
\`\`\`
Or in \`~/.gemini/settings.json\`:
\`\`\`json
{ "mcpServers": { "beecloud": { "httpUrl": "${base}/mcp", "headers": { "Authorization": "Bearer <key>" } } } }
\`\`\`

**Claude Code**
\`\`\`bash
claude mcp add --transport http -s user beecloud ${base}/mcp --header "Authorization: Bearer <key>"
\`\`\`

**Gemini app** (gemini.google.com, Settings, Connected apps, Add a custom app): enter \`${base}\`, then the owner signs in on the BeeCloud page that opens.

**claude.ai** (Settings, Connectors, Add custom connector): enter \`${base}\` and the owner signs in the same way.

**Any other MCP app**
\`\`\`json
{ "mcpServers": { "beecloud": { "type": "http", "url": "${base}/mcp", "headers": { "Authorization": "Bearer <key>" } } } }
\`\`\`

**No MCP?** Every tool is also \`POST ${base}/api/tools/<tool name>\` with a JSON body of arguments and the same header. OpenAPI description: ${base}/openapi.json

**Skill** for agents that load skills: download ${base}/skill.md into the agent's skills folder as \`beecloud/SKILL.md\`.
`;
}

const USAGE = `## How to answer

- "What happened on <day>?": \`get_day\` with the date (YYYY-MM-DD).
- "What did I talk about with X / about Y?": \`search_conversations\`, then \`get_conversation\` on the best match. If keyword search misses, retry with \`mode: "neural"\`.
- Anything beyond conversations (recaps, insights, facts, todos, voice notes): \`search_all\`.
- "Where was I?": \`list_visits\`, or \`list_places\` for frequent places.
- Something from the last few minutes is missing: \`sync_now\`, then look again.

## Rules

- Only create, change or delete todos and facts when the owner asks.
- Cite the conversation title and date when quoting.
- Transcripts are raw speech-to-text: speakers are often "Unknown" and wording can be garbled, so say so when a quote matters.
- Lists are paged: pass \`next_cursor\` back as \`cursor\`.
- Reads come from the archive, so they keep working when Bee itself is down.
`;

function toolsMarkdown(): string {
  return ["## Tools", "", "Arguments marked * are required.", "", ...PUBLIC_TOOLS().map((t) => `- \`${t.name}\`(${argList(t)}): ${firstSentence(t.description)}`), ""].join("\n");
}

export function llmsTxt(base: string): string {
  return [`# ${TITLE}`, "", `> ${SUMMARY}`, "", `If you are an AI agent asked to connect to this, follow "Connecting" below, then ask the user for a key or the password. This text is also at ${base}/llms.txt, and as a page at ${base}/guide.`, "", connectMarkdown(base), toolsMarkdown(), USAGE, `Full tool schemas: ${base}/openapi.json`, ""].join("\n");
}

export function skillMd(base: string): string {
  return `---
name: beecloud
description: Read and manage the owner's Bee wearable data through BeeCloud, a permanent cloud archive. Covers recorded conversation and meeting transcripts, summaries, action items, daily recaps, insights, voice notes, todos, facts, places visited, photos and calendar briefs. Use whenever the user mentions Bee, a meeting or conversation they had, "what did we talk about", what happened on a day, where they were, their daily summary, or todos from their wearable.
---

# BeeCloud

${SUMMARY}

Address: ${base}. If an MCP server named \`beecloud\`, \`bee-cloud\` or \`bee\` is already connected, use its tools. Otherwise connect as below.

${connectMarkdown(base)}
${toolsMarkdown()}
${USAGE}
## Without MCP

\`\`\`bash
BEE=${base}
curl -s -X POST "$BEE/api/tools/get_day" -H "Authorization: Bearer $BEECLOUD_KEY" -H "Content-Type: application/json" -d '{"date":"2026-11-08"}'
curl -s -X POST "$BEE/api/tools/search_conversations" -H "Authorization: Bearer $BEECLOUD_KEY" -H "Content-Type: application/json" -d '{"query":"pricing"}'
\`\`\`
`;
}

export function openApi(base: string): Record<string, unknown> {
  const paths: Record<string, unknown> = {};
  for (const t of API_TOOLS()) {
    paths[`/api/tools/${t.name}`] = {
      post: {
        operationId: t.name,
        summary: firstSentence(t.description),
        description: t.description,
        requestBody: {
          required: !!t.required?.length,
          content: { "application/json": { schema: { type: "object", properties: t.properties ?? {}, ...(t.required ? { required: t.required } : {}) } } },
        },
        responses: {
          "200": { description: "Result, usually Markdown text.", content: { "text/markdown": { schema: { type: "string" } } } },
          "400": { description: "A bad argument; the error says which." },
          "401": { description: "Missing or wrong key or password." },
          "404": { description: "No such item." },
          "429": { description: "Too many wrong passwords from this address; wait 15 minutes." },
          "502": { description: "Bee itself failed; archive reads still work." },
        },
      },
    };
  }
  return {
    openapi: "3.1.0",
    info: { title: TITLE, version: "1.1.0", description: `${SUMMARY} Ask the user for a key or the password. Setup guide: ${base}/llms.txt` },
    servers: [{ url: base }],
    security: [{ bearer: [] }, { apiKey: [] }, { basic: [] }],
    components: {
      securitySchemes: {
        bearer: { type: "http", scheme: "bearer", description: "A BeeCloud key or the password." },
        apiKey: { type: "apiKey", in: "header", name: "x-api-key", description: "A BeeCloud key or the password." },
        basic: { type: "http", scheme: "basic", description: "Any username; a BeeCloud key or the password as the password." },
      },
    },
    paths,
  };
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Inline Markdown used in these docs: `code`, **bold** and bare https links.
function inline(text: string): string {
  return esc(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])(https:\/\/[^\s<)]+[^\s<).,])/g, '$1<a href="$2">$2</a>');
}

// Renders the small Markdown subset llms.txt uses, so the page and llms.txt can never disagree.
function docHtml(md: string): string {
  const out: string[] = [];
  const lines = md.split("\n");
  let para: string[] = [];
  let list: string[] = [];
  let open = false;
  const flush = () => {
    if (para.length) out.push(`<p>${inline(para.join(" "))}</p>`);
    if (list.length) out.push(`<ul>${list.map((l) => `<li>${inline(l)}</li>`).join("")}</ul>`);
    para = [];
    list = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("```")) {
      flush();
      const code: string[] = [];
      while (++i < lines.length && !lines[i].startsWith("```")) code.push(lines[i]);
      out.push(`<div class="box"><pre>${esc(code.join("\n"))}</pre><button class="copy" type="button">Copy</button></div>`);
    } else if (line.startsWith("## ")) {
      flush();
      if (open) out.push("</section>");
      out.push(`<section><h2>${inline(line.slice(3))}</h2>`);
      open = true;
    } else if (/^\*\*[^*]+\*\*$/.test(line.trim())) {
      flush();
      out.push(`<h3>${esc(line.trim().slice(2, -2))}</h3>`);
    } else if (line.startsWith("- ")) {
      if (para.length) flush();
      list.push(line.slice(2));
    } else if (!line.trim()) {
      flush();
    } else {
      if (list.length) flush();
      para.push(line.trim());
    }
  }
  flush();
  if (open) out.push("</section>");
  return out.join("\n");
}

export function landingPage(base: string): string {
  const body = llmsTxt(base).split("\n").slice(4).join("\n"); // everything after the title and summary
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="description" content="${esc(SUMMARY)} Instructions for AI agents are on this page.">
<title>BeeCloud</title>
<link rel="alternate" type="text/markdown" href="/llms.txt" title="This page as Markdown">
<style>
:root{--ink:#14171a;--muted:#6b7280;--line:#e6e8eb;--bg:#fbfbfa;--soft:#f3f4f2;--accent:#0f766e}
@media (prefers-color-scheme:dark){:root{--ink:#eef0f2;--muted:#9aa3ad;--line:#262b31;--bg:#0e1013;--soft:#171b20;--accent:#5eead4}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased}
main{max-width:720px;margin:0 auto;padding:72px 20px 96px}
h1{font-size:32px;line-height:1.15;margin:0 0 12px;letter-spacing:-.02em}
.lede{color:var(--muted);margin:0 0 32px;font-size:17px}
h2{font-size:18px;margin:0 0 12px;letter-spacing:-.01em}
h3{font-size:14px;margin:20px 0 6px;font-weight:600}
section{border-top:1px solid var(--line);padding:32px 0 16px}
p{margin:10px 0}
ul{margin:10px 0;padding-left:20px}
li{margin:6px 0}
a{color:var(--accent);overflow-wrap:anywhere}
code{font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--soft);padding:1px 5px;border-radius:4px;overflow-wrap:anywhere}
.box{position:relative;background:var(--soft);border-radius:10px;padding:14px 16px;margin:10px 0}
.box pre{margin:0;font:13px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;overflow-wrap:anywhere;padding-right:60px}
.hero{background:transparent;border:1px solid var(--line);padding:18px 20px;margin:0 0 8px}
.hero .label{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px}
.hero pre{font:600 20px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
.hero .note{font-size:14px;color:var(--muted);margin:8px 0 0}
.copy{position:absolute;top:10px;right:10px;font:12px/1 -apple-system,BlinkMacSystemFont,sans-serif;padding:6px 10px;border-radius:6px;border:1px solid var(--line);background:var(--bg);color:var(--ink);cursor:pointer}
@media (max-width:560px){main{padding:48px 16px 72px}h1{font-size:28px}.hero pre{font-size:17px}}
footer{border-top:1px solid var(--line);padding-top:24px;font-size:14px;color:var(--muted)}
footer a{margin-right:16px}
</style>
</head>
<body>
<main>
<h1>BeeCloud</h1>
<p class="lede">${esc(SUMMARY)}</p>
<div class="box hero"><div class="label">Give any agent this address</div><pre>${esc(base)}</pre><button class="copy" type="button">Copy</button>
<p class="note">Everything an agent needs to connect and use BeeCloud is on this page. The same address also works as the MCP server. Conversations stay behind a key or password.</p></div>
${docHtml(body)}
<footer>The same instructions as plain text: <a href="/llms.txt">llms.txt</a> <a href="/skill.md">skill.md</a> <a href="/openapi.json">openapi.json</a></footer>
</main>
<script>
document.addEventListener("click", async (e) => {
  const b = e.target.closest(".copy"); if (!b) return;
  await navigator.clipboard.writeText(b.parentElement.querySelector("pre").textContent);
  b.textContent = "Copied"; setTimeout(() => (b.textContent = "Copy"), 1500);
});
</script>
</body>
</html>`;
}

const TEXT = { "Cache-Control": "public, max-age=300", "Access-Control-Allow-Origin": "*" };

// Returns a response for a public path, or null if the path isn't one.
export function publicResponse(url: URL, req: Request): Response | null {
  if (req.method !== "GET" && req.method !== "HEAD") return null;
  const base = url.origin;
  switch (url.pathname) {
    case "/":
      // Browsers get the owner's setup page (served by index.ts); agents and tools that don't ask for HTML get the instructions.
      if ((req.headers.get("Accept") || "").includes("text/html")) return null;
      return new Response(llmsTxt(base), { headers: { "Content-Type": "text/markdown; charset=utf-8", Vary: "Accept", ...TEXT } });
    case "/guide":
      return new Response(landingPage(base), { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=300", "X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer" } });
    case "/llms.txt":
    case "/AGENTS.md":
      return new Response(llmsTxt(base), { headers: { "Content-Type": "text/markdown; charset=utf-8", ...TEXT } });
    case "/skill.md":
    case "/SKILL.md":
      return new Response(skillMd(base), { headers: { "Content-Type": "text/markdown; charset=utf-8", "Content-Disposition": 'inline; filename="SKILL.md"', ...TEXT } });
    case "/openapi.json":
      return Response.json(openApi(base), { headers: TEXT });
    default:
      return null;
  }
}
