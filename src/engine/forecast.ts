import { addDays, AVG_DAYS_PER_MONTH, diffDays, type ISODate } from './dates.ts';
import { estimateBill, type EstimateStats } from './estimate.ts';
import { matchSlackDays, occurrences, type Occurrence } from './schedule.ts';
import type {
  Bill, Cents, LedgerEvent, OccurrenceNote, Override, PlannedItem, Settings, Snapshot, Transaction,
} from './types.ts';

export interface ForecastInput {
  today: ISODate;
  settings: Settings;
  bills: readonly Bill[];
  transactions: readonly Transaction[];
  overrides: readonly Override[];
  notes?: readonly OccurrenceNote[];
  planned: readonly PlannedItem[];
  /** The forecast starts from the latest checking balance. Events on or before its date are assumed to be in it. */
  checking: Snapshot;
  savings: Snapshot | null;
  /** Override the horizon end (defaults to today + settings.horizonDays). */
  horizonEnd?: ISODate;
  /**
   * Charges already on a card that its bill's next statement will include. That bill's next
   * unpaid payment is never estimated below this.
   */
  cardFloors?: readonly { code: string; amountCents: Cents }[];
}

export interface TopUp {
  /** Money must be in checking by the start of this day. */
  by: ISODate;
  amountCents: Cents;
}

export interface SavingsOutlook {
  snapshot: Snapshot;
  /** Snapshot minus draws posted after it. */
  balanceTodayCents: Cents;
  floorCents: Cents;
  trailing90DrawsCents: Cents;
  /** Average monthly shortfall of the forward schedule, ignoring savings draws. ≤ 0 means no shortfall. */
  monthlyShortfallCents: Cents;
  /** Months until savings reaches its floor at that shortfall; null when there is no shortfall. */
  runwayMonths: number | null;
  floorDate: ISODate | null;
}

export interface PlannedDraw {
  plannedId: number;
  code: string;
  date: ISODate;
  amountCents: Cents;
  /** How much smaller this draw could be while checking still clears the floor through the horizon. */
  canTrimCents: Cents;
}

export interface Forecast {
  today: ISODate;
  horizonEnd: ISODate;
  start: { date: ISODate; balanceCents: Cents };
  events: LedgerEvent[];
  /** End-of-day checking balance for every day from start to horizonEnd. */
  daily: { date: ISODate; balanceCents: Cents }[];
  todayBalanceCents: Cents;
  /** Lowest end-of-day balance from today through the horizon. */
  lowest: { date: ISODate; balanceCents: Cents };
  /** How much could leave checking today and still never breach the floor. */
  safeToSweepCents: Cents;
  /** Transfers into checking that keep every day at or above the floor, each covering about two weeks. */
  topUps: TopUp[];
  /** Upcoming outflows that are still guesses. */
  estimatedOutflowCents: Cents;
  /** Events between the balance snapshot and today that haven't been confirmed. */
  unconfirmed: LedgerEvent[];
  nextPaycheck: { date: ISODate; amountCents: Cents } | null;
  /** The next planned transfer in from savings, if any. */
  nextDraw: PlannedDraw | null;
  estimates: Record<string, EstimateStats>;
  savings: SavingsOutlook | null;
}

const LOOKBEHIND_DAYS = 45;
const TOP_UP_COVER_DAYS = 14;

