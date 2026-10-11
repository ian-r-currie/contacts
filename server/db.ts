import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { config } from "./config.ts";

/** Editable text fields on a contact, in display order. */
export const CONTACT_FIELDS = [
  "name",
  "role",
  "department",
  "schools",
  "current_school",
  "research",
  "website",
  "email",
  "last_contacted",
  "follow_up_date",
  "notes",
] as const;
export type ContactField = (typeof CONTACT_FIELDS)[number];

/** Fields the research agent is allowed to fill in. */
export const RESEARCHABLE_FIELDS = ["name", "role", "department", "schools", "research", "website", "email"] as const;
export type ResearchableField = (typeof RESEARCHABLE_FIELDS)[number];

/** in_network is false for people who only appear as someone's connection (not tracked as contacts). */
export type Contact = { id: number; in_network: boolean; created_at: string; updated_at: string } & Record<ContactField, string>;
export type Relation = { id: number; name: string; note: string; in_network: boolean };
export type ContactWithRelations = Contact & { related: Relation[] };

export type ResearchRun = {
  id: number;
  contact_id: number;
  status: "running" | "done" | "error";
  started_at: string;
  finished_at: string | null;
  summary: string;
  sources: { url: string; title: string }[];
  applied: Partial<Record<ResearchableField, string>>;
  suggestions: Partial<Record<ResearchableField, string>>;
  error: string;
};

export type ContactInput = Partial<Record<ContactField, string>> & { in_network?: boolean };
export type DB = ReturnType<typeof openDb>;

export const splitSchools = (schools: string) =>
  schools
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  in_network INTEGER NOT NULL DEFAULT 1,
  role TEXT NOT NULL DEFAULT '',
  department TEXT NOT NULL DEFAULT '',
  schools TEXT NOT NULL DEFAULT '',
  current_school TEXT NOT NULL DEFAULT '',
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
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (a_id, b_id),
  CHECK (a_id < b_id)
);
CREATE INDEX IF NOT EXISTS relationships_b ON relationships(b_id);

CREATE TABLE IF NOT EXISTS research_runs (
  id INTEGER PRIMARY KEY,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
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
        `SELECT r.a_id AS self, c.id, c.name, c.in_network, r.note FROM relationships r JOIN contacts c ON c.id = r.b_id
         UNION ALL
         SELECT r.b_id AS self, c.id, c.name, c.in_network, r.note FROM relationships r JOIN contacts c ON c.id = r.a_id
         ORDER BY name COLLATE NOCASE`,
      )
      .all() as { self: number; id: number; name: string; in_network: number; note: string }[];
    for (const r of rows) map.get(r.self)?.push({ id: r.id, name: r.name, note: r.note, in_network: Boolean(r.in_network) });
    return map;
  }

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
      return contacts.map((c) => ({ ...c, related: rel.get(c.id) ?? [] }));
    },

    getContact(id: number): ContactWithRelations | undefined {
      const row = db.prepare("SELECT * FROM contacts WHERE id = ?").get(id) as Record<string, unknown> | undefined;
      if (!row) return undefined;
      return { ...rowToContact(row), related: relationsFor([id]).get(id) ?? [] };
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
      // Editing the school list drops a current school that is no longer in it.
      if (values.schools !== undefined && values.current_school === undefined) {
        const current = (db.prepare("SELECT current_school FROM contacts WHERE id = ?").get(id) as { current_school: string } | undefined)
          ?.current_school;
        if (current && !splitSchools(values.schools as string).some((s) => s.toLowerCase() === current.toLowerCase())) values.current_school = "";
      }
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

    /** Links two contacts. Idempotent; updates the note when given. */
    relate(x: number, y: number, note?: string) {
      if (x === y) throw new Error("A contact cannot be related to itself");
      const [a, b] = x < y ? [x, y] : [y, x];
      db.prepare(
        `INSERT INTO relationships (a_id, b_id, note) VALUES (?, ?, ?)
         ON CONFLICT (a_id, b_id) DO UPDATE SET note = CASE WHEN ? IS NULL THEN note ELSE excluded.note END`,
      ).run(a, b, note ?? "", note ?? null);
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

    // --- research runs ---
    startRun(contactId: number): number {
      return Number(db.prepare("INSERT INTO research_runs (contact_id, status) VALUES (?, 'running')").run(contactId).lastInsertRowid);
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

    listRuns(contactId: number): ResearchRun[] {
      return (db.prepare("SELECT * FROM research_runs WHERE contact_id = ? ORDER BY id DESC").all(contactId) as Record<string, unknown>[]).map(
        parseRun,
      );
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
 */
function migrate(db: DatabaseSync) {
  const version = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  const hasContacts = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'contacts'").get();
  if (!hasContacts) {
    db.exec("PRAGMA user_version = 1");
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
}

function parseRun(row: Record<string, unknown>): ResearchRun {
  return {
    ...(row as unknown as ResearchRun),
    sources: JSON.parse(row.sources as string),
    applied: JSON.parse(row.applied as string),
    suggestions: JSON.parse(row.suggestions as string),
  };
}
