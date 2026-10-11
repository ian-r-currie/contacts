import { useEffect, useRef, useState, type ReactNode } from "react";

export function Menu({ label, title, children }: { label: ReactNode; title: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);
  return (
    <div className="menu" ref={ref}>
      <button className="icon-btn" title={title} aria-label={title} aria-expanded={open} onClick={() => setOpen(!open)}>
        {label}
      </button>
      {open && (
        <div
          className="menu-pop"
          onClick={(e) => {
            const t = e.target as HTMLElement;
            if (t.closest("button, a")) setOpen(false);
          }}
        >
          {children}
        </div>
      )}
    </div>
  );
}
