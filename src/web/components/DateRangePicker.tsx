import { useEffect, useRef, useState } from 'react';
import { addDays, daysInMonth, isISODate } from '../../engine/dates.ts';
import { dayMonth, longDate } from '../format.ts';

export type PresetId =
  | 'today' | 'yesterday' | 'thisWeek' | 'lastWeek' | 'last7' | 'last28' | 'last30' | 'last90'
  | 'thisMonth' | 'lastMonth' | 'last12Months' | 'thisYear' | 'lastYear' | 'custom';

export interface DateRange { from: string; to: string; preset: PresetId }

const PRESETS: { id: Exclude<PresetId, 'custom'>; label: string }[] = [
  { id: 'today', label: 'Today' },
  { id: 'yesterday', label: 'Yesterday' },
  { id: 'thisWeek', label: 'This week' },
  { id: 'lastWeek', label: 'Last week' },
  { id: 'last7', label: 'Last 7 days' },
  { id: 'last28', label: 'Last 28 days' },
  { id: 'last30', label: 'Last 30 days' },
  { id: 'last90', label: 'Last 90 days' },
  { id: 'thisMonth', label: 'This month' },
  { id: 'lastMonth', label: 'Last month' },
  { id: 'last12Months', label: 'Last 12 months' },
  { id: 'thisYear', label: 'This year' },
  { id: 'lastYear', label: 'Last year' },
];

const weekday = (iso: string) => new Date(`${iso}T00:00:00Z`).getUTCDay(); // 0 = Sunday
const ym = (y: number, m: number) => `${y}-${String(m).padStart(2, '0')}`;
const monthEnd = (y: number, m: number) => `${ym(y, m)}-${String(daysInMonth(y, m)).padStart(2, '0')}`;
function shiftMonth(month: string, by: number): string {
  const [y, m] = month.split('-').map(Number);
  const i = y * 12 + (m - 1) + by;
  return ym(Math.floor(i / 12), (i % 12) + 1);
}

/** The dates a preset covers on a given day. "Last N days" includes today. */
export function presetRange(id: Exclude<PresetId, 'custom'>, today: string): DateRange {
  const [y, m] = today.split('-').map(Number);
  const r = (from: string, to: string): DateRange => ({ from, to, preset: id });
  switch (id) {
    case 'today': return r(today, today);
    case 'yesterday': return r(addDays(today, -1), addDays(today, -1));
    case 'thisWeek': return r(addDays(today, -weekday(today)), today);
    case 'lastWeek': { const sun = addDays(today, -weekday(today) - 7); return r(sun, addDays(sun, 6)); }
    case 'last7': return r(addDays(today, -6), today);
    case 'last28': return r(addDays(today, -27), today);
    case 'last30': return r(addDays(today, -29), today);
    case 'last90': return r(addDays(today, -89), today);
    case 'thisMonth': return r(`${ym(y, m)}-01`, today);
    case 'lastMonth': { const [py, pm] = shiftMonth(ym(y, m), -1).split('-').map(Number); return r(`${ym(py, pm)}-01`, monthEnd(py, pm)); }
    case 'last12Months': return r(`${shiftMonth(ym(y, m), -11)}-01`, today);
    case 'thisYear': return r(`${y}-01-01`, today);
    case 'lastYear': return r(`${y - 1}-01-01`, `${y - 1}-12-31`);
  }
}

export function rangeLabel(r: DateRange): string {
  if (r.from === r.to) return longDate(r.from);
  return r.from.slice(0, 4) === r.to.slice(0, 4)
    ? `${dayMonth(r.from)} – ${longDate(r.to)}`
    : `${longDate(r.from)} – ${longDate(r.to)}`;
}

