import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export interface Env {
  ARCHIVE: R2Bucket;
  DB: D1Database;
  BEE_API: string;
  // All optional. Without them, the setup page creates the admin key and connects Bee.
  BEE_TOKEN?: string; // overrides the Bee key saved by the setup page
  ADMIN_TOKEN?: string; // overrides (and recovers) the admin key made on the setup page
  PUSHBULLET_TOKEN?: string; // turns on phone alerts
  ACCESS_PASSWORD?: string; // a shared password agents can use instead of a key (write access, never admin)
  OAUTH_KV?: KVNamespace; // sign-in grants for apps such as the Gemini app and claude.ai
  OAUTH_PROVIDER?: OAuthHelpers; // added by the OAuth library for the sign-in page
}

export type Json = Record<string, any>;

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}
export const badRequest = (message: string) => new HttpError(400, message);
export const notFound = (message: string) => new HttpError(404, message);

export const DAY_MS = 86_400_000;
export const HOUR_MS = 3_600_000;
export const DEFAULT_TZ = "UTC";
