import { ApiError, GoogleGenAI } from "@google/genai";
import { z } from "zod";
import { config, hasResearchCredentials } from "./config.ts";
import {
  RESEARCHABLE_FIELDS,
  splitList,
  type ContactWithRelations,
  type DB,
  type OrgInput,
  type OrgRef,
  type OrgWithMembers,
  type ResearchableField,
  type ResearchRun,
  type Subject,
} from "./db.ts";

export type ResearchEvent =
  | { type: "status"; text: string }
  | { type: "search"; query: string }
  | { type: "fetch"; url: string }
  | { type: "progress"; text: string }
  | { type: "done"; run: ResearchRun }
  | { type: "error"; message: string };

type Job = { runId: number; subject: Subject; events: ResearchEvent[]; listeners: Set<(e: ResearchEvent) => void>; finished: boolean };

/** One research job per person or organization at a time. Jobs outlive the HTTP request, so closing the pane doesn't stop them. */
const jobs = new Map<string, Job>();
const jobKey = (s: Subject) => `${s.kind}:${s.id}`;

export function getJob(subject: Subject): Job | undefined {
  return jobs.get(jobKey(subject));
}

export function subscribe(job: Job, listener: (e: ResearchEvent) => void): () => void {
  for (const e of job.events) listener(e);
  if (job.finished) return () => {};
  job.listeners.add(listener);
  return () => job.listeners.delete(listener);
}

export function startResearch(db: DB, subject: Subject, instructions = ""): Job {
  const running = jobs.get(jobKey(subject));
  if (running && !running.finished) return running;

  const target = subject.kind === "org" ? db.getOrg(subject.id) : db.getContact(subject.id);
  if (!target) throw new Error(subject.kind === "org" ? "Organization not found" : "Contact not found");
  if (!hasResearchCredentials()) throw new Error("Set GEMINI_API_KEY in .env to use the research agent.");

  const job: Job = { runId: db.startRun(subject), subject, events: [], listeners: new Set(), finished: false };
  jobs.set(jobKey(subject), job);
  const emit = (e: ResearchEvent) => {
    job.events.push(e);
    for (const l of job.listeners) l(e);
    if (e.type === "done" || e.type === "error") {
      job.finished = true;
      job.listeners.clear();
    }
  };

  const work =
    subject.kind === "org"
      ? runAgent(ORG_AGENT, orgPrompt(db, target as OrgWithMembers, instructions), OrgFindingsSchema, emit).then((f) =>
          applyOrgFindings(db, job.runId, subject.id, f),
        )
      : runAgent(PERSON_AGENT, personPrompt(db, target as ContactWithRelations, instructions), PersonFindingsSchema, emit).then(
          (f) => applyPersonFindings(db, job.runId, subject.id, f),
        );
  work
    .then((run) => emit({ type: "done", run }))
    .catch((err: unknown) => {
      const message = describeError(err);
      db.failRun(job.runId, message);
      emit({ type: "error", message });
    });
  return job;
}

// ---------------------------------------------------------------------------------------------------------------------
// Shared pieces

const SourcesSchema = z.array(z.object({ url: z.string(), title: z.string() }));
/** A research agent: what to look for (step 1, with web search) and the JSON shape to extract (step 2). */
type Agent = { system: string; schema: Record<string, unknown> };

const textField = (description: string) => ({ type: "string", description: `${description} Empty string if not found with confidence.` });

function findingsSchema(fields: Record<string, unknown>, summary: string) {
  return {
    type: "object",
    properties: {
      fields: { type: "object", properties: fields, required: Object.keys(fields) },
      summary: { type: "string", description: summary },
    },
    required: ["fields", "summary"],
  };
}

/** Field list for the research instructions. */
const describeFields = (guide: Record<string, string>) =>
  Object.entries(guide)
    .map(([f, d]) => `- ${f}: ${d}`)
    .join("\n");

/** Organization names already in the list, so the agent reuses them instead of inventing variants. */
function knownOrgNames(db: DB): string {
  const names = db.listOrgs().map((o) => o.name);
  return names.length ? `\nOrganizations already in the list (use these exact names when one matches): ${names.slice(0, 200).join("; ")}.` : "";
}

const clean = (v: string | null | undefined) => (v ?? "").trim();

