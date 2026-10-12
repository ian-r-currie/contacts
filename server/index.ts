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
import { CONTACT_FIELDS, ORG_FIELDS, RESEARCHABLE_FIELDS, openDb, type ContactField, type OrgField } from "./db.ts";
import { importCsv, importOrgsCsv, previewCsv } from "./importer.ts";
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
  .extend({
    last_contacted: date.optional(),
    follow_up_date: date.optional(),
    in_network: z.boolean().optional(),
    /** Replaces the person's organizations with these names (created as needed). */
    orgs: z.array(z.string().trim().min(1).max(200)).max(50).optional(),
  })
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
  // Adding someone who is already known as a connection brings them into your network instead of duplicating them.
  const existing = body.in_network !== false ? db.findByName(body.name) : undefined;
  if (existing && !existing.in_network) {
    const { orgs, ...fields } = body;
    db.updateContact(existing.id, { ...fields, name: undefined, in_network: true });
    if (orgs) db.addContactOrgs(existing.id, orgs.map((name) => ({ name })));
    return c.json(db.getContact(existing.id), 200);
  }
  const { orgs, ...fields } = body;
  const id = db.transaction(() => {
    const id = db.createContact(fields);
    if (orgs) db.setContactOrgs(id, orgs);
    return id;
  });
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
  const { orgs, ...fields } = body;
  if (!db.updateContact(id, fields)) return c.json({ error: "Not found" }, 404);
  if (orgs) db.transaction(() => db.setContactOrgs(id, orgs));
  return c.json(db.getContact(id));
});

// --- memberships (person ↔ organization) ---
app.put("/api/contacts/:id/orgs/:orgId", async (c) => {
  const id = idParam(c.req.param("id"));
  const orgId = idParam(c.req.param("orgId"));
  const { current } = z.object({ current: z.boolean().optional() }).parse(await c.req.json().catch(() => ({})));
  if (!db.getContact(id) || !db.getOrg(orgId)) return c.json({ error: "Not found" }, 404);
  db.setMembership(id, orgId, current);
  return c.json(db.getContact(id));
});
app.delete("/api/contacts/:id/orgs/:orgId", (c) => {
  const id = idParam(c.req.param("id"));
  db.removeMembership(id, idParam(c.req.param("orgId")));
  return c.json(db.getContact(id));
});

// --- organizations ---
const OrgPatch = z
  .object(Object.fromEntries(ORG_FIELDS.map((f) => [f, z.string().max(20000)])) as Record<OrgField, z.ZodString>)
  .partial()
  .extend({ parent_id: z.number().int().positive().nullable().optional() })
  .strict();
const orgNameTaken = (name: string, selfId?: number) => {
  const other = db.findOrg(name);
  return other && other.id !== selfId;
};

app.get("/api/orgs", (c) => c.json(db.listOrgs()));

app.post("/api/orgs", async (c) => {
  const body = OrgPatch.extend({ name: z.string().trim().min(1, "Name is required") }).parse(await c.req.json());
  if (orgNameTaken(body.name)) return c.json({ error: `${body.name} already exists` }, 409);
  return c.json(db.getOrg(db.createOrg(body)), 201);
});

app.patch("/api/orgs/:id", async (c) => {
  const id = idParam(c.req.param("id"));
  const body = OrgPatch.parse(await c.req.json());
  if (body.name !== undefined && !body.name.trim()) return c.json({ error: "Name is required" }, 400);
  if (body.name && orgNameTaken(body.name, id)) return c.json({ error: `${body.name} already exists` }, 409);
  try {
    if (!db.updateOrg(id, body)) return c.json({ error: "Not found" }, 404);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
  return c.json(db.getOrg(id));
});

app.delete("/api/orgs/:id", (c) => {
  return db.deleteOrg(idParam(c.req.param("id"))) ? c.json({ ok: true }) : c.json({ error: "Not found" }, 404);
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
  const { csv, kind } = z.object({ csv: z.string(), kind: z.enum(["people", "orgs"]).optional() }).parse(await c.req.json());
  return c.json(previewCsv(csv, kind));
});

app.post("/api/import", async (c) => {
  const body = z
    .object({
      csv: z.string(),
      kind: z.enum(["people", "orgs"]).optional(),
      role: z.string().optional(),
      mapping: z
        .record(z.string(), z.enum([...CONTACT_FIELDS, ...ORG_FIELDS, "organizations", "parent", "related", "updated", "ignore"]))
        .optional(),
    })
    .parse(await c.req.json());
  return c.json(body.kind === "orgs" ? importOrgsCsv(db, body.csv, body) : importCsv(db, body.csv, body));
});

app.get("/api/export.csv", (c) => {
  const header = ["Name", "In network", "Role", "Department", "Organizations", "Research", "Website", "Email", "Related to", "Last contacted", "Follow-up date", "Notes", "Updated"];
  const rows = db
    .listContacts()
    .map((x) => [
      x.name,
      x.in_network ? "yes" : "no",
      x.role,
      x.department,
      x.orgs.map((o) => (o.current ? `${o.name} (current)` : o.name)).join(", "),
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

app.get("/api/export-orgs.csv", (c) => {
  const orgs = db.listOrgs();
  const nameOf = new Map(orgs.map((o) => [o.id, o.name]));
  const rows = orgs.map((o) => [
    o.name,
    o.type,
    o.parent_id ? (nameOf.get(o.parent_id) ?? "") : "",
    o.website,
    o.description,
    o.members.map((m) => m.name).join(", "),
    o.notes,
  ]);
  c.header("Content-Type", "text/csv; charset=utf-8");
  c.header("Content-Disposition", `attachment; filename="organizations-${today()}.csv"`);
  return c.body(toCsv([["Name", "Type", "Part of", "Website", "Description", "People", "Notes"], ...rows]));
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
