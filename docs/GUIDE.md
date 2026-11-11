# BeeCloud: the complete guide

Everything about connecting to and using a BeeCloud install. Replace `https://YOUR-WORKER.workers.dev` with your BeeCloud address and `YOUR_KEY` with an agent key from your setup page, then give this file to any LLM, agent or tool that needs the owner's Bee data. It covers what BeeCloud is, how to connect, every tool with an example, the web links, the archive, limits, errors, and what to tell an agent.

> **Once you fill in a real key, this file is private.** Anyone with the key can read the owner's recordings and change their Bee todos and facts. Never post it or put it anywhere public.

---

## Contents

1. What BeeCloud is
2. Connection details
3. How to connect (claude.ai, Claude Code, any MCP client, no MCP)
4. Talking to the server directly (raw MCP, Python, JavaScript)
5. Every tool, with examples
6. Web links (REST)
7. How to answer common questions
8. The permanent archive
9. How syncing works
10. Limits, paging and time zone
11. Errors and troubleshooting
12. Admin-only features
13. What isn't available
14. A ready-to-paste prompt for any agent

---

## 1. What BeeCloud is

**Bee** is an Amazon wearable that records its owner's conversations. **BeeCloud** is a small open-source service that runs in the owner's own Cloudflare account and:

- copies everything from Bee **every 15 minutes**: conversations (summaries, action items, full transcripts), daily recaps, insights, voice notes, todos, facts, places visited, frequent places, photos, suggested todos, calendar and email briefs, and a log of outside services that read his Bee data
- keeps it **permanently**, in Bee's original format, with **earlier versions** of anything that gets edited
- **keeps items even after they're deleted from Bee**
- answers reads **from its own archive**, so search and lists keep working when Bee is down
- lets agents **add, complete and delete todos** and **manage facts** in Bee
- runs entirely in the cloud, with no dependency on any local machine

New install? Open your BeeCloud address in a browser. The setup page creates your admin key, connects your Bee and makes agent keys. See the README.

Data is at most 15 minutes behind Bee. Times are the owner's time zone, as Bee reports it.

---

## 2. Connection details

| Item | Value |
|---|---|
| Base URL | `https://YOUR-WORKER.workers.dev` |
| MCP endpoint (Streamable HTTP) | `https://YOUR-WORKER.workers.dev/mcp` |
| MCP endpoint with the key built in | `https://YOUR-WORKER.workers.dev/mcp/YOUR_KEY` |
| Access key | `YOUR_KEY` |
| Web links (REST) | `https://YOUR-WORKER.workers.dev/api/...` |
| Health check (no key needed) | `GET /health` returns `ok` |
| Suggested server name | `bee-cloud` |
| Server name it reports | `beecloud`, version `1.0.0` |

### Ways to send the key

| Method | Use when |
|---|---|
| Header `Authorization: Bearer YOUR_KEY` | Preferred. Works everywhere. |
| Header `x-api-key: YOUR_KEY` | The tool only lets you set a custom header name. |
| Key in the MCP address: `/mcp/YOUR_KEY` | The tool can't send headers at all (such as claude.ai connectors). Only works on `/mcp`, not on `/api/...`, and never with an admin key. |

There is **no OAuth**. Keys in a link's query string (`?token=` or `?key=`) are **refused**. Requests without a valid key get `401 {"error":"unauthorized"}`.

An agent key can read everything and change todos and facts. It can't create keys or webhooks; those need the admin key. See section 12.

---

## 3. How to connect

### claude.ai (custom connector)
1. Open **Settings**, then **Connectors**.
2. Tap **Add custom connector**.
3. Name: `bee-cloud`. URL: `https://YOUR-WORKER.workers.dev/mcp/YOUR_KEY`
4. Tap **Add**, then turn it on. New chats pick it up.

### Claude Code
```bash
claude mcp add --transport http -s user bee-cloud https://YOUR-WORKER.workers.dev/mcp --header "Authorization: Bearer YOUR_KEY"
```
Check it with `claude mcp get bee-cloud`. It should say `✔ Connected`.

### Any MCP client that reads a JSON config
Desktop apps, IDEs and agent frameworks mostly accept a remote HTTP server in this shape. Exact key names vary by tool; the URL and header are what matter.
```json
{
  "mcpServers": {
    "bee-cloud": {
      "type": "http",
      "url": "https://YOUR-WORKER.workers.dev/mcp",
      "headers": { "Authorization": "Bearer YOUR_KEY" }
    }
  }
}
```
If the tool only takes a URL, use `https://YOUR-WORKER.workers.dev/mcp/YOUR_KEY` with no header.

