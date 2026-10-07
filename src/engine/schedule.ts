import { addDays, daysInMonth, diffDays, monthKey, type ISODate } from './dates.ts';
import type { Bill } from './types.ts';

export interface Occurrence {
  code: string;
  dueDate: ISODate;
  /** Stable key for overrides: "YYYY-MM" (monthly) or the due date (interval). */
  period: string;
}

/** Every scheduled occurrence of `bill` with from <= dueDate <= to. */
export function occurrences(bill: Bill, from: ISODate, to: ISODate): Occurrence[] {
  const s = bill.schedule;
  const out: Occurrence[] = [];

  if (s.kind === 'monthly') {
    let y = Number(from.slice(0, 4));
    let m = Number(from.slice(5, 7));
    for (;;) {
      const day = Math.min(s.day, daysInMonth(y, m));
      const due = `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      if (due > to) break;
      if (due >= from) out.push({ code: bill.code, dueDate: due, period: monthKey(due) });
      if (++m > 12) { m = 1; y++; }
    }
  } else if (s.kind === 'interval') {
    if (s.everyDays < 1) return out;
    const k0 = Math.ceil(diffDays(from, s.anchor) / s.everyDays);
    for (let k = k0; ; k++) {
      const due = addDays(s.anchor, k * s.everyDays);
      if (due > to) break;
      out.push({ code: bill.code, dueDate: due, period: due });
    }
  }
  return out;
}

/** How far a real payment may land from its due date and still count as that occurrence. */
export function matchSlackDays(bill: Bill): number {
  const s = bill.schedule;
  if (s.kind === 'interval') return Math.max(1, Math.floor(s.everyDays / 2) - 1);
  return 15;
}

/** The occurrence a real date belongs to: the nearest within matchSlackDays, or null. */
export function nearestOccurrence(bill: Bill, date: ISODate): Occurrence | null {
  const slack = matchSlackDays(bill);
  let best: Occurrence | null = null;
  for (const o of occurrences(bill, addDays(date, -slack), addDays(date, slack))) {
    if (!best || Math.abs(diffDays(o.dueDate, date)) < Math.abs(diffDays(best.dueDate, date))) best = o;
  }
  return best;
}
