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
  const [editingNote, setEditingNote] = useState<number | null>(null);
  const [noteDraft, setNoteDraft] = useState("");

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

  const saveNote = async (otherId: number) => {
    setEditingNote(null);
    await api.relate(contact.id, otherId, noteDraft.trim());
    onChanged();
  };

  return (
    <div className="related-editor">
      <ul className="related-list">
        {contact.related.map((r) => (
          <li key={r.id}>
            <button className={`tag person ${r.in_network ? "" : "outside"}`} title={r.in_network ? undefined : "Outside your network"} onClick={() => onOpen(r.id)}>
              {r.name}
            </button>
            {editingNote === r.id ? (
              <input
                className="note-input"
                autoFocus
                value={noteDraft}
                placeholder="How are they connected?"
                onChange={(e) => setNoteDraft(e.target.value)}
                onBlur={() => saveNote(r.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") saveNote(r.id);
                  if (e.key === "Escape") setEditingNote(null);
                }}
              />
            ) : (
              <button
                className={`note ${r.note ? "" : "placeholder"}`}
                onClick={() => {
                  setNoteDraft(r.note);
                  setEditingNote(r.id);
                }}
              >
                {r.note || "add note"}
              </button>
            )}
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
