---
name: bee-cloud
description: Read and manage the user's Bee wearable data through BeeCloud, their permanent cloud archive. Covers recorded conversation and meeting transcripts, summaries, action items, daily recaps, insights, voice notes, todos, facts, places visited, photos and calendar briefs. Use whenever the user mentions Bee, a meeting or conversation they had, "what did we talk about", what happened on a day, where they were, their daily summary, or todos from their wearable.
---

# BeeCloud

The user's Bee wearable records their conversations. BeeCloud copies everything from Bee into the user's own Cloudflare account every 15 minutes and keeps it permanently. Reads come from that archive, so they keep working even if Bee is down.

Before installing this skill, replace `https://YOUR-WORKER.workers.dev` with the BeeCloud address and `YOUR_KEY` with an agent key from the setup page. After that this file is private.

## Connect

- **MCP (Streamable HTTP):** `https://YOUR-WORKER.workers.dev/mcp` with header `Authorization: Bearer YOUR_KEY`
- **If the client can't send headers:** `https://YOUR-WORKER.workers.dev/mcp/YOUR_KEY`
- **Plain HTTPS:** `https://YOUR-WORKER.workers.dev/api/...` with the same header

If an MCP server named `bee-cloud` is already connected, use its tools directly. Otherwise use the web links below.

## How to answer

1. **"What happened on <day>":** `get_day` with the date. One call returns the recap, conversations, voice notes, insights, places and calendar.
2. **"What did I talk about with X" / "about Y":** `search_conversations`, then `get_conversation` for the match. If keyword search misses, retry with `mode: "neural"`. Filter with `from`, `to`, `place`.
3. **Searching beyond conversations:** `search_all` covers recaps, insights, facts, todos and voice notes.
4. **"Where was I":** `list_visits`, or `list_places` for frequent places.
5. **Todos:** `list_todos`, `create_todo`, `complete_todo`, `update_todo`, `delete_todo`, and `list_todo_suggestions` with `accept_todo_suggestion` or `dismiss_todo_suggestion`.
6. **Facts:** `list_facts`, `create_fact`, `update_fact`, `confirm_fact`, `delete_fact`.
7. **Also:** `list_voice_notes`, `get_voice_note`, `list_daily_summaries`, `list_insights`, `list_photos`, `get_photo`, `get_today_brief`, `get_related_conversations`, `list_external_access`.
8. **Archive files:** `list_archive` and `read_archive`. `md/` is readable, `raw/` is Bee's original data, `history/` holds earlier versions of edited items.
9. **Health or freshness:** `get_status`. Call `sync_now` if the very latest recording matters.

Only change or delete todos and facts when the user asks. Cite the conversation title and date when quoting. Transcripts are raw speech-to-text: speakers are often "Unknown" and wording can be garbled. Lists are paged: pass `next_cursor` back as `cursor`.

## Web links

```bash
BEE=https://YOUR-WORKER.workers.dev
KEY=YOUR_KEY
curl -s -H "Authorization: Bearer $KEY" "$BEE/api/day/2026-11-08"
curl -s -H "Authorization: Bearer $KEY" "$BEE/api/search?q=roadmap&from=2026-11-01"
curl -s -H "Authorization: Bearer $KEY" "$BEE/api/search/all?q=harbor"
curl -s -H "Authorization: Bearer $KEY" "$BEE/api/conversations?limit=20&min_minutes=10"
curl -s -H "Authorization: Bearer $KEY" "$BEE/api/conversations/<id>?transcript=false"
curl -s -H "Authorization: Bearer $KEY" "$BEE/api/todos?show=open"
curl -s -H "Authorization: Bearer $KEY" "$BEE/api/visits?from=2026-11-01"
curl -s -H "Authorization: Bearer $KEY" "$BEE/api/status"
curl -s -X POST -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -d '{"text":"call the bank"}' "$BEE/api/tools/create_todo"
```

`POST /api/tools/<tool name>` with a JSON body reaches every tool. The full reference is `docs/GUIDE.md` in the BeeCloud repository.
