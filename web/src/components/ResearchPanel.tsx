import { useCallback, useEffect, useRef, useState } from "react";
import { api, formatDate, LABELS, type Contact, type Field, type ResearchableField, type ResearchEvent, type ResearchRun } from "../api";

type Props = {
  contact: Contact;
  enabled: boolean;
  onChanged: () => void;
  onUpdate: (id: number, fields: Partial<Record<Field, string>>) => Promise<void>;
  notify: (msg: string) => void;
};

export function ResearchPanel({ contact, enabled, onChanged, onUpdate, notify }: Props) {
  const [runs, setRuns] = useState<ResearchRun[] | null>(null);
  const [log, setLog] = useState<ResearchEvent[]>([]);
  const [running, setRunning] = useState(false);
  const [instructions, setInstructions] = useState("");
  const source = useRef<EventSource | null>(null);
  const logEnd = useRef<HTMLDivElement>(null);

  const listen = useCallback(() => {
    source.current?.close();
    setRunning(true);
    setLog([]);
    const es = new EventSource(`/api/contacts/${contact.id}/research/events`);
    source.current = es;
    es.onmessage = (msg) => {
      const e = JSON.parse(msg.data) as ResearchEvent;
      setLog((l) => [...l, e]);
      if (e.type === "done" || e.type === "error") {
        es.close();
        setRunning(false);
        api.researchRuns(contact.id).then((r) => setRuns(r.runs));
        if (e.type === "done") {
          onChanged();
          const filled = Object.keys(e.run.applied).length;
          notify(filled ? `Research filled in ${filled} field${filled === 1 ? "" : "s"}` : "Research finished");
        }
      }
    };
    es.onerror = () => {
      // The stream closes after the final event; anything else means the server went away.
      if (es.readyState === EventSource.CLOSED) setRunning(false);
    };
  }, [contact.id, onChanged, notify]);

  useEffect(() => {
    api.researchRuns(contact.id).then((r) => {
      setRuns(r.runs);
      if (r.running) listen();
    });
    return () => source.current?.close();
  }, [contact.id, listen]);

  useEffect(() => logEnd.current?.scrollIntoView({ block: "nearest" }), [log]);

  const start = async () => {
    try {
      await api.startResearch(contact.id, instructions.trim());
      listen();
    } catch (err) {
      notify((err as Error).message);
    }
  };

  const updateRun = (run: ResearchRun) => setRuns((rs) => rs?.map((r) => (r.id === run.id ? run : r)) ?? null);
  const accept = async (run: ResearchRun, fields: ResearchableField[]) => {
    const res = await api.acceptSuggestions(run.id, fields);
    updateRun(res.run);
    onChanged();
  };
  const dismiss = async (run: ResearchRun, fields: ResearchableField[]) => updateRun((await api.dismissSuggestions(run.id, fields)).run);

  const latest = runs?.[0];
  const older = runs?.slice(1) ?? [];

  if (!enabled) {
    return (
      <div className="research">
        <p>
          The research agent searches the web for this person and fills in details you don't have yet (role, department, schools, research,
          website, email).
        </p>
        <p className="callout">
          To turn it on, add <code>ANTHROPIC_API_KEY=…</code> to the <code>.env</code> file next to <code>package.json</code> and restart the
          server.
        </p>
      </div>
    );
  }

  return (
    <div className="research">
      <p className="muted small">
        Searches the web for {contact.name}, fills in empty fields automatically, and suggests changes to fields you've already filled.
      </p>
      <textarea
        rows={2}
        placeholder="Optional hints (e.g. “the one at the business school”, “find their lab page”)"
        value={instructions}
        onChange={(e) => setInstructions(e.target.value)}
        disabled={running}
      />
      <button className="primary" onClick={start} disabled={running}>
        {running ? "Researching…" : latest ? "✦ Research again" : "✦ Research this person"}
      </button>

      {(running || log.length > 0) && (
        <ol className="research-log" aria-live="polite">
          {log.map((e, i) => (
            <li key={i} className={`ev ev-${e.type}`}>
              {e.type === "status" && e.text}
              {e.type === "search" && (
                <>
                  <span className="ev-icon">🔍</span> {e.query}
                </>
              )}
              {e.type === "fetch" && (
                <>
                  <span className="ev-icon">📄</span> {e.url.replace(/^https?:\/\//, "")}
                </>
              )}
              {e.type === "progress" && e.text}
              {e.type === "done" && "Done."}
              {e.type === "error" && `Error: ${e.message}`}
            </li>
          ))}
          {running && <li className="ev spinner">Working…</li>}
          <div ref={logEnd} />
        </ol>
      )}

      {latest && latest.status !== "running" && (
        <RunCard run={latest} contact={contact} onAccept={accept} onDismiss={dismiss} onUpdate={onUpdate} notify={notify} />
      )}

      {older.length > 0 && (
        <details className="history">
          <summary>Earlier research ({older.length})</summary>
          {older.map((run) => (
            <RunCard key={run.id} run={run} contact={contact} onAccept={accept} onDismiss={dismiss} onUpdate={onUpdate} notify={notify} />
          ))}
        </details>
      )}
    </div>
  );
}

function RunCard({
  run,
  contact,
  onAccept,
  onDismiss,
  onUpdate,
  notify,
}: {
  run: ResearchRun;
  contact: Contact;
  onAccept: (run: ResearchRun, fields: ResearchableField[]) => void;
  onDismiss: (run: ResearchRun, fields: ResearchableField[]) => void;
  onUpdate: Props["onUpdate"];
  notify: Props["notify"];
}) {
  const applied = Object.entries(run.applied) as [ResearchableField, string][];
  const suggestions = Object.entries(run.suggestions) as [ResearchableField, string][];

  return (
    <section className="run">
      <header className="muted small">
        {formatDate(run.started_at)} · {run.status === "error" ? "failed" : "finished"}
      </header>
      {run.status === "error" && <p className="error">{run.error}</p>}

      {applied.length > 0 && (
        <div className="run-block">
          <h4>Filled in</h4>
          <dl>
            {applied.map(([f, v]) => (
              <div key={f} className="kv applied">
                <dt>{LABELS[f]}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}

      {suggestions.length > 0 && (
        <div className="run-block">
          <h4>
            Different from what you have
            {suggestions.length > 1 && (
              <button className="link small" onClick={() => onAccept(run, suggestions.map(([f]) => f))}>
                accept all
              </button>
            )}
          </h4>
          <dl>
            {suggestions.map(([f, v]) => (
              <div key={f} className="kv suggestion">
                <dt>{LABELS[f]}</dt>
                <dd>
                  <div className="was">{contact[f] || "—"}</div>
                  <div className="now">{v}</div>
                  <div className="kv-actions">
                    <button className="small-btn" onClick={() => onAccept(run, [f])}>
                      Use this
                    </button>
                    <button className="small-btn ghost" onClick={() => onDismiss(run, [f])}>
                      Keep mine
                    </button>
                  </div>
                </dd>
              </div>
            ))}
          </dl>
        </div>
      )}

      {run.status === "done" && applied.length === 0 && suggestions.length === 0 && <p className="muted small">No new details found.</p>}

      {run.summary && (
        <div className="run-block">
          <h4>
            Summary
            <button
              className="link small"
              onClick={async () => {
                await onUpdate(contact.id, { notes: [contact.notes, run.summary].filter(Boolean).join("\n\n") });
                notify("Summary added to notes");
              }}
            >
              add to notes
            </button>
          </h4>
          <p>{run.summary}</p>
        </div>
      )}

      {run.sources.length > 0 && (
        <div className="run-block">
          <h4>Sources</h4>
          <ul className="sources">
            {run.sources.map((s) => (
              <li key={s.url}>
                <a href={s.url} target="_blank" rel="noreferrer">
                  {s.title || s.url}
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
