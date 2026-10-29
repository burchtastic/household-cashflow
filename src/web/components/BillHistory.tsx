import { useLayoutEffect, useRef, useState } from 'react';
import { api, type BillWithStats } from '../api.ts';
import { niceScale } from './BalanceChart.tsx';
import { ErrorNote, useLoad } from './ui.tsx';
import { longDate, money, money0 } from '../format.ts';

const RANGES = [{ months: 6, label: '6 months' }, { months: 12, label: '1 year' }, { months: 24, label: '2 years' }];
const LONGEST = Math.max(...RANGES.map((r) => r.months));

const HEIGHT = 190;
const M = { top: 10, right: 8, bottom: 36, left: 56 };

/** "2026-10" moved n months. */
function shiftMonth(key: string, n: number): string {
  const [y, m] = key.split('-').map(Number);
  const i = y * 12 + m - 1 + n;
  return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`;
}

/** "Oct", or "Oct 2026" with the year. */
const monthName = (key: string, withYear = false) =>
  new Date(`${key}-01T00:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', ...(withYear && { year: 'numeric' }) });

/** A bar from the baseline y0 to y1, rounded only at the data end. */
function barPath(cx: number, w: number, y0: number, y1: number): string {
  const r = Math.min(4, w / 2, Math.abs(y1 - y0));
  const s = y1 < y0 ? 1 : -1;
  const l = cx - w / 2;
  return `M${l},${y0}V${y1 + s * r}Q${l},${y1} ${l + r},${y1}H${l + w - r}Q${l + w},${y1} ${l + w},${y1 + s * r}V${y0}Z`;
}

/** A bill's payments month by month: how much it has actually been, next to what the forecast expects. */
export function BillHistory({ bill, today, onEdit, onClose }: {
  bill: BillWithStats; today: string; onEdit: () => void; onClose: () => void;
}) {
  const [months, setMonths] = useState(6);
  const thisMonth = today.slice(0, 7);
  // Every range comes from one fetch, a month longer than the longest so a bill not yet paid this
  // month still shows a full range of months that have one.
  const txns = useLoad(
    () => api.transactions({ code: bill.code, from: `${shiftMonth(thisMonth, -LONGEST)}-01`, to: today }),
    [bill.code, thisMonth, today],
  );
  const paidWord = bill.direction === 'in' ? 'received' : 'paid';

  if (txns.error) return <ErrorNote error={txns.error} />;
  if (!txns.data) return <p className="empty">Loading…</p>;

  // Money the other way under the same code (a refund on a card, say) counts against the month.
  const signed = (t: { direction: string; amountCents: number }) => (t.direction === bill.direction ? t.amountCents : -t.amountCents);
  const byMonth = new Map<string, { cents: number; count: number }>();
  for (const t of txns.data) {
    const m = byMonth.get(t.date.slice(0, 7)) ?? { cents: 0, count: 0 };
    byMonth.set(t.date.slice(0, 7), { cents: m.cents + signed(t), count: m.count + 1 });
  }
  const end = byMonth.has(thisMonth) ? thisMonth : shiftMonth(thisMonth, -1);
  const bars = Array.from({ length: months }, (_, i) => {
    const key = shiftMonth(end, i - months + 1);
    return { key, ...(byMonth.get(key) ?? { cents: 0, count: 0 }) };
  });
  const payments = txns.data.filter((t) => t.date >= `${bars[0].key}-01`).reverse();
  const paidMonths = bars.filter((b) => b.count > 0);
  const total = paidMonths.reduce((s, b) => s + b.cents, 0);
  const high = paidMonths.reduce<typeof bars[number] | null>((a, b) => (a && a.cents >= b.cents ? a : b), null);
  const low = paidMonths.reduce<typeof bars[number] | null>((a, b) => (a && a.cents <= b.cents ? a : b), null);
  const range = RANGES.find((r) => r.months === months)!;

  return (
    <>
      <div className="choice-row" role="group" aria-label="How far back">
        {RANGES.map((r) => (
          <button key={r.months} type="button" className="choice" aria-pressed={r.months === months} onClick={() => setMonths(r.months)}>
            {r.label}
          </button>
        ))}
      </div>

      {paidMonths.length === 0 ? (
        <p className="empty">
          Nothing {paidWord} in the last {range.label}.
          {bill.stats.lastPaid && ` Last ${paidWord} ${longDate(bill.stats.lastPaid)}.`}
        </p>
      ) : (
        <>
          <div className="tiles bill-stats">
            <div className="tile">
              <div className="label">Average</div>
              <div className="value">{money(Math.round(total / paidMonths.length))}</div>
              <div className="sub">a month</div>
            </div>
            <div className="tile">
              <div className="label">Highest</div>
              <div className="value">{money(high!.cents)}</div>
              <div className="sub">{monthName(high!.key, true)}</div>
            </div>
            <div className="tile">
              <div className="label">Lowest</div>
              <div className="value">{money(low!.cents)}</div>
              <div className="sub">{monthName(low!.key, true)}</div>
            </div>
            <div className="tile">
              <div className="label">Total</div>
              <div className="value">{money(total)}</div>
              <div className="sub">{payments.length} {payments.length === 1 ? 'payment' : 'payments'}</div>
            </div>
          </div>

          {/* The estimate is for one payment, so it only lines up with a month's total on a monthly bill. */}
          <MonthBars
            bars={bars} thisMonth={thisMonth} paidWord={paidWord}
            estimateCents={bill.active && bill.schedule.kind === 'monthly' ? bill.stats.estimateCents : 0}
          />

          <h3 className="bill-payments-head">{bill.direction === 'in' ? 'Received' : 'Payments'}</h3>
          <table className="bill-payments">
            <tbody>
              {payments.map((t) => (
                <tr key={t.id}>
                  <td>
                    {longDate(t.date)}
                    {t.note && <div className="note small">{t.note}</div>}
                  </td>
                  <td className="num">{money(signed(t))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <div className="form-actions">
        <button type="button" onClick={onEdit}>Edit bill</button>
        <button type="button" className="primary" onClick={onClose}>Done</button>
      </div>
    </>
  );
}

function MonthBars({ bars, thisMonth, estimateCents, paidWord }: {
  bars: { key: string; cents: number; count: number }[]; thisMonth: string; estimateCents: number; paidWord: string;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(520);
  const [hover, setHover] = useState<number | null>(null);

  // Measure before first paint so text is never drawn at a scaled-down size.
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    setWidth(Math.max(260, el.clientWidth));
    const ro = new ResizeObserver(([entry]) => setWidth(Math.max(260, entry.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const plotW = width - M.left - M.right;
  const plotH = HEIGHT - M.top - M.bottom;
  const slot = plotW / bars.length;
  const barW = Math.min(24, slot * 0.66);
  const cx = (i: number) => M.left + slot * (i + 0.5);
  const values = bars.map((b) => b.cents);
  const [yMin, yMax, ticks] = niceScale(Math.min(0, ...values), Math.max(1, ...values, estimateCents));
  const y = (c: number) => M.top + (1 - (c - yMin) / (yMax - yMin)) * plotH;
  // Month names on as many bars as they fit under, on calendar steps (every other month, quarters…).
  const step = [1, 2, 3, 6].find((s) => slot * s >= 30) ?? 12;
  const labelled = bars.map((b) => (Number(b.key.slice(5)) - 1) % step === 0);
  const firstLabelled = labelled.indexOf(true);

  const onMove = (ev: React.PointerEvent<SVGSVGElement>) => {
    const rect = ev.currentTarget.getBoundingClientRect();
    const px = ((ev.clientX - rect.left) / rect.width) * width;
    setHover(Math.min(bars.length - 1, Math.max(0, Math.floor((px - M.left) / slot))));
  };
  const h = hover !== null ? bars[hover] : null;
  const hx = hover !== null ? cx(hover) : 0;

  return (
    <div className={`chart bill-chart${h ? ' hovering' : ''}`} ref={wrapRef}>
      <svg
        viewBox={`0 0 ${width} ${HEIGHT}`}
        role="img"
        aria-label={
          `Totals by month: ${bars.map((b) => `${monthName(b.key, true)} ${money(b.cents)}`).join(', ')}.` +
          (estimateCents > 0 ? ` The forecast expects ${money(estimateCents)}.` : '')
        }
        onPointerMove={onMove}
        onPointerDown={onMove}
        onPointerLeave={() => setHover(null)}
      >
        <g className="grid">
          {ticks.map((t) => <line key={t} x1={M.left} x2={width - M.right} y1={y(t)} y2={y(t)} />)}
        </g>
        <g className="axis">
          {ticks.map((t) => (
            <text key={t} x={M.left - 8} y={y(t)} dy="0.32em" textAnchor="end">{money0(t)}</text>
          ))}
          {bars.map((b, i) => labelled[i] && (
            <text key={b.key} x={cx(i)} y={HEIGHT - 20} textAnchor="middle">{monthName(b.key)}</text>
          ))}
          {bars.map((b, i) => labelled[i] && (i === firstLabelled || b.key.endsWith('-01')) && (
            <text key={b.key} className="year" x={cx(i)} y={HEIGHT - 6} textAnchor="middle">{b.key.slice(0, 4)}</text>
          ))}
        </g>
        {bars.map((b, i) => b.cents !== 0 && (
          <path key={b.key} className={`bar${i === hover ? ' on' : ''}`} d={barPath(cx(i), barW, y(0), y(b.cents))} />
        ))}
        {estimateCents > 0 && <line className="estimate-line" x1={M.left} x2={width - M.right} y1={y(estimateCents)} y2={y(estimateCents)} />}
        {/* Hit area spanning the whole plot. */}
        <rect x={M.left} y={M.top} width={plotW} height={plotH} fill="transparent" />
      </svg>
      {estimateCents > 0 && (
        <div className="chart-key">
          <svg viewBox="0 0 16 10" aria-hidden="true"><path className="estimate-line" d="M3,5H13" /></svg>
          The forecast expects {money(estimateCents)}
        </div>
      )}

      {h && (
        <div
          className="tooltip"
          style={{
            left: `${(hx / width) * 100}%`,
            top: 0,
            transform: hx / width > 0.6 ? 'translateX(calc(-100% - 12px))' : 'translateX(12px)',
          }}
        >
          <div className="t-head">
            <span>{monthName(h.key, true)}{h.key === thisMonth && ' so far'}</span>
            <span className="num">{money(h.cents)}</span>
          </div>
          <div className="faint small">
            {h.count === 0 ? `Nothing ${paidWord}` : h.count === 1 ? '1 payment' : `${h.count} payments, added together`}
          </div>
        </div>
      )}
    </div>
  );
}