/**
 * Two Gemini calls: the first searches the web (Google Search + URL context grounding) and writes research notes,
 * the second turns those notes into JSON matching the agent's schema. Search and structured output are kept apart
 * because combining them in one request isn't supported on every model.
 */
async function runAgent<T>(agent: Agent, prompt: string, schema: z.ZodType<T>, emit: (e: ResearchEvent) => void): Promise<T> {
  const ai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY,
    // Only for pointing at a proxy or a local stand-in; normally unset.
    ...(process.env.GEMINI_BASE_URL ? { httpOptions: { baseUrl: process.env.GEMINI_BASE_URL } } : {}),
  });
  emit({ type: "status", text: "Searching the web…" });

  const stream = await ai.models.generateContentStream({
    model: config.researchModel,
    contents: prompt,
    config: {
      systemInstruction: agent.system,
      tools: [{ googleSearch: {} }, { urlContext: {} }],
      thinkingConfig: { includeThoughts: true },
    },
  });

  let notes = "";
  const queries = new Set<string>();
  const fetched = new Set<string>();
  const sources = new Map<string, string>();
  for await (const chunk of stream) {
    const candidate = chunk.candidates?.[0];
    for (const part of candidate?.content?.parts ?? []) {
      if (!part.text) continue;
      if (part.thought) {
        const text = part.text.replace(/\*\*/g, "").trim();
        if (text) emit({ type: "progress", text: text.length > 240 ? `${text.slice(0, 239)}…` : text });
      } else notes += part.text;
    }
    for (const q of candidate?.groundingMetadata?.webSearchQueries ?? []) {
      if (queries.has(q)) continue;
      queries.add(q);
      emit({ type: "search", query: q });
    }
    for (const c of candidate?.groundingMetadata?.groundingChunks ?? []) {
      if (c.web?.uri) sources.set(c.web.uri, c.web.title ?? c.web.uri);
    }
    for (const m of candidate?.urlContextMetadata?.urlMetadata ?? []) {
      if (m.retrievedUrl && !fetched.has(m.retrievedUrl)) {
        fetched.add(m.retrievedUrl);
        sources.set(m.retrievedUrl, m.retrievedUrl.replace(/^https?:\/\//, ""));
        emit({ type: "fetch", url: m.retrievedUrl });
      }
    }
  }
  if (!notes.trim()) throw new Error("Gemini returned no findings. Try again, or add a hint.");

  emit({ type: "status", text: "Organizing what was found…" });
  let lastError = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await ai.models.generateContent({
      model: config.researchModel,
      contents: `${prompt}\n\nResearch notes:\n${notes}`,
      config: {
        systemInstruction:
          "Extract the details from the research notes into the JSON format. Use only facts stated in the notes; use an empty string (or an empty list) for anything the notes don't establish.",
        responseMimeType: "application/json",
        responseJsonSchema: agent.schema,
      },
    });
    try {
      const raw = JSON.parse(res.text ?? "") as { fields?: Record<string, unknown>; summary?: string };
      // Empty strings / lists mean "not found".
      const fields = Object.fromEntries(
        Object.entries(raw.fields ?? {}).map(([k, v]) => [k, v === "" || (Array.isArray(v) && v.length === 0) ? null : typeof v === "string" ? v.trim() : v]),
      );
      const parsed = schema.safeParse({
        fields,
        summary: raw.summary ?? "",
        sources: [...sources].slice(0, 12).map(([url, title]) => ({ url, title })),
      });
      if (parsed.success) return parsed.data;
      lastError = parsed.error.message;
    } catch (err) {
      lastError = (err as Error).message;
    }
  }
  throw new Error(`Couldn't read Gemini's answer (${lastError}).`);
}

// ---------------------------------------------------------------------------------------------------------------------
// People

type TextField = Exclude<ResearchableField, "organizations">;
const TEXT_FIELDS = RESEARCHABLE_FIELDS.filter((f): f is TextField => f !== "organizations");
const PersonFindingsSchema = z.object({
  fields: z.object({
    ...(Object.fromEntries(TEXT_FIELDS.map((f) => [f, z.string().nullable()])) as Record<TextField, z.ZodNullable<z.ZodString>>),
    organizations: z.array(z.object({ name: z.string(), type: z.string(), current: z.boolean() })).nullable(),
  }),
  summary: z.string(),
  sources: SourcesSchema,
});
type PersonFindings = z.infer<typeof PersonFindingsSchema>;

