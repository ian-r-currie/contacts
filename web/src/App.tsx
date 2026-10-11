import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, dueState, localToday, type AppConfig, type Contact, type ContactInput } from "./api";
import { ContactTable, type Column, type SortKey, ALL_COLUMNS, DEFAULT_COLUMNS } from "./components/ContactTable";
import { DetailPanel, type PanelTab } from "./components/DetailPanel";
import { ImportDialog } from "./components/ImportDialog";
import { Menu } from "./components/Menu";
import { NetworkView } from "./components/NetworkView";
import { disablePush, enablePush, pushState, registerServiceWorker, type PushState } from "./push";

const load = <T,>(key: string, fallback: T): T => {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
};
const save = (key: string, value: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable */
  }
};

export function App() {
  const [session, setSession] = useState<{ authRequired: boolean; authenticated: boolean } | null>(null);
  useEffect(() => {
    api.session().then(setSession, () => setSession({ authRequired: false, authenticated: true }));
  }, []);
  if (!session) return null;
  if (!session.authenticated) return <Login onDone={() => setSession({ ...session, authenticated: true })} />;
  return <Main authRequired={session.authRequired} />;
}

function Login({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  return (
    <form
      className="login"
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          await api.login(password);
          onDone();
        } catch (err) {
          setError((err as Error).message);
        }
      }}
    >
      <h1>Contacts</h1>
      <input type="password" autoFocus placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} />
      <button className="primary" type="submit">
        Log in
      </button>
      {error && <p className="error">{error}</p>}
    </form>
  );
}