export function forecast(input: ForecastInput): Forecast {
  const { today, settings, checking } = input;
  const start = checking.date;
  const horizonEnd = input.horizonEnd ?? addDays(today, settings.horizonDays);
  const billByCode = new Map(input.bills.map((b) => [b.code, b]));
  const overrideByKey = new Map(input.overrides.map((o) => [`${o.code}|${o.period}`, o.amountCents]));
  const noteByKey = new Map((input.notes ?? []).map((n) => [`${n.code}|${n.period}`, n.note]));

  const estimates: Record<string, EstimateStats> = {};
  for (const b of input.bills) estimates[b.code] = estimateBill(b, input.transactions, today, settings);

  // 1. Scheduled occurrences around the window, each matched to at most one real payment.
  const occs: { occ: Occurrence; bill: Bill }[] = [];
  for (const bill of input.bills) {
    if (!bill.active) continue;
    for (const occ of occurrences(bill, addDays(start, -LOOKBEHIND_DAYS), horizonEnd)) {
      occs.push({ occ, bill });
    }
  }
  const matchable = input.transactions.filter(
    (t) => t.plannedId === null && t.date >= addDays(start, -2 * LOOKBEHIND_DAYS),
  );
  const matched = matchOccurrences(occs, matchable);
  const matchedTxnIds = new Set([...matched.values()].map((t) => t.id));

  // 2. Build the events that move the balance after the snapshot.
  const events: Omit<LedgerEvent, 'balanceCents'>[] = [];
  const floors = new Map((input.cardFloors ?? []).map((f) => [f.code, f.amountCents]));
  // Occurrences come out of each bill in date order, so the first one left is the next payment.
  occs.sort((a, b) => a.occ.dueDate.localeCompare(b.occ.dueDate));
  for (const { occ, bill } of occs) {
    const txn = matched.get(occKey(occ));
    const estimateCents = estimates[bill.code].estimateCents;
    const base = {
      key: `occ:${bill.code}:${occ.period}`,
      code: bill.code,
      name: bill.name,
      category: bill.category,
      direction: bill.direction,
      estimateCents,
      dueDate: occ.dueDate,
      period: occ.period,
      plannedId: null,
    };
    if (txn) {
      if (txn.date <= start) continue;
      events.push({ ...base, date: txn.date, amountCents: txn.amountCents, status: 'posted', note: txn.note, transactionId: txn.id });
      continue;
    }
    if (occ.dueDate <= start) continue;
    const known = overrideByKey.get(`${bill.code}|${occ.period}`);
    // The next payment still to come can't be less than what's already been charged.
    const floor = known === undefined && occ.dueDate >= today ? floors.get(bill.code) : undefined;
    if (floor !== undefined) floors.delete(bill.code);
    const raised = floor !== undefined && floor > estimateCents;
    events.push({
      ...base,
      date: occ.dueDate,
      amountCents: known ?? (raised ? floor : estimateCents),
      raisedFromCents: raised ? estimateCents : null,
      note: noteByKey.get(`${bill.code}|${occ.period}`) ?? '',
      status: known !== undefined ? 'known' : bill.amountMode === 'auto' ? 'estimated' : 'scheduled',
      transactionId: null,
    });
  }

  for (const t of input.transactions) {
    if (matchedTxnIds.has(t.id) || t.date <= start || t.date > horizonEnd) continue;
    const bill = billByCode.get(t.code);
    events.push({
      key: `txn:${t.id}`,
      date: t.date,
      code: t.code,
      name: t.description,
      category: bill?.category ?? 'Uncategorized',
      direction: t.direction,
      amountCents: t.amountCents,
      status: 'posted',
      note: t.note,
      estimateCents: null,
      dueDate: null,
      period: null,
      plannedId: t.plannedId,
      transactionId: t.id,
    });
  }

  for (const p of input.planned) {
    if (p.status !== 'planned' || p.date <= start || p.date > horizonEnd) continue;
    const bill = billByCode.get(p.code);
    events.push({
      key: `plan:${p.id}`,
      date: p.date,
      code: p.code,
      name: p.description,
      category: bill?.category ?? 'Uncategorized',
      direction: p.direction,
      amountCents: p.amountCents,
      status: 'planned',
      note: p.note,
      estimateCents: null,
      dueDate: null,
      period: null,
      plannedId: p.id,
      transactionId: null,
    });
  }

  // 3. Order within a day: money in first, then the bill table's order.
  const sortOf = (code: string) => billByCode.get(code)?.sort ?? Number.MAX_SAFE_INTEGER;
  events.sort((a, b) =>
    a.date.localeCompare(b.date) ||
    (a.direction === b.direction ? 0 : a.direction === 'in' ? -1 : 1) ||
    sortOf(a.code) - sortOf(b.code) ||
    a.key.localeCompare(b.key),
  );

  let running = checking.amountCents;
  const ledger: LedgerEvent[] = events.map((e) => {
    running += e.direction === 'in' ? e.amountCents : -e.amountCents;
    return { ...e, balanceCents: running };
  });

  // 4. Daily end-of-day series.
  const daily: { date: ISODate; balanceCents: Cents }[] = [];
  let bal = checking.amountCents;
  let i = 0;
  for (let d = start; d <= horizonEnd; d = addDays(d, 1)) {
    while (i < ledger.length && ledger[i].date <= d) bal = ledger[i++].balanceCents;
    daily.push({ date: d, balanceCents: bal });
  }

  const todayBalanceCents = balanceOn(daily, today, checking.amountCents);
  const forward = daily.filter((p) => p.date > today);
  let lowest = { date: today, balanceCents: todayBalanceCents };
  for (const p of forward) if (p.balanceCents < lowest.balanceCents) lowest = p;

  const floor = settings.bufferFloorCents;
  const safeToSweepCents = Math.max(0, lowest.balanceCents - floor);

  // At each breach, move enough to cover the low point of the following
  // TOP_UP_COVER_DAYS, so transfers come in pay-cycle-sized chunks rather than daily slivers.
  const topUps: TopUp[] = [];
  const path = [{ date: today, balanceCents: todayBalanceCents }, ...forward];
  let added = 0;
  for (let j = 0; j < path.length; j++) {
    if (path[j].balanceCents + added >= floor) continue;
    const coverUntil = addDays(path[j].date, TOP_UP_COVER_DAYS - 1);
    let low = path[j].balanceCents;
    for (let k = j; k < path.length && path[k].date <= coverUntil; k++) low = Math.min(low, path[k].balanceCents);
    const amountCents = roundUp(floor - (low + added), settings.topUpRoundingCents);
    topUps.push({ by: path[j].date, amountCents });
    added += amountCents;
  }

  const estimatedOutflowCents = ledger
    .filter((e) => e.date > today && e.direction === 'out' && e.status === 'estimated')
    .reduce((s, e) => s + e.amountCents, 0);

  const unconfirmed = ledger.filter((e) => e.date <= today && e.status !== 'posted');

  const drawCodes = new Set(settings.savingsDrawCodes);
  const draw = ledger.find((e) => e.status === 'planned' && e.direction === 'in' && drawCodes.has(e.code) && e.date >= today);
  let nextDraw: PlannedDraw | null = null;
  if (draw) {
    // Shrinking the draw lowers every balance from its date on by the same amount.
    let low = Infinity;
    for (const p of daily) if (p.date >= draw.date) low = Math.min(low, p.balanceCents);
    const slack = Math.min(draw.amountCents, Math.max(0, low - floor));
    nextDraw = {
      plannedId: draw.plannedId!, code: draw.code, date: draw.date, amountCents: draw.amountCents,
      canTrimCents: roundDown(slack, settings.topUpRoundingCents),
    };
  }

  const pay = ledger.find((e) => e.code === 'PAY' && e.date > today);
  const nextPaycheck = pay ? { date: pay.date, amountCents: pay.amountCents } : null;

  return {
    today,
    horizonEnd,
    start: { date: start, balanceCents: checking.amountCents },
    events: ledger,
    daily,
    todayBalanceCents,
    lowest,
    safeToSweepCents,
    topUps,
    estimatedOutflowCents,
    unconfirmed,
    nextPaycheck,
    nextDraw,
    estimates,
    savings: input.savings ? savingsOutlook(input, ledger, today, horizonEnd) : null,
  };
}

