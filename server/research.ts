import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { config, hasAnthropicCredentials } from "./config.ts";
import { RESEARCHABLE_FIELDS, splitSchools, type ContactWithRelations, type DB, type ResearchableField, type ResearchRun } from "./db.ts";

export type ResearchEvent =
  | { type: "status"; text: string }
  | { type: "search"; query: string }
  | { type: "fetch"; url: string }
  | { type: "progress"; text: string }
  | { type: "done"; run: ResearchRun }
  | { type: "error"; message: string };

type Job = { runId: number; contactId: number; events: ResearchEvent[]; listeners: Set<(e: ResearchEvent) => void>; finished: boolean };

/** One research job per contact at a time. Jobs outlive the HTTP request, so closing the pane doesn't stop them. */
const jobs = new Map<number, Job>();

export function getJob(contactId: number): Job | undefined {
  return jobs.get(contactId);
}

export function subscribe(job: Job, listener: (e: ResearchEvent) => void): () => void {
  for (const e of job.events) listener(e);
  if (job.finished) return () => {};
  job.listeners.add(listener);
  return () => job.listeners.delete(listener);
}

export function startResearch(db: DB, contactId: number, instructions = ""): Job {
  const running = jobs.get(contactId);
  if (running && !running.finished) return running;

  const contact = db.getContact(contactId);
  if (!contact) throw new Error("Contact not found");
  if (!hasAnthropicCredentials()) throw new Error("Set ANTHROPIC_API_KEY in .env to use the research agent.");

  const job: Job = { runId: db.startRun(contactId), contactId, events: [], listeners: new Set(), finished: false };
  jobs.set(contactId, job);
  const emit = (e: ResearchEvent) => {
    job.events.push(e);
    for (const l of job.listeners) l(e);
    if (e.type === "done" || e.type === "error") {
      job.finished = true;
      job.listeners.clear();
    }
  };

  runAgent(contact, instructions, emit)
    .then((findings) => {
      const run = applyFindings(db, job.runId, contactId, findings);
      emit({ type: "done", run });
    })
    .catch((err: unknown) => {
      const message = describeError(err);
      db.failRun(job.runId, message);
      emit({ type: "error", message });
    });
  return job;
}

const FieldsSchema = z.object(Object.fromEntries(RESEARCHABLE_FIELDS.map((f) => [f, z.string().nullable()])) as Record<ResearchableField, z.ZodNullable<z.ZodString>>);
const FindingsSchema = z.object({
  fields: FieldsSchema,
  summary: z.string(),
  sources: z.array(z.object({ url: z.string(), title: z.string() })),
});
type Findings = z.infer<typeof FindingsSchema>;

const FIELD_GUIDE: Record<ResearchableField, string> = {
  name: "Full name as the person writes it professionally.",
  role: 'Current position, e.g. "Professor", "Associate Professor", "3rd year PhD Candidate", "Masters Student".',
  department: 'Department or program, e.g. "Computer Science".',
  schools: "Institutions they are or were affiliated with (current first), comma-separated, short common names (e.g. \"U of T, UBC\").",
  research: "Short comma-separated list of research areas or interests (under ~20 words).",
  website: "Personal or official profile page URL (prefer a personal site, then a lab or faculty page, then Google Scholar).",
  email: "Public email address, only if explicitly published by the person or their institution. Never guess a pattern.",
};

const SAVE_TOOL: Anthropic.Beta.BetaTool = {
  name: "save_findings",
  description: "Record the verified details about this person. Call exactly once, when research is complete.",
  strict: true,
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["fields", "summary", "sources"],
    properties: {
      fields: {
        type: "object",
        additionalProperties: false,
        required: [...RESEARCHABLE_FIELDS],
        properties: Object.fromEntries(
          RESEARCHABLE_FIELDS.map((f) => [f, { type: ["string", "null"], description: `${FIELD_GUIDE[f]} null if not found with confidence.` }]),
        ),
      },
      summary: { type: "string", description: "2-4 sentence plain-text background on the person, useful before reaching out." },
      sources: {
        type: "array",
        description: "Pages that support the findings.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["url", "title"],
          properties: { url: { type: "string" }, title: { type: "string" } },
        },
      },
    },
  },
};

const SYSTEM = `You research people for a personal contacts list kept by a student who networks with researchers and academics (mostly around the University of Toronto).

Use web search and web fetch to find accurate, current public information about the person described. Disambiguate carefully: use the known details (school, department, related people, website) to make sure every finding is about this same person. Prefer official sources (personal sites, university and lab pages, Google Scholar). If a known detail looks outdated or wrong, report what you found.

When finished, call save_findings exactly once. Set a field to null when you could not find it with confidence. Do not invent or infer email addresses.`;

function describeContact(c: ContactWithRelations): string {
  const lines = [`Name: ${c.name}`];
  for (const f of ["role", "department", "schools", "current_school", "research", "website", "email", "notes"] as const) {
    if (c[f]) lines.push(`${f[0].toUpperCase()}${f.slice(1).replace("_", " ")}: ${c[f]}`);
  }
  if (c.related.length) lines.push(`Related to: ${c.related.map((r) => r.name + (r.note ? ` (${r.note})` : "")).join(", ")}`);
  return lines.join("\n");
}

