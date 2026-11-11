# Working on BeeCloud

BeeCloud is one Cloudflare Worker that archives a Bee wearable's data into R2 and D1 and serves it over MCP and REST. See `README.md` for what it does and `docs/GUIDE.md` for every tool.

- Run `npm run check` before any change is called done. It type-checks and runs the Worker in Cloudflare's local runtime against a fake Bee (`tests/harness.mjs`).
- Never lose data: R2 keeps Bee's original JSON forever, edits keep earlier versions under `history/`, and items gone from Bee are marked, never removed.
- Keep existing tool names and arguments working. Agents in the wild depend on them.
- A sync run must be safe to kill at any moment: save progress per item, and only move a cursor after the work it covers is saved.
- Keys are stored as hashes and never logged. Admin keys are never accepted in a URL.
- No personal data in tests or docs. Fixtures are fictional.
- The test runtime (miniflare 4) only accepts compatibility dates up to 2026-08-06, which is why `wrangler.jsonc` and the tests pin 2026-08-01.
