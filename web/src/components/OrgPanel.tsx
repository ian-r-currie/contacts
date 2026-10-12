import { useEffect, useMemo, useState } from "react";
import { api, formatDate, type Contact, type Org, type OrgField, type OrgInput } from "../api";
import { websiteLabel } from "./ContactTable";
import { EditableCell } from "./EditableCell";
import { resolveParent } from "./OrgTable";
import type { PanelTab } from "./DetailPanel";
import { ResearchPanel } from "./ResearchPanel";

type Props = {
  org: Org;
  tab: PanelTab;
  onTab: (tab: PanelTab) => void;
  researchEnabled: boolean;
  orgs: Org[];
  contacts: Contact[];
  onClose: () => void;
  onOpenOrg: (id: number) => void;
  onOpenContact: (id: number) => void;
  onChanged: () => void;
  notify: (msg: string) => void;
};

const LABELS: Record<OrgField | "parent", string> = {
  name: "Name",
  type: "Type",
  parent: "Part of",
  website: "Website",
  description: "Description",
  notes: "Notes",
};

export function OrgPanel({ org: o, tab, onTab, researchEnabled, orgs, contacts, onClose, onOpenOrg, onOpenContact, onChanged, notify }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !(e.target as HTMLElement).closest("input, textarea")) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const parent = orgs.find((x) => x.id === o.parent_id);
  const children = orgs.filter((x) => x.parent_id === o.id);

  const update = async (fields: OrgInput) => {
    try {
      await api.updateOrg(o.id, fields);
    } catch (err) {
      notify(`Couldn't save: ${(err as Error).message}`);
    }
    onChanged();
  };

  const field = (f: OrgField, opts: { type?: "text" | "textarea"; display?: React.ReactNode; list?: string } = {}) => (
    <div className="field" key={f}>
      <label>{LABELS[f]}</label>
      <EditableCell value={o[f]} onSave={(v) => update({ [f]: v })} placeholder="Add…" type={opts.type} display={opts.display} list={opts.list} />
    </div>
  );

  return (
    <aside className="panel" aria-label={`Details for ${o.name}`}>
      <div className="panel-head">
        <div className="panel-title">
          <EditableCell value={o.name} onSave={(v) => (v.trim() ? update({ name: v }) : notify("Name can't be empty"))} className="title-cell" />
          <div className="muted small">{[o.type, parent ? `part of ${parent.name}` : ""].filter(Boolean).join(" · ") || "Organization"}</div>
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
        {tab === "research" ? (
          <ResearchPanel
            target={{
              kind: "org",
              id: o.id,
              name: o.name,
              values: { ...o, parent: parent?.name ?? "" } as unknown as Record<string, string>,
              labels: LABELS,
              fieldsBlurb: "name, type, website, description, and the organization it's part of",
            }}
            enabled={researchEnabled}
            onChanged={onChanged}
            onAddToNotes={(summary) => update({ notes: [o.notes, summary].filter(Boolean).join("\n\n") })}
            notify={notify}
          />
        ) : (
          <>
        {field("type", { list: "org-type-options" })}
        <div className="field">
          <label>{LABELS.parent}</label>
          <EditableCell
            value={parent?.name ?? ""}
            placeholder="Add… (e.g. the university)"
            list="org-panel-names"
            display={
              parent && (
                <button
                  className="link"
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenOrg(parent.id);
                  }}
                >
                  {parent.name}
                </button>
              )
            }
            onSave={async (v) => {
              try {
                await update({ parent_id: await resolveParent(orgs, v) });
              } catch (err) {
                notify((err as Error).message);
              }
            }}
          />
          <datalist id="org-panel-names">
            {orgs
              .filter((x) => x.id !== o.id)
              .map((x) => (
                <option key={x.id} value={x.name} />
              ))}
          </datalist>
        </div>
        {field("website", {
          display: (
            <a href={o.website} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
              {websiteLabel(o.website)}
            </a>
          ),
        })}
        {field("description", { type: "textarea" })}
        {field("notes", { type: "textarea" })}

        {children.length > 0 && (
          <div className="field">
            <label>Includes</label>
            <div className="chips pad-top">
              {children.map((c) => (
                <button key={c.id} className="tag person" onClick={() => onOpenOrg(c.id)}>
                  {c.name}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="field">
          <label>People</label>
          <Members org={o} contacts={contacts} onOpenContact={onOpenContact} onChanged={onChanged} notify={notify} />
        </div>

        <footer className="panel-foot">
          <span className="muted small">
            Added {formatDate(o.created_at)} · Updated {formatDate(o.updated_at)}
          </span>
          <button
            className="danger"
            onClick={async () => {
              const who = o.members.length ? ` It will be removed from ${o.members.length} ${o.members.length === 1 ? "person" : "people"}.` : "";
              if (!confirm(`Delete ${o.name}?${who}`)) return;
              await api.removeOrg(o.id);
              onClose();
              onChanged();
              notify(`Deleted ${o.name}`);
            }}
          >
            Delete
          </button>
        </footer>
          </>
        )}
      </div>
    </aside>
  );
}

/** Members of an organization: toggle "current", unlink, or add someone (existing or new). */
function Members({
  org,
  contacts,
  onOpenContact,
  onChanged,
  notify,
}: {
  org: Org;
  contacts: Contact[];
  onOpenContact: (id: number) => void;
  onChanged: () => void;
  notify: (msg: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const memberIds = new Set(org.members.map((m) => m.id));
  const q = query.trim().toLowerCase();
  const options = useMemo(
    () => (q ? contacts.filter((c) => !memberIds.has(c.id) && c.name.toLowerCase().includes(q)).slice(0, 6) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [q, contacts, org],
  );
  const exact = contacts.some((c) => c.name.toLowerCase() === q);
  const items: ({ kind: "link"; c: Contact } | { kind: "create"; name: string })[] = [
    ...options.map((c) => ({ kind: "link" as const, c })),
    ...(q && !exact ? [{ kind: "create" as const, name: query.trim() }] : []),
  ];

  const choose = async (item: (typeof items)[number]) => {
    try {
      if (item.kind === "link") await api.setMembership(item.c.id, org.id);
      else {
        const created = await api.create({ name: item.name });
        await api.setMembership(created.id, org.id);
        notify(`Added ${item.name}`);
      }
      setQuery("");
      setActive(0);
      onChanged();
    } catch (err) {
      notify((err as Error).message);
    }
  };

  return (
    <div className="related-editor">
      <ul className="related-list">
        {org.members.map((m) => (
          <li key={m.id}>
            <button className={`tag person ${m.in_network ? "" : "outside"}`} onClick={() => onOpenContact(m.id)}>
              {m.name}
            </button>
            <button
              className={`note ${m.current ? "is-current" : "placeholder"}`}
              title={m.current ? "Marked as current. Click to unmark." : "Mark as a current affiliation"}
              onClick={() => api.setMembership(m.id, org.id, !m.current).then(onChanged)}
            >
              {m.current ? "current" : "mark current"}
            </button>
            <button
              className="icon-btn remove"
              title={`Remove ${m.name} from ${org.name}`}
              aria-label={`Remove ${m.name}`}
              onClick={() => api.removeMembership(m.id, org.id).then(onChanged)}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
      <div className="combo">
        <input
          value={query}
          placeholder="Add a person: type a name…"
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((a) => Math.min(a + 1, items.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((a) => Math.max(a - 1, 0));
            } else if (e.key === "Enter" && items[active]) {
              e.preventDefault();
              choose(items[active]);
            } else if (e.key === "Escape") setQuery("");
          }}
        />
        {items.length > 0 && (
          <ul className="combo-list" role="listbox">
            {items.map((item, i) => (
              <li key={item.kind === "link" ? item.c.id : "new"} role="option" aria-selected={i === active}>
                <button onMouseDown={(e) => e.preventDefault()} onClick={() => choose(item)} className={i === active ? "active" : ""}>
                  {item.kind === "link" ? (
                    <>
                      {item.c.name} <span className="muted small">{item.c.role}</span>
                    </>
                  ) : (
                    <>Create “{item.name}” and add</>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
