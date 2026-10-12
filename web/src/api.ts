export const FIELDS = [
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
export type Field = (typeof FIELDS)[number];
export type ResearchableField = "name" | "role" | "department" | "organizations" | "research" | "website" | "email";

export const LABELS: Record<Field | "orgs" | "organizations" | "related" | "updated_at", string> = {
  name: "Name",
  role: "Role",
  relationship_status: "Relationship status",
  department: "Department",
  orgs: "Organizations",
  organizations: "Organizations",
  research: "Research",
  website: "Website",
  email: "Email",
  last_contacted: "Last contacted",
  follow_up_date: "Follow-up",
  notes: "Notes",
  related: "Related to",
  updated_at: "Updated",
};

/** A link between two people. `kind` is an optional type (friends, mentorship…), `note` free text. */
export type Relation = { id: number; name: string; kind: string; note: string; in_network: boolean };
/** Suggested relationship types; any text works. */
export const RELATION_KINDS = ["Friends", "Colleagues", "Mentorship", "Supervisor", "Collaborators", "Classmates", "Family", "Introduced by"];
/** A person's link to an organization. `current` marks where they are now. */
export type Membership = { id: number; name: string; type: string; current: boolean };
/** in_network is false for people who are only someone's connection, not tracked as contacts themselves. */
export type Contact = {
  id: number;
  in_network: boolean;
  created_at: string;
  updated_at: string;
  related: Relation[];
  orgs: Membership[];
} & Record<Field, string>;
/** `orgs` replaces the person's organizations with these names (created as needed). */
export type ContactInput = Partial<Record<Field, string>> & { in_network?: boolean; orgs?: string[] };

export const ORG_FIELDS = ["name", "type", "website", "description", "notes"] as const;
export type OrgField = (typeof ORG_FIELDS)[number];
export type OrgMember = { id: number; name: string; in_network: boolean; current: boolean };
/** A school, lab, institute, company, group… Schools are organizations of type "School". */
export type Org = { id: number; parent_id: number | null; created_at: string; updated_at: string; members: OrgMember[] } & Record<OrgField, string>;
export type OrgInput = Partial<Record<OrgField, string>> & { parent_id?: number | null };
export const ORG_TYPES = ["School", "Lab", "Institute", "Department", "Company", "Group", "Nonprofit", "Government"];

export type ResearchRun = {
  id: number;
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

export type ResearchSubject = { kind: "contact" | "org"; id: number };

export type ResearchEvent =
  | { type: "status"; text: string }
  | { type: "search"; query: string }
  | { type: "fetch"; url: string }
  | { type: "progress"; text: string }
  | { type: "done"; run: ResearchRun }
  | { type: "error"; message: string };

export type AppConfig = { researchEnabled: boolean; vapidPublicKey: string; today: string };
export type ImportKind = "people" | "orgs";
export type ImportPreview = {
  kind: ImportKind;
  headers: string[];
  mapping: Record<string, string>;
  rowCount: number;
  sample: string[][];
  suggestedRole: string;
};
export type ImportSummary = { created: number; merged: number; stubs: number; relations: number; skipped: number; notes: string[] };

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError((data as { error?: string }).error ?? res.statusText, res.status);
  return data as T;
}

export const api = {
  session: () => request<{ authRequired: boolean; authenticated: boolean }>("GET", "/api/session"),
  login: (password: string) => request("POST", "/api/login", { password }),
  logout: () => request("POST", "/api/logout"),
  config: () => request<AppConfig>("GET", "/api/config"),

  contacts: () => request<Contact[]>("GET", "/api/contacts"),
  create: (fields: ContactInput & { name: string }) => request<Contact>("POST", "/api/contacts", fields),
  update: (id: number, fields: ContactInput) => request<Contact>("PATCH", `/api/contacts/${id}`, fields),
  remove: (id: number) => request("DELETE", `/api/contacts/${id}`),
  relate: (id: number, otherId: number, details: { note?: string; kind?: string } = {}) =>
    request<Contact>("PUT", `/api/contacts/${id}/related/${otherId}`, details),
  relationKinds: () => request<string[]>("GET", "/api/relation-kinds"),
  unrelate: (id: number, otherId: number) => request<Contact>("DELETE", `/api/contacts/${id}/related/${otherId}`),

  importPreview: (csv: string, kind?: ImportKind) => request<ImportPreview>("POST", "/api/import/preview", { csv, kind }),
  importCsv: (csv: string, kind: ImportKind, role: string, mapping: Record<string, string>) =>
    request<ImportSummary>("POST", "/api/import", { csv, kind, role, mapping }),

  setMembership: (id: number, orgId: number, current?: boolean) => request<Contact>("PUT", `/api/contacts/${id}/orgs/${orgId}`, { current }),
  removeMembership: (id: number, orgId: number) => request<Contact>("DELETE", `/api/contacts/${id}/orgs/${orgId}`),

  orgs: () => request<Org[]>("GET", "/api/orgs"),
  createOrg: (fields: OrgInput & { name: string }) => request<Org>("POST", "/api/orgs", fields),
  updateOrg: (id: number, fields: OrgInput) => request<Org>("PATCH", `/api/orgs/${id}`, fields),
  removeOrg: (id: number) => request("DELETE", `/api/orgs/${id}`),

  researchBase: (s: ResearchSubject) => `/api/${s.kind === "org" ? "orgs" : "contacts"}/${s.id}/research`,
  researchRuns: (s: ResearchSubject) => request<{ runs: ResearchRun[]; running: number | null }>("GET", api.researchBase(s)),
  startResearch: (s: ResearchSubject, instructions: string) => request<{ runId: number }>("POST", api.researchBase(s), { instructions }),
  acceptSuggestions: (runId: number, fields: string[]) => request<{ run: ResearchRun }>("POST", `/api/research/${runId}/accept`, { fields }),
  dismissSuggestions: (runId: number, fields: string[]) =>
    request<{ run: ResearchRun }>("POST", `/api/research/${runId}/dismiss`, { fields }),

  pushSubscribe: (sub: PushSubscriptionJSON) => request("POST", "/api/push/subscribe", sub),
  pushUnsubscribe: (endpoint: string) => request("POST", "/api/push/unsubscribe", { endpoint }),
  pushTest: () => request<{ delivered: number }>("POST", "/api/push/test"),
};

/** Local-date helpers (YYYY-MM-DD). */
export function localToday(): string {
  return new Date().toLocaleDateString("en-CA");
}
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00`);
  d.setDate(d.getDate() + days);
  return d.toLocaleDateString("en-CA");
}
export function formatDate(date: string): string {
  if (!date) return "";
  const d = new Date(date.length === 10 ? `${date}T12:00:00` : date);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: sameYear ? undefined : "numeric" });
}
export type DueState = "overdue" | "today" | "soon" | "later" | "";
export function dueState(date: string, today = localToday()): DueState {
  if (!date) return "";
  if (date < today) return "overdue";
  if (date === today) return "today";
  if (date <= addDays(today, 7)) return "soon";
  return "later";
}

/** Where someone is now: memberships marked current, or their only organization. */
export function currentOrgs(c: Pick<Contact, "orgs">): Membership[] {
  const marked = c.orgs.filter((o) => o.current);
  return marked.length ? marked : c.orgs.length === 1 ? c.orgs : [];
}

/** Short "where they are" text for subtitles and cards. */
export function orgSummary(c: Pick<Contact, "orgs">): string {
  const current = currentOrgs(c);
  return (current.length ? current : c.orgs.slice(0, 1)).map((o) => o.name).join(", ");
}