### Tools with no MCP support
Use the web links in section 6. `POST /api/tools/<tool name>` with a JSON body reaches every tool.

### What the agent learns when it connects
- **On the handshake,** the server sends this short guide:
  > <Owner>'s Bee wearable, archived in their own Cloudflare account: conversations with transcripts, daily recaps, insights, voice notes, todos, facts, places visited, photos and calendar briefs. Use get_day for 'what happened on <date>'. Use search_conversations or search_all, then get_conversation, for 'what did we say about X'. Reads come from the archive (at most 15 minutes behind) and keep working if Bee is down; call sync_now if you need the very latest. Transcripts are raw speech-to-text: speakers are often Unknown and wording can be garbled.
- **From the tool list,** it gets each tool's description and arguments, so it finds new tools automatically.
- **Tool hints:** each tool is marked read-only or not, and deleting tools are marked destructive, so careful clients ask before using them.
- **Not included:** behaviour rules, such as "only change todos when asked". Put those in the agent's prompt; section 14 has one ready to paste.

An agent that was already running before a server update sees new tools on its next connection, usually a restart or a new chat.

---

## 4. Talking to the server directly

The server speaks MCP over Streamable HTTP in its simplest form:
- **stateless:** no session id
- **one request at a time:** one JSON-RPC message, or a batch array, per `POST /mcp`
- **plain JSON replies:** no SSE stream
- **protocol versions:** `2025-11-25`, `2025-06-18`, `2025-03-26` and `2024-11-05`. An unknown version gets `2025-11-25`.

### Raw requests
```bash
BEE=https://YOUR-WORKER.workers.dev
KEY=YOUR_KEY

# 1. Handshake
curl -s -X POST "$BEE/mcp" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"my-agent","version":"1.0"}}}'

# 2. List tools
curl -s -X POST "$BEE/mcp" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'

# 3. Call a tool
curl -s -X POST "$BEE/mcp" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_day","arguments":{"date":"2026-11-08"}}}'
```

### What comes back
| Situation | Reply |
|---|---|
| Tool worked | `{"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":"..."}]}}` |
| `get_photo` worked | `content` holds `{"type":"image","data":"<base64>","mimeType":"image/jpeg"}` |
| Tool failed (bad id, Bee down, not allowed) | `result` has `"isError": true` and the reason in the text, such as `Error: id must be a number` |
| Unknown method | `{"error":{"code":-32601,"message":"Method not found: ..."}}` |
| Body isn't JSON | `400` with `{"error":{"code":-32700,"message":"Parse error"}}` |
| Notification (no `id`) | `202`, empty body |
| Batch (array of messages) | An array of replies |
| `GET /mcp` | `405` (there is no event stream) |

### Python
```python
import json, urllib.request

BEE = "https://YOUR-WORKER.workers.dev"
KEY = "YOUR_KEY"

def call(tool, **args):
    body = {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": tool, "arguments": args}}
    req = urllib.request.Request(f"{BEE}/mcp", data=json.dumps(body).encode(),
                                 headers={"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"})
    result = json.load(urllib.request.urlopen(req))["result"]
    text = result["content"][0].get("text", "")
    if result.get("isError"):
        raise RuntimeError(text)
    return text

print(call("get_day", date="2026-11-08"))
print(call("search_conversations", query="marketing strategy", limit=3))
```

### JavaScript (Node 18+ or a browser-side backend)
```js
const BEE = "https://YOUR-WORKER.workers.dev";
const KEY = "YOUR_KEY";

async function call(name, args = {}) {
  const res = await fetch(`${BEE}/mcp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const { result } = await res.json();
  if (result.isError) throw new Error(result.content[0].text);
  return result.content[0].text;
}

console.log(await call("list_todos", { show: "open" }));
```

### Plain HTTPS, no MCP
Same tools, same arguments:
```bash
curl -s -X POST "$BEE/api/tools/get_day" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -d '{"date":"2026-11-08"}'
```

---

## 5. Every tool, with examples

Arguments marked **\*** are required. Dates are `YYYY-MM-DD` and both `from` and `to` include the day given. Example outputs below are shortened and illustrative; real ones contain the owner's data.

### Finding things

#### `get_day`
Everything for one date in a single call: recap, conversations with summaries, voice notes, insights, places visited, calendar, photos, and todos and facts created that day.

| Argument | Meaning |
|---|---|
| `date` | `YYYY-MM-DD`. Defaults to today. |
| `summaries` | Include each conversation's summary. Default `true`. |

```json
{"name": "get_day", "arguments": {"date": "2026-11-08"}}
```
```text
# 2026-11-08

