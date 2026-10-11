import { useEffect, useRef, useState } from "react";
import { api, FIELDS, LABELS, type ImportPreview, type ImportSummary, type ImportTarget } from "../api";

const TARGETS: ImportTarget[] = [...FIELDS, "related", "updated", "ignore"];
const targetLabel = (t: ImportTarget) => (t === "ignore" ? "— ignore —" : t === "updated" ? "Updated (date)" : LABELS[t]);

export function ImportDialog({ onClose, onImported }: { onClose: () => void; onImported: (msg: string) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [csv, setCsv] = useState("");
  const [fileName, setFileName] = useState("");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [mapping, setMapping] = useState<Record<string, ImportTarget>>({});
  const [role, setRole] = useState("");
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => dialog.current?.showModal(), []);

  const pick = async (file: File) => {
    setError("");
    setSummary(null);
    const text = await file.text();
    setCsv(text);
    setFileName(file.name);
    try {
      const p = await api.importPreview(text);
      setPreview(p);
      setMapping(p.mapping);
      setRole(p.suggestedRole);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const run = async () => {
    setBusy(true);
    try {
      const s = await api.importCsv(csv, role, mapping);
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
        In Google Sheets: File → Download → Comma-separated values (one tab at a time). Rows matching an existing name are merged: empty fields get
        filled, nothing is overwritten. Names in “Related to” become links, creating placeholder contacts when needed.
      </p>
      <input type="file" accept=".csv,text/csv" onChange={(e) => e.target.files?.[0] && pick(e.target.files[0])} />

      {preview && !summary && (
        <>
          <p className="small">
            {preview.rowCount} rows. Check how each column is used:
          </p>
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
                    <select value={mapping[h]} onChange={(e) => setMapping({ ...mapping, [h]: e.target.value as ImportTarget })}>
                      {TARGETS.map((t) => (
                        <option key={t} value={t}>
                          {targetLabel(t)}
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {(
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
            <strong>{summary.created}</strong> created · <strong>{summary.merged}</strong> merged · <strong>{summary.stubs}</strong> people outside
            your network from “Related to” · <strong>{summary.relations}</strong> relationships · {summary.skipped} skipped
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
