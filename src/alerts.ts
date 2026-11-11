// Phone alerts through Pushbullet. One alert per problem, repeated at most daily,
// plus one "recovered" note when it clears.
import { getKv, setKv } from "./db";
import { DAY_MS, Env } from "./env";

async function push(env: Env, title: string, body: string): Promise<boolean> {
  if (!env.PUSHBULLET_TOKEN) return false;
  try {
    const res = await fetch("https://api.pushbullet.com/v2/pushes", {
      method: "POST",
      headers: { "Access-Token": env.PUSHBULLET_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({ type: "note", title, body }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) console.error("pushbullet failed", res.status);
    return res.ok;
  } catch (e: any) {
    console.error("pushbullet failed", e.message);
    return false;
  }
}

export async function raise(env: Env, key: string, title: string, body: string): Promise<void> {
  const last = await getKv(env, `alert:${key}`);
  if (last && Date.now() - Number(last) < DAY_MS) return;
  if (await push(env, `BeeCloud: ${title}`, body)) await setKv(env, `alert:${key}`, Date.now());
}

export async function clear(env: Env, key: string, message: string): Promise<void> {
  const last = await getKv(env, `alert:${key}`);
  if (!last) return;
  await env.DB.prepare(`DELETE FROM kv WHERE key = ?`).bind(`alert:${key}`).run();
  await push(env, "BeeCloud: recovered", message);
}

export const sendTestAlert = (env: Env, message: string) => push(env, "BeeCloud: test alert", message);
