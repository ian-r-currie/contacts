import { useEffect, useRef, useState, type ReactNode } from "react";

type Props = {
  value: string;
  onSave: (value: string) => void;
  type?: "text" | "date" | "textarea";
  list?: string;
  placeholder?: string;
  display?: ReactNode;
  className?: string;
};

/** Spreadsheet-style cell: click (or Enter when focused) to edit, Enter/blur to save, Escape to cancel. */
export function EditableCell({ value, onSave, type = "text", list, placeholder, display, className = "" }: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement & HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      if (type !== "date") inputRef.current?.select();
    }
  }, [editing, type]);

  const commit = () => {
    setEditing(false);
    if (draft.trim() !== value.trim()) onSave(draft);
  };

  if (!editing) {
    return (
      <div
        className={`cell ${className} ${value ? "" : "blank"}`}
        tabIndex={0}
        onClick={() => {
          setDraft(value);
          setEditing(true);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            setDraft(value);
            setEditing(true);
          }
        }}
      >
        {value ? (display ?? value) : <span className="placeholder">{placeholder ?? "—"}</span>}
      </div>
    );
  }

  const common = {
    ref: inputRef,
    value: draft,
    className: "cell-input",
    onChange: (e: React.ChangeEvent<HTMLInputElement & HTMLTextAreaElement>) => setDraft(e.target.value),
    onBlur: commit,
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        setDraft(value);
        setEditing(false);
      } else if (e.key === "Enter" && (type !== "textarea" || e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        commit();
      }
    },
  };
  return type === "textarea" ? <textarea rows={3} {...common} /> : <input type={type} list={list} {...common} />;
}
