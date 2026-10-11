import crypto from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { config } from "./config.ts";
import type { DB } from "./db.ts";

const COOKIE = "contacts_session";

/**
 * Optional single-password auth. Off when APP_PASSWORD is unset (fine on localhost);
 * set it before exposing the app to the internet. Sessions are HMAC-signed cookies.
 */
export function createAuth(db: DB) {
  let secret = db.getSetting("session_secret");
  if (!secret) {
    secret = crypto.randomBytes(32).toString("hex");
    db.setSetting("session_secret", secret);
  }
  const sign = (value: string) => crypto.createHmac("sha256", secret).update(value).digest("hex");
  const enabled = Boolean(config.appPassword);

  const isAuthed = (cookie: string | undefined) => {
    if (!enabled) return true;
    if (!cookie) return false;
    const [expires, mac] = cookie.split(".");
    if (!expires || !mac || Number(expires) < Date.now()) return false;
    const expected = sign(expires);
    return mac.length === expected.length && crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected));
  };

  const middleware: MiddlewareHandler = async (c, next) => {
    const path = c.req.path;
    if (!path.startsWith("/api/") || path === "/api/session" || path === "/api/login") return next();
    if (!isAuthed(getCookie(c, COOKIE))) return c.json({ error: "Not logged in" }, 401);
    return next();
  };

  return {
    middleware,
    session: (cookie: string | undefined) => ({ authRequired: enabled, authenticated: isAuthed(cookie) }),
    cookieName: COOKIE,
    login(password: string): string | null {
      const a = crypto.createHash("sha256").update(password).digest();
      const b = crypto.createHash("sha256").update(config.appPassword).digest();
      if (!enabled || !crypto.timingSafeEqual(a, b)) return null;
      const expires = String(Date.now() + 90 * 24 * 3600 * 1000);
      return `${expires}.${sign(expires)}`;
    },
    setCookie,
    deleteCookie,
  };
}