## Recap

# Daily summary 2026-11-08
- id: 900012
- conversations: 6

**Strategy calls and an evening out**
...

## Conversations

- 10000123 | Nov 8, 2026, 2:10 PM | Pricing the onboarding package | 412 utterances | COMPLETED | 38.5 min | 410 Congress Avenue, Austin
  the owner and a partner priced the onboarding package and agreed to...

## Voice notes
- Nov 8, 2026, 6:20 PM | Remember to send the deck to Jordan — id p7d2w9xk...

## Insights
- Best ideas tend to come out on walks — id 20000045

## Places visited
- Nov 8, 2026, 12:55 PM | 410 Congress Avenue, Austin | 95 min — id visit-500000118

## Calendar
- [WEEKLY] Team sync
```

#### `search_conversations`
Finds conversations by person or topic.

| Argument | Meaning |
|---|---|
| `query` **\*** | Words or a question |
| `mode` | `keyword` (default): searches the archive and works when Bee is down. `neural`: Bee's meaning-based search; needs Bee up, and falls back to keyword if Bee is down. |
| `limit` | Default 10, max 50 |
| `from`, `to` | Date range |
| `place` | Part of an address, such as `Congress` |
| `include_removed` | Also search conversations deleted from Bee |

```json
{"name": "search_conversations", "arguments": {"query": "pricing onboarding", "from": "2026-11-01"}}
```
```text
## 10000123 — Pricing the onboarding package (Nov 8, 2026, 2:10 PM, score 7.42)
The owner and a partner priced the onboarding package and agreed to...

## 10000098 — Quarterly planning with the design team (Nov 4, 2026, 11:02 AM, score 5.10)
...
```
Tip: if keyword search misses, retry with `"mode": "neural"` and a plain-language question.

#### `search_all`
Keyword search across everything: conversations, recaps, insights, facts, todos, voice notes, suggested todos and visits.

| Argument | Meaning |
|---|---|
| `query` **\*** | Words to find |
| `types` | Limit to some of: `conversation`, `daily`, `insight`, `fact`, `todo`, `journal` (voice notes), `suggestion`, `visit` |
| `limit` | Default 15, max 50 |
| `from`, `to`, `place`, `include_removed` | As above |

```json
{"name": "search_all", "arguments": {"query": "harbor", "types": ["journal", "fact"]}}
```
```text
## [journal] p7d2w9xk... — voice note about the harbor (Nov 2, 2026, 6:20 PM, score 4.11)
...walked past the **harbor** and thought about...
```
Matching words are wrapped in `**`.

#### `list_conversations`
Conversations, newest first.

| Argument | Meaning |
|---|---|
| `limit` | Default 20, max 100 |
| `cursor` | From the previous page's `next_cursor` |
| `from`, `to` | Date range |
| `place` | Part of an address |
| `min_minutes` | Only conversations at least this long |
| `state` | `COMPLETED` (finished) or `CAPTURING` (still recording) |
| `include_removed` | Also list conversations deleted from Bee. They show `removed from Bee` instead of a state. |

```json
{"name": "list_conversations", "arguments": {"from": "2026-11-01", "place": "Austin", "min_minutes": 10, "limit": 3}}
```
```text
- 10000157 | Nov 10, 2026, 2:51 PM | Vendor walkthrough of the new dashboard | 233 utterances | COMPLETED | 22.4 min | 410 Congress Avenue, Austin
- 10000140 | Nov 9, 2026, 9:07 PM | Catching up over dinner | 120 utterances | COMPLETED | 14 min | 1200 Barton Springs Road, Austin
- 10000123 | Nov 8, 2026, 2:10 PM | Pricing the onboarding package | 412 utterances | COMPLETED | 38.5 min | 410 Congress Avenue, Austin

next_cursor: 1793123456000_812
```
Each row reads `id | start time | title | utterance count | state | minutes | place`.

#### `get_conversation`
One conversation as Markdown: title, times, place, Bee's summary (key takeaways and action items), and the full timestamped transcript. It still works for conversations later deleted from Bee, and for ones still recording.

| Argument | Meaning |
|---|---|
| `id` **\*** | Conversation id (a number) |
| `include_transcript` | Default `true`. Use `false` when the summary is enough; transcripts can be long. |

```json
{"name": "get_conversation", "arguments": {"id": "10000123", "include_transcript": false}}
```
```text
# Pricing the onboarding package

- id: 10000123
- start: Nov 8, 2026, 2:10 PM
- end: Nov 8, 2026, 2:48 PM
- location: 410 Congress Avenue, Austin
- state: COMPLETED

