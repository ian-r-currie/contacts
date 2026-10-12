import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { config } from "./config.ts";

/** Editable text fields on a contact, in display order. */
export const CONTACT_FIELDS = [
  "name",
  "role",
  "relationship_status",
  "department",
  "research",
  "website",
  "email",
  "last_contacted",
  "follow_up_date",
  "notes",
] as const;
export type ContactField = (typeof CONTACT_FIELDS)[number];

/** Fields the research agent is allowed to fill in. "organizations" maps to memberships rather than a column. */
export const RESEARCHABLE_FIELDS = ["name", "role", "department", "organizations", "research", "website", "email"] as const;
export type ResearchableField = (typeof RESEARCHABLE_FIELDS)[number];

/** in_network is false for people who only appear as someone's connection (not tracked as contacts). */
export type Contact = { id: number; in_network: boolean; created_at: string; updated_at: string } & Record<ContactField, string>;
/** A link between two people. `kind` is an optional type (friends, mentorship, supervisor…), `note` free text. */
export type Relation = { id: number; name: string; kind: string; note: string; in_network: boolean };
/** A contact's link to an organization. `current` marks where they are now (e.g. their current school). */
export type Membership = { id: number; name: string; type: string; current: boolean };
export type ContactWithRelations = Contact & { related: Relation[]; orgs: Membership[] };

/** Organization: a school, lab, institute, company, group… Schools are just organizations of type "School". */
export const ORG_FIELDS = ["name", "type", "website", "description", "notes"] as const;
export type OrgField = (typeof ORG_FIELDS)[number];
export type Org = { id: number; parent_id: number | null; created_at: string; updated_at: string } & Record<OrgField, string>;
export type OrgMember = { id: number; name: string; in_network: boolean; current: boolean };
export type OrgWithMembers = Org & { members: OrgMember[] };
export type OrgInput = Partial<Record<OrgField, string>> & { parent_id?: number | null };
export type OrgRef = { name: string; type?: string; current?: boolean };

export type ResearchRun = {
  id: number;
  /** Exactly one of contact_id / org_id is set: what the run researched. */
  contact_id: number | null;
  org_id: number | null;
  status: "running" | "done" | "error";
  started_at: string;
  finished_at: string | null;
  summary: string;
  sources: { url: string; title: string }[];
  applied: Record<string, string>;
  suggestions: Record<string, string>;
  error: string;
};

export type ContactInput = Partial<Record<ContactField, string>> & { in_network?: boolean };
export type DB = ReturnType<typeof openDb>;

export const splitList = (value: string) =>
  value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const RUNS_SCHEMA = `
CREATE TABLE IF NOT EXISTS research_runs (
  id INTEGER PRIMARY KEY,
  contact_id INTEGER REFERENCES contacts(id) ON DELETE CASCADE,
  org_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  finished_at TEXT,
  summary TEXT NOT NULL DEFAULT '',
  sources TEXT NOT NULL DEFAULT '[]',
  applied TEXT NOT NULL DEFAULT '{}',
  suggestions TEXT NOT NULL DEFAULT '{}',
  error TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS research_runs_contact ON research_runs(contact_id);
CREATE INDEX IF NOT EXISTS research_runs_org ON research_runs(org_id);
`;

/** What a research run is about. */
export type Subject = { kind: "contact" | "org"; id: number };

const ORG_SCHEMA = `
CREATE TABLE IF NOT EXISTS organizations (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT '',
  parent_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL,
  website TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS organizations_name ON organizations(name COLLATE NOCASE);

-- Many-to-many: people and the organizations they belong to.
CREATE TABLE IF NOT EXISTS contact_orgs (
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  org_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  current INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (contact_id, org_id)
);
CREATE INDEX IF NOT EXISTS contact_orgs_org ON contact_orgs(org_id);
`;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  in_network INTEGER NOT NULL DEFAULT 1,
  role TEXT NOT NULL DEFAULT '',
  relationship_status TEXT NOT NULL DEFAULT '',
  department TEXT NOT NULL DEFAULT '',
  research TEXT NOT NULL DEFAULT '',
  website TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  last_contacted TEXT NOT NULL DEFAULT '',
  follow_up_date TEXT NOT NULL DEFAULT '',
  follow_up_notified TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Undirected many-to-many link between two contacts. Stored once with a_id < b_id.