function Main({ authRequired }: { authRequired: boolean }) {
  const [contacts, setContacts] = useState<Contact[] | null>(null);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [query, setQuery] = useState("");
  const [view, setView] = useState<"table" | "network">(() => load("view", "table"));
  const [showOutside, setShowOutside] = useState(false);
  const [dueOnly, setDueOnly] = useState(false);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>(() => load("sort", { key: "name" as SortKey, dir: 1 as const }));
  const [columns, setColumns] = useState<Column[]>(() => load("columns", DEFAULT_COLUMNS).filter((c) => ALL_COLUMNS.includes(c)));
  const [selected, setSelected] = useState<{ id: number; tab: PanelTab } | null>(() => {
    const id = Number(new URLSearchParams(location.search).get("contact"));
    return id ? { id, tab: "details" } : null;
  });
  const [importing, setImporting] = useState(false);
  const [push, setPush] = useState<PushState>("unsupported");
  const [newName, setNewName] = useState("");
  const toastTimer = useRef<number>(undefined);

  const notify = useCallback((msg: string) => {
    setToast(msg);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(""), 3500);
  }, []);

  const refresh = useCallback(async () => {
    try {
      setContacts(await api.contacts());
      setError("");
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) location.reload();
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    refresh();
    api.config().then(setConfig, () => {});
    registerServiceWorker().then(() => pushState().then(setPush));
    // Keep the list fresh when coming back to the tab (e.g. after editing on another device).
    const onFocus = () => document.visibilityState === "visible" && refresh();
    document.addEventListener("visibilitychange", onFocus);
    return () => document.removeEventListener("visibilitychange", onFocus);
  }, [refresh]);

  useEffect(() => save("view", view), [view]);
  useEffect(() => save("sort", sort), [sort]);
  useEffect(() => save("columns", columns), [columns]);

  // Reflect the open contact in the URL so notifications and reloads land on it.
  useEffect(() => {
    const url = new URL(location.href);
    if (selected) url.searchParams.set("contact", String(selected.id));
    else url.searchParams.delete("contact");
    history.replaceState(null, "", url);
  }, [selected]);

  const roles = useMemo(() => [...new Set((contacts ?? []).map((c) => c.role).filter(Boolean))].sort(), [contacts]);
  const outsideCount = useMemo(() => (contacts ?? []).filter((c) => !c.in_network).length, [contacts]);
  const networkCount = (contacts?.length ?? 0) - outsideCount;
  const today = localToday();
  const due = useMemo(() => (contacts ?? []).filter((c) => ["overdue", "today"].includes(dueState(c.follow_up_date, today))), [contacts, today]);

  const visible = useMemo(() => {
    if (!contacts) return [];
    const q = query.trim().toLowerCase();
    const list = contacts.filter((c) => {
      // People who are only someone's connection live in the network web, not the contacts list.
      if (!c.in_network && !showOutside) return false;
      if (dueOnly && !due.includes(c)) return false;
      if (!q) return true;
      const hay = [c.name, c.role, c.department, c.schools, c.research, c.email, c.notes, ...c.related.map((r) => r.name)];
      return hay.some((v) => v.toLowerCase().includes(q));
    });
    const value = (c: Contact) => (sort.key === "related" ? String(c.related.length).padStart(4, "0") : c[sort.key]);
    return list.sort((a, b) => {
      const va = value(a);
      const vb = value(b);
      // Empty values always sort last.
      if (!va !== !vb) return va ? -1 : 1;
      return va.localeCompare(vb, undefined, { sensitivity: "base", numeric: true }) * sort.dir;
    });
  }, [contacts, query, showOutside, dueOnly, due, sort]);

  const update = useCallback(
    async (id: number, fields: ContactInput) => {
      setContacts((list) => list?.map((c) => (c.id === id ? { ...c, ...fields } : c)) ?? null);
      try {
        await api.update(id, fields);
      } catch (err) {
        notify(`Couldn't save: ${(err as Error).message}`);
      }
      await refresh();
    },
    [refresh, notify],
  );

  const addContact = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = newName.trim();
    if (!name) return;
    try {
      const created = await api.create({ name });
      setNewName("");
      await refresh();
      notify(`Added ${created.name}`);
    } catch (err) {
      notify((err as Error).message);
    }
  };

  const togglePush = async () => {
    try {
      if (push === "on") setPush(await disablePush());
      else if (config) {
        const state = await enablePush(config.vapidPublicKey);
        setPush(state);
        if (state === "on") notify("Follow-up reminders enabled on this device");
        if (state === "denied") notify("Notifications are blocked in your browser settings");
      }
    } catch (err) {
      notify(`Notifications: ${(err as Error).message}`);
    }
  };

  const selectedContact = contacts?.find((c) => c.id === selected?.id);

  return (
    <div className={`app ${selectedContact ? "with-panel" : ""}`}>
      <header className="topbar">
        <h1>Contacts</h1>
        <input className="search" type="search" placeholder="Search names, schools, research, notes…" value={query} onChange={(e) => setQuery(e.target.value)} />
        <Menu label="⋯" title="More">
          <button onClick={() => setImporting(true)}>Import CSV…</button>
          <a href="/api/export.csv" download>
            Export CSV
          </a>
          {push !== "unsupported" && (
            <button onClick={togglePush} disabled={push === "denied"}>
              {push === "on" ? "Turn off follow-up notifications" : push === "denied" ? "Notifications blocked by browser" : "Enable follow-up notifications"}
            </button>
          )}
          {push === "on" && <button onClick={() => api.pushTest().then((r) => notify(r.delivered ? "Test notification sent" : "No devices subscribed"))}>Send test notification</button>}
          {push === "unsupported" && <span className="menu-note">Notifications need HTTPS or localhost.</span>}
          <span className="menu-sep" />
          <span className="menu-label">Columns</span>
          {ALL_COLUMNS.filter((c) => c !== "name").map((c) => (
            <label key={c} className="menu-check">
              <input
                type="checkbox"
                checked={columns.includes(c)}
                onChange={(e) => setColumns(e.target.checked ? ALL_COLUMNS.filter((x) => x === c || columns.includes(x)) : columns.filter((x) => x !== c))}
              />
              {LABEL_FOR[c]}
            </label>
          ))}
          {authRequired && (
            <>
              <span className="menu-sep" />
              <button onClick={() => api.logout().then(() => location.reload())}>Log out</button>
            </>
          )}
        </Menu>
      </header>

      <div className="filters">
        <div className="segmented" role="tablist" aria-label="View">
          <button role="tab" aria-selected={view === "table"} className={view === "table" ? "active" : ""} onClick={() => setView("table")}>
            Table <span className="count">{networkCount}</span>
          </button>
          <button role="tab" aria-selected={view === "network"} className={view === "network" ? "active" : ""} onClick={() => setView("network")}>
            Network
          </button>
        </div>
        {view === "table" && (
          <>
            <button className={`chip due ${dueOnly ? "active" : ""}`} onClick={() => setDueOnly(!dueOnly)} disabled={!due.length && !dueOnly}>
              Follow-ups due <span className="count">{due.length}</span>
            </button>
            {outsideCount > 0 && (
              <button
                className={`chip ${showOutside ? "active" : ""}`}
                title="People who are only listed as someone's connection"
                onClick={() => setShowOutside(!showOutside)}
              >
                Outside network <span className="count">{outsideCount}</span>
              </button>
            )}
          </>
        )}
      </div>

      <form className="quick-add" onSubmit={addContact}>
        <input placeholder="Add someone: type a name and press Enter" value={newName} onChange={(e) => setNewName(e.target.value)} />
        <button className="primary" type="submit" disabled={!newName.trim()}>
          Add
        </button>
      </form>

      {error && <p className="error banner">{error}</p>}

      <datalist id="role-options">
        {[...new Set(["Professor", ...roles])].map((r) => (
          <option key={r} value={r} />
        ))}
      </datalist>

      <main className="content">
        {contacts === null ? (
          <p className="empty">Loading…</p>
        ) : contacts.length === 0 ? (
          <div className="empty">
            <p>No contacts yet.</p>
            <p>
              Add someone above, or <button className="link" onClick={() => setImporting(true)}>import your spreadsheet as CSV</button>.
            </p>
          </div>
        ) : view === "network" ? (
          <NetworkView contacts={contacts} query={query} focusId={selected?.id} onOpen={(id) => setSelected({ id, tab: "details" })} />
        ) : (
          <ContactTable
            contacts={visible}
            columns={columns}
            sort={sort}
            onSort={(key) => setSort((s) => ({ key, dir: s.key === key ? ((-s.dir) as 1 | -1) : 1 }))}
            selectedId={selected?.id}
            onOpen={(id, tab = "details") => setSelected({ id, tab })}
            onUpdate={update}
            researchEnabled={!!config?.researchEnabled}
          />
        )}
      </main>

      {selectedContact && (
        <DetailPanel
          key={selectedContact.id}
          contact={selectedContact}
          contacts={contacts ?? []}
          tab={selected!.tab}
          onTab={(tab) => setSelected({ id: selectedContact.id, tab })}
          onClose={() => setSelected(null)}
          onOpen={(id) => setSelected({ id, tab: "details" })}
          onUpdate={update}
          onChanged={refresh}
          notify={notify}
          researchEnabled={!!config?.researchEnabled}
        />
      )}

      {importing && (
        <ImportDialog
          onClose={() => setImporting(false)}
          onImported={(msg) => {
            refresh();
            notify(msg);
          }}
        />
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

const LABEL_FOR: Record<Column, string> = {
  name: "Name",
  role: "Role",
  department: "Department",
  schools: "Schools",
  research: "Research",
  related: "Related to",
  email: "Email",
  website: "Website",
  last_contacted: "Last contacted",
  follow_up_date: "Follow-up",
  notes: "Notes",
  updated_at: "Updated",
};
