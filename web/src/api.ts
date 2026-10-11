export const FIELDS = [
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
export type Field = (typeof FIELDS)[number];
export type ResearchableField = "name" | "role" | "department" | "schools" | "research" | "website" | "email";

export const LABELS: Record<Field | "related" | "updated_at", string> = {
  name: "Name",
  role: "Role",
  department: "Department",
  schools: "Schools",
  current_school: "Current school",
  research: "Research",
  website: "Website",
  email: "Email",
  last_contacted: "Last contacted",
  follow_up_date: "Follow-up",
  notes: "Notes",
  related: "Related to",
  updated_at: "Updated",
};

export type Relation = { id: number; name: string; note: string; in_network: boolean };
/** in_network is false for people who are only someone's connection, not tracked as contacts themselves. */
export type Contact = { id: number; in_network: boolean; created_at: string; updated_at: string; related: Relation[] } & Record<Field, string>;
export type ContactInput = Partial<Record<Field, string>> & { in_network?: boolean };

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

export type ResearchEvent =
  | { type: "status"; text: string }
  | { type: "search"; query: string }
  | { type: "fetch"; url: string }
  | { type: "progress"; text: string }
  | { type: "done"; run: ResearchRun }
  | { type: "error"; message: string };

export type AppConfig = { researchEnabled: boolean; vapidPublicKey: string; today: string };
export type ImportTarget = Field | "related" | "updated" | "ignore";
export type ImportPreview = {
  headers: string[];
  mapping: Record<string, ImportTarget>;
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
  relate: (id: number, otherId: number, note?: string) => request<Contact>("PUT", `/api/contacts/${id}/related/${otherId}`, { note }),
  unrelate: (id: number, otherId: number) => request<Contact>("DELETE", `/api/contacts/${id}/related/${otherId}`),

  importPreview: (csv: string) => request<ImportPreview>("POST", "/api/import/preview", { csv }),
  importCsv: (csv: string, role: string, mapping: Record<string, ImportTarget>) =>
    request<ImportSummary>("POST", "/api/import", { csv, role, mapping }),

  researchRuns: (id: number) => request<{ runs: ResearchRun[]; running: number | null }>("GET", `/api/contacts/${id}/research`),
  startResearch: (id: number, instructions: string) => request<{ runId: number }>("POST", `/api/contacts/${id}/research`, { instructions }),
  acceptSuggestions: (runId: number, fields: ResearchableField[]) =>
    request<{ run: ResearchRun; contact: Contact }>("POST", `/api/research/${runId}/accept`, { fields }),
  dismissSuggestions: (runId: number, fields: ResearchableField[]) =>
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

export function splitSchools(schools: string): string[] {
  return schools
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** The highlighted school: the one marked current, or the only one listed. */
export function currentSchool(c: Pick<Contact, "schools" | "current_school">): string {
  const list = splitSchools(c.schools);
  const marked = list.find((s) => s.toLowerCase() === c.current_school.trim().toLowerCase());
  return marked ?? (list.length === 1 ? list[0] : "");
}
