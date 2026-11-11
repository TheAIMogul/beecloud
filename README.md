# BeeCloud

**Your Bee wearable, archived in your own Cloudflare account and ready for your AI agents.**

[Bee](https://www.bee.computer/) is an Amazon wearable that records your conversations and turns them into summaries, todos and facts. That data lives inside Bee's app. BeeCloud copies all of it into storage you own, keeps it permanently, and gives Claude, ChatGPT-style agents and any other MCP tool a way to search it and act on it.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/TheAIMogul/beecloud)

- **Everything, forever:** conversations with full transcripts, daily recaps, insights, voice notes, todos, facts, places visited, photos and calendar briefs, saved in Bee's original format. Edits keep their earlier versions. Things you delete in Bee stay in your archive.
- **Works when Bee is down:** search and lists read from your own archive.
- **33 tools for agents:** "what happened on Tuesday", "what did we decide about pricing", "add a todo", "where was I on Saturday".
- **Yours alone:** it runs in your Cloudflare account. No third-party server ever sees your data.
- **No computer needed:** it syncs from the cloud every 15 minutes.

BeeCloud is an independent open-source project. It is not affiliated with or endorsed by Amazon or Bee.

---

## What you need

| | |
|---|---|
| A Bee wearable | With the Bee phone app |
| A Cloudflare account | The **Workers Paid plan ($5/month)** is what BeeCloud is built and tested on. The free plan's limits are likely too tight for the first import; it is untested. BeeCloud's own usage sits far inside what the paid plan includes. |
| A GitHub account | The deploy button copies this code into your account so you own it |

## Set up in about five minutes

### 1. Deploy
Click **Deploy to Cloudflare** above. Cloudflare copies the code into your GitHub, creates the storage bucket and database, and deploys. You don't need to enter any secrets.

When it finishes you get an address like `https://beecloud.YOUR-NAME.workers.dev`.

### 2. Create your admin key
Open that address in a browser and press **Create admin key**. Save the key in a password manager. It is shown once.

Do this right after deploying: the first person to open a fresh install creates the admin key.

### 3. Connect your Bee
1. In the Bee phone app, open **Settings** and tap **Version** five times. This turns on Developer Mode.
2. On the setup page press **Connect**, then **Open Bee approval**, and approve the request.

BeeCloud starts importing your history right away. The first import takes a few minutes; after that it checks Bee every 15 minutes.

### 4. Give your agents access
On the setup page, type a name (such as `claude`) and press **Create key**. You get that agent's key plus ready-to-paste connection details:

- **claude.ai:** Settings → Connectors → Add custom connector, and paste the connector URL.
- **Claude Code:** paste the `claude mcp add ...` command.
- **Anything else:** paste the prompt, or add the MCP address and header to the tool's config:

```json
{
  "mcpServers": {
    "bee-cloud": {
      "type": "http",
      "url": "https://beecloud.YOUR-NAME.workers.dev/mcp",
      "headers": { "Authorization": "Bearer YOUR_AGENT_KEY" }
    }
  }
}
```

Make one key per agent. You can revoke any one of them from the setup page without touching the others.

### 5. Try it
Ask your agent:

- "What happened yesterday?"
- "What did I talk about with Sam last week?"
- "What are my open todos?"
- "Add a todo to call the bank tomorrow at 10."

---

## What agents can do

| Ask | Tool |
|---|---|
| Everything about one day | `get_day` |
| Find a conversation by person or topic | `search_conversations`, then `get_conversation` |
| Search recaps, insights, facts, todos and voice notes too | `search_all` |
| Browse conversations by date, place or length | `list_conversations` |
| Daily recaps and insights | `list_daily_summaries`, `list_insights` |
| Todos: read, add, edit, complete, delete | `list_todos`, `create_todo`, `update_todo`, `complete_todo`, `delete_todo` |
| Bee's suggested todos | `list_todo_suggestions`, `accept_todo_suggestion`, `dismiss_todo_suggestion` |
| Facts about you: read, add, edit, confirm, delete | `list_facts`, `create_fact`, `update_fact`, `confirm_fact`, `delete_fact` |
| Voice notes | `list_voice_notes`, `get_voice_note` |
| Where you've been | `list_visits`, `list_places` |
| Photos | `list_photos`, `get_photo` |
| Today's calendar and email brief | `get_today_brief` |
| Read the raw archive | `list_archive`, `read_archive` |
| Health and freshness | `get_status`, `sync_now` |

Every tool, with arguments and examples: **[docs/GUIDE.md](docs/GUIDE.md)**.
A prompt to paste into any agent: **[docs/AGENT-PROMPT.md](docs/AGENT-PROMPT.md)**.
A skill for agents that load skills: **[docs/skill/bee-cloud/SKILL.md](docs/skill/bee-cloud/SKILL.md)**.

No MCP? Every tool is also a plain web link: `POST /api/tools/<tool name>` with a JSON body and the `Authorization: Bearer` header.

---

## How it works

```
Bee's servers ──every 15 min──▶ BeeCloud Worker ──▶ R2 bucket  (every item, original format, forever)
                                      │        └──▶ D1 database (search index, sync queue, agent keys)
                                      ▼
                         MCP at /mcp and web links at /api/*  ◀── your agents
```

- **Sync:** every 15 minutes BeeCloud asks Bee what changed and saves each item on its own, so one bad item never blocks the rest. Once a day it compares everything against Bee to catch anything missed or deleted.
- **Archive:** `raw/` holds Bee's original JSON, `md/` holds readable versions, `history/` holds earlier versions of edited items.
- **Search:** a full-text index in D1. If the database is ever lost, the `rebuild_index` tool rebuilds it from the bucket without calling Bee.
- **Sign-in to Bee:** the setup page uses the same approval flow as Bee's official open-source command-line tool ([bee-cli](https://github.com/bee-computer/bee-cli)) and Bee's documented [developer API](https://docs.bee.computer/docs/api).

## Security and privacy

- **Your account only.** All data stays in your Cloudflare account. The Worker talks to Bee, and to Pushbullet if you turn alerts on. Nothing else.
- **Keys are hashed.** Admin and agent keys are stored as SHA-256 hashes and shown once.
- **Scoped keys.** Agent keys can read everything and change todos and facts. Only the admin key can make keys or webhooks.
- **Keys in headers.** The one exception is `/mcp/<agent key>`, for tools that can't send headers such as claude.ai connectors. Treat that URL like a password. Admin keys are refused in a URL.
- **Your Bee token** is stored in your D1 database after you approve the connection. To hold it as a Worker secret instead, set `BEE_TOKEN`.
- **This is sensitive data.** Conversation transcripts can include other people. Follow the recording and consent laws where you live, and only give keys to tools you trust.

## Optional settings

Set these as secrets on the Worker (Cloudflare dashboard → your Worker → Settings → Variables and Secrets):

| Secret | What it does |
|---|---|
| `PUSHBULLET_TOKEN` | Phone alerts through [Pushbullet](https://www.pushbullet.com/) when Bee rejects the key, syncing keeps failing, an item won't save, or nothing new arrives for 24 hours |
| `ADMIN_TOKEN` | A fixed admin key. Also how you get back in if you lose the one from the setup page |
| `BEE_TOKEN` | A Bee developer token, used instead of the one saved by the setup page |

Webhooks (get a POST when a conversation finishes, with retries and signatures) are set up with the admin key. See section 12 of the guide.

## Cost

BeeCloud itself adds no charge beyond Cloudflare's Workers Paid plan at personal-use volumes. Measured on one real install: about 3,000 sync runs a month against 10 million included requests, 5.5 MB of files after the first import against 10 GB included, and a 5 MB database against 5 GB included. Check [Cloudflare's pricing](https://developers.cloudflare.com/workers/platform/pricing/) for current numbers.

## Limits

- **Up to 15 minutes behind.** Agents can call `sync_now` when the very latest matters.
- **Voice notes are text only.** Bee doesn't share the audio.
- **No Bee chat threads or "ask Bee".** Bee limits those to its test users. BeeCloud checks daily and starts saving threads if your account gets access.
- **Speakers are often "Unknown".** Transcripts are raw speech-to-text.
- **Bee's developer API can change.** This project depends on it.

## Troubleshooting

| Problem | Fix |
|---|---|
| Connect says Bee rejected the request | Update the Bee app, tap Version five times again, then press Connect |
| The approval link expired | Press **Start again** on the setup page |
| Lost the admin key | Set an `ADMIN_TOKEN` secret on the Worker and sign in with that value |
| Someone else created the admin key first | Set an `ADMIN_TOKEN` secret, sign in with it, then revoke the key named `admin` with the `revoke_key` tool |
| Agent doesn't see the tools | Restart the agent or open a new chat |
| An agent gets `401` | The key is wrong or revoked. Make a new one on the setup page |
| Data looks stale | Open the setup page: it shows the last sync and the latest problem |

## Run it yourself, without the button

```bash
git clone https://github.com/TheAIMogul/beecloud && cd beecloud
npm install
npx wrangler login
npx wrangler r2 bucket create beecloud-archive
npx wrangler d1 create beecloud-index
```

Put the `database_id` that the last command prints into `wrangler.jsonc`, then:

```bash
npm run deploy
```

## Development

```bash
npm run check
```

That type-checks and runs the tests: the real Worker inside Cloudflare's local runtime with real D1 and R2, against a fake Bee. No Bee account or Cloudflare account is needed to run them.

| Path | What's there |
|---|---|
| `src/sync.ts` | The sync engine |
| `src/archive.ts` | How each kind of Bee data is stored and indexed |
| `src/tools.ts` | Every tool, shared by MCP and the web links |
| `src/setup.ts`, `src/page.ts` | First-time setup and Bee sign-in |
| `src/auth.ts` | Keys and scopes |
| `tests/` | The test suite and the fake Bee |

Issues and pull requests are welcome.

## License

[MIT](LICENSE)
