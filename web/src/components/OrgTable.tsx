import { useMemo } from "react";
import { api, formatDate, type Org, type OrgInput } from "../api";
import { websiteLabel } from "./ContactTable";
import { EditableCell } from "./EditableCell";

/** People chips per row before collapsing into "+N more". */
const PEOPLE_SHOWN = 8;

type Props = {
  orgs: Org[];
  query: string;
  selectedId?: number;
  onOpen: (id: number, tab?: "details" | "research") => void;
  onOpenContact: (id: number) => void;
  onChanged: () => void;
  notify: (msg: string) => void;
};

/** Orders organizations as a tree: each one followed by the organizations that are part of it. */
export function orgTree(orgs: Org[]): { org: Org; depth: number }[] {
  const ids = new Set(orgs.map((o) => o.id));
  const children = new Map<number | null, Org[]>();
  for (const o of orgs) {
    const parent = o.parent_id != null && ids.has(o.parent_id) ? o.parent_id : null;
    children.set(parent, [...(children.get(parent) ?? []), o]);
  }
  const out: { org: Org; depth: number }[] = [];
  const walk = (parent: number | null, depth: number) => {
    for (const o of (children.get(parent) ?? []).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }))) {
      out.push({ org: o, depth });
      walk(o.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

/** Turns a typed "part of" name into a parent id, creating the parent organization if it doesn't exist yet. */
export async function resolveParent(orgs: Org[], name: string): Promise<number | null> {
  const trimmed = name.trim();
  if (!trimmed) return null;
  const found = orgs.find((o) => o.name.toLowerCase() === trimmed.toLowerCase());
  if (found) return found.id;
  return (await api.createOrg({ name: trimmed })).id;
}

export function OrgTable({ orgs, query, selectedId, onOpen, onOpenContact, onChanged, notify }: Props) {
  const byId = useMemo(() => new Map(orgs.map((o) => [o.id, o])), [orgs]);
  const q = query.trim().toLowerCase();
  const rows = useMemo(() => {
    const tree = orgTree(orgs);
    if (!q) return tree;
    return tree
      .filter(({ org: o }) => [o.name, o.type, o.description, o.notes, ...o.members.map((m) => m.name)].some((v) => v.toLowerCase().includes(q)))
      .map((r) => ({ ...r, depth: 0 }));
  }, [orgs, q]);

  const update = async (o: Org, fields: OrgInput) => {
    try {
      await api.updateOrg(o.id, fields);
    } catch (err) {
      notify(`Couldn't save: ${(err as Error).message}`);
    }
    onChanged();
  };

  const setParent = async (o: Org, name: string) => {
    try {
      await update(o, { parent_id: await resolveParent(orgs, name) });
    } catch (err) {
      notify((err as Error).message);
    }
  };

  if (orgs.length === 0) {
    return (
      <div className="empty">
        <p>No organizations yet.</p>
        <p>Add one above, list them on people (schools count too), or import an organizations sheet from ⋯ → Import CSV.</p>
      </div>
    );
  }

  return (
    <>
      <datalist id="org-name-options">
        {orgs.map((o) => (
          <option key={o.id} value={o.name} />
        ))}
      </datalist>

      <div className="table-wrap">
        <table className="contacts orgs">
          <thead>
            <tr>
              <th className="col-name">
                <span>Name</span>
              </th>
              <th className="col-type">
                <span>Type</span>
              </th>
              <th className="col-parent">
                <span>Part of</span>
              </th>
              <th className="col-people">
                <span>People</span>
              </th>
              <th className="col-website">
                <span>Website</span>
              </th>
              <th className="col-description">
                <span>Description</span>
              </th>
              <th>
                <span>Updated</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ org: o, depth }) => (
              <tr key={o.id} className={o.id === selectedId ? "selected" : ""}>
                <td className="col-name">
                  <div className="name-cell" style={{ paddingLeft: depth * 18 }}>
                    <button className="name-link" onClick={() => onOpen(o.id)}>
                      {depth > 0 && <span className="tree-mark">↳ </span>}
                      {o.name}
                    </button>
                    <button
                      className="icon-btn research-btn"
                      title="Research this organization"
                      aria-label={`Research ${o.name}`}
                      onClick={() => onOpen(o.id, "research")}
                    >
                      ✦
                    </button>
                  </div>
                </td>
                <td className="col-type">
                  <EditableCell value={o.type} onSave={(v) => update(o, { type: v })} list="org-type-options" />
                </td>
                <td className="col-parent">
                  <EditableCell value={o.parent_id ? (byId.get(o.parent_id)?.name ?? "") : ""} onSave={(v) => setParent(o, v)} list="org-name-options" />
                </td>
                <td className="col-people">
                  <div className="chips">
                    {o.members.slice(0, PEOPLE_SHOWN).map((m) => (
                      <button
                        key={m.id}
                        className={`tag person ${m.in_network ? "" : "outside"}`}
                        title={m.current ? "Current" : undefined}
                        onClick={() => onOpenContact(m.id)}
                      >
                        {m.name}
                      </button>
                    ))}
                    {o.members.length > PEOPLE_SHOWN ? (
                      <button className="tag add" title="See everyone" onClick={() => onOpen(o.id)}>
                        +{o.members.length - PEOPLE_SHOWN} more
                      </button>
                    ) : (
                      <button className="tag add" title="Add people" onClick={() => onOpen(o.id)}>
                        +
                      </button>
                    )}
                  </div>
                </td>
                <td className="col-website">
                  <EditableCell
                    value={o.website}
                    onSave={(v) => update(o, { website: v })}
                    display={
                      <a href={o.website} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
                        {websiteLabel(o.website)}
                      </a>
                    }
                  />
                </td>
                <td className="col-description">
                  <EditableCell type="textarea" value={o.description} onSave={(v) => update(o, { description: v })} className="clamp" />
                </td>
                <td>
                  <span className="muted cell-static">{formatDate(o.updated_at)}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && <p className="empty">No matches.</p>}
      </div>

      <ul className="cards">
        {rows.map(({ org: o, depth }) => (
          <li key={o.id} className={o.id === selectedId ? "selected" : ""} style={{ marginLeft: depth * 14 }}>
            <button className="card" onClick={() => onOpen(o.id)}>
              <div className="card-top">
                <strong>{o.name}</strong>
                {o.type && <span className="tag">{o.type}</span>}
              </div>
              {o.description && <div className="card-research">{o.description}</div>}
              <div className="muted small">
                {o.members.length} {o.members.length === 1 ? "person" : "people"}
                {o.members.length > 0 && `: ${o.members.map((m) => m.name).join(", ")}`}
              </div>
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}