## Summary
...
## Action items
- Send the revised pricing sheet by Friday
```
With the transcript, lines look like `[2:11:05 PM] Unknown: so the onboarding piece is...`.

If Bee deleted it, the reply starts with `> Deleted from Bee; this is the archived copy.` If Bee is unreachable, it starts with `> Bee is unreachable; this is the archived copy.`

#### `get_related_conversations`
Bee's own list of conversations related to one conversation. This needs Bee up.

```json
{"name": "get_related_conversations", "arguments": {"id": "10000123"}}
```
```text
{
  "conversations": [ ... ],
  "timezone": "America/Chicago"
}
```

### Recaps, insights and briefs

#### `list_daily_summaries`
Bee's daily recaps, newest first, with email and calendar summaries.

| Argument | Meaning |
|---|---|
| `limit` | Default 7, max 30 |
| `cursor`, `from`, `to` | Paging and date range |

```json
{"name": "list_daily_summaries", "arguments": {"limit": 1}}
```
```text
# Daily summary 2026-11-09

- id: 900013
- conversations: 6

**A busy day of client calls**

...

## Email
...

## Calendar
...
```

#### `list_insights`
Bee's insights about the owner, with suggested actions. Newest first.

| Argument | Meaning |
|---|---|
| `limit` | Default 20, max 50 |
| `cursor`, `from`, `to` | Paging and date range |

```text
# Best ideas tend to come out on walks

- id: 20000045
- generated: Nov 9, 2026, 8:00 AM

...description...

## Suggested actions

- Block a 30-minute walk before planning sessions
```

#### `get_today_brief`
Calendar events and emails for a date, as Bee prepared them.

| Argument | Meaning |
|---|---|
| `date` | Defaults to today, which is fetched live from Bee (falling back to the archive). Earlier dates come from the archive, saved hourly. |

```text
# Brief 2026-11-10

## Calendar

- 11:00:00 AM: [WEEKLY] Team sync (Zoom)
- All day: Conference

## Emails

- someone@example.com: Proposal follow-up — wants a call Thursday
```

### Todos

#### `list_todos`
| Argument | Meaning |
|---|---|
| `show` | `all` (default), `open` or `completed` |
| `limit` | Default 200, max 500 |
| `cursor` | Paging |

```text
# Bee todos

- [ ] Confirm tomorrow's meetup (due Nov 11, 2026, 9:00 AM) — id 30000188
- [x] Send the deck to Jordan — id 30000102
```

#### `create_todo`
| Argument | Meaning |
|---|---|
| `text` **\*** | The todo |
| `alarm_at` | Reminder time in UTC, ISO 8601, such as `2026-11-12T15:00:00Z` |

```json
{"name": "create_todo", "arguments": {"text": "Call the bank", "alarm_at": "2026-11-12T15:00:00Z"}}
```
```text
Created todo 30000210: Call the bank
```

#### `update_todo`
Change text, completed state or reminder. Send only what changes. Set `alarm_at` to `null` to clear the reminder.

```json
{"name": "update_todo", "arguments": {"id": "30000210", "text": "Call the credit union", "alarm_at": null}}
```
```text
- [ ] Call the credit union — id 30000210
```

#### `complete_todo`
```json
{"name": "complete_todo", "arguments": {"id": "30000210"}}
```
```text
- [x] Call the credit union — id 30000210
```

#### `delete_todo`
Deletes it from Bee. The archive keeps a copy.
```text
Deleted todo 30000210.
```

#### `list_todo_suggestions`, `accept_todo_suggestion`, `dismiss_todo_suggestion`
Todos Bee suggests from conversations but the owner hasn't accepted.
```text
- Send the team a recap of the vendor demo — id 7001
```
```json
{"name": "accept_todo_suggestion", "arguments": {"id": "7001"}}
```
```text
Accepted suggestion 7001 as todo 30000215.
```
`dismiss_todo_suggestion` replies `Dismissed suggestion 7001.`

### Facts

#### `list_facts`
Everything Bee has learned about the owner, newest first. No cap; page with `cursor` past `limit`.

| Argument | Meaning |
|---|---|
| `limit` | Default 200, max 500 |
| `cursor` | Paging |

```text
# Bee facts