/**
 * Why a gap between the bank's balance and the ledger's (bank − ledger) is worth flagging, or
 * null if it isn't. 'floor': the bank has less, and that takes the low point under the floor
 * when the ledger's figure doesn't, however small. 'size': at least the threshold either way.
 */
export function flagBankGap({ gapCents, thresholdCents, lowCents, floorCents }: {
  gapCents: Cents; thresholdCents: Cents; lowCents: Cents; floorCents: Cents;
}): 'floor' | 'size' | null {
  if (gapCents === 0) return null;
  if (lowCents >= floorCents && lowCents + gapCents < floorCents) return 'floor';
  return Math.abs(gapCents) >= thresholdCents ? 'size' : null;
}

function savingsOutlook(
  input: ForecastInput,
  ledger: LedgerEvent[],
  today: ISODate,
  horizonEnd: ISODate,
): SavingsOutlook {
  const { settings } = input;
  const snapshot = input.savings!;
  const drawCodes = new Set(settings.savingsDrawCodes);
  const isDraw = (t: { code: string; direction: string }) => drawCodes.has(t.code) && t.direction === 'in';

  let balanceTodayCents = snapshot.amountCents;
  let trailing90DrawsCents = 0;
  const since90 = addDays(today, -90);
  for (const t of input.transactions) {
    if (!isDraw(t) || t.date > today) continue;
    if (t.date > snapshot.date) balanceTodayCents -= t.amountCents;
    if (t.date > since90) trailing90DrawsCents += t.amountCents;
  }

  // Shortfall of the forward schedule itself, not counting the draws that cover it.
  let net = 0;
  for (const e of ledger) {
    if (e.date <= today || isDraw(e)) continue;
    net += e.direction === 'in' ? e.amountCents : -e.amountCents;
  }
  const days = Math.max(1, diffDays(horizonEnd, today));
  const monthlyShortfallCents = Math.round((-net * AVG_DAYS_PER_MONTH) / days);

  let runwayMonths: number | null = null;
  let floorDate: ISODate | null = null;
  if (monthlyShortfallCents > 0) {
    const cushion = Math.max(0, balanceTodayCents - settings.savingsFloorCents);
    runwayMonths = cushion / monthlyShortfallCents;
    floorDate = addDays(today, Math.floor(runwayMonths * AVG_DAYS_PER_MONTH));
  }

  return {
    snapshot,
    balanceTodayCents,
    floorCents: settings.savingsFloorCents,
    trailing90DrawsCents,
    monthlyShortfallCents,
    runwayMonths,
    floorDate,
  };
}

