// Bee developer API client. Bee is the feed; the archive is the source of truth.
import { getKv } from "./db";
import { Env, HttpError, Json } from "./env";

const TIMEOUT_MS = 20_000;
const MAX_PAGES = 200;

export class BeeError extends Error {
  constructor(public status: number, public path: string, public body: string) {
    super(`Bee API ${path} -> ${status || "unreachable"}: ${body.slice(0, 300)}`);
  }
  get authFailed() {
    return this.status === 401 || (this.status === 403 && !this.path.startsWith("/v1/threads"));
  }
  get notFound() {
    return this.status === 404;
  }
  get unavailable() {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }
}

export const qs = (p: Record<string, any>) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(p)) if (v !== undefined && v !== null && v !== "") s.set(k, String(v));
  const out = s.toString();
  return out ? `?${out}` : "";
};

// The Bee key comes from the BEE_TOKEN secret if set, else from the setup page (saved in D1).
let cached: { token: string; at: number } | null = null;
export async function beeToken(env: Env): Promise<string | null> {
  if (env.BEE_TOKEN) return env.BEE_TOKEN;
  if (cached && Date.now() - cached.at < 60_000) return cached.token;
  const token = await getKv(env, "bee_token");
  cached = token ? { token, at: Date.now() } : null;
  return token;
}
export const forgetBeeToken = () => void (cached = null);

export async function beeResponse(env: Env, path: string, init: RequestInit = {}): Promise<Response> {
  const token = await beeToken(env);
  if (!token) throw new HttpError(503, "Bee isn't connected yet. Open this Worker's address in a browser to finish setup.");
  const canRetry = !init.method || init.method === "GET"; // never repeat a write
  for (let attempt = 0; ; attempt++) {
    let res: Response | undefined;
    let failure = "";
    try {
      res = await fetch(env.BEE_API + path, {
        ...init,
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers || {}) },
      });
      if (res.ok) return res;
      failure = await res.text();
    } catch (e: any) {
      failure = e.message;
    }
    const err = new BeeError(res?.status ?? 0, path, failure);
    if (!canRetry || attempt > 0 || !err.unavailable) throw err;
    await new Promise((r) => setTimeout(r, 500));
  }
}

export async function bee(env: Env, path: string, init: RequestInit = {}): Promise<Json> {
  const res = await beeResponse(env, path, init);
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

// Walks a cursor-paginated list. `onPage` returning false stops early.
export async function walk(env: Env, path: string, key: string, onPage: (rows: Json[], page: Json) => Promise<boolean | void>, limit = 100): Promise<void> {
  let cursor: string | undefined;
  for (let i = 0; i < MAX_PAGES; i++) {
    const page = await bee(env, `${path}${qs({ limit, cursor })}`);
    if ((await onPage(page[key] || [], page)) === false) return;
    cursor = page.next_cursor || undefined;
    if (!cursor) return;
  }
}
