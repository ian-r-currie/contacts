import fs from "node:fs";
import path from "node:path";

// Load .env (gitignored) if present. Real environment variables win.
if (fs.existsSync(".env")) process.loadEnvFile(".env");

export const config = {
  port: Number(process.env.PORT ?? 8787),
  host: process.env.HOST ?? "127.0.0.1",
  /** Where the SQLite database lives. Never inside the git tree's tracked files (data/ is gitignored). */
  dataDir: path.resolve(process.env.DATA_DIR ?? "data"),
  /** Optional. When set, every API call requires logging in with this password. Set it before exposing the app beyond localhost. */
  appPassword: process.env.APP_PASSWORD ?? "",
  anthropicModel: process.env.RESEARCH_MODEL ?? "claude-sonnet-5-5",
  /** Hour of the day (local server time, 0-23) from which follow-up notifications are sent. */
  notifyHour: Number(process.env.NOTIFY_HOUR ?? 8),
  /** Contact address embedded in Web Push VAPID details (required by the spec; any mailto: or https: URL). */
  vapidSubject: process.env.VAPID_SUBJECT ?? "mailto:contacts-app@localhost",
  production: process.env.NODE_ENV === "production",
};

export function hasAnthropicCredentials(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

/** Today's date as YYYY-MM-DD in the server's local timezone (set TZ to change it). */
export function today(now = new Date()): string {
  return now.toLocaleDateString("en-CA");
}