async function runAgent(contact: ContactWithRelations, instructions: string, emit: (e: ResearchEvent) => void): Promise<Findings> {
  const client = new Anthropic();
  const missing = RESEARCHABLE_FIELDS.filter((f) => !contact[f] || /^Unknown \(/.test(contact[f]));
  const prompt = [
    "Research this person:",
    describeContact(contact),
    missing.length ? `\nMost wanted (currently missing): ${missing.join(", ")}.` : "",
    instructions ? `\nExtra instructions from the user: ${instructions}` : "",
  ].join("\n");

  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: prompt }];
  emit({ type: "status", text: "Starting research…" });

  for (let turn = 0; turn < 12; turn++) {
    const stream = client.beta.messages.stream({
      model: config.anthropicModel,
      max_tokens: 64000,
      betas: ["server-side-fallback-2026-07-01", "thinking-display-updates-2026-08-18"],
      // On a safety-classifier refusal, the API retries on a fallback model instead of failing the run.
      fallbacks: "default",
      thinking: { type: "adaptive", display: "updates" },
      output_config: { effort: "medium" },
      system: SYSTEM,
      tools: [
        { type: "web_search_20260209", name: "web_search", max_uses: 8 },
        { type: "web_fetch_20260209", name: "web_fetch", max_uses: 8 },
        SAVE_TOOL,
      ],
      messages,
    });

    let progress = "";
    stream.on("thinking", (delta) => {
      progress += delta;
    });
    stream.on("contentBlock", (block) => {
      if (block.type === "thinking" && progress.trim()) {
        emit({ type: "progress", text: progress.trim() });
      }
      progress = "";
      if (block.type === "server_tool_use") {
        const input = block.input as { query?: string; url?: string };
        if (block.name === "web_search" && input.query) emit({ type: "search", query: input.query });
        if (block.name === "web_fetch" && input.url) emit({ type: "fetch", url: input.url });
      }
      if (block.type === "text" && block.text.trim()) emit({ type: "progress", text: block.text.trim() });
    });

    const message = await stream.finalMessage();

    if (message.stop_reason === "refusal") throw new Error("The model declined to research this request.");
    if (message.stop_reason === "pause_turn") {
      messages.push({ role: "assistant", content: message.content });
      continue;
    }

    const call = message.content.find((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use" && b.name === "save_findings");
    if (call) {
      const parsed = FindingsSchema.safeParse(call.input);
      if (parsed.success) return parsed.data;
      if (message.stop_reason === "max_tokens") throw new Error("The research response was cut off.");
      messages.push({ role: "assistant", content: message.content });
      messages.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: call.id, is_error: true, content: `Invalid input: ${parsed.error.message}. Call save_findings again.` }],
      });
      continue;
    }

    // Ended without saving: nudge once more.
    messages.push({ role: "assistant", content: message.content });
    messages.push({ role: "user", content: "Please call save_findings now with what you found (use null for anything not found)." });
  }
  throw new Error("Research did not finish within the turn limit.");
}

const clean = (v: string | null | undefined) => (v ?? "").trim();

/** Fills empty fields automatically; differing values for fields you already have become suggestions. */
function applyFindings(db: DB, runId: number, contactId: number, findings: Findings): ResearchRun {
  const contact = db.getContact(contactId);
  if (!contact) throw new Error("Contact was deleted during research");

  const applied: ResearchRun["applied"] = {};
  const suggestions: ResearchRun["suggestions"] = {};
  for (const f of RESEARCHABLE_FIELDS) {
    const found = clean(findings.fields[f]);
    if (!found) continue;
    const current = clean(contact[f]);
    const placeholder = f === "name" && /^Unknown \(/.test(current);
    if (!current || placeholder) applied[f] = found;
    else if (current.toLowerCase() !== found.toLowerCase()) suggestions[f] = found;
  }
  // The agent lists schools current-first, so a freshly filled list also gets its current school.
  const schools = applied.schools ? splitSchools(applied.schools) : [];
  db.updateContact(contactId, schools.length > 1 && !contact.current_school ? { ...applied, current_school: schools[0] } : applied);
  db.finishRun(runId, { summary: findings.summary.trim(), sources: findings.sources, applied, suggestions });
  return db.getRun(runId)!;
}

/** Applies chosen suggestions from a finished run. */
export function acceptSuggestions(db: DB, runId: number, fields: ResearchableField[]): ResearchRun {
  const run = db.getRun(runId);
  if (!run) throw new Error("Run not found");
  const patch: Partial<Record<ResearchableField, string>> = {};
  const suggestions = { ...run.suggestions };
  const applied = { ...run.applied };
  for (const f of fields) {
    const value = suggestions[f];
    if (value === undefined) continue;
    patch[f] = value;
    applied[f] = value;
    delete suggestions[f];
  }
  db.updateContact(run.contact_id, patch);
  db.updateRunSuggestions(runId, applied, suggestions);
  return db.getRun(runId)!;
}

export function dismissSuggestions(db: DB, runId: number, fields: ResearchableField[]): ResearchRun {
  const run = db.getRun(runId);
  if (!run) throw new Error("Run not found");
  const suggestions = { ...run.suggestions };
  for (const f of fields) delete suggestions[f];
  db.updateRunSuggestions(runId, run.applied, suggestions);
  return db.getRun(runId)!;
}

function describeError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) return "Anthropic API key was rejected. Check ANTHROPIC_API_KEY in .env.";
  if (err instanceof Anthropic.RateLimitError) return "Rate limited by the Anthropic API. Try again in a minute.";
  if (err instanceof Anthropic.APIError) return `Anthropic API error ${err.status ?? ""}: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}