const PERSON_GUIDE: Record<ResearchableField, string> = {
  name: "Full name as the person writes it professionally.",
  role: 'Current position, e.g. "Professor", "Associate Professor", "3rd year PhD Candidate", "Masters Student".',
  department: 'Department or program, e.g. "Computer Science".',
  organizations:
    'Schools, labs, institutes, companies and groups they are or were part of, with a type ("School", "Lab", "Institute", "Company", "Group"…) and current=true for affiliations they hold now. Use the full official name (e.g. "University of Toronto").',
  research: "Short comma-separated list of research areas or interests (under ~20 words).",
  website: "Personal or official profile page URL (prefer a personal site, then a lab or faculty page, then Google Scholar).",
  email: "Public email address, only if explicitly published by the person or their institution. Never guess a pattern.",
};

const PERSON_AGENT: Agent = {
  system: `You research people for a personal contacts list kept by a student who networks with researchers and academics (mostly around the University of Toronto).

Search the web for accurate, current public information about the person described. Disambiguate carefully: use the known details (organizations, department, related people, website) to make sure every finding is about this same person. Prefer official sources (personal sites, university and lab pages, Google Scholar). If a known detail looks outdated or wrong, say what you found.

Write concise research notes with, for each detail below, the value and the page it came from, or "not found":
${describeFields(PERSON_GUIDE)}
Do not invent or infer email addresses. End with a 2-4 sentence background on the person, useful before reaching out.`,
  schema: findingsSchema(
    {
      ...Object.fromEntries(TEXT_FIELDS.map((f) => [f, textField(PERSON_GUIDE[f])])),
      organizations: {
        type: "array",
        description: `${PERSON_GUIDE.organizations} Empty list if none found.`,
        items: {
          type: "object",
          properties: { name: { type: "string" }, type: { type: "string" }, current: { type: "boolean" } },
          required: ["name", "type", "current"],
        },
      },
    },
    "2-4 sentence plain-text background on the person, useful before reaching out.",
  ),
};