- Has lived in Austin for about three years [general] — id 40000031
- Prefers oat milk in coffee [food] (unconfirmed) — id 40000077
```
`(unconfirmed)` means Bee isn't sure yet.

#### `create_fact`, `update_fact`, `confirm_fact`, `delete_fact`
```json
{"name": "create_fact", "arguments": {"text": "Prefers morning meetings"}}
```
```text
Created fact 40000090: Prefers morning meetings
```
```json
{"name": "update_fact", "arguments": {"id": "40000090", "text": "Prefers meetings before noon", "confirmed": true}}
```
```text
- Prefers meetings before noon — id 40000090
```
`confirm_fact` marks a fact as confirmed. `delete_fact` removes it from Bee, and the archive keeps a copy.

### Voice notes

#### `list_voice_notes`
Voice notes, newest first. Bee calls these "journals". Bee only shares the text, not the audio.

| Argument | Meaning |
|---|---|
| `limit` | Default 20, max 100 |
| `cursor`, `from`, `to` | Paging and date range |

```text
- Oct 29, 2026, 6:20 PM | Pick up the dry cleaning before Friday — id k3v9x2mq7ptz4h8wn1c6rbya
```

#### `get_voice_note`
```json
{"name": "get_voice_note", "arguments": {"id": "k3v9x2mq7ptz4h8wn1c6rbya"}}
```
```text
# Voice note Oct 29, 2026, 6:20 PM

- id: k3v9x2mq7ptz4h8wn1c6rbya
- state: COMPLETED

