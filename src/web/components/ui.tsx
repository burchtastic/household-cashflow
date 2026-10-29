import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { Direction, EventStatus } from '../../engine/index.ts';
import { centsToInput, mmdd, parseDollars, shortDate } from '../format.ts';

/** Fetch on mount; `reload` refetches. */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(() => {
    fn().then((d) => { setData(d); setError(null); }, (e: Error) => setError(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(reload, [reload]);
  return { data, error, reload };
}

export function Modal({ title, open, onClose, children }: {
  title: string; open: boolean; onClose: () => void; children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} onClose={onClose} onCancel={onClose}>
      <h2>{title}</h2>
      {open && children}
    </dialog>
  );
}

/** A form wrapper that runs an async submit and shows its error. */
export function AsyncForm({ onSubmit, onCancel, submitLabel = 'Save', children }: {
  onSubmit: () => Promise<unknown>; onCancel?: () => void; submitLabel?: string; children: ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try { await onSubmit(); } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
      }}
    >
      {children}
      {error && <p className="error" role="alert">{error}</p>}
      <div className="form-actions">
        {onCancel && <button type="button" onClick={onCancel}>Cancel</button>}
        <button type="submit" className="primary" disabled={busy}>{busy ? 'Saving…' : submitLabel}</button>
      </div>
    </form>
  );
}

/** Dollar text input that reports cents (or null while invalid). */
export function MoneyInput({ label, cents, onChange, allowNegative = false, required = true, autoFocus = false, className }: {
  label: string; cents: number | null; onChange: (c: number | null) => void; allowNegative?: boolean; required?: boolean;
  autoFocus?: boolean; className?: string;
}) {
  const [text, setText] = useState(cents === null ? '' : centsToInput(cents));
  const invalid = text !== '' && parseDollars(text, allowNegative) === null;
  return (
    <label className={`field ${className ?? ''}`}>
      <span>{label}</span>
      <input
        inputMode="decimal"
        autoFocus={autoFocus}
        value={text}
        required={required}
        aria-invalid={invalid}
        onChange={(e) => {
          setText(e.target.value);
          onChange(e.target.value === '' ? null : parseDollars(e.target.value, allowNegative));
        }}
      />
      {invalid && <span className="error">Enter an amount like 1234.56</span>}
    </label>
  );
}

export function StatusChip({ status, direction = 'out', future = false }: { status: EventStatus; direction?: Direction; future?: boolean }) {
  // A done item dated ahead is committed (e.g. a transfer set up with the bank) but hasn't landed yet.
  const done = future ? '✓ Set up' : direction === 'in' ? '✓ Received' : '✓ Paid';
  const label = { posted: done, known: 'Known', scheduled: 'Scheduled', estimated: 'Estimate', planned: 'Planned' }[status];
  return <span className={`chip ${status}`}>{label}</span>;
}

export function ErrorNote({ error }: { error: string | null }) {
  return error ? <p className="error" role="alert">{error}</p> : null;
}

export function PencilIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
      <path d="M11.2 2.3a1.5 1.5 0 0 1 2.1 0l.4.4a1.5 1.5 0 0 1 0 2.1L5.5 13 2 14l1-3.5z" />
      <path d="M10 3.5 12.5 6" />
    </svg>
  );
}

export interface RowAction {
  label: string;
  onSelect: () => void;
  /** Shown instead of the label on wide screens (e.g. a pencil); the label is then its name. */
  icon?: ReactNode;
  title?: string;
  className?: string;
}

/**
 * A table row's buttons. Wide screens get them in a line; phones get one thumb-sized ⋯ that
 * slides them out over the row. A row with nothing to do gets nothing, not an empty menu.
 * Its cell needs the `row-menu-cell` class so the menu can cover the row.
 */
export function RowActions({ label, actions }: { label: string; actions: RowAction[] }) {
  const [open, setOpen] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  // Opened from a keyboard, focus moves into the menu; a tap leaves it be, so no focus ring flashes.
  const byKeyboard = useRef(false);
  useEffect(() => {
    if (!open) return;
    if (byKeyboard.current) menu.current?.querySelector('button')?.focus();
    const away = (e: PointerEvent) => { if (!menu.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); toggle.current?.focus(); } };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);
  if (!actions.length) return null;

  return (
    <>
      <div className="row-actions wide-only">
        {actions.map((a) => (
          <button
            key={a.label} className={['small', a.icon ? 'icon' : '', a.className ?? ''].join(' ').trim()}
            title={a.title} aria-label={a.icon ? a.label : undefined} onClick={a.onSelect}
          >
            {a.icon ?? a.label}
          </button>
        ))}
      </div>
      <button
        ref={toggle} className="row-menu-toggle phone-only" aria-label={`Options for ${label}`} aria-expanded={open}
        onClick={(e) => { byKeyboard.current = e.detail === 0; setOpen(true); }}
      >
        <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true" fill="currentColor">
          <circle cx="4" cy="10" r="1.8" /><circle cx="10" cy="10" r="1.8" /><circle cx="16" cy="10" r="1.8" />
        </svg>
      </button>
      {open && (
        <div ref={menu} className="row-menu phone-only" role="group" aria-label={`Options for ${label}`}>
          {actions.map((a) => (
            <button key={a.label} onClick={() => { setOpen(false); a.onSelect(); }}>{a.label}</button>
          ))}
          <button className="row-menu-close" aria-label="Close" onClick={() => { setOpen(false); toggle.current?.focus(); }}>
            <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M5 5l10 10M15 5L5 15" />
            </svg>
          </button>
        </div>
      )}
    </>
  );
}

/** A delete-style button that asks "Sure?" in place before doing anything. */
export function ConfirmButton({ label, confirmLabel = 'Yes, delete', keepLabel = 'Keep', className = 'small link danger', title, disabled, onConfirm }: {
  label: string; confirmLabel?: string; keepLabel?: string; className?: string; title?: string; disabled?: boolean;
  onConfirm: () => unknown;
}) {
  const [asking, setAsking] = useState(false);
  if (!asking) return <button className={className} title={title} disabled={disabled} onClick={() => setAsking(true)}>{label}</button>;
  return (
    <span className="confirm-inline" role="group" aria-label={`${label}?`}>
      <button className="small danger" disabled={disabled} onClick={() => { setAsking(false); onConfirm(); }}>{confirmLabel}</button>
      <button className="small" onClick={() => setAsking(false)}>{keepLabel}</button>
    </span>
  );
}

/** "Tue, Nov 24" on wide screens, "11-24" on phones. */
export function DateText({ iso }: { iso: string }) {
  return (
    <>
      <span className="wide-only">{shortDate(iso)}</span>
      <span className="phone-only" title={shortDate(iso)}>{mmdd(iso)}</span>
    </>
  );
}
