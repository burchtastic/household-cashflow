import { createHash } from 'node:crypto';
import type {
  Bill, OccurrenceNote, Override, PlannedItem, Settings, Snapshot, Transaction,
} from '../engine/index.ts';
import type { BankTransaction, PlaidAccountRow } from './db.ts';

/**
 * Demo mode: every amount the app shows is disguised, for showing it off. Each kind of money
 * is scaled (paychecks to 70%, cards 50%, housing 75%, everything else 60%), then nudged by a
 * small fixed wobble per item, so nobody can divide back to the real figures. The wobble is
 * keyed by bill code (or account), so a fixed bill stays fixed and history keeps its shape.
 * The forecast runs on the disguised inputs, so it all still adds up.
 *
 * Demo is per browser (a cookie) and read-only: nothing disguised can be saved.
 */

export const DEMO_COOKIE = '__Host-cashflow-demo';

const FACTORS: Record<string, number> = { Income: 0.7, 'Credit Card': 0.5, Housing: 0.75 };
const OTHER = 0.6;

/** A fixed factor between 0.94 and 1.06 for this key. */
export function wobble(key: string): number {
  const n = createHash('sha256').update(`cashflow-demo:${key}`).digest().readUInt32BE(0);
  return 0.94 + (n / 0xffffffff) * 0.12;
}

export function disguise(cents: number, category: string, key: string): number {
  return Math.round(cents * (FACTORS[category] ?? OTHER) * wobble(key));
}

const disguiseOrNull = (cents: number | null, category: string, key: string) =>
  cents === null ? null : disguise(cents, category, key);

/** Round to whole dollars, so settings don't look oddly precise. */
const dollars = (cents: number) => Math.round(cents / 100) * 100;

/** Everything the screens read. The real one reads the database; demo wraps it. */
export interface Reader {
  settings(): Settings;
  bills(): Bill[];
  transactions(from?: string, to?: string): Transaction[];
  overrides(): Override[];
  notes(): OccurrenceNote[];
  planned(): PlannedItem[];
  snapshots(): (Snapshot & { id: number })[];
  cardFloors(): { code: string; amountCents: number }[];
}

export function demoReader(real: Reader): Reader {
  const categoryOf = () => {
    const m = new Map(real.bills().map((b) => [b.code, b.category]));
    return (code: string) => m.get(code) ?? 'Uncategorized';
  };
  return {
    settings: () => {
      const s = real.settings();
      return {
        ...s,
        bufferFloorCents: dollars(disguise(s.bufferFloorCents, 'Floor', 'checking-floor')),
        savingsFloorCents: dollars(disguise(s.savingsFloorCents, 'Floor', 'savings-floor')),
        topUpRoundingCents: s.topUpRoundingCents,
      };
    },
    bills: () => real.bills().map((b) => ({
      ...b,
      amountCents: disguise(b.amountCents, b.category, b.code),
      minCents: disguiseOrNull(b.minCents, b.category, b.code),
    })),
    transactions: (from, to) => {
      const cat = categoryOf();
      return real.transactions(from, to).map((t) => ({ ...t, amountCents: disguise(t.amountCents, cat(t.code), t.code) }));
    },
    overrides: () => {
      const cat = categoryOf();
      return real.overrides().map((o) => ({ ...o, amountCents: disguise(o.amountCents, cat(o.code), o.code) }));
    },
    notes: () => real.notes(),
    planned: () => {
      const cat = categoryOf();
      return real.planned().map((p) => ({ ...p, amountCents: disguise(p.amountCents, cat(p.code), p.code) }));
    },
    snapshots: () => real.snapshots().map((s) => ({ ...s, amountCents: disguise(s.amountCents, 'Balance', s.account) })),
    cardFloors: () => real.cardFloors().map((f) => ({ ...f, amountCents: disguise(f.amountCents, 'Credit Card', f.code) })),
  };
}

/** A bank account as the demo shows it: disguised balances and statement, no account number. */
export function demoAccount<A extends PlaidAccountRow>(a: A): A {
  const [cat, key] = a.type === 'credit' ? ['Credit Card', a.billCode ?? a.accountId] : ['Balance', a.accountId];
  const s = a.statement;
  return {
    ...a,
    mask: '',
    availableCents: disguiseOrNull(a.availableCents, cat, key),
    currentCents: disguiseOrNull(a.currentCents, cat, key),
    statement: s && {
      ...s,
      balanceCents: disguiseOrNull(s.balanceCents, cat, key),
      minDueCents: disguiseOrNull(s.minDueCents, cat, key),
      lastPaymentCents: disguiseOrNull(s.lastPaymentCents, cat, key),
    },
  };
}

/** A bank transaction as the demo shows it: a category instead of the merchant, a disguised amount. */
export function demoBankTransaction<T extends BankTransaction>(t: T): T {
  const label = t.category
    ? t.category.toLowerCase().replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())
    : 'Bank activity';
  return { ...t, name: label, merchantName: '', amountCents: disguise(t.amountCents, 'Bank', t.accountId) };
}
