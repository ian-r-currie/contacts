import { parseCsv } from "./csv.ts";
import { CONTACT_FIELDS, splitList, type ContactField, type DB, type OrgField, type OrgInput } from "./db.ts";

export type ImportTarget = ContactField | "organizations" | "related" | "updated" | "ignore";
export type OrgImportTarget = OrgField | "parent" | "ignore";
export type ImportKind = "people" | "orgs";

export type ImportOptions = {
  /** Role for rows that don't have one (e.g. "Professor" for a list of profs). */
  role?: string;
  /** Header → target overrides. Headers not listed fall back to the automatic guess. */
  mapping?: Record<string, string>;
};

export type ImportSummary = {
  created: number;
  merged: number;
  stubs: number;
  relations: number;
  skipped: number;
  notes: string[];
};

const SYNONYMS: Record<string, ImportTarget> = {
  name: "name",
  fullname: "name",
  professor: "name",
  prof: "name",
  contact: "name",
  person: "name",
  role: "role",
  relationshipstatus: "relationship_status",
  relationship: "relationship_status",
  status: "relationship_status",
  title: "role",
  position: "role",
  department: "department",
  dept: "department",
  field: "department",
  school: "organizations",
  schools: "organizations",
  university: "organizations",
  institution: "organizations",
  affiliation: "organizations",
  affiliations: "organizations",
  organization: "organizations",
  organizations: "organizations",
  organisation: "organizations",
  organisations: "organizations",
  orgs: "organizations",
  research: "research",
  researchinterests: "research",
  researcharea: "research",
  website: "website",
  url: "website",
  site: "website",
  homepage: "website",
  email: "email",
  emailaddress: "email",
  followupdate: "follow_up_date",
  followup: "follow_up_date",
  lastcontacted: "last_contacted",
  notes: "notes",
  note: "notes",
  comments: "notes",
  relatedto: "related",
  related: "related",
  connections: "related",
  updated: "updated",
  lastupdated: "updated",
};

const normHeader = (h: string) => h.toLowerCase().replace(/[^a-z]/g, "");

const ORG_SYNONYMS: Record<string, OrgImportTarget> = {
  orgname: "name",
  organization: "name",
  organisation: "name",
  organizationname: "name",
  org: "name",
  name: "name",
  school: "parent",
  university: "parent",
  institution: "parent",
  parent: "parent",
  partof: "parent",
  type: "type",
  kind: "type",
  category: "type",
  website: "website",
  url: "website",
  site: "website",
  homepage: "website",
  description: "description",
  about: "description",
  summary: "description",
  focus: "description",
  notes: "notes",
  note: "notes",
  comments: "notes",
};

const normHeaderAll = (headers: string[]) => headers.map((h) => h.toLowerCase().replace(/[^a-z]/g, ""));

/** An organizations sheet names an org column and has no person column. */
export function guessKind(headers: string[]): ImportKind {
  const norm = normHeaderAll(headers);
  const hasOrgName = norm.some((h) => ["orgname", "organizationname", "org", "organization", "organisation"].includes(h));
  const hasPerson = norm.some((h) => ["professor", "prof", "fullname", "contact", "person"].includes(h));
  return hasOrgName && !hasPerson ? "orgs" : "people";
}

export function guessMapping(headers: string[], kind: ImportKind = guessKind(headers)): Record<string, string> {
  const table: Record<string, string> = kind === "orgs" ? ORG_SYNONYMS : SYNONYMS;
  return Object.fromEntries(headers.map((h) => [h, table[normHeader(h)] ?? "ignore"]));
}

export function previewCsv(text: string, forceKind?: ImportKind) {
  const rows = parseCsv(text);
  const headers = rows[0] ?? [];
  const kind = forceKind ?? guessKind(headers);
  return {
    kind,
    headers,
    mapping: guessMapping(headers, kind),
    rowCount: Math.max(rows.length - 1, 0),
    sample: rows.slice(1, 4),
    suggestedRole: headers.some((h) => normHeader(h).startsWith("prof")) ? "Professor" : "",
  };
}

const isSchoolHeader = (h: string) => /school|universit/i.test(h);

