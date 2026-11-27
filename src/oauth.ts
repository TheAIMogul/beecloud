// Standard sign-in (OAuth 2.1 with PKCE and dynamic client registration) for apps such as the
// Gemini app and claude.ai that can't send a key in a header. They find it through the usual
// discovery documents, open /authorize, and the owner types the BeeCloud password or admin key
// once. The library handles discovery, registration and tokens; this file is the login page and
// the handler that serves signed-in requests. Keys in headers still work as before.
// It is on whenever the Worker has the OAUTH_KV binding and is reached over HTTPS.
import { AuthorizationError, OAuthProvider, type ConsentDescription } from "@cloudflare/workers-oauth-provider";
import { Caller, clientIp, isOwnerSecret, lockedOut, recordFailure } from "./auth";
import { Env } from "./env";
import { handleMcp } from "./mcp";
import { handleRest } from "./rest";

const SCOPE = "beecloud";
const DAY_S = 86_400;
// Tokens issued by the library look like userId:grantId:secret. BeeCloud keys never contain ':'.
export const OAUTH_TOKEN = /^Bearer [^:\s]+:[^:\s]+:[^:\s]+$/;
export const OAUTH_PATHS = ["/.well-known/oauth-authorization-server", "/.well-known/oauth-protected-resource", "/.well-known/openid-configuration", "/register", "/oauth/token", "/oauth/revoke", "/authorize"];

const SIGNED_IN: Caller = { name: "signed-in app", scope: "write" };

const apiHandler = {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/")) return handleRest(url, req, env, SIGNED_IN);
    return handleMcp(req, env, SIGNED_IN);
  },
};

const defaultHandler = {
  fetch: (req: Request, env: Env) => (new URL(req.url).pathname === "/authorize" ? authorize(req, env) : Response.json({ error: "not found" }, { status: 404 })),
};

const providers = new Map<string, OAuthProvider<Env>>();

// Sign-in needs its storage and a secure address (the library requires HTTPS resource URLs).
export const oauthEnabled = (env: Env, url: URL) => !!env.OAUTH_KV && url.protocol === "https:";

// One provider per address the Worker is reached on (workers.dev, a custom domain).
export function oauthProvider(base: string): OAuthProvider<Env> {
  const found = providers.get(base);
  if (found) return found;
  const provider = new OAuthProvider<Env>({
    apiRoute: ["/mcp", "/api/"],
    apiHandler,
    defaultHandler,
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/oauth/token",
    clientRegistrationEndpoint: "/register",
    scopesSupported: [SCOPE, "offline_access"],
    requiredScopes: [SCOPE],
    // The whole address is one resource, so apps work whether they were given the main address or /mcp.
    resourceMetadata: { resource: base, resource_name: "BeeCloud" },
    accessTokenTTL: 3600,
    // Stay signed in while the app keeps using it; sign in again after 60 idle days.
    refreshTokenTTL: 365 * DAY_S,
    refreshTokenIdleTTL: 60 * DAY_S,
  });
  providers.set(base, provider);
  return provider;
}

// Apps that were given the /mcp address may ask for a token for that address. It's the same
// service, so treat it as the main address, which is the one resource the library knows.
export async function withMainResource(req: Request, base: string): Promise<Request> {
  const fix = (params: URLSearchParams) => {
    const all = params.getAll("resource");
    if (!all.some((r) => r === `${base}/mcp` || r === `${base}/mcp/`)) return false;
    params.delete("resource");
    for (const r of all) params.append("resource", r.startsWith(`${base}/mcp`) ? base : r);
    return true;
  };
  const url = new URL(req.url);
  let changed = fix(url.searchParams);
  let body: BodyInit | null = req.body;
  if (req.method === "POST" && (req.headers.get("Content-Type") || "").startsWith("application/x-www-form-urlencoded")) {
    const form = new URLSearchParams(await req.text());
    if (fix(form)) changed = true;
    body = form.toString();
  }
  if (!changed && body === req.body) return req;
  return new Request(url, { method: req.method, headers: req.headers, body, redirect: "manual" });
}

// ---------- The login page ----------

