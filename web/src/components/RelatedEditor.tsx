import { useMemo, useState } from "react";
import { api, orgSummary, type Contact } from "../api";

type Props = {
  contact: Contact;
  contacts: Contact[];
  onOpen: (id: number) => void;
  onChanged: () => void;
  notify: (msg: string) => void;
};

/** Many-to-many relationship editor: link to existing contacts or create a new one by name. */
export function RelatedEditor({ contact, contacts, onOpen, onChanged, notify }: Props) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [editing, setEditing] = useState<{ id: number; field: "kind" | "note" } | null>(null);
  const [draft, setDraft] = useState("");

  const relatedIds = new Set(contact.related.map((r) => r.id));
  const q = query.trim().toLowerCase();
  const options = useMemo(
    () =>
      q
        ? contacts
            .filter((c) => c.id !== contact.id && !relatedIds.has(c.id) && c.name.toLowerCase().includes(q))
            .sort((a, b) => Number(!a.name.toLowerCase().startsWith(q)) - Number(!b.name.toLowerCase().startsWith(q)))
            .slice(0, 6)
        : [],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [q, contacts, contact],
  );
  const exact = contacts.some((c) => c.name.toLowerCase() === q);
  const items: ({ kind: "link"; c: Contact } | { kind: "create"; name: string })[] = [
    ...options.map((c) => ({ kind: "link" as const, c })),
    ...(q && !exact ? [{ kind: "create" as const, name: query.trim() }] : []),
  ];

  const choose = async (item: (typeof items)[number]) => {
    try {
      const otherId = item.kind === "link" ? item.c.id : (await api.create({ name: item.name, in_network: false })).id;
      await api.relate(contact.id, otherId);
      if (item.kind === "create") notify(`Linked ${item.name} (outside your network; open them to add as a contact)`);
      setQuery("");
      setActive(0);
      onChanged();
    } catch (err) {
      notify((err as Error).message);
    }
  };

  const save = async () => {
    if (!editing) return;
    setEditing(null);
    await api.relate(contact.id, editing.id, { [editing.field]: draft.trim() });
    onChanged();
  };

  /** Inline editor for a relationship's type or note. Both are optional and hidden until hovered when empty. */
  const detail = (r: Contact["related"][number], field: "kind" | "note") =>
    editing?.id === r.id && editing.field === field ? (
      <input
        className={field === "kind" ? "kind-input" : "note-input"}
        autoFocus
        value={draft}
        list={field === "kind" ? "relation-kind-options" : undefined}
        placeholder={field === "kind" ? "Friends, mentorship…" : "How are they connected?"}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === "Enter") save();
          if (e.key === "Escape") setEditing(null);
        }}
      />
    ) : (
      <button
        className={`${field === "kind" ? "kind-pill" : "note"} ${r[field] ? "" : "placeholder"}`}
        title={field === "kind" ? "Type of relationship (optional)" : "Note (optional)"}
        onClick={() => {
          setDraft(r[field]);
          setEditing({ id: r.id, field });
        }}
      >
        {r[field] || (field === "kind" ? "+ type" : "add note")}
      </button>
    );

  return (
    <div className="related-editor">
      <ul className="related-list">
        {contact.related.map((r) => (
          <li key={r.id}>
            <button className={`tag person ${r.in_network ? "" : "outside"}`} title={r.in_network ? undefined : "Outside your network"} onClick={() => onOpen(r.id)}>
              {r.name}
            </button>
            {detail(r, "kind")}
            {detail(r, "note")}
            <button
              className="icon-btn remove"
              title={`Unlink ${r.name}`}
              aria-label={`Unlink ${r.name}`}
              onClick={async () => {
                await api.unrelate(contact.id, r.id);
                onChanged();
              }}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
      <div className="combo">
        <input
          value={query}
          placeholder="Link a person: type a name…"
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
                      {item.c.name} <span className="muted small">{[item.c.role, orgSummary(item.c)].filter(Boolean).join(" · ")}</span>
                    </>
                  ) : (
                    <>
                      Create “{item.name}” and link
                    </>
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