Pick up the dry cleaning before Friday...
```

### Places

#### `list_visits`
Each place the owner stopped at, newest first.

| Argument | Meaning |
|---|---|
| `limit` | Default 30, max 100 |
| `cursor`, `from`, `to` | Paging and date range |
| `place` | Part of an address |

```text
- Nov 10, 2026, 12:55 PM | 410 Congress Avenue, Austin, Texas | 193.5 min — id visit-500000244
```

#### `list_places`
Frequent places, with visit counts.

| Argument | Meaning |
|---|---|
| `limit` | Default 50, max 100 |
| `cursor` | Paging |
| `place` | Part of an address |

```text
- 410 Congress Avenue, Austin, Texas | 25 visits | last Nov 10, 2026, 3:11 PM — id cluster-visit-500000605
```

### Photos

#### `list_photos`, `get_photo`
Photos synced to Bee. `list_photos` takes `limit`, `cursor`, `from` and `to`. `get_photo` returns the image itself as MCP image content; over REST, `GET /api/photos/<id>` returns the image file. There are none yet; this works as soon as one is taken.

### Archive and health

#### `list_archive`
Lists saved file paths, newest first. See section 8 for the layout.

| Argument | Meaning |
|---|---|
| `prefix` | Default `md/`. Examples: `md/daily/`, `raw/facts/`, `history/` |
| `limit` | Default 200, max 2000 |

#### `read_archive`
Reads one saved text file by its path. It works even when Bee is down. Photo files can't be read this way; use `get_photo`.
```json
{"name": "read_archive", "arguments": {"key": "md/daily/2026-11-08.md"}}
```

#### `get_status`
Health of the archive.
```json
{
  "backfillDone": true,
  "lastSync": "2026-11-10T20:17:48.509Z",
  "lastError": null,
  "syncFailuresInARow": 0,
  "lastFullCheck": "2026-11-10T20:09:04.369Z",
  "archived": { "conversations": 86, "dailies": 21, "insights": 40, "fact": 52, "todo": 9, "journal": 3, "visit": 120, "place": 34, "suggestion": 12, "external": 6, "brief": 7, "profile": 1 },
  "keptAfterLeavingBee": 2,
  "pending": 0,
  "retrying": 0,
  "threadsAccess": "no",
  "unhandledFeedTypes": null,
  "activeAlerts": []
}
```
| Field | Meaning |
|---|---|
| `lastSync` | When the last successful sync finished |
| `lastError` | The most recent problem, or `null` |
| `syncFailuresInARow` | Above 0 means syncing is currently failing |
| `keptAfterLeavingBee` | Items deleted from Bee but kept here |
| `pending`, `retrying` | Items waiting to be fetched, and how many failed at least once |
| `threadsAccess` | Whether Bee lets this account use chat threads (see section 13) |
| `activeAlerts` | Problems the owner has been alerted about and that haven't cleared |

#### `list_external_access`
Bee's log of outside services that read the owner's Bee data.
```text
- Nov 9, 2026, 6:10 PM | example-service: Reads recent summaries to suggest reminders
```

#### `sync_now`
Pulls the latest from Bee immediately instead of waiting up to 15 minutes. It runs for up to 25 seconds; anything left over continues on the next run.
```json
{"saved": {"conversation": 1, "fact": 2}, "deleted": 0, "failed": 0, "pending": 0, "webhooks": 0, "errors": [], "lastSync": "2026-11-10T20:16:00.856Z"}
```
If a sync is already running, it replies `{"skipped": "a sync is already running", ...}`. Wait a minute and read again.

---

## 6. Web links (REST)

Send the key as a header on every request. Most links return Markdown text; `.json`, `format=json` and `/api/status` return JSON. Query parameters use the same names as the tool arguments.

| Request | Same as |
|---|---|
| `GET /api/day/2026-11-08` (no date means today) | `get_day` |
| `GET /api/search?q=pricing&from=2026-11-01` | `search_conversations` |
| `GET /api/search?q=what%20did%20we%20plan&mode=neural` | `search_conversations`, neural mode |
| `GET /api/search/all?q=harbor` | `search_all` |
| `GET /api/conversations?limit=20&place=Austin&min_minutes=10` | `list_conversations` |
| `GET /api/conversations?format=json&limit=20` | Conversation list as JSON (`conversations` plus `next_cursor`) |
| `GET /api/conversations/10000123` | `get_conversation` |
| `GET /api/conversations/10000123?transcript=false` | `get_conversation` without the transcript |
| `GET /api/conversations/10000123.json` | Bee's original JSON for that conversation |
| `GET /api/daily?limit=7` | `list_daily_summaries` |
| `GET /api/insights` | `list_insights` |
| `GET /api/todos?show=open` | `list_todos` |
| `GET /api/todos/suggestions` | `list_todo_suggestions` |
| `GET /api/facts` | `list_facts` |
| `GET /api/voice-notes`, `GET /api/voice-notes/<id>` | `list_voice_notes`, `get_voice_note` |
| `GET /api/visits?from=2026-11-01` | `list_visits` |
| `GET /api/places` | `list_places` |
| `GET /api/photos`, `GET /api/photos/<id>` (image file) | `list_photos`, `get_photo` |
| `GET /api/brief?date=2026-11-10` | `get_today_brief` |
| `GET /api/external-access` | `list_external_access` |
| `GET /api/archive?prefix=md/daily/` | `list_archive` |
| `GET /api/archive/md/daily/2026-11-08.md` | `read_archive` |
| `GET /api/status` | `get_status` (JSON) |
| `POST /api/sync` | `sync_now` (JSON) |
| `POST /api/tools/<tool name>` with a JSON body | Any tool, including the write tools |

```bash
BEE=https://YOUR-WORKER.workers.dev
KEY=YOUR_KEY
curl -s -H "Authorization: Bearer $KEY" "$BEE/api/day/2026-11-08"
curl -s -H "Authorization: Bearer $KEY" "$BEE/api/search?q=pricing"
curl -s -H "Authorization: Bearer $KEY" "$BEE/api/todos?show=open"
curl -s -X POST -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -d '{"text":"Call the bank"}' "$BEE/api/tools/create_todo"
curl -s -X POST -H "Authorization: Bearer $KEY" "$BEE/api/sync"
```

---

## 7. How to answer common questions

| The owner asks | Do this |
|---|---|
| "What happened on Tuesday?" | `get_day` with that date |
| "What did I talk about with Sam?" | `search_conversations` for `Sam`, then `get_conversation` on the best match |
| "What did we decide about pricing?" | `search_conversations` for `pricing`; if nothing useful, retry with `mode: "neural"` and a question; then `get_conversation` |
| "Did I ever mention the harbor?" | `search_all` for `harbor` |
| "Where was I on Saturday?" | `list_visits` with `from` and `to` set to that date |
| "Where do I spend the most time?" | `list_places` |
| "What are my open action items?" | `list_todos` with `show: "open"`, plus the action items in recent `get_conversation` results |
| "Add a todo to call the bank tomorrow at 10" | `create_todo` with `alarm_at` converted to UTC |
| "Mark that done" | `complete_todo` |
| "What does Bee know about me?" | `list_facts` |
| "That fact is wrong" | `update_fact` or `delete_fact`, only when the owner says so |
| "What's on my calendar today?" | `get_today_brief` |
| "What did I say in my voice note?" | `list_voice_notes`, then `get_voice_note` |
| "I just finished a meeting, what was it about?" | `sync_now`, then `list_conversations` with `limit: 1` |
| "Is this working?" | `get_status` |
| Bee itself is down | Keep going; every read tool except neural search and `get_related_conversations` works from the archive |

**Good practice**
- **Cite your source:** give the conversation title and date when quoting.
- **Be careful with transcripts:** they're raw speech-to-text. Speakers are often `Unknown`, a TV or a nearby stranger may be recorded, and wording can be garbled. Say so when a quote matters.
- **Skip transcripts when you can:** use `include_transcript: false` unless the exact words matter.
- **Only change things when asked:** create, change or delete todos and facts only when the owner asks.
- **Check for more pages:** when a list ends with `next_cursor`, there's more.

---

## 8. The permanent archive

Everything lives in the owner's Cloudflare R2 bucket and can be listed and read with `list_archive` and `read_archive`.

### Readable files (`md/`)
| Path | Contents |
|---|---|
| `md/conversations/<YYYY-MM-DD>/<id>.md` | One conversation with transcript |
| `md/daily/<YYYY-MM-DD>.md` | That day's recap |
| `md/insights/<YYYY-MM-DD>/<id>.md` | One insight |
| `md/journals/<YYYY-MM-DD>/<id>.md` | One voice note |
| `md/briefs/<YYYY-MM-DD>.md` | That day's calendar and email brief |
| `md/todos.md` | Every current todo |
| `md/facts.md` | Every current fact |

### Bee's original data (`raw/`)
One JSON file per item, exactly as Bee sent it: `raw/<type>/<id>.json`. The types are:

| Folder | Holds |
|---|---|
| `raw/conversations/` | Conversations |
| `raw/daily/` | Daily recaps |
| `raw/insights/` | Insights |
| `raw/facts/` | Facts |
| `raw/todos/` | Todos |
| `raw/journals/` | Voice notes |
| `raw/visits/` | Place visits |
| `raw/places/` | Frequent places |
| `raw/photos/` | Photo details |
| `raw/todo-suggestions/` | Suggested todos |
| `raw/external-access/` | Outside-access log |
| `raw/briefs/` | Daily calendar and email briefs |
| `raw/profile/` | the owner's Bee profile |
| `raw/threads/` | Chat threads, once Bee allows them |

### Earlier versions (`history/`)
When an item changes in Bee, the previous version is kept at `history/<type>/<id>/<timestamp>.json`.

### Photo files (`files/`)
`files/photos/<id>`: read with `get_photo` or `GET /api/photos/<id>`.

### Deleted items
Items deleted, dismissed or accepted in Bee stay in the archive. They're hidden from lists and search unless you pass `include_removed: true`, and `get_conversation` still returns them.

---

## 9. How syncing works

| How often | What |
|---|---|
| Every 15 minutes | Bee's "what changed" feed. New or edited conversations, recaps, insights, facts, todos and voice notes are fetched and saved one by one, so one bad item never blocks the rest. Failed items retry with growing gaps. |
| Hourly | Place visits, suggested todos, today's brief, photos |
| Daily | A full comparison against Bee to catch anything missed or deleted, plus frequent places, the outside-access log, the profile and chat threads |

If the optional `PUSHBULLET_TOKEN` secret is set, the owner gets a phone alert through Pushbullet when:
- Bee rejects the saved key
- three syncs in a row fail
- an item keeps failing to save
- nothing new arrives for 24 hours
- a webhook gives up

They get one alert per problem, at most once a day, and a "recovered" message when it clears.

---

## 10. Limits, paging and time zone

| Tool | Default | Max |
|---|---|---|
| `list_conversations` | 20 | 100 |
| `search_conversations` | 10 | 50 |
| `search_all` | 15 | 50 |
| `list_daily_summaries` | 7 | 30 |
| `list_insights` | 20 | 50 |
| `list_todos`, `list_facts` | 200 | 500 |
| `list_voice_notes`, `list_photos` | 20 | 100 |
| `list_visits` | 30 | 100 |
| `list_places` | 50 | 100 |
| `list_todo_suggestions`, `list_external_access` | 50 | 200 |
| `list_archive` | 200 | 2000 |

- **Paging:** a list with more results ends with `next_cursor: <value>`. Pass that value as `cursor` to get the next page. Cursors look like `1793123456000_812`.
- **Time zone:** times shown are in the owner's time zone, and dates (`from`, `to`, `date`) are days in that zone. `alarm_at` is given in UTC, such as `2026-11-12T15:00:00Z`.
- **Freshness:** reads are at most 15 minutes behind Bee. `sync_now` closes the gap.
- **Ids:** conversation, todo, fact, insight and recap ids are numbers. Voice note, visit and place ids are text.

---

## 11. Errors and troubleshooting

| You get | It means | Do this |
|---|---|---|
| `401 {"error":"unauthorized"}` | Missing or wrong key, or the key was put in `?token=` | Send the header, or use the `/mcp/<key>` address |
| `400 {"error":"..."}` | A bad argument, such as `id must be a number` or `from must look like 2026-10-30` | Fix the argument the message names |
| `403 {"error":"This key can't use ..."}` | An admin-only tool | See section 12 |
| `404 {"error":"..."}` | No such item, file or link | Check the id or path |
| `405` | Wrong method, such as `GET /api/sync` or `GET /mcp` | Use `POST` |
| `502 {"error":"Bee API ..."}` | Bee itself failed, on a call that needs Bee live (neural search, related conversations, writes, today's brief) | Use the archive tools, or try again later |
| MCP `"isError": true` | The tool failed; the text says why | Read the text |
| `sync_now` says `skipped` | Another sync is running | Wait a minute and read again |
| Recent conversation missing | Up to 15 minutes behind, or still recording | `sync_now`, or `list_conversations` with `state: "CAPTURING"` |
| Agent doesn't see a tool | It connected before the tool existed | Restart the agent or open a new chat |
| `get_status` shows `syncFailuresInARow` above 0 | Syncing is failing | Check `lastError`; reads still work from the archive |

---

## 12. Admin-only features

These tools need the **admin key** (made on the setup page, or the `ADMIN_TOKEN` secret). Agent keys can't use them and don't see them in their tool list. Send the admin key as a header only; it is refused in a URL.

| Tool | What it does |
|---|---|
| `create_key`, `list_keys`, `revoke_key` | One key per agent: create, see who used theirs and when, and cut one off without touching the others |
| `add_webhook`, `list_webhooks`, `remove_webhook`, `list_webhook_deliveries` | Send events to an address as new data arrives |
| `rebuild_index` | Rebuild the search index from the archive alone, without calling Bee |
| `send_test_alert` | Send a test alert to the owner's phone |

### Webhooks, for anyone building a receiver
- **Events:**
  - `conversation.completed`: sent once a conversation finishes recording
  - `daily.created`, `insight.created`, `fact.created`, `todo.created`, `journal.created`, `photo.created`
  - `*` subscribes to all of them
- **Timing:** delivered within 15 minutes of the data reaching BeeCloud.
- **Retries:** if the receiver fails, it retries with growing gaps (at least 1, 5, 15, 60, 360 and 1,440 minutes, checked every 15 minutes) for about a day, then gives up and alerts the owner.
- **Request:** `POST` with JSON and these headers:
  - `X-Bee-Event`: the event name
  - `X-Bee-Delivery`: a delivery id
  - `X-Bee-Signature`: `sha256=<hex>`, an HMAC-SHA256 of the raw body using the webhook's secret

`conversation.completed` body:
```json
{
  "event": "conversation.completed",
  "id": 10000123,
  "title": "Pricing the onboarding package",
  "start_time": 1793123456000,
  "end_time": 1793125766000,
  "summary": "## Summary ...",
  "markdown": "# Pricing the onboarding package\n\n- id: 10000123\n..."
}
```
Other events send `{"event": ..., "id": ..., "data": <Bee's original JSON>, "markdown": ...}`.

Verifying the signature in Python:
```python
import hmac, hashlib
expected = "sha256=" + hmac.new(secret.encode(), raw_body, hashlib.sha256).hexdigest()
ok = hmac.compare_digest(expected, request.headers["X-Bee-Signature"])
```

---

## 13. What isn't available

| Not available | Why |
|---|---|
| Asking Bee's own assistant, and Bee chat threads | Bee only allows these for its test users. BeeCloud checks daily and starts saving threads automatically if the owner's account gets access (`threadsAccess` in `get_status`). |
| Voice note audio | Bee only shares the text. |
| Instant updates | Data is at most 15 minutes behind. Bee's live stream needs an always-on connection, which BeeCloud doesn't keep. |
| Speaker names | Bee labels most speakers `Unknown`. |

---

## 14. A ready-to-paste prompt for any agent

```text
You have access to BeeCloud, the permanent archive of my Amazon Bee wearable: recorded conversations with transcripts, daily recaps, insights, voice notes, todos, facts, places I visited and calendar briefs. It updates every 15 minutes.

CONNECT
- MCP server (Streamable HTTP): https://YOUR-WORKER.workers.dev/mcp
- Header: Authorization: Bearer YOUR_KEY
- If you can't send headers, use this address instead: https://YOUR-WORKER.workers.dev/mcp/YOUR_KEY
- If you can't use MCP, call https://YOUR-WORKER.workers.dev/api/tools/<tool name> with POST, a JSON body of arguments, and the same header.
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
- Times are in my time zone. Lists are paged: pass next_cursor back as cursor.
- The key above is private. Never repeat it, share it or put it anywhere public.
```

---