function personPrompt(db: DB, c: ContactWithRelations, instructions: string): string {
  const lines = [`Name: ${c.name}`];
  for (const f of ["role", "department", "research", "website", "email", "notes"] as const) {
    if (c[f]) lines.push(`${f[0].toUpperCase()}${f.slice(1)}: ${c[f]}`);
  }
  if (c.orgs.length) lines.push(`Organizations: ${formatOrgs(c.orgs)}`);
  if (c.related.length) lines.push(`Related to: ${c.related.map((r) => r.name + (r.kind || r.note ? ` (${[r.kind, r.note].filter(Boolean).join(": ")})` : "")).join(", ")}`);
  const missing = RESEARCHABLE_FIELDS.filter((f) => (f === "organizations" ? !c.orgs.length : !c[f] || /^Unknown \(/.test(c[f])));
  return [
    "Research this person:",
    lines.join("\n"),
    missing.length ? `\nMost wanted (currently missing): ${missing.join(", ")}.` : "",
    knownOrgNames(db),
    instructions ? `\nExtra instructions from the user: ${instructions}` : "",
  ].join("\n");
}

/** Fills empty fields automatically; differing values for fields you already have become suggestions. */
function applyPersonFindings(db: DB, runId: number, contactId: number, findings: PersonFindings): ResearchRun {
  const contact = db.getContact(contactId);
  if (!contact) throw new Error("Contact was deleted during research");

  const applied: Record<string, string> = {};
  const suggestions: Record<string, string> = {};
  const patch: Partial<Record<TextField, string>> = {};
  for (const f of TEXT_FIELDS) {
    const found = clean(findings.fields[f]);
    if (!found) continue;
    const current = clean(contact[f]);
    const placeholder = f === "name" && /^Unknown \(/.test(current);
    if (!current || placeholder) applied[f] = patch[f] = found;
    else if (current.toLowerCase() !== found.toLowerCase()) suggestions[f] = found;
  }
  db.updateContact(contactId, patch);

  // Organizations are only ever added: all of them when the person has none yet, otherwise new ones are suggested.
  const known = new Set(contact.orgs.map((o) => o.name.toLowerCase()));
  const newOrgs = (findings.fields.organizations ?? []).filter((o) => o.name.trim() && !known.has(o.name.trim().toLowerCase()));
  if (newOrgs.length && contact.orgs.length === 0) {
    db.addContactOrgs(contactId, newOrgs);
    applied.organizations = formatOrgs(newOrgs);
  } else if (newOrgs.length) suggestions.organizations = formatOrgs(newOrgs);
  db.finishRun(runId, { summary: findings.summary.trim(), sources: findings.sources, applied, suggestions });
  return db.getRun(runId)!;
}

// ---------------------------------------------------------------------------------------------------------------------
// Organizations

export const ORG_RESEARCHABLE = ["name", "type", "website", "description", "parent"] as const;
type OrgResearchField = (typeof ORG_RESEARCHABLE)[number];

const OrgFindingsSchema = z.object({
  fields: z.object(Object.fromEntries(ORG_RESEARCHABLE.map((f) => [f, z.string().nullable()])) as Record<OrgResearchField, z.ZodNullable<z.ZodString>>),
  summary: z.string(),
  sources: SourcesSchema,
});
type OrgFindings = z.infer<typeof OrgFindingsSchema>;

const ORG_GUIDE: Record<OrgResearchField, string> = {
  name: "The organization's full official name.",
  type: 'One or two words: "School", "Lab", "Institute", "Department", "Company", "Group", "Nonprofit", "Government"…',
  website: "Official homepage URL.",
  description: "One or two plain sentences on what the organization does or focuses on.",
  parent: 'The larger organization it is part of, if any (e.g. a lab\'s university, a campus\'s university). Use the full official name.',
};

const ORG_AGENT: Agent = {
  system: `You research organizations (schools, campuses, labs, institutes, companies, groups) for a personal contacts list kept by a student who networks with researchers and academics (mostly around the University of Toronto).

Search the web for accurate, current public information about the organization described. Use the known details (website, parent organization, members) to make sure every finding is about this same organization. Prefer the organization's own pages. If a known detail looks outdated or wrong, say what you found.

Write concise research notes with, for each detail below, the value and the page it came from, or "not found":
${describeFields(ORG_GUIDE)}
End with a 2-3 sentence overview of the organization, useful when deciding who to reach out to there.`,
  schema: findingsSchema(
    Object.fromEntries(ORG_RESEARCHABLE.map((f) => [f, textField(ORG_GUIDE[f])])),
    "2-3 sentence plain-text overview of the organization.",
  ),
};

/** Names imported from a bare website ("ethics.example.edu") are placeholders research may replace. */
const looksLikeDomain = (name: string) => /^[\w-]+(\.[\w-]+)+$/.test(name.trim());

function orgPrompt(db: DB, o: OrgWithMembers, instructions: string): string {
  const parent = o.parent_id ? db.getOrg(o.parent_id) : undefined;
  const lines = [`Name: ${o.name}${looksLikeDomain(o.name) ? " (placeholder taken from its website; find the real name)" : ""}`];
  if (o.type) lines.push(`Type: ${o.type}`);
  if (parent) lines.push(`Part of: ${parent.name}`);
  if (o.website) lines.push(`Website: ${o.website}`);
  if (o.description) lines.push(`Description: ${o.description}`);
  if (o.notes) lines.push(`Notes: ${o.notes}`);
  if (o.members.length) lines.push(`People known to be part of it: ${o.members.slice(0, 20).map((m) => m.name).join(", ")}`);
  const missing = ORG_RESEARCHABLE.filter((f) => (f === "parent" ? !parent : f === "name" ? looksLikeDomain(o.name) : !o[f]));
  return [
    "Research this organization:",
    lines.join("\n"),
    missing.length ? `\nMost wanted (currently missing): ${missing.join(", ")}.` : "",
    knownOrgNames(db),
    instructions ? `\nExtra instructions from the user: ${instructions}` : "",
  ].join("\n");
}

function applyOrgFindings(db: DB, runId: number, orgId: number, findings: OrgFindings): ResearchRun {
  const org = db.getOrg(orgId);
  if (!org) throw new Error("Organization was deleted during research");
  const applied: Record<string, string> = {};
  const suggestions: Record<string, string> = {};
  const patch: OrgInput = {};

  for (const f of ["name", "type", "website", "description"] as const) {
    const found = clean(findings.fields[f]);
    if (!found) continue;
    const current = clean(org[f]);
    const takenByOther = f === "name" && db.findOrg(found) && db.findOrg(found)!.id !== orgId;
    if (takenByOther) continue;
    if (!current || (f === "name" && looksLikeDomain(current))) applied[f] = patch[f] = found;
    else if (current.toLowerCase() !== found.toLowerCase()) suggestions[f] = found;
  }

  const parentName = clean(findings.fields.parent);
  const currentParent = org.parent_id ? db.getOrg(org.parent_id) : undefined;
  const nameNow = patch.name ?? org.name;
  if (parentName && parentName.toLowerCase() !== nameNow.toLowerCase()) {
    if (!currentParent) {
      patch.parent_id = db.ensureOrg(parentName);
      applied.parent = parentName;
    } else if (currentParent.name.toLowerCase() !== parentName.toLowerCase()) suggestions.parent = parentName;
  }

  try {
    db.updateOrg(orgId, patch);
  } catch {
    // A parent that would create a cycle: offer it as a suggestion instead.
    delete applied.parent;
    delete patch.parent_id;
    db.updateOrg(orgId, patch);
  }
  db.finishRun(runId, { summary: findings.summary.trim(), sources: findings.sources, applied, suggestions });
  return db.getRun(runId)!;
}

// ---------------------------------------------------------------------------------------------------------------------
// Suggestions

/** Applies chosen suggestions from a finished run. */
export function acceptSuggestions(db: DB, runId: number, fields: string[]): ResearchRun {
  const run = db.getRun(runId);
  if (!run) throw new Error("Run not found");
  const suggestions = { ...run.suggestions };
  const applied = { ...run.applied };
  const chosen = fields.filter((f) => suggestions[f] !== undefined);

  if (run.org_id != null) {
    const patch: OrgInput = {};
    for (const f of chosen) {
      if (f === "parent") patch.parent_id = db.ensureOrg(suggestions[f]);
      else if (f === "name" || f === "type" || f === "website" || f === "description") patch[f] = suggestions[f];
    }
    db.updateOrg(run.org_id, patch);
  } else if (run.contact_id != null) {
    const patch: Partial<Record<TextField, string>> = {};
    for (const f of chosen) {
      if (f === "organizations") db.addContactOrgs(run.contact_id, parseOrgs(suggestions[f]));
      else if ((TEXT_FIELDS as readonly string[]).includes(f)) patch[f as TextField] = suggestions[f];
    }
    db.updateContact(run.contact_id, patch);
  }
  for (const f of chosen) {
    applied[f] = suggestions[f];
    delete suggestions[f];
  }
  db.updateRunSuggestions(runId, applied, suggestions);
  return db.getRun(runId)!;
}

export function dismissSuggestions(db: DB, runId: number, fields: string[]): ResearchRun {
  const run = db.getRun(runId);
  if (!run) throw new Error("Run not found");
  const suggestions = { ...run.suggestions };
  for (const f of fields) delete suggestions[f];
  db.updateRunSuggestions(runId, run.applied, suggestions);
  return db.getRun(runId)!;
}

/** "University of Toronto (School, current), Vector Institute (Institute)": readable in the UI and parseable back. */
function formatOrgs(orgs: OrgRef[]): string {
  return orgs.map((o) => `${o.name.trim()}${o.type || o.current ? ` (${[o.type, o.current ? "current" : ""].filter(Boolean).join(", ")})` : ""}`).join(", ");
}

function parseOrgs(text: string): OrgRef[] {
  return text.split(/,\s*(?![^()]*\))/).flatMap((part) => {
    const m = part.trim().match(/^(.*?)\s*\(([^()]*)\)$/);
    if (!m) return part.trim() ? [{ name: part.trim() }] : [];
    const tags = splitList(m[2]);
    return [{ name: m[1], type: tags.find((t) => t !== "current") ?? "", current: tags.includes("current") }];
  });
}

function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 429) return "Gemini's rate limit was reached (the free tier allows a limited number of searches per minute and per day). Try again later.";
    if (err.status === 400 && /api key/i.test(err.message)) return "Gemini rejected the API key. Check GEMINI_API_KEY in .env.";
    if (err.status === 401 || err.status === 403) return "Gemini rejected the API key. Check GEMINI_API_KEY in .env.";
    return `Gemini API error ${err.status}: ${err.message}`;
  }
  return err instanceof Error ? err.message : String(err);
}
