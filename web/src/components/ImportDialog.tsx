import { useEffect, useRef, useState } from "react";
import { api, FIELDS, LABELS, type ImportKind, type ImportPreview, type ImportSummary } from "../api";

/** Where each column can go, per kind of sheet. */
const TARGETS: Record<ImportKind, [string, string][]> = {
  people: [
    ...FIELDS.map((f) => [f, LABELS[f]] as [string, string]),
    ["organizations", "Organizations (schools, labs…)"],
    ["related", LABELS.related],
    ["updated", "Updated (date)"],
    ["ignore", "— ignore —"],
  ],
  orgs: [
    ["name", "Name"],
    ["type", "Type"],
    ["parent", "Part of (parent organization)"],
    ["website", "Website"],
    ["description", "Description"],
    ["notes", "Notes"],
    ["ignore", "— ignore —"],
  ],
};

export function ImportDialog({ onClose, onImported }: { onClose: () => void; onImported: (msg: string) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [csv, setCsv] = useState("");
  const [fileName, setFileName] = useState("");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [kind, setKind] = useState<ImportKind>("people");
  const [role, setRole] = useState("");
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => dialog.current?.showModal(), []);

  const pick = async (file: File) => {
    const text = await file.text();
    setCsv(text);
    setFileName(file.name);
    await loadPreview(text);
  };

  const loadPreview = async (text: string, forceKind?: ImportKind) => {
    setError("");
    setSummary(null);
    try {
      const p = await api.importPreview(text, forceKind);
      setPreview(p);
      setKind(p.kind);
      setMapping(p.mapping);
      setRole(p.suggestedRole);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const run = async () => {
    setBusy(true);
    try {
      const s = await api.importCsv(csv, kind, role, mapping);
      setSummary(s);
      onImported(`Imported ${fileName}: ${s.created} new, ${s.merged} merged`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const hasName = Object.values(mapping).includes("name") || Object.values(mapping).includes("website");

  return (
    <dialog ref={dialog} className="dialog" onClose={onClose}>
      <header>
        <h2>Import CSV</h2>
        <button className="icon-btn" onClick={() => dialog.current?.close()} aria-label="Close">
          ✕
        </button>
      </header>
      <p className="muted small">
        In Google Sheets: File → Download → Comma-separated values (one tab at a time). Sheets of people and sheets of organizations both work.
        Rows matching an existing name are merged: empty fields get filled, nothing is overwritten.
      </p>
      <input type="file" accept=".csv,text/csv" onChange={(e) => e.target.files?.[0] && pick(e.target.files[0])} />

      {preview && !summary && (
        <>
          <div className="kind-switch small">
            <span>
              {preview.rowCount} rows of
            </span>
            <div className="segmented">
              {(["people", "orgs"] as const).map((k) => (
                <button key={k} className={kind === k ? "active" : ""} onClick={() => loadPreview(csv, k)}>
                  {k === "people" ? "people" : "organizations"}
                </button>
              ))}
            </div>
            <span>Check how each column is used:</span>
          </div>
          <table className="mapping">
            <thead>
              <tr>
                <th>Column in file</th>
                <th>Example</th>
                <th>Save as</th>
              </tr>
            </thead>
            <tbody>
              {preview.headers.map((h, i) => (
                <tr key={h + i}>
                  <td>{h}</td>
                  <td className="muted small example">{preview.sample.map((r) => r[i]).find((v) => v?.trim()) ?? ""}</td>
                  <td>
                    <select value={mapping[h]} onChange={(e) => setMapping({ ...mapping, [h]: e.target.value })}>
                      {TARGETS[kind].map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {kind === "people" && (
            <label className="inline-field">
              Role for rows that don't have one (optional, e.g. Professor)
              <input value={role} onChange={(e) => setRole(e.target.value)} list="role-options" />
            </label>
          )}
          <div className="dialog-actions">
            <button onClick={() => dialog.current?.close()}>Cancel</button>
            <button className="primary" disabled={busy || !hasName} onClick={run}>
              {busy ? "Importing…" : `Import ${preview.rowCount} rows`}
            </button>
          </div>
          {!hasName && <p className="error small">Map a column to Name (or Website).</p>}
        </>
      )}

      {summary && (
        <div className="import-summary">
          <p>
            <strong>{summary.created}</strong> created · <strong>{summary.merged}</strong> merged
            {kind === "people" && (
              <>
                {" "}
                · <strong>{summary.stubs}</strong> people outside your network from “Related to” · <strong>{summary.relations}</strong> relationships
              </>
            )}{" "}
            · {summary.skipped} skipped
          </p>
          {summary.notes.length > 0 && (
            <ul className="small">
              {summary.notes.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          )}
          <div className="dialog-actions">
            <button
              onClick={() => {
                setPreview(null);
                setSummary(null);
                setCsv("");
              }}
            >
              Import another file
            </button>
            <button className="primary" onClick={() => dialog.current?.close()}>
              Done
            </button>
          </div>
        </div>
      )}
      {error && <p className="error">{error}</p>}
    </dialog>
  );
}
