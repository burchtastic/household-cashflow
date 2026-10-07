import { addDays, type ISODate } from './dates.ts';
import type { Bill, Cents, Settings, Transaction } from './types.ts';

export interface EstimateStats {
  estimateCents: Cents;
  averageCents: Cents | null;
  worstCents: Cents | null;
  sampleSize: number;
  lastPaid: ISODate | null;
}

/**
 * Expected amount for a bill, mirroring the spreadsheet:
 *   fixed → amountCents
 *   auto  → average (or worst) of that code's payments in the lookback window,
 *           never below minCents; amountCents when there is no history.
 */
export function estimateBill(
  bill: Bill,
  transactions: readonly Transaction[],
  today: ISODate,
  settings: Settings,
): EstimateStats {
  const from = addDays(today, -settings.lookbackDays);
  const amounts: Cents[] = [];
  let lastPaid: ISODate | null = null;
  for (const t of transactions) {
    if (t.code !== bill.code || t.plannedId !== null) continue;
    if (t.date <= today && (lastPaid === null || t.date > lastPaid)) lastPaid = t.date;
    if (t.date >= from && t.date <= today) amounts.push(t.amountCents);
  }

  const averageCents = amounts.length
    ? Math.round(amounts.reduce((a, b) => a + b, 0) / amounts.length)
    : null;
  const worstCents = amounts.length ? Math.max(...amounts) : null;

  let estimateCents: Cents;
  if (bill.amountMode === 'fixed' || averageCents === null) {
    estimateCents = bill.amountCents;
  } else {
    const stat = settings.estimateMode === 'worst' ? worstCents! : averageCents;
    estimateCents = Math.max(stat, bill.minCents ?? 0);
  }

  return { estimateCents, averageCents, worstCents, sampleSize: amounts.length, lastPaid };
}
