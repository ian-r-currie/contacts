import { useMemo, useState } from "react";
import { api, currentOrgs, type Contact, type Org } from "../api";

type Props = {
  contact: Contact;
  orgs: Org[];
  onOpenOrg: (id: number) => void;
  onChanged: () => void;
  notify: (msg: string) => void;
};

/** A person's organizations: open one, mark it current, remove it, or add an existing or new organization. */
export function MembershipsEditor({ contact, orgs, onOpenOrg, onChanged, notify }: Props) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const current = new Set(currentOrgs(contact).map((o) => o.id));
  const mine = new Set(contact.orgs.map((o) => o.id));
  const q = query.trim().toLowerCase();
  const options = useMemo(
    () =>
      q
        ? orgs
            .filter((o) => !mine.has(o.id) && o.name.toLowerCase().includes(q))
            .sort((a, b) => Number(!a.name.toLowerCase().startsWith(q)) - Number(!b.name.toLowerCase().startsWith(q)))
            .slice(0, 6)
        : [],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [q, orgs, contact],
  );
  const exact = orgs.some((o) => o.name.toLowerCase() === q);
  const items: ({ kind: "link"; o: Org } | { kind: "create"; name: string })[] = [
    ...options.map((o) => ({ kind: "link" as const, o })),
    ...(q && !exact ? [{ kind: "create" as const, name: query.trim() }] : []),
  ];

  const choose = async (item: (typeof items)[number]) => {
    try {
      const orgId = item.kind === "link" ? item.o.id : (await api.createOrg({ name: item.name })).id;
      await api.setMembership(contact.id, orgId);
      if (item.kind === "create") notify(`Created organization ${item.name}`);
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
        {contact.orgs.map((m) => {
          const isCurrent = current.has(m.id) && contact.orgs.length > 1;
          return (
            <li key={m.id}>
              <button className={`tag person ${isCurrent ? "current" : ""}`} title={m.type || undefined} onClick={() => onOpenOrg(m.id)}>
                {m.name}
              </button>
              {contact.orgs.length > 1 ? (
                <button
                  className={`note ${m.current ? "is-current" : "placeholder"}`}
                  title={m.current ? "Current. Click to unmark." : "Mark as current"}
                  onClick={() => api.setMembership(contact.id, m.id, !m.current).then(onChanged)}
                >
                  {m.current ? "current" : "mark current"}
                </button>
              ) : (
                <span className="note muted">{m.type}</span>
              )}
              <button
                className="icon-btn remove"
                title={`Remove ${m.name}`}
                aria-label={`Remove ${m.name}`}
                onClick={() => api.removeMembership(contact.id, m.id).then(onChanged)}
              >
                ×
              </button>
            </li>
          );
        })}
      </ul>
      <div className="combo">
        <input
          value={query}
          placeholder="Add a school, lab, company…"
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
              <li key={item.kind === "link" ? item.o.id : "new"} role="option" aria-selected={i === active}>
                <button onMouseDown={(e) => e.preventDefault()} onClick={() => choose(item)} className={i === active ? "active" : ""}>
                  {item.kind === "link" ? (
                    <>
                      {item.o.name} <span className="muted small">{item.o.type}</span>
                    </>
                  ) : (
                    <>Create organization “{item.name}”</>
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
