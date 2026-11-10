/**
 * Small UI primitives: a segmented control, a sheet (native <dialog>), and a
 * delayed indicator. Plain React + CSS; no component library, to keep the bundle
 * small (the whole UI is a handful of controls).
 */
import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * A row of mutually exclusive buttons (a radio group that looks like tabs).
 * `aria-pressed` carries the state for assistive tech; the selected one is
 * visibly filled, and every press is acknowledged on pointerdown (see main.tsx).
 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  labels,
  className = "",
}: {
  options: readonly T[];
  value: T;
  onChange: (v: T) => void;
  label: string;
  labels?: Partial<Record<T, string>>;
  className?: string;
}) {
  return (
    <div className={`segmented ${className}`} role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o} type="button" aria-pressed={o === value} onClick={() => o !== value && onChange(o)}>
          {labels?.[o] ?? o}
        </button>
      ))}
    </div>
  );
}

/**
 * A modal sheet built on the native <dialog>: focus trapping, Escape to close and
 * the backdrop come from the browser. On phones it is a bottom sheet (CSS).
 * No history entry: a small dialog closes with Esc / Done / a tap outside.
 */
export function Sheet({
  open,
  onClose,
  title,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className="sheet"
      aria-label={title}
      onClose={onClose}
      // A click on the backdrop lands on the <dialog> element itself.
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="sheet-inner">
        <header className="sheet-head">
          <h2>{title}</h2>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </header>
        <div className="sheet-body">{children}</div>
        {footer && <footer className="sheet-foot">{footer}</footer>}
      </div>
    </dialog>
  );
}

/**
 * True once `active` has been true for `delayMs` (so a fast load never flashes a
 * spinner), and stays true at least `holdMs` once shown (so it never flickers).
 */
export function useDelayed(active: boolean, delayMs = 400, holdMs = 300): boolean {
  const [shown, setShown] = useState(false);
  const shownAt = useRef(0);
  useEffect(() => {
    if (active) {
      const t = setTimeout(() => {
        shownAt.current = Date.now();
        setShown(true);
      }, delayMs);
      return () => clearTimeout(t);
    }
    if (!shown) return;
    const wait = Math.max(0, holdMs - (Date.now() - shownAt.current));
    const t = setTimeout(() => setShown(false), wait);
    return () => clearTimeout(t);
  }, [active, delayMs, holdMs, shown]);
  return shown;
}
