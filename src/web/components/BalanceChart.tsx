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

  // Each day's step is drawn in two parts: solid for the amounts you know, then dotted for the
  // estimates, so a guessed bill doesn't look as certain as one you've entered.
  const guessOn = (d: string) => (eventsByDate.get(d) ?? [])
    .filter((e) => e.status === 'estimated')
    .reduce((s, e) => s + (e.direction === 'in' ? e.amountCents : -e.amountCents), 0);
  const stepPaths = (pts: typeof points) => {
    let solid = '';
    let dotted = '';
    pts.forEach((p, i) => {
      const px = x(p.date);
      if (i === 0) { solid = `M${px},${y(p.balanceCents)}`; return; }
      const guess = guessOn(p.date);
      solid += `H${px}V${y(p.balanceCents - guess)}`;
      if (guess !== 0) {
        dotted += `M${px},${y(p.balanceCents - guess)}V${y(p.balanceCents)}`;
        solid += `M${px},${y(p.balanceCents)}`;
      }
    });
    return { solid, dotted };
  };
  const todayIdx = points.findIndex((p) => p.date >= today);
  const past = todayIdx > 0 ? stepPaths(points.slice(0, todayIdx + 1)) : null;
  const future = stepPaths(todayIdx >= 0 ? points.slice(Math.max(0, todayIdx)) : points);

  // The 1st and 15th of each month, and the first day too unless it would crowd the next one.
  const marks = points.filter((p) => p.date.endsWith('-01') || p.date.endsWith('-15'));
  const xTicks = marks.length && x(marks[0].date) - x(points[0].date) < 44 ? marks : [points[0], ...marks];

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

  // The low is meant to sit just above the floor, so their labels often land on each other. Try
  // the floor label at the right end of its line, then under it, then at the left end, and the low
  // label under its dot, then over it, and keep the first pair that stay clear of each other.
  const bottom = top + plotH;
  const fy = y(floorCents);
  const floorText = `Floor ${money0(floorCents)}`;
  const floorSpots: ChartLabel[] = [
    { x: width - M.right, y: fy - 5, anchor: 'end', text: floorText },
    ...(fy + 14 <= bottom ? [{ x: width - M.right, y: fy + 14, anchor: 'end', text: floorText } as const] : []),
    { x: M.left + 4, y: fy - 5, anchor: 'start', text: floorText },
    ...(fy + 14 <= bottom ? [{ x: M.left + 4, y: fy + 14, anchor: 'start', text: floorText } as const] : []),
  ];
  const zeroLabel: ChartLabel | null = negative
    ? { x: width - M.right - 4, y: y(0) + (bottom - y(0) > 18 ? 14 : -5), anchor: 'end', text: 'Overdrawn below $0' }
    : null;
  const lx = x(lowest.date);
  const ly = y(lowest.balanceCents);
  const lowText = `Low ${money0(lowest.balanceCents)}`;
  const lowAnchor = lx > width - 120 ? 'end' : 'middle';
  const lowSpots: ChartLabel[] = [
    ...(ly <= bottom - 20 ? [{ x: lx, y: ly + 18, anchor: lowAnchor, text: lowText } as const] : []),
    { x: lx, y: ly - 12, anchor: lowAnchor, text: lowText },
  ];
  const clear = (a: ChartLabel, b: ChartLabel | null) => !b || !labelsTouch(a, b);
  const pairs = floorSpots.flatMap((f) => (showLowLabel ? lowSpots : [null]).map((l) => [f, l] as const));
  const [floorLabel, lowLabel] = pairs.find(([f, l]) => clear(f, zeroLabel) && (!l || (clear(l, f) && clear(l, zeroLabel))))
    ?? pairs[0];

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
          </>
        )}
        <line className="floor-line" x1={M.left} x2={width - M.right} y1={fy} y2={fy} />

        {todayIdx >= 0 && (
          <>
            <line className="today-line" x1={x(today)} x2={x(today)} y1={top} y2={top + plotH} />
            <text className="today-label" x={x(today) + 4} y={draws.length ? top + 12 : top - 6}>Today</text>
          </>
        )}

        {past && (
          <>
            <path className="series past" d={past.solid} />
            <path className="series past guess" d={past.dotted} />
          </>
        )}
        <path className="series" d={future.solid} />
        <path className="series guess" d={future.dotted} />
        {/* The same line again in red wherever it is below $0. */}
        {negative && (
          <>
            <path className="series below-zero" d={future.solid} clipPath={`url(#${clipId})`} />
            <path className="series below-zero guess" d={future.dotted} clipPath={`url(#${clipId})`} />
          </>
        )}

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

        {/* Labels go over the line so it never runs through their text. */}
        {zeroLabel && <LabelText className="zero-label" label={zeroLabel} />}
        <LabelText className="floor-label" label={floorLabel} />
        {lowLabel && (
          <g>
            <circle className="marker low" cx={lx} cy={ly} r={5} />
            <LabelText className="floor-label" label={lowLabel} />
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
      {future.dotted && (
        <div className="chart-key">
          <svg viewBox="0 0 10 16" aria-hidden="true"><path className="series guess" d="M5,3V13" /></svg>
          Dotted steps are estimates
        </div>
      )}

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
                <li key={e.key} className={[isDraw(e) && 'draw', e.status === 'estimated' && 'guess'].filter(Boolean).join(' ') || undefined}>
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

interface ChartLabel { x: number; y: number; anchor: 'start' | 'middle' | 'end'; text: string }

function LabelText({ className, label }: { className: string; label: ChartLabel }) {
  return <text className={`${className} halo`} x={label.x} y={label.y} textAnchor={label.anchor}>{label.text}</text>;
}

/** Whether two 11px labels would touch, from a generous guess at their size (y is the baseline). */
function labelsTouch(a: ChartLabel, b: ChartLabel): boolean {
  const box = (l: ChartLabel) => {
    const w = l.text.length * 6.8;
    const left = l.anchor === 'start' ? l.x : l.anchor === 'end' ? l.x - w : l.x - w / 2;
    return { left, right: left + w, top: l.y - 10, bottom: l.y + 3 };
  };
  const p = box(a);
  const q = box(b);
  return p.left < q.right + 6 && q.left < p.right + 6 && p.top < q.bottom + 2 && q.top < p.bottom + 2;
}

/** Round the domain out to tidy steps and return the tick values. */
export function niceScale(min: number, max: number): [number, number, number[]] {
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
