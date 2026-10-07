import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { toDayNumber } from '../../engine/dates.ts';
import type { LedgerEvent } from '../../engine/index.ts';
import { dayMonth, money, money0, shortDate } from '../format.ts';

interface Props {
  daily: { date: string; balanceCents: number }[];
  events: LedgerEvent[];
  today: string;
  floorCents: number;
  lowest: { date: string; balanceCents: number };
  /** How many days before today to show. */
  pastDays?: number;
  /** Codes of transfers in from savings; these get marked on the chart. */
  drawCodes?: string[];
}

const HEIGHT = 280;
const M = { top: 20, right: 16, bottom: 28, left: 64 };
/** Room above the plot for each row of savings-transfer labels. */
const DRAW_ROW = 20;

export function BalanceChart({ daily, events, today, floorCents, lowest, pastDays = 14, drawCodes = [] }: Props) {
  const clipId = useId();
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  const [hover, setHover] = useState<number | null>(null);

  // Measure before first paint so text is never drawn at a scaled-down size.
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    setWidth(Math.max(320, el.clientWidth));
    const ro = new ResizeObserver(([entry]) => setWidth(Math.max(320, entry.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const todayN = toDayNumber(today);
  const points = useMemo(
    () => daily.filter((p) => toDayNumber(p.date) >= todayN - pastDays),
    [daily, todayN, pastDays],
  );
  const eventsByDate = useMemo(() => {
    const m = new Map<string, LedgerEvent[]>();
    for (const e of events) m.set(e.date, [...(m.get(e.date) ?? []), e]);
    return m;
  }, [events]);

  if (points.length < 2) return <p className="empty">Not enough data to chart yet.</p>;

  const x0 = toDayNumber(points[0].date);
  const x1 = toDayNumber(points[points.length - 1].date);
  const plotW = width - M.left - M.right;

  // Transfers in from savings, labelled above the plot; labels that would touch drop to another row.
  const isDraw = (e: LedgerEvent) => e.direction === 'in' && drawCodes.includes(e.code);
  const xOf = (d: string) => M.left + ((toDayNumber(d) - x0) / Math.max(1, x1 - x0)) * plotW;
  const draws: { date: string; cents: number; row: number; label: string; lx: number; w: number }[] = [];
  const rowEnds: number[] = [];
  for (const p of points) {
    const cents = (eventsByDate.get(p.date) ?? []).filter(isDraw).reduce((s, e) => s + e.amountCents, 0);
    if (cents === 0) continue;
    const label = `↑ ${money0(cents)} from savings`;
    const w = label.length * 6.8 + 14;
    // Centred on the day, but kept inside the chart.
    const lx = Math.min(Math.max(xOf(p.date), M.left + w / 2), width - M.right - w / 2);
    let row = rowEnds.findIndex((end) => lx - w / 2 > end + 6);
    if (row === -1) { row = rowEnds.length; rowEnds.push(0); }
    rowEnds[row] = lx + w / 2;
    draws.push({ date: p.date, cents, row, label, lx, w });
  }
  const top = M.top + rowEnds.length * DRAW_ROW;
  const plotH = HEIGHT - top - M.bottom;

  const values = points.map((p) => p.balanceCents);
  const [yMin, yMax, ticks] = niceScale(Math.min(...values, floorCents, 0), Math.max(...values, floorCents));
  const x = xOf;
  const y = (c: number) => top + (1 - (c - yMin) / (yMax - yMin)) * plotH;
  const negative = yMin < 0;

  const stepPath = (pts: typeof points) =>
    pts.map((p, i) => (i === 0 ? `M${x(p.date)},${y(p.balanceCents)}` : `H${x(p.date)}V${y(p.balanceCents)}`)).join('');
  const todayIdx = points.findIndex((p) => p.date >= today);
  const past = todayIdx > 0 ? points.slice(0, todayIdx + 1) : [];
  const future = todayIdx >= 0 ? points.slice(Math.max(0, todayIdx)) : points;

  const xTicks = points.filter((p, i) => i === 0 || p.date.endsWith('-01') || p.date.endsWith('-15'));

  const onMove = (ev: React.PointerEvent<SVGSVGElement>) => {
    const rect = ev.currentTarget.getBoundingClientRect();
    const px = ((ev.clientX - rect.left) / rect.width) * width;
    const day = Math.round(x0 + ((px - M.left) / plotW) * (x1 - x0));
    const idx = Math.min(points.length - 1, Math.max(0, day - x0));
    setHover(idx);
  };

  const h = hover !== null ? points[hover] : null;
  const hoverEvents = h ? eventsByDate.get(h.date) ?? [] : [];
  const showLowLabel = toDayNumber(lowest.date) >= x0;
  const firstNegative = points.find((p) => p.date >= today && p.balanceCents < 0);

  return (
    <div className="chart" ref={wrapRef}>
      <svg
        viewBox={`0 0 ${width} ${HEIGHT}`}
        role="img"
        aria-label={
          `Projected checking balance. Lowest point ${money(lowest.balanceCents)} on ${shortDate(lowest.date)}; floor ${money(floorCents)}.` +
          (firstNegative ? ` Goes below zero on ${shortDate(firstNegative.date)}.` : '') +
          draws.map((d) => ` Transfer of ${money0(d.cents)} from savings on ${shortDate(d.date)}.`).join('')
        }
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
      >
        <g className="grid">
          {ticks.map((t) => <line key={t} x1={M.left} x2={width - M.right} y1={y(t)} y2={y(t)} />)}
        </g>
        <g className="axis">
          {ticks.map((t) => (
            <text key={t} x={M.left - 8} y={y(t)} dy="0.32em" textAnchor="end">{money0(t)}</text>
          ))}
          {xTicks.map((p) => (
            <text key={p.date} x={x(p.date)} y={HEIGHT - 8} textAnchor="middle">{dayMonth(p.date)}</text>
          ))}
        </g>

        <defs>
          <clipPath id={clipId}>
            <rect x={M.left - 4} width={plotW + 8} y={y(0)} height={Math.max(0, top + plotH - y(0) + 4)} />
          </clipPath>
        </defs>

        <rect className="floor-zone" x={M.left} width={plotW} y={y(floorCents)} height={Math.max(0, top + plotH - y(floorCents))} />
        {negative && (
          <>
            <rect className="negative-zone" x={M.left} width={plotW} y={y(0)} height={top + plotH - y(0)} />
            <line className="zero-line" x1={M.left} x2={width - M.right} y1={y(0)} y2={y(0)} />
            <text className="zero-label" x={width - M.right - 4} y={y(0) + (top + plotH - y(0) > 18 ? 14 : -5)} textAnchor="end">
              Overdrawn below $0
            </text>
          </>
        )}
        <line className="floor-line" x1={M.left} x2={width - M.right} y1={y(floorCents)} y2={y(floorCents)} />
        <text className="floor-label" x={width - M.right} y={y(floorCents) - 5} textAnchor="end">
          Floor {money0(floorCents)}
        </text>

        {todayIdx >= 0 && (
          <>
            <line className="today-line" x1={x(today)} x2={x(today)} y1={top} y2={top + plotH} />
            <text className="today-label" x={x(today) + 4} y={draws.length ? top + 12 : top - 6}>Today</text>
          </>
        )}

        {past.length > 1 && <path className="series past" d={stepPath(past)} />}
        <path className="series" d={stepPath(future)} />
        {/* The same line again in red wherever it is below $0. */}
        {negative && <path className="series below-zero" d={stepPath(future)} clipPath={`url(#${clipId})`} />}

        {draws.map((d) => {
          const cx = x(d.date);
          const ly = M.top + d.row * DRAW_ROW;
          const bal = points.find((p) => p.date === d.date)!.balanceCents;
          return (
            <g key={d.date} className="draw">
              <line className="draw-line" x1={cx} x2={cx} y1={ly + 9} y2={top + plotH} />
              <rect className="draw-pill" x={d.lx - d.w / 2} y={ly - 8} width={d.w} height={17} rx={8.5} />
              <text className="draw-label" x={d.lx} y={ly} dy="0.35em" textAnchor="middle">{d.label}</text>
              <circle className="marker draw-dot" cx={cx} cy={y(bal)} r={5} />
            </g>
          );
        })}

        {showLowLabel && (
          <g>
            <circle className="marker low" cx={x(lowest.date)} cy={y(lowest.balanceCents)} r={5} />
            <text
              className="floor-label"
              x={x(lowest.date)}
              y={y(lowest.balanceCents) + (y(lowest.balanceCents) > top + plotH - 20 ? -12 : 18)}
              textAnchor={x(lowest.date) > width - 120 ? 'end' : 'middle'}
            >
              Low {money0(lowest.balanceCents)}
            </text>
          </g>
        )}

        {h && (
          <g>
            <line className="crosshair" x1={x(h.date)} x2={x(h.date)} y1={top} y2={top + plotH} />
            <circle className="marker" cx={x(h.date)} cy={y(h.balanceCents)} r={4.5} />
          </g>
        )}
        {/* Hit area spanning the whole plot. */}
        <rect x={M.left} y={top} width={plotW} height={plotH} fill="transparent" />
      </svg>

      {h && (
        <div
          className="tooltip"
          style={{
            left: `${Math.min((x(h.date) / width) * 100, 70)}%`,
            top: 8,
            transform: x(h.date) / width > 0.7 ? 'translateX(-20%)' : 'translateX(12px)',
          }}
        >
          <div className="t-head">
            <span>{shortDate(h.date)}</span>
            <span className={`num${h.balanceCents < 0 ? ' negative' : ''}`}>{money(h.balanceCents)}</span>
          </div>
          {hoverEvents.length > 0 ? (
            <ul>
              {hoverEvents.map((e) => (
                <li key={e.key} className={isDraw(e) ? 'draw' : undefined}>
                  <span>{e.name}</span>
                  <span className="num">{e.direction === 'in' ? '+' : '−'}{money(e.amountCents)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <div className="faint small">No activity</div>
          )}
        </div>
      )}
    </div>
  );
}

/** Round the domain out to tidy steps and return the tick values. */
function niceScale(min: number, max: number): [number, number, number[]] {
  const span = Math.max(1, max - min);
  const rough = span / 5;
  const pow = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= rough)!;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let t = lo; t <= hi + step / 2; t += step) ticks.push(Math.round(t));
  return [lo, hi, ticks];
}
