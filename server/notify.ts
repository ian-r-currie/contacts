import webpush from "web-push";
import { config, today } from "./config.ts";
import type { DB } from "./db.ts";

/** VAPID keys identify this server to browser push services. Generated once and kept in the local database. */
export function initPush(db: DB): string {
  let keys = db.getSetting("vapid");
  if (!keys) {
    keys = JSON.stringify(webpush.generateVAPIDKeys());
    db.setSetting("vapid", keys);
  }
  const { publicKey, privateKey } = JSON.parse(keys) as { publicKey: string; privateKey: string };
  webpush.setVapidDetails(config.vapidSubject, publicKey, privateKey);
  return publicKey;
}

export async function sendToAll(db: DB, payload: { title: string; body: string; url?: string; tag?: string }): Promise<number> {
  let delivered = 0;
  for (const { endpoint, subscription } of db.listPushSubscriptions()) {
    try {
      await webpush.sendNotification(subscription as webpush.PushSubscription, JSON.stringify(payload));
      delivered++;
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      // 404/410: the browser unsubscribed or the subscription expired.
      if (status === 404 || status === 410) db.deletePushSubscription(endpoint);
      else console.warn(`push to ${new URL(endpoint).host} failed:`, (err as Error).message);
    }
  }
  return delivered;
}

/** Sends one notification per due follow-up (once per follow-up date), from NOTIFY_HOUR onwards. */
export async function checkFollowUps(db: DB, now = new Date()): Promise<void> {
  if (now.getHours() < config.notifyHour) return;
  if (db.listPushSubscriptions().length === 0) return;
  const date = today(now);
  for (const c of db.dueFollowUps(date, true)) {
    const overdue = c.follow_up_date < date;
    await sendToAll(db, {
      title: overdue ? `Overdue follow-up: ${c.name}` : `Follow up with ${c.name}`,
      body: [overdue ? `Was due ${c.follow_up_date}.` : "Due today.", c.role, c.schools].filter(Boolean).join(" · "),
      url: `/?contact=${c.id}`,
      tag: `follow-up-${c.id}`,
    });
    db.markNotified(c.id, c.follow_up_date);
  }
}

export function startScheduler(db: DB): void {
  const tick = () => checkFollowUps(db).catch((err) => console.error("follow-up check failed:", err));
  tick();
  setInterval(tick, 10 * 60 * 1000).unref();
}
