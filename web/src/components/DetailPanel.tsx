import { useEffect } from "react";
import { addDays, api, dueState, formatDate, LABELS, localToday, type Contact, type Field } from "../api";
import { Chips, DueBadge, websiteLabel } from "./ContactTable";
import { EditableCell } from "./EditableCell";
import { RelatedEditor } from "./RelatedEditor";
import { ResearchPanel } from "./ResearchPanel";

export type PanelTab = "details" | "research";

type Props = {
  contact: Contact;
  contacts: Contact[];
  categories: string[];
  tab: PanelTab;
  onTab: (tab: PanelTab) => void;
  onClose: () => void;
  onOpen: (id: number) => void;
  onUpdate: (id: number, fields: Partial<Record<Field, string>>) => Promise<void>;
  onChanged: () => void;
  notify: (msg: string) => void;
  researchEnabled: boolean;
};

export function DetailPanel({ contact: c, contacts, tab, onTab, onClose, onOpen, onUpdate, onChanged, notify, researchEnabled }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !(e.target as HTMLElement).closest("input, textarea")) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const save = (f: Field) => (value: string) => {
    if (f === "name" && !value.trim()) return notify("Name can't be empty");
    onUpdate(c.id, { [f]: value });
  };
  const today = localToday();

  const contactedToday = async () => {
    const due = ["overdue", "today"].includes(dueState(c.follow_up_date, today));
    await onUpdate(c.id, due ? { last_contacted: today, follow_up_date: "" } : { last_contacted: today });
    notify(due ? "Marked contacted today and cleared the follow-up" : "Marked contacted today");
  };

  const field = (f: Field, opts: { type?: "text" | "date" | "textarea"; display?: React.ReactNode; list?: string; placeholder?: string } = {}) => (
    <div className="field" key={f}>
      <label>{LABELS[f]}</label>
      <EditableCell value={c[f]} onSave={save(f)} placeholder={opts.placeholder ?? "Add…"} type={opts.type} display={opts.display} list={opts.list} />
    </div>
  );

  return (
    <aside className="panel" aria-label={`Details for ${c.name}`}>
      <div className="panel-head">
        <div className="panel-title">
          <EditableCell value={c.name} onSave={save("name")} className="title-cell" />
          <div className="muted small">{[c.role, c.department].filter(Boolean).join(" · ")}</div>
        </div>
        <button className="icon-btn" onClick={onClose} aria-label="Close" title="Close (Esc)">
          ✕
        </button>
      </div>

      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === "details"} className={tab === "details" ? "active" : ""} onClick={() => onTab("details")}>
          Details
        </button>
        <button role="tab" aria-selected={tab === "research"} className={tab === "research" ? "active" : ""} onClick={() => onTab("research")}>
          ✦ Research
        </button>
      </div>

      <div className="panel-body">
        {tab === "details" ? (
          <>
            <section className="actions">
              <button onClick={contactedToday}>✓ Contacted today</button>
              <span className="muted small">Follow up in</span>
              {[
                ["1w", 7],
                ["2w", 14],
                ["1m", 30],
                ["3m", 90],
              ].map(([label, days]) => (
                <button key={label} className="small-btn" onClick={() => onUpdate(c.id, { follow_up_date: addDays(today, days as number) })}>
                  {label}
                </button>
              ))}
            </section>

            {field("category", { list: "category-options" })}
            {field("role")}
            {field("department")}
            {field("schools", { display: <Chips value={c.schools} /> })}
            {field("research", { type: "textarea" })}
            {field("website", {
              display: (
                <a href={c.website} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
                  {websiteLabel(c.website)}
                </a>
              ),
            })}
            {field("email", {
              display: (
                <a href={`mailto:${c.email}`} onClick={(e) => e.stopPropagation()}>
                  {c.email}
                </a>
              ),
            })}
            {field("last_contacted", { type: "date", display: formatDate(c.last_contacted) })}
            <div className="field">
              <label>{LABELS.follow_up_date}</label>
              <div className="follow-up">
                <EditableCell type="date" value={c.follow_up_date} onSave={save("follow_up_date")} placeholder="None" display={<DueBadge date={c.follow_up_date} />} />
                {c.follow_up_date && (
                  <button className="link small" onClick={() => onUpdate(c.id, { follow_up_date: "" })}>
                    clear
                  </button>
                )}
              </div>
            </div>
            {field("notes", { type: "textarea" })}

            <div className="field">
              <label>{LABELS.related}</label>
              <RelatedEditor contact={c} contacts={contacts} onOpen={onOpen} onChanged={onChanged} notify={notify} />
            </div>

            <footer className="panel-foot">
              <span className="muted small">
                Added {formatDate(c.created_at)} · Updated {formatDate(c.updated_at)}
              </span>
              <button
                className="danger"
                onClick={async () => {
                  if (!confirm(`Delete ${c.name}? This also removes their relationships.`)) return;
                  await api.remove(c.id);
                  onClose();
                  onChanged();
                  notify(`Deleted ${c.name}`);
                }}
              >
                Delete
              </button>
            </footer>
          </>
        ) : (
          <ResearchPanel contact={c} enabled={researchEnabled} onChanged={onChanged} onUpdate={onUpdate} notify={notify} />
        )}
      </div>
    </aside>
  );
}
