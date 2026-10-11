import { currentSchool, dueState, formatDate, LABELS, splitSchools, type Contact, type ContactInput, type Field } from "../api";
import { EditableCell } from "./EditableCell";
import type { PanelTab } from "./DetailPanel";

export type Column = Exclude<Field, "current_school"> | "related" | "updated_at";
export type SortKey = Column;

export const ALL_COLUMNS: Column[] = [
  "name",
  "role",
  "department",
  "schools",
  "research",
  "related",
  "email",
  "website",
  "last_contacted",
  "follow_up_date",
  "notes",
  "updated_at",
];
export const DEFAULT_COLUMNS: Column[] = [
  "name",
  "role",
  "department",
  "schools",
  "research",
  "related",
  "last_contacted",
  "follow_up_date",
  "updated_at",
];

type Props = {
  contacts: Contact[];
  columns: Column[];
  sort: { key: SortKey; dir: 1 | -1 };
  onSort: (key: SortKey) => void;
  selectedId?: number;
  onOpen: (id: number, tab?: PanelTab) => void;
  onUpdate: (id: number, fields: ContactInput) => void;
  researchEnabled: boolean;
};

/**
 * School chips. With several schools the current one is highlighted and clicking another makes it current
 * (clicking the current one again clears it). Clicks don't reach the surrounding editable cell.
 */
export function SchoolChips({ contact, onSetCurrent }: { contact: Contact; onSetCurrent?: (school: string) => void }) {
  const schools = splitSchools(contact.schools);
  const current = currentSchool(contact);
  const pickable = schools.length > 1 && onSetCurrent;
  return (
    <span className="chips">
      {schools.map((s) =>
        pickable ? (
          <button
            key={s}
            className={`tag school ${s === current ? "current" : ""}`}
            title={s === current ? "Current school (click to unmark)" : "Mark as current school"}
            onClick={(e) => {
              e.stopPropagation();
              onSetCurrent(s === current ? "" : s);
            }}
            onKeyDown={(e) => e.stopPropagation()}
          >
            {s}
          </button>
        ) : (
          <span key={s} className={`tag ${s === current && schools.length > 1 ? "current" : ""}`}>
            {s}
          </span>
        ),
      )}
    </span>
  );
}

export function DueBadge({ date }: { date: string }) {
  const state = dueState(date);
  return <span className={`due-badge ${state}`}>{formatDate(date)}</span>;
}

export function websiteLabel(url: string) {
  return url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "");
}

export function ContactTable({ contacts, columns, sort, onSort, selectedId, onOpen, onUpdate, researchEnabled }: Props) {
  const cell = (c: Contact, col: Column) => {
    const save = (value: string) => onUpdate(c.id, { [col]: value });
    switch (col) {
      case "name":
        return (
          <div className="name-cell">
            <button className="name-link" onClick={() => onOpen(c.id)}>
              {c.name}
            </button>
            <button
              className="icon-btn research-btn"
              title={researchEnabled ? "Research this person" : "Research agent (needs ANTHROPIC_API_KEY)"}
              aria-label={`Research ${c.name}`}
              onClick={() => onOpen(c.id, "research")}
            >
              ✦
            </button>
          </div>
        );
      case "related":
        return (
          <div className="chips">
            {c.related.map((r) => (
              <button
                key={r.id}
                className={`tag person ${r.in_network ? "" : "outside"}`}
                title={[r.note, r.in_network ? "" : "outside your network"].filter(Boolean).join(" · ") || undefined}
                onClick={() => onOpen(r.id)}
              >
                {r.name}
              </button>
            ))}
            <button className="tag add" title="Edit relationships" onClick={() => onOpen(c.id)}>
              +
            </button>
          </div>
        );
      case "updated_at":
        return <span className="muted">{formatDate(c.updated_at)}</span>;
      case "role":
        return <EditableCell value={c.role} onSave={save} list="role-options" />;
      case "schools":
        return (
          <EditableCell
            value={c.schools}
            onSave={save}
            display={<SchoolChips contact={c} onSetCurrent={(school) => onUpdate(c.id, { current_school: school })} />}
          />
        );
      case "website":
        return (
          <EditableCell
            value={c.website}
            onSave={save}
            display={
              <a href={c.website} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
                {websiteLabel(c.website)}
              </a>
            }
          />
        );
      case "email":
        return (
          <EditableCell
            value={c.email}
            onSave={save}
            display={
              <a href={`mailto:${c.email}`} onClick={(e) => e.stopPropagation()}>
                {c.email}
              </a>
            }
          />
        );
      case "last_contacted":
        return <EditableCell type="date" value={c.last_contacted} onSave={save} display={formatDate(c.last_contacted)} />;
      case "follow_up_date":
        return <EditableCell type="date" value={c.follow_up_date} onSave={save} display={<DueBadge date={c.follow_up_date} />} />;
      case "notes":
      case "research":
        return <EditableCell type="textarea" value={c[col]} onSave={save} className="clamp" />;
      default:
        return <EditableCell value={c[col]} onSave={save} />;
    }
  };

  return (
    <>

      <div className="table-wrap">
        <table className="contacts">
          <thead>
            <tr>
              {columns.map((col) => (
                <th key={col} className={`col-${col}`} aria-sort={sort.key === col ? (sort.dir === 1 ? "ascending" : "descending") : undefined}>
                  <button onClick={() => onSort(col)}>
                    {LABELS[col]}
                    <span className="sort-arrow">{sort.key === col ? (sort.dir === 1 ? "▲" : "▼") : ""}</span>
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {contacts.map((c) => (
              <tr key={c.id} className={c.id === selectedId ? "selected" : ""}>
                {columns.map((col) => (
                  <td key={col} className={`col-${col}`}>
                    {cell(c, col)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {contacts.length === 0 && <p className="empty">No matches.</p>}
      </div>

      {/* Phone layout: cards instead of a wide table. */}
      <ul className="cards">
        {contacts.map((c) => (
          <li key={c.id} className={c.id === selectedId ? "selected" : ""}>
            <button className="card" onClick={() => onOpen(c.id)}>
              <div className="card-top">
                <strong>{c.name}</strong>
                {c.follow_up_date && <DueBadge date={c.follow_up_date} />}
              </div>
              <div className="muted">{[c.role, c.department, currentSchool(c) || c.schools].filter(Boolean).join(" · ") || "No details yet"}</div>
              {c.research && <div className="card-research">{c.research}</div>}
              {c.related.length > 0 && <div className="muted small">↔ {c.related.map((r) => r.name).join(", ")}</div>}
            </button>
          </li>
        ))}
        {contacts.length === 0 && <p className="empty">No matches.</p>}
      </ul>
    </>
  );
}