const esc = (v: string) => v.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function loginPage(d: ConsentDescription, handle: string, error = ""): string {
  const name = esc(d.clientName);
  const from = d.clientDomain ? `Published by <strong>${esc(d.clientDomain)}</strong>.` : "This app named itself; its name isn't verified.";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Sign in to BeeCloud</title>
<style>
:root{--ink:#14171a;--muted:#6b7280;--line:#e6e8eb;--bg:#fbfbfa;--accent:#0f766e;--accent-ink:#fff;--bad:#b42318}
@media (prefers-color-scheme:dark){:root{--ink:#eef0f2;--muted:#9aa3ad;--line:#262b31;--bg:#0e1013;--accent:#5eead4;--accent-ink:#0e1013;--bad:#f97066}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased}
main{max-width:420px;margin:0 auto;padding:72px 20px}
h1{font-size:24px;line-height:1.25;margin:0 0 8px;letter-spacing:-.01em}
p{margin:8px 0;color:var(--muted)}
p strong{color:var(--ink)}
.warn{color:var(--ink);border-left:2px solid var(--bad);padding-left:10px}
label{display:block;font-size:14px;font-weight:600;margin:28px 0 6px}
input{font:inherit;width:100%;padding:11px 12px;border:1px solid var(--line);border-radius:8px;background:transparent;color:var(--ink)}
input:focus{outline:2px solid var(--accent);outline-offset:1px}
.error{color:var(--bad);font-size:14px;margin:8px 0 0}
.buttons{display:flex;gap:10px;margin-top:20px}
button{font:inherit;font-weight:600;border-radius:8px;padding:11px 18px;cursor:pointer;border:1px solid var(--line);background:transparent;color:var(--ink)}
button.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-ink);flex:1}
.small{font-size:13px;margin-top:28px;border-top:1px solid var(--line);padding-top:16px}
</style>
</head>
<body>
<main>
<h1>Allow ${name} to use BeeCloud?</h1>
<p>It will be able to read your Bee conversations, recaps and notes, and change todos and facts.</p>
<p>${from} Access goes to <strong>${esc(d.redirectHost)}</strong>.</p>
${d.redirectIsLoopback ? `<p class="warn">This sends access to an app on this computer. Continue only if you just started signing in from it.</p>` : ""}
<form method="post">
<input type="hidden" name="handle" value="${esc(handle)}">
<label for="password">BeeCloud password or admin key</label>
<input id="password" name="password" type="password" autocomplete="current-password" autofocus required>
${error ? `<p class="error">${esc(error)}</p>` : ""}
<div class="buttons"><button class="primary" name="decision" value="approve">Allow</button><button name="decision" value="deny" formnovalidate>Deny</button></div>
</form>
<p class="small">You'll stay signed in while the app keeps using BeeCloud.</p>
</main>
</body>
</html>`;
}

function messagePage(title: string, message: string, status: number): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title>
<style>body{margin:0;background:#fbfbfa;color:#14171a;font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}main{max-width:420px;margin:0 auto;padding:72px 20px}h1{font-size:22px}p{color:#6b7280}@media (prefers-color-scheme:dark){body{background:#0e1013;color:#eef0f2}p{color:#9aa3ad}}</style></head>
<body><main><h1>${esc(title)}</h1><p>${esc(message)}</p></main></body></html>`;
  return new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8", "X-Frame-Options": "DENY", "Cache-Control": "no-store" } });
}

async function showLogin(env: Env, getRequest: Request, error = "", status = 200): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER!;
  const authRequest = await oauth.parseAuthRequest(getRequest);
  const details = await oauth.describeConsent(authRequest);
  const consent = await oauth.beginConsent(authRequest);
  consent.headers.set("Content-Type", "text/html; charset=utf-8");
  consent.headers.set("Cache-Control", "no-store");
  return new Response(loginPage(details, consent.handle, error), { status, headers: consent.headers });
}

async function authorize(req: Request, env: Env): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER!;
  // The form posts back to the same address, so the original sign-in request is still in the query string.
  const asGet = new Request(req.url, { method: "GET", headers: req.headers });
  try {
    if (req.method === "GET") return await showLogin(env, asGet);
    if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, POST" } });

    const form = await req.formData();
    const handle = String(form.get("handle") ?? "");
    if (form.get("decision") !== "approve") {
      const denied = await oauth.denyConsent(req, handle);
      return new Response(null, { status: 302, headers: denied.headers });
    }
    const ip = clientIp(req);
    if (await lockedOut(env, ip)) return showLogin(env, asGet, "Too many wrong passwords from this network. Try again in 15 minutes.", 429);
    const password = String(form.get("password") ?? "");
    if (!(await isOwnerSecret(env, password))) {
      await recordFailure(env, ip);
      return showLogin(env, asGet, "That isn't the password or an admin key.", 401);
    }
    const approved = await oauth.approveConsent(req, handle, { scope: [SCOPE] });
    const { redirectTo } = await oauth.completeAuthorization({
      request: approved.request,
      userId: "owner",
      metadata: { signedInAt: Date.now() },
      scope: approved.request.scope.length ? approved.request.scope : [SCOPE],
      props: { name: SIGNED_IN.name },
    });
    approved.headers.set("Location", redirectTo);
    return new Response(null, { status: 302, headers: approved.headers });
  } catch (e) {
    if (e instanceof AuthorizationError) {
      if (e.redirectTo) return Response.redirect(e.redirectTo, 302);
      return messagePage("This sign-in link didn't work", `${e.description || "The request was invalid."} Start again from the app.`, 400);
    }
    throw e;
  }
}
