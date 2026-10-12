import { currentOrgs, type Contact, type Membership } from "../api";

/**
 * A person's organization chips. With several organizations, the current ones are highlighted and clicking a
 * chip toggles whether it's current. With just one, it's current implicitly and nothing is highlighted.
 * Clicks don't reach a surrounding editable cell.
 */
export function OrgChips({ contact, onToggleCurrent }: { contact: Contact; onToggleCurrent?: (m: Membership) => void }) {
  const current = new Set(currentOrgs(contact).map((o) => o.id));
  const pickable = contact.orgs.length > 1 && onToggleCurrent;
  return (
    <span className="chips">
      {contact.orgs.map((o) => {
        const isCurrent = current.has(o.id) && contact.orgs.length > 1;
        const title = [o.type, isCurrent ? "current" : ""].filter(Boolean).join(" · ");
        return pickable ? (
          <button
            key={o.id}
            className={`tag school ${isCurrent ? "current" : ""}`}
            title={`${title ? `${title}. ` : ""}${isCurrent ? "Click to unmark as current" : "Click to mark as current"}`}
            onClick={(e) => {
              e.stopPropagation();
              onToggleCurrent(o);
            }}
            onKeyDown={(e) => e.stopPropagation()}
          >
            {o.name}
          </button>
        ) : (
          <span key={o.id} className="tag" title={title || undefined}>
            {o.name}
          </span>
        );
      })}
    </span>
  );
}

export const orgNames = (c: Contact) => c.orgs.map((o) => o.name).join(", ");
export const parseOrgNames = (text: string) =>
  text
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