function occKey(o: Occurrence): string {
  return `${o.code}|${o.period}`;
}

/** Greedy nearest-date matching: each occurrence and each transaction is used at most once. */
export function matchOccurrences(
  occs: readonly { occ: Occurrence; bill: Bill }[],
  txns: readonly Transaction[],
): Map<string, Transaction> {
  const byCode = new Map<string, Transaction[]>();
  for (const t of txns) {
    const list = byCode.get(t.code);
    if (list) list.push(t);
    else byCode.set(t.code, [t]);
  }

  const pairs: { key: string; txn: Transaction; dist: number }[] = [];
  for (const { occ, bill } of occs) {
    const slack = matchSlackDays(bill);
    for (const t of byCode.get(occ.code) ?? []) {
      if (t.direction !== bill.direction) continue;
      const dist = Math.abs(diffDays(t.date, occ.dueDate));
      if (dist <= slack) pairs.push({ key: occKey(occ), txn: t, dist });
    }
  }
  pairs.sort((a, b) => a.dist - b.dist || a.txn.date.localeCompare(b.txn.date) || a.txn.id - b.txn.id);

  const result = new Map<string, Transaction>();
  const used = new Set<number>();
  for (const p of pairs) {
    if (result.has(p.key) || used.has(p.txn.id)) continue;
    result.set(p.key, p.txn);
    used.add(p.txn.id);
  }
  return result;
}

function balanceOn(daily: { date: ISODate; balanceCents: Cents }[], d: ISODate, fallback: Cents): Cents {
  let bal = fallback;
  for (const p of daily) {
    if (p.date > d) break;
    bal = p.balanceCents;
  }
  return bal;
}

function roundDown(cents: Cents, step: Cents): Cents {
  return step > 0 ? Math.floor(cents / step) * step : cents;
}

function roundUp(cents: Cents, step: Cents): Cents {
  return step > 0 ? Math.ceil(cents / step) * step : cents;
}
