import type { ISODate } from './dates.ts';

/** All money is integer cents. */
export type Cents = number;
export type Direction = 'in' | 'out';

export const CATEGORIES = [
  'Housing', 'Support', 'Credit Card', 'Utility', 'Insurance', 'Taxes',
  'Income', 'Transfer', 'Childcare', 'Savings draw', 'Uncategorized',
] as const;

export type Schedule =
  | { kind: 'monthly'; day: number }                          // day 29–31 clamps to month end
  | { kind: 'interval'; anchor: ISODate; everyDays: number }  // e.g. bi-weekly paycheck
  | { kind: 'none' };                                         // tag only, never scheduled

export interface Bill {
  /** Permanent identity (e.g. "MORT"). History matches on this, never on name. */
  code: string;
  name: string;
  category: string;
  direction: Direction;
  active: boolean;
  schedule: Schedule;
  /** fixed: always amountCents. auto: from history, falling back to amountCents when there is none. */
  amountMode: 'fixed' | 'auto';
  amountCents: Cents;
  /** Auto estimates never go below this (e.g. known day care charges on a card). */
  minCents: Cents | null;
  notes: string;
  sort: number;
}

export interface Transaction {
  id: number;
  date: ISODate;
  code: string;
  description: string;
  direction: Direction;
  amountCents: Cents;
  source: string;
  note: string;
  /** Set when this transaction fulfils a one-off planned item. */
  plannedId: number | null;
}

/** A known amount for one occurrence (e.g. a card statement), keyed by period. */
export interface Override {
  code: string;
  /** "YYYY-MM" for monthly bills, the scheduled date for interval bills. */
  period: string;
  amountCents: Cents;
}

/** A note on one scheduled occurrence before it is paid, e.g. "plumbing repair" on a big card bill. */
export interface OccurrenceNote {
  code: string;
  period: string;
  note: string;
}

export interface PlannedItem {
  id: number;
  date: ISODate;
  code: string;
  description: string;
  direction: Direction;
  amountCents: Cents;
  note: string;
  status: 'planned' | 'done' | 'skipped';
}

export interface Snapshot {
  account: 'checking' | 'savings';
  date: ISODate;
  amountCents: Cents;
}

export interface Settings {
  bufferFloorCents: Cents;
  savingsFloorCents: Cents;
  horizonDays: number;
  lookbackDays: number;
  estimateMode: 'average' | 'worst';
  topUpRoundingCents: Cents;
  /** Transaction codes that represent money moved from savings into checking. */
  savingsDrawCodes: string[];
  /** Differences between the bank's balance and the ledger's smaller than this aren't flagged (see flagBankGap). */
  bankCheckThresholdCents: Cents;
}

/** posted: happened. known: amount entered ahead of time. scheduled: a fixed amount. estimated: a guess from history. */
export type EventStatus = 'posted' | 'known' | 'scheduled' | 'estimated' | 'planned';

export interface LedgerEvent {
  key: string;
  date: ISODate;
  code: string;
  name: string;
  category: string;
  direction: Direction;
  amountCents: Cents;
  status: EventStatus;
  /** Free text: the transaction's note once paid, the occurrence note before. */
  note: string;
  /** The estimate this occurrence would have used, for comparison. */
  estimateCents: Cents | null;
  /** Set when the estimate was raised to what's already on the card; the estimate it replaced. */
  raisedFromCents?: Cents | null;
  /** Scheduled date when this came from a recurring bill. */
  dueDate: ISODate | null;
  /** Override period, so the UI can set a known amount. */
  period: string | null;
  plannedId: number | null;
  transactionId: number | null;
  balanceCents: Cents;
}