export function DateRangePicker({ value, today, onChange }: {
  value: DateRange; today: string; onChange: (r: DateRange) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  const [pickingEnd, setPickingEnd] = useState(false);
  const [hover, setHover] = useState<string | null>(null);
  const [month, setMonth] = useState(value.to.slice(0, 7));
  const ref = useRef<HTMLDivElement>(null);

  const show = () => { setDraft(value); setMonth(value.to.slice(0, 7)); setPickingEnd(false); setOpen(true); };
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [open]);

  const pickPreset = (id: Exclude<PresetId, 'custom'>) => {
    const r = presetRange(id, today);
    setDraft(r);
    setMonth(r.to.slice(0, 7));
    setPickingEnd(false);
  };
  const pickDay = (d: string) => {
    if (!pickingEnd || d < draft.from) {
      setDraft({ from: d, to: d, preset: 'custom' });
      setPickingEnd(true);
    } else {
      setDraft({ ...draft, to: d, preset: 'custom' });
      setPickingEnd(false);
    }
  };
  const typed = (field: 'from' | 'to', v: string) => {
    if (!isISODate(v)) return;
    setDraft({ ...draft, [field]: v, preset: 'custom' });
    setMonth(v.slice(0, 7));
    setPickingEnd(false);
  };
  const apply = () => {
    const [from, to] = draft.from <= draft.to ? [draft.from, draft.to] : [draft.to, draft.from];
    onChange({ ...draft, from, to });
    setOpen(false);
  };

  // While choosing the end day, preview the range up to the hovered day.
  const lo = draft.from;
  const hi = pickingEnd && hover && hover >= draft.from ? hover : draft.to;
  const presetName = PRESETS.find((p) => p.id === value.preset)?.label ?? 'Custom';

  return (
    <div className="drp" ref={ref}>
      <button type="button" className="drp-trigger" aria-expanded={open} aria-haspopup="dialog" onClick={() => (open ? setOpen(false) : show())}>
        <span className="drp-preset">{presetName}</span>
        <span className="drp-dates">{rangeLabel(value)}</span>
        <span className="drp-caret" aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className="drp-panel" role="dialog" aria-label="Choose a date range">
          <ul className="drp-presets">
            {PRESETS.map((p) => (
              <li key={p.id}>
                <button type="button" aria-pressed={draft.preset === p.id} onClick={() => pickPreset(p.id)}>{p.label}</button>
              </li>
            ))}
            <li><button type="button" aria-pressed={draft.preset === 'custom'} onClick={() => setDraft({ ...draft, preset: 'custom' })}>Custom</button></li>
          </ul>
          <div className="drp-main">
            <div className="drp-inputs">
              <label className="field"><span>Start date</span>
                <input type="date" value={draft.from} onChange={(e) => typed('from', e.target.value)} />
              </label>
              <span className="drp-dash" aria-hidden="true">–</span>
              <label className="field"><span>End date</span>
                <input type="date" value={draft.to} onChange={(e) => typed('to', e.target.value)} />
              </label>
            </div>
            <Month month={month} today={today} lo={lo} hi={hi} onPick={pickDay} onHover={setHover} onShift={(by) => setMonth(shiftMonth(month, by))} />
            <p className="hint drp-hint">{pickingEnd ? 'Now pick the end date.' : 'Click a start date, then an end date.'}</p>
            <div className="form-actions">
              <button type="button" onClick={() => setOpen(false)}>Cancel</button>
              <button type="button" className="primary" onClick={apply}>Apply</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Month({ month, today, lo, hi, onPick, onHover, onShift }: {
  month: string; today: string; lo: string; hi: string;
  onPick: (d: string) => void; onHover: (d: string | null) => void; onShift: (by: number) => void;
}) {
  const [y, m] = month.split('-').map(Number);
  const first = `${month}-01`;
  const cells: (string | null)[] = Array(weekday(first)).fill(null);
  for (let d = 1; d <= daysInMonth(y, m); d++) cells.push(`${month}-${String(d).padStart(2, '0')}`);
  const title = new Date(`${first}T00:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', year: 'numeric' });

  return (
    <div className="drp-cal">
      <div className="drp-cal-head">
        <button type="button" className="icon" aria-label="Previous month" onClick={() => onShift(-1)}>‹</button>
        <strong>{title}</strong>
        <button type="button" className="icon" aria-label="Next month" onClick={() => onShift(1)}>›</button>
      </div>
      <div className="drp-grid" onMouseLeave={() => onHover(null)}>
        {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => <span key={i} className="drp-dow">{d}</span>)}
        {cells.map((d, i) =>
          d === null ? <span key={`b${i}`} /> : (
            <button
              type="button"
              key={d}
              className={[
                'drp-day',
                d >= lo && d <= hi ? 'in' : '',
                d === lo ? 'start' : '',
                d === hi ? 'end' : '',
                d === today ? 'today' : '',
              ].join(' ')}
              aria-label={longDate(d)}
              onClick={() => onPick(d)}
              onMouseEnter={() => onHover(d)}
            >
              {Number(d.slice(8))}
            </button>
          ),
        )}
      </div>
    </div>
  );
}