/** Normalizes assorted human date formats ("Oct 7 2026", "October 17, 2026") to YYYY-MM-DD. Returns null if unparseable. */
export function normalizeDate(raw: string): string | null {
  const s = raw.trim();
  if (!s) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const t = Date.parse(s);
  if (Number.isNaN(t)) return null;
  const d = new Date(t);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function splitNames(raw: string): string[] {
  return raw
    .split(/[,;\n]|\s+and\s+|\s*&\s*/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** "https://www.janedoe.ca/x" → "janedoe" (host minus www and TLD, letters only). */
function hostKey(url: string): string {
  try {
    const host = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).hostname.replace(/^www\./, "");
    return host.split(".").slice(0, -1).join("").toLowerCase().replace(/[^a-z]/g, "");
  } catch {
    return "";
  }
}

function hostName(url: string): string {
  try {
    return new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

const nameTokens = (name: string) =>
  name
    .toLowerCase()
    .split(/[\s-]+/)
    .map((t) => t.replace(/[^a-z]/g, ""))
    .filter((t) => t.length >= 4);

const PLACEHOLDER = /^Unknown \(.*\)$/;

export function importCsv(db: DB, text: string, opts: ImportOptions = {}): ImportSummary {
  const rows = parseCsv(text);
  const summary: ImportSummary = { created: 0, merged: 0, stubs: 0, relations: 0, skipped: 0, notes: [] };
  if (rows.length < 2) return summary;

  const headers = rows[0];
  const mapping = { ...guessMapping(headers, "people"), ...opts.mapping } as Record<string, ImportTarget>;
  const defaultRole = opts.role?.trim() ?? "";

  return db.transaction(() => {
    // Live index of everyone in the database, updated as we go.
    const contacts = db.listContacts().map((c) => ({ id: c.id, name: c.name, website: c.website }));
    const byName = new Map(contacts.map((c) => [c.name.toLowerCase(), c]));
    const add = (c: { id: number; name: string; website: string }) => {
      contacts.push(c);
      byName.set(c.name.toLowerCase(), c);
    };

    const pending: { id: number; related: string[] }[] = [];

    for (const [i, row] of rows.slice(1).entries()) {
      const fields: Partial<Record<ContactField, string>> = {};
      const related: string[] = [];
      const orgs: { name: string; type: string }[] = [];
      let updated: string | undefined;

      headers.forEach((h, col) => {
        const target = mapping[h];
        const value = (row[col] ?? "").trim();
        if (!value || !target || target === "ignore") return;
        if (target === "related") related.push(...splitNames(value));
        else if (target === "organizations") orgs.push(...splitList(value).map((name) => ({ name, type: isSchoolHeader(h) ? "School" : "" })));
        else if (target === "updated") updated = normalizeDate(value) || undefined;
        else if (target === "follow_up_date" || target === "last_contacted") {
          const d = normalizeDate(value);
          if (d === null) {
            fields.notes = [fields.notes, `${h}: ${value}`].filter(Boolean).join("\n");
            summary.notes.push(`Row ${i + 2}: couldn't read "${value}" as a date; kept it in notes.`);
          } else fields[target] = d;
        } else if (target === "notes" && fields.notes) fields.notes = `${value}\n${fields.notes}`;
        else fields[target] = fields[target] ? `${fields[target]}, ${value}` : value;
      });
      if (!fields.role && defaultRole) fields.role = defaultRole;

      let name = fields.name ?? "";
      let existing = name ? byName.get(name.toLowerCase()) : undefined;

      if (!name) {
        if (!fields.website) {
          summary.skipped++;
          summary.notes.push(`Row ${i + 2}: no name or website, skipped.`);
          continue;
        }
        // A nameless row with a website: find the one known person whose name appears in the domain.
        const key = hostKey(fields.website);
        const matches = contacts.filter((c) => !c.website && nameTokens(c.name).some((t) => key.includes(t)));
        if (matches.length === 1) {
          existing = matches[0];
          summary.notes.push(`Row ${i + 2}: matched ${hostName(fields.website)} to ${existing.name}.`);
        } else {
          name = `Unknown (${hostName(fields.website)})`;
          existing = byName.get(name.toLowerCase());
          summary.notes.push(`Row ${i + 2}: no name; saved as "${name}". The research agent can fill it in.`);
        }
      }

      let id: number;
      if (existing) {
        // Merge: only fill fields that are currently empty, never overwrite.
        const current = db.getContact(existing.id)!;
        const patch: Partial<Record<ContactField, string>> = {};
        for (const f of CONTACT_FIELDS) {
          if (f === "name" || !fields[f]) continue;
          if (!current[f]) patch[f] = fields[f];
          else if (f === "notes" && !current.notes.includes(fields.notes!)) patch.notes = `${current.notes}\n${fields.notes}`;
        }
        // Someone who was only a connection is now a contact in their own right.
        db.updateContact(existing.id, { ...patch, in_network: true });
        if (patch.website) existing.website = patch.website;
        id = existing.id;
        summary.merged++;
      } else {
        id = db.createContact({ ...fields, name }, updated ? `${updated}T12:00:00.000Z` : undefined);
        add({ id, name, website: fields.website ?? "" });
        summary.created++;
      }
      if (orgs.length) db.addContactOrgs(id, orgs, { touch: false });
      if (related.length) pending.push({ id, related });
    }

    // Second pass, so references to people later in the file resolve to them instead of stubs.
    const resolve = (ref: string): number => {
      const exact = byName.get(ref.toLowerCase());
      if (exact) return exact.id;

      const tokens = ref.toLowerCase().split(/\s+/);
      if (tokens.length === 1) {
        const firstNameMatches = contacts.filter((c) => c.name.toLowerCase().split(/\s+/)[0] === tokens[0]);
        if (firstNameMatches.length === 1) {
          summary.notes.push(`"${ref}" linked to ${firstNameMatches[0].name}.`);
          return firstNameMatches[0].id;
        }
      }

      // A placeholder ("Unknown (janedoe.ca)") whose domain contains this name: give it the real name.
      const refTokens = nameTokens(ref);
      const placeholders = contacts.filter((c) => PLACEHOLDER.test(c.name) && refTokens.some((t) => hostKey(c.website).includes(t)));
      if (placeholders.length === 1) {
        const p = placeholders[0];
        summary.notes.push(`Renamed "${p.name}" to ${ref}.`);
        byName.delete(p.name.toLowerCase());
        db.updateContact(p.id, { name: ref });
        p.name = ref;
        byName.set(ref.toLowerCase(), p);
        return p.id;
      }

      const id = db.createContact({ name: ref, in_network: false });
      add({ id, name: ref, website: "" });
      summary.stubs++;
      return id;
    };

    const linked = new Set<string>();
    for (const { id, related } of pending) {
      for (const ref of related) {
        const other = resolve(ref);
        if (other === id) continue;
        db.relate(id, other);
        linked.add([id, other].sort((a, b) => a - b).join("-"));
      }
    }
    summary.relations = linked.size;
    return summary;
  });
}

/**
 * Imports an organizations sheet. A blank name falls back to the website's domain; a "School" column
 * becomes the parent organization. Rows matching an existing org (by name or website) are merged.
 */
export function importOrgsCsv(db: DB, text: string, opts: ImportOptions = {}): ImportSummary {
  const rows = parseCsv(text);
  const summary: ImportSummary = { created: 0, merged: 0, stubs: 0, relations: 0, skipped: 0, notes: [] };
  if (rows.length < 2) return summary;
  const headers = rows[0];
  const mapping = { ...guessMapping(headers, "orgs"), ...opts.mapping } as Record<string, OrgImportTarget>;

  return db.transaction(() => {
    for (const [i, row] of rows.slice(1).entries()) {
      const fields: OrgInput = {};
      let parent: { name: string; type: string } | undefined;
      headers.forEach((h, col) => {
        const target = mapping[h];
        const value = (row[col] ?? "").trim();
        if (!value || !target || target === "ignore") return;
        if (target === "parent") parent = { name: value, type: isSchoolHeader(h) ? "School" : "" };
        else fields[target] = fields[target] ? `${fields[target]}\n${value}` : value;
      });

      let name = fields.name ?? "";
      if (!name && fields.website) {
        name = hostName(fields.website);
        summary.notes.push(`Row ${i + 2}: no name; saved as "${name}". Rename it on the Organizations page.`);
      }
      if (!name) {
        summary.skipped++;
        summary.notes.push(`Row ${i + 2}: no name or website, skipped.`);
        continue;
      }
      if (parent && parent.name.toLowerCase() !== name.toLowerCase()) fields.parent_id = db.ensureOrg(parent.name, { type: parent.type });

      const key = siteKey(fields.website ?? "");
      const existing = db.findOrg(name) ?? (key ? db.listOrgs().find((o) => siteKey(o.website) === key) : undefined);
      if (existing) {
        const patch: OrgInput = {};
        for (const f of ["type", "website", "description", "notes"] as const) if (fields[f] && !existing[f]) patch[f] = fields[f];
        if (fields.parent_id && !existing.parent_id) patch.parent_id = fields.parent_id;
        db.updateOrg(existing.id, patch);
        summary.merged++;
      } else {
        db.createOrg({ ...fields, name });
        summary.created++;
      }
    }
    return summary;
  });
}

/** Host + path, ignoring scheme, "www." and trailing slashes, so two links to the same page compare equal. */
function siteKey(url: string): string {
  if (!url.trim()) return "";
  try {
    const u = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
    return u.hostname.replace(/^www\./, "") + u.pathname.replace(/\/$/, "");
  } catch {
    return url.trim().toLowerCase();
  }
}
