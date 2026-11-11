// D1: the search index, sync queue, keys and webhooks. R2 holds the data itself,
// so this whole database can be rebuilt from the archive (see rebuildIndex).
import { DEFAULT_TZ, Env } from "./env";

const SCHEMA_VERSION = "1";
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS items (
    rid INTEGER PRIMARY KEY,
    type TEXT NOT NULL, id TEXT NOT NULL,
    ts INTEGER NOT NULL, day TEXT NOT NULL, title TEXT,
    state TEXT, place TEXT, minutes REAL, meta TEXT,
    hash TEXT NOT NULL, sig TEXT NOT NULL,
    first_seen INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER,
    UNIQUE (type, id))`,
  `CREATE INDEX IF NOT EXISTS items_by_time ON items (type, ts DESC, rid DESC)`,
  `CREATE INDEX IF NOT EXISTS items_by_day ON items (day, type)`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(title, body, tokenize = 'porter unicode61')`,
  `CREATE TABLE IF NOT EXISTS pending (
    type TEXT NOT NULL, id TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0, next_try INTEGER NOT NULL DEFAULT 0, last_error TEXT,
    PRIMARY KEY (type, id))`,
  `CREATE TABLE IF NOT EXISTS api_keys (
    name TEXT PRIMARY KEY, hash TEXT NOT NULL UNIQUE, scope TEXT NOT NULL,
    created_at INTEGER NOT NULL, last_used_at INTEGER, revoked_at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS webhooks (
    id INTEGER PRIMARY KEY, url TEXT NOT NULL UNIQUE, secret TEXT NOT NULL,
    events TEXT NOT NULL, created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS deliveries (
    id INTEGER PRIMARY KEY, webhook_id INTEGER NOT NULL, event TEXT NOT NULL,
    item_type TEXT NOT NULL, item_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0, next_try INTEGER NOT NULL DEFAULT 0,
    last_status INTEGER, last_error TEXT, created_at INTEGER NOT NULL, delivered_at INTEGER)`,
  `CREATE INDEX IF NOT EXISTS deliveries_due ON deliveries (status, next_try)`,
];

let ready: Promise<void> | null = null;

export function ensureSchema(env: Env): Promise<void> {
  ready ??= (async () => {
    const current = await env.DB.prepare(`SELECT value FROM kv WHERE key = 'schema_version'`)
      .first<string>("value")
      .catch(() => null);
    if (current === SCHEMA_VERSION) return;
    await env.DB.batch([
      ...SCHEMA.map((s) => env.DB.prepare(s)),
      env.DB.prepare(`INSERT INTO kv (key, value) VALUES ('schema_version', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`).bind(SCHEMA_VERSION),
    ]);
  })().catch((e) => {
    ready = null;
    throw e;
  });
  return ready;
}

export const getKv = (env: Env, key: string) => env.DB.prepare(`SELECT value FROM kv WHERE key = ?`).bind(key).first<string>("value");

export const kvStatement = (env: Env, key: string, value: string | number) =>
  env.DB.prepare(`INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`).bind(key, String(value));

export const setKv = (env: Env, key: string, value: string | number) => kvStatement(env, key, value).run();

export const getTz = async (env: Env): Promise<string> => (await getKv(env, "timezone")) || DEFAULT_TZ;