CREATE TABLE IF NOT EXISTS relationships (
  a_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  b_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (a_id, b_id),
  CHECK (a_id < b_id)
);
CREATE INDEX IF NOT EXISTS relationships_b ON relationships(b_id);

${ORG_SCHEMA}

${RUNS_SCHEMA}

CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  subscription TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

const now = () => new Date().toISOString();

export function openDb(file = path.join(config.dataDir, "contacts.db")) {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  migrate(db);
  db.exec(SCHEMA);

  // A crashed server can leave runs marked running forever.
  db.prepare("UPDATE research_runs SET status = 'error', error = 'Interrupted (server restarted)' WHERE status = 'running'").run();

  const rowToContact = (row: Record<string, unknown>): Contact => {
    const { follow_up_notified: _ignored, ...rest } = row;
    return { ...rest, in_network: Boolean(row.in_network) } as unknown as Contact;
  };

  function relationsFor(ids: number[]): Map<number, Relation[]> {
    const map = new Map<number, Relation[]>(ids.map((id) => [id, []]));
    const rows = db
      .prepare(
        `SELECT r.a_id AS self, c.id, c.name, c.in_network, r.kind, r.note FROM relationships r JOIN contacts c ON c.id = r.b_id
         UNION ALL
         SELECT r.b_id AS self, c.id, c.name, c.in_network, r.kind, r.note FROM relationships r JOIN contacts c ON c.id = r.a_id
         ORDER BY name COLLATE NOCASE`,
      )
      .all() as { self: number; id: number; name: string; in_network: number; kind: string; note: string }[];
    for (const r of rows) map.get(r.self)?.push({ id: r.id, name: r.name, kind: r.kind, note: r.note, in_network: Boolean(r.in_network) });
    return map;
  }

  function membershipsFor(): Map<number, Membership[]> {
    const map = new Map<number, Membership[]>();
    const rows = db
      .prepare(
        `SELECT m.contact_id, o.id, o.name, o.type, m.current FROM contact_orgs m JOIN organizations o ON o.id = m.org_id
         ORDER BY m.current DESC, o.name COLLATE NOCASE`,
      )
      .all() as { contact_id: number; id: number; name: string; type: string; current: number }[];
    for (const r of rows) {
      const list = map.get(r.contact_id) ?? [];
      list.push({ id: r.id, name: r.name, type: r.type, current: Boolean(r.current) });
      map.set(r.contact_id, list);
    }
    return map;
  }

  const touchContact = (id: number) => db.prepare("UPDATE contacts SET updated_at = ? WHERE id = ?").run(now(), id);

  const api = {
    raw: db,

    transaction<T>(fn: () => T): T {
      db.exec("BEGIN");
      try {
        const out = fn();
        db.exec("COMMIT");
        return out;
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },

    listContacts(): ContactWithRelations[] {
      const rows = db.prepare("SELECT * FROM contacts ORDER BY name COLLATE NOCASE").all() as Record<string, unknown>[];
      const contacts = rows.map(rowToContact);
      const rel = relationsFor(contacts.map((c) => c.id));
      const orgs = membershipsFor();
      return contacts.map((c) => ({ ...c, related: rel.get(c.id) ?? [], orgs: orgs.get(c.id) ?? [] }));
    },

    getContact(id: number): ContactWithRelations | undefined {
      const row = db.prepare("SELECT * FROM contacts WHERE id = ?").get(id) as Record<string, unknown> | undefined;
      if (!row) return undefined;
      return { ...rowToContact(row), related: relationsFor([id]).get(id) ?? [], orgs: membershipsFor().get(id) ?? [] };
    },

    createContact(fields: ContactInput & { name: string }, updatedAt?: string): number {
      const cols = CONTACT_FIELDS.filter((f) => fields[f] !== undefined);
      const ts = updatedAt ?? now();
      const result = db
        .prepare(
          `INSERT INTO contacts (${[...cols, "in_network", "created_at", "updated_at"].join(", ")})
           VALUES (${[...cols, "", "", ""].map(() => "?").join(", ")})`,
        )
        .run(...cols.map((f) => fields[f]!.trim()), fields.in_network === false ? 0 : 1, ts, ts);
      return Number(result.lastInsertRowid);
    },

    findByName(name: string): Contact | undefined {
      const row = db.prepare("SELECT * FROM contacts WHERE name = ? COLLATE NOCASE ORDER BY in_network DESC LIMIT 1").get(name.trim()) as
        | Record<string, unknown>
        | undefined;
      return row && rowToContact(row);
    },

    updateContact(id: number, fields: ContactInput): boolean {
      const values: Record<string, string | number> = {};
      for (const f of CONTACT_FIELDS) if (fields[f] !== undefined) values[f] = fields[f]!.trim();
      if (fields.in_network !== undefined) values.in_network = fields.in_network ? 1 : 0;
      const cols = Object.keys(values);
      if (cols.length === 0) return api.getContact(id) !== undefined;
      const sets = cols.map((f) => `${f} = ?`);
      // Changing the follow-up date re-arms its notification.
      if (cols.includes("follow_up_date")) sets.push("follow_up_notified = ''");
      const result = db
        .prepare(`UPDATE contacts SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`)
        .run(...cols.map((f) => values[f]), now(), id);
      return result.changes > 0;
    },

    deleteContact(id: number): boolean {
      return db.prepare("DELETE FROM contacts WHERE id = ?").run(id).changes > 0;
    },

    /** Links two contacts. Idempotent; updates the kind and/or note when given. */
    relate(x: number, y: number, details: { note?: string; kind?: string } = {}) {
      if (x === y) throw new Error("A contact cannot be related to itself");
      const [a, b] = x < y ? [x, y] : [y, x];
      const { note, kind } = details;
      db.prepare(
        `INSERT INTO relationships (a_id, b_id, note, kind) VALUES (?, ?, ?, ?)
         ON CONFLICT (a_id, b_id) DO UPDATE SET
           note = CASE WHEN ? IS NULL THEN note ELSE excluded.note END,
           kind = CASE WHEN ? IS NULL THEN kind ELSE excluded.kind END`,
      ).run(a, b, note?.trim() ?? "", kind?.trim() ?? "", note ?? null, kind ?? null);
    },

    /** Relationship types already in use, most common first (for suggestions). */
    relationKinds(): string[] {
      return (
        db.prepare("SELECT kind FROM relationships WHERE kind != '' GROUP BY kind COLLATE NOCASE ORDER BY COUNT(*) DESC").all() as { kind: string }[]
      ).map((r) => r.kind);
    },

    unrelate(x: number, y: number): boolean {
      const [a, b] = x < y ? [x, y] : [y, x];
      return db.prepare("DELETE FROM relationships WHERE a_id = ? AND b_id = ?").run(a, b).changes > 0;
    },

    /** Contacts whose follow-up is due on or before `date`. */
    dueFollowUps(date: string, onlyUnnotified = false): Contact[] {
      const rows = db
        .prepare(
          `SELECT * FROM contacts WHERE follow_up_date != '' AND follow_up_date <= ?
           ${onlyUnnotified ? "AND follow_up_notified != follow_up_date" : ""} ORDER BY follow_up_date`,
        )
        .all(date) as Record<string, unknown>[];
      return rows.map(rowToContact);
    },

    markNotified(id: number, followUpDate: string) {
      db.prepare("UPDATE contacts SET follow_up_notified = ? WHERE id = ?").run(followUpDate, id);
    },

    // --- organizations ---
    listOrgs(): OrgWithMembers[] {
      const orgs = db.prepare("SELECT * FROM organizations ORDER BY name COLLATE NOCASE").all() as unknown as Org[];
      const rows = db
        .prepare(
          `SELECT m.org_id, c.id, c.name, c.in_network, m.current FROM contact_orgs m JOIN contacts c ON c.id = m.contact_id
           ORDER BY c.name COLLATE NOCASE`,
        )
        .all() as { org_id: number; id: number; name: string; in_network: number; current: number }[];
      const members = new Map<number, OrgMember[]>();
      for (const r of rows) {
        const list = members.get(r.org_id) ?? [];
        list.push({ id: r.id, name: r.name, in_network: Boolean(r.in_network), current: Boolean(r.current) });
        members.set(r.org_id, list);
      }
      return orgs.map((o) => ({ ...o, members: members.get(o.id) ?? [] }));
    },

    getOrg(id: number): OrgWithMembers | undefined {
      return api.listOrgs().find((o) => o.id === id);
    },

    findOrg(name: string): Org | undefined {
      return db.prepare("SELECT * FROM organizations WHERE name = ? COLLATE NOCASE").get(name.trim()) as unknown as Org | undefined;
    },

    createOrg(fields: OrgInput & { name: string }): number {
      const cols = ORG_FIELDS.filter((f) => fields[f] !== undefined);
      const result = db
        .prepare(`INSERT INTO organizations (${[...cols, "parent_id"].join(", ")}) VALUES (${[...cols, ""].map(() => "?").join(", ")})`)
        .run(...cols.map((f) => fields[f]!.trim()), fields.parent_id ?? null);
      return Number(result.lastInsertRowid);
    },

    /** Finds an organization by name (case-insensitive) or creates it. Fills its type if it had none. */
    ensureOrg(name: string, defaults: OrgInput = {}): number {
      const existing = api.findOrg(name);
      if (!existing) return api.createOrg({ ...defaults, name: name.trim() });
      if (!existing.type && defaults.type) api.updateOrg(existing.id, { type: defaults.type });
      return existing.id;
    },

    updateOrg(id: number, fields: OrgInput): boolean {
      const values: Record<string, string | number | null> = {};
      for (const f of ORG_FIELDS) if (fields[f] !== undefined) values[f] = fields[f]!.trim();
      if (fields.parent_id !== undefined) {
        // Refuse cycles: the new parent can't be this org or one of its descendants.
        for (let p = fields.parent_id; p != null; ) {
          if (p === id) throw new Error("An organization can't be part of itself");
          p = (db.prepare("SELECT parent_id FROM organizations WHERE id = ?").get(p) as { parent_id: number | null } | undefined)?.parent_id ?? null;
        }
        values.parent_id = fields.parent_id;
      }
      const cols = Object.keys(values);
      if (cols.length === 0) return api.getOrg(id) !== undefined;
      return (
        db.prepare(`UPDATE organizations SET ${cols.map((c) => `${c} = ?`).join(", ")}, updated_at = ? WHERE id = ?`).run(...cols.map((c) => values[c]), now(), id)
          .changes > 0
      );
    },

    deleteOrg(id: number): boolean {
      return db.prepare("DELETE FROM organizations WHERE id = ?").run(id).changes > 0;
    },

    /** Adds (or updates the current flag of) one membership. */
    setMembership(contactId: number, orgId: number, current?: boolean, touch = true) {
      db.prepare(
        `INSERT INTO contact_orgs (contact_id, org_id, current) VALUES (?, ?, ?)
         ON CONFLICT (contact_id, org_id) DO UPDATE SET current = CASE WHEN ? IS NULL THEN current ELSE excluded.current END`,
      ).run(contactId, orgId, current ? 1 : 0, current === undefined ? null : current ? 1 : 0);
      if (touch) touchContact(contactId);
    },

    removeMembership(contactId: number, orgId: number): boolean {
      const removed = db.prepare("DELETE FROM contact_orgs WHERE contact_id = ? AND org_id = ?").run(contactId, orgId).changes > 0;
      if (removed) touchContact(contactId);
      return removed;
    },

    /** Replaces a contact's organizations with this list of names, creating organizations as needed. Keeps current flags. */
    setContactOrgs(contactId: number, names: string[], defaults: OrgInput = {}) {
      const ids = [...new Set(names.map((n) => n.trim()).filter(Boolean).map((n) => api.ensureOrg(n, defaults)))];
      db.prepare(`DELETE FROM contact_orgs WHERE contact_id = ? AND org_id NOT IN (${ids.map(() => "?").join(", ") || "NULL"})`).run(
        contactId,
        ...ids,
      );
      for (const id of ids) api.setMembership(contactId, id);
      touchContact(contactId);
    },

    /** Adds organizations without removing any. `touch: false` leaves updated_at alone (imports keep the sheet's date). */
    addContactOrgs(contactId: number, refs: OrgRef[], { touch = true } = {}) {
      for (const ref of refs) {
        if (!ref.name.trim()) continue;
        api.setMembership(contactId, api.ensureOrg(ref.name, { type: ref.type ?? "" }), ref.current || undefined, touch);
      }
    },

    // --- research runs ---
    startRun(subject: Subject): number {
      const col = subject.kind === "org" ? "org_id" : "contact_id";
      return Number(db.prepare(`INSERT INTO research_runs (${col}, status) VALUES (?, 'running')`).run(subject.id).lastInsertRowid);
    },

    finishRun(id: number, data: Pick<ResearchRun, "summary" | "sources" | "applied" | "suggestions">) {
      db.prepare(
        `UPDATE research_runs SET status = 'done', finished_at = ?, summary = ?, sources = ?, applied = ?, suggestions = ? WHERE id = ?`,
      ).run(now(), data.summary, JSON.stringify(data.sources), JSON.stringify(data.applied), JSON.stringify(data.suggestions), id);
    },

    failRun(id: number, error: string) {
      db.prepare("UPDATE research_runs SET status = 'error', finished_at = ?, error = ? WHERE id = ?").run(now(), error, id);
    },

    updateRunSuggestions(id: number, applied: ResearchRun["applied"], suggestions: ResearchRun["suggestions"]) {
      db.prepare("UPDATE research_runs SET applied = ?, suggestions = ? WHERE id = ?").run(
        JSON.stringify(applied),
        JSON.stringify(suggestions),
        id,
      );
    },

    getRun(id: number): ResearchRun | undefined {
      const row = db.prepare("SELECT * FROM research_runs WHERE id = ?").get(id) as Record<string, unknown> | undefined;
      return row && parseRun(row);
    },

    listRuns(subject: Subject): ResearchRun[] {
      const col = subject.kind === "org" ? "org_id" : "contact_id";
      return (db.prepare(`SELECT * FROM research_runs WHERE ${col} = ? ORDER BY id DESC`).all(subject.id) as Record<string, unknown>[]).map(parseRun);
    },

    // --- push + settings ---
    savePushSubscription(endpoint: string, subscription: unknown) {
      db.prepare(
        "INSERT INTO push_subscriptions (endpoint, subscription) VALUES (?, ?) ON CONFLICT (endpoint) DO UPDATE SET subscription = excluded.subscription",
      ).run(endpoint, JSON.stringify(subscription));
    },
    deletePushSubscription(endpoint: string) {
      db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").run(endpoint);
    },
    listPushSubscriptions(): { endpoint: string; subscription: unknown }[] {
      return (db.prepare("SELECT endpoint, subscription FROM push_subscriptions").all() as { endpoint: string; subscription: string }[]).map(
        (r) => ({ endpoint: r.endpoint, subscription: JSON.parse(r.subscription) }),
      );
    },
    getSetting(key: string): string | undefined {
      return (db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined)?.value;
    },
    setSetting(key: string, value: string) {
      db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(key, value);
    },
  };
  return api;
}

/**
 * Upgrades databases created by earlier versions:
 * v1: "category" folds into "role" (Professor etc.), adds current_school and in_network.
 * v2: schools become organizations (type "School") linked through contact_orgs.
 * v3: relationship status on people, a type on relationships, research runs for organizations.
 */
const LATEST_VERSION = 3;
function migrate(db: DatabaseSync) {
  const version = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  const hasContacts = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'contacts'").get();
  if (!hasContacts) {
    db.exec(`PRAGMA user_version = ${LATEST_VERSION}`);
    return;
  }
  if (version < 1) {
    db.exec("BEGIN");
    db.exec(`
      ALTER TABLE contacts ADD COLUMN in_network INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE contacts ADD COLUMN current_school TEXT NOT NULL DEFAULT '';
      UPDATE contacts SET role = category WHERE role = '' AND category NOT IN ('', 'Contact');
      ALTER TABLE contacts DROP COLUMN category;
      -- Name-only people who exist because someone listed them under "Related to".
      UPDATE contacts SET in_network = 0
        WHERE role = '' AND department = '' AND schools = '' AND research = '' AND website = '' AND email = ''
          AND notes = '' AND last_contacted = '' AND follow_up_date = ''
          AND id IN (SELECT a_id FROM relationships UNION SELECT b_id FROM relationships);
      PRAGMA user_version = 1;
    `);
    db.exec("COMMIT");
  }
  if (version < 2) {
    db.exec("BEGIN");
    db.exec(ORG_SCHEMA);
    const rows = db.prepare("SELECT id, schools, current_school FROM contacts WHERE schools != ''").all() as {
      id: number;
      schools: string;
      current_school: string;
    }[];
    const find = db.prepare("SELECT id FROM organizations WHERE name = ? COLLATE NOCASE");
    const create = db.prepare("INSERT INTO organizations (name, type) VALUES (?, 'School')");
    const link = db.prepare("INSERT OR IGNORE INTO contact_orgs (contact_id, org_id, current) VALUES (?, ?, ?)");
    for (const r of rows) {
      for (const name of splitList(r.schools)) {
        const orgId = (find.get(name) as { id: number } | undefined)?.id ?? Number(create.run(name).lastInsertRowid);
        link.run(r.id, orgId, name.toLowerCase() === r.current_school.trim().toLowerCase() ? 1 : 0);
      }
    }
    db.exec(`
      ALTER TABLE contacts DROP COLUMN schools;
      ALTER TABLE contacts DROP COLUMN current_school;
      PRAGMA user_version = 2;
    `);
    db.exec("COMMIT");
  }
  if (version < 3) {
    db.exec("BEGIN");
    db.exec(`
      ALTER TABLE contacts ADD COLUMN relationship_status TEXT NOT NULL DEFAULT '';
      ALTER TABLE relationships ADD COLUMN kind TEXT NOT NULL DEFAULT '';
    `);
    // Research runs can now belong to an organization, so contact_id becomes optional (SQLite needs a table rebuild).
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'research_runs'").get()) {
      db.exec(`
        ALTER TABLE research_runs RENAME TO research_runs_v2;
        DROP INDEX IF EXISTS research_runs_contact;
        ${RUNS_SCHEMA}
        INSERT INTO research_runs (id, contact_id, status, started_at, finished_at, summary, sources, applied, suggestions, error)
          SELECT id, contact_id, status, started_at, finished_at, summary, sources, applied, suggestions, error FROM research_runs_v2;
        DROP TABLE research_runs_v2;
      `);
    }
    db.exec("PRAGMA user_version = 3");
    db.exec("COMMIT");
  }
}

function parseRun(row: Record<string, unknown>): ResearchRun {
  return {
    ...(row as unknown as ResearchRun),
    sources: JSON.parse(row.sources as string),
    applied: JSON.parse(row.applied as string),
    suggestions: JSON.parse(row.suggestions as string),
  };
}
