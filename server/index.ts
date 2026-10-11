import fs from "node:fs";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { createAuth } from "./auth.ts";
import { config, hasAnthropicCredentials, today } from "./config.ts";
import { toCsv } from "./csv.ts";
import { CONTACT_FIELDS, RESEARCHABLE_FIELDS, openDb, type ContactField } from "./db.ts";
import { importCsv, previewCsv } from "./importer.ts";
import { initPush, sendToAll, startScheduler } from "./notify.ts";
import { acceptSuggestions, dismissSuggestions, getJob, startResearch, subscribe } from "./research.ts";

const db = openDb();
const auth = createAuth(db);
const vapidPublicKey = initPush(db);

const app = new Hono();
app.use("*", auth.middleware);

app.onError((err, c) => {
  if (err instanceof z.ZodError) return c.json({ error: err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") }, 400);
  console.error(err);
  return c.json({ error: err.message }, 500);
});

const date = z.union([z.literal(""), z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD")]);
const ContactPatch = z
  .object(Object.fromEntries(CONTACT_FIELDS.map((f) => [f, z.string().max(20000)])) as Record<ContactField, z.ZodString>)
  .partial()
  .extend({ last_contacted: date.optional(), follow_up_date: date.optional() })
  .strict();
const NewContact = ContactPatch.extend({ name: z.string().trim().min(1, "Name is required") });
const idParam = (raw: string) => z.coerce.number().int().positive().parse(raw);

// --- session ---
app.get("/api/session", (c) => c.json(auth.session(getCookie(c, auth.cookieName))));
app.post("/api/login", async (c) => {
  const { password } = z.object({ password: z.string() }).parse(await c.req.json());
  const token = auth.login(password);
  if (!token) return c.json({ error: "Wrong password" }, 401);
  auth.setCookie(c, auth.cookieName, token, {
    httpOnly: true,
    sameSite: "Lax",
    secure: new URL(c.req.url).protocol === "https:",
    path: "/",
    maxAge: 90 * 24 * 3600,
  });
  return c.json({ ok: true });
});
app.post("/api/logout", (c) => {
  auth.deleteCookie(c, auth.cookieName, { path: "/" });
  return c.json({ ok: true });
});

app.get("/api/config", (c) =>
  c.json({ researchEnabled: hasAnthropicCredentials(), vapidPublicKey, today: today(), researchableFields: RESEARCHABLE_FIELDS }),
);

// --- contacts ---
app.get("/api/contacts", (c) => c.json(db.listContacts()));

app.post("/api/contacts", async (c) => {
  const body = NewContact.parse(await c.req.json());
  const id = db.createContact(body);
  return c.json(db.getContact(id), 201);
});

app.get("/api/contacts/:id", (c) => {
  const contact = db.getContact(idParam(c.req.param("id")));
  return contact ? c.json(contact) : c.json({ error: "Not found" }, 404);
});

app.patch("/api/contacts/:id", async (c) => {
  const id = idParam(c.req.param("id"));
  const body = ContactPatch.parse(await c.req.json());
  if (body.name !== undefined && !body.name.trim()) return c.json({ error: "Name is required" }, 400);
  if (!db.updateContact(id, body)) return c.json({ error: "Not found" }, 404);
  return c.json(db.getContact(id));
});

app.delete("/api/contacts/:id", (c) => {
  return db.deleteContact(idParam(c.req.param("id"))) ? c.json({ ok: true }) : c.json({ error: "Not found" }, 404);
});

// --- relationships (undirected) ---
app.put("/api/contacts/:id/related/:otherId", async (c) => {
  const id = idParam(c.req.param("id"));
  const other = idParam(c.req.param("otherId"));
  const { note } = z.object({ note: z.string().max(500).optional() }).parse(await c.req.json().catch(() => ({})));
  if (!db.getContact(id) || !db.getContact(other)) return c.json({ error: "Not found" }, 404);
  if (id === other) return c.json({ error: "A contact can't be related to itself" }, 400);
  db.relate(id, other, note);
  return c.json(db.getContact(id));
});

app.delete("/api/contacts/:id/related/:otherId", (c) => {
  const id = idParam(c.req.param("id"));
  db.unrelate(id, idParam(c.req.param("otherId")));
  return c.json(db.getContact(id));
});

// --- follow-ups ---
app.get("/api/due", (c) => c.json(db.dueFollowUps(today())));

// --- import / export ---
app.post("/api/import/preview", async (c) => {
  const { csv } = z.object({ csv: z.string() }).parse(await c.req.json());
  return c.json(previewCsv(csv));
});

app.post("/api/import", async (c) => {
  const body = z
    .object({
      csv: z.string(),
      category: z.string().optional(),
      mapping: z.record(z.string(), z.enum([...CONTACT_FIELDS, "related", "updated", "ignore"])).optional(),
    })
    .parse(await c.req.json());
  return c.json(importCsv(db, body.csv, body));
});

app.get("/api/export.csv", (c) => {
  const header = ["Name", "Category", "Role", "Department", "Schools", "Research", "Website", "Email", "Related to", "Last contacted", "Follow-up date", "Notes", "Updated"];
  const rows = db
    .listContacts()
    .map((x) => [
      x.name,
      x.category,
      x.role,
      x.department,
      x.schools,
      x.research,
      x.website,
      x.email,
      x.related.map((r) => r.name).join(", "),
      x.last_contacted,
      x.follow_up_date,
      x.notes,
      x.updated_at.slice(0, 10),
    ]);
  c.header("Content-Type", "text/csv; charset=utf-8");
  c.header("Content-Disposition", `attachment; filename="contacts-${today()}.csv"`);
  return c.body(toCsv([header, ...rows]));
});

// --- research agent ---
app.get("/api/contacts/:id/research", (c) => {
  const id = idParam(c.req.param("id"));
  const job = getJob(id);
  return c.json({ runs: db.listRuns(id), running: job && !job.finished ? job.runId : null });
});

app.post("/api/contacts/:id/research", async (c) => {
  const id = idParam(c.req.param("id"));
  const { instructions } = z.object({ instructions: z.string().max(2000).optional() }).parse(await c.req.json().catch(() => ({})));
  const job = startResearch(db, id, instructions);
  return c.json({ runId: job.runId });
});

app.get("/api/contacts/:id/research/events", (c) => {
  const job = getJob(idParam(c.req.param("id")));
  if (!job) return c.json({ error: "No research running" }, 404);
  return streamSSE(c, async (stream) => {
    // Writes are chained so the final event is flushed before the stream closes.
    let writes = Promise.resolve();
    await new Promise<void>((resolve) => {
      const unsubscribe = subscribe(job, (e) => {
        writes = writes.then(() => stream.writeSSE({ data: JSON.stringify(e) }));
        if (e.type === "done" || e.type === "error") resolve();
      });
      stream.onAbort(() => {
        unsubscribe();
        resolve();
      });
    });
    await writes;
  });
});

const FieldList = z.object({ fields: z.array(z.enum(RESEARCHABLE_FIELDS)) });
app.post("/api/research/:runId/accept", async (c) => {
  const run = acceptSuggestions(db, idParam(c.req.param("runId")), FieldList.parse(await c.req.json()).fields);
  return c.json({ run, contact: db.getContact(run.contact_id) });
});
app.post("/api/research/:runId/dismiss", async (c) => {
  return c.json({ run: dismissSuggestions(db, idParam(c.req.param("runId")), FieldList.parse(await c.req.json()).fields) });
});

// --- push notifications ---
const Subscription = z.object({ endpoint: z.string().url(), keys: z.object({ p256dh: z.string(), auth: z.string() }) }).passthrough();
app.post("/api/push/subscribe", async (c) => {
  const sub = Subscription.parse(await c.req.json());
  db.savePushSubscription(sub.endpoint, sub);
  return c.json({ ok: true });
});
app.post("/api/push/unsubscribe", async (c) => {
  const { endpoint } = z.object({ endpoint: z.string() }).parse(await c.req.json());
  db.deletePushSubscription(endpoint);
  return c.json({ ok: true });
});
app.post("/api/push/test", async (c) => {
  const delivered = await sendToAll(db, { title: "Contacts", body: "Notifications are working.", url: "/" });
  return c.json({ delivered });
});

// --- built frontend (production) ---
if (fs.existsSync("dist/index.html")) {
  app.use("/*", serveStatic({ root: "./dist" }));
  app.get("*", serveStatic({ path: "./dist/index.html" }));
} else {
  app.get("/", (c) => c.text("Frontend not built. Run `npm run dev` (development) or `npm run build` first."));
}

startScheduler(db);

serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  console.log(`Contacts API listening on http://${config.host === "0.0.0.0" ? "localhost" : info.address}:${info.port}`);
  if (!hasAnthropicCredentials()) console.log("Research agent disabled: set ANTHROPIC_API_KEY in .env to enable it.");
  if (config.host !== "127.0.0.1" && config.host !== "localhost" && !config.appPassword) {
    console.warn("WARNING: listening beyond localhost without APP_PASSWORD. Anyone who can reach this port can read your contacts.");
  }
});
