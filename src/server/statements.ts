import { nearestOccurrence } from '../engine/index.ts';
import {
  getBill, getOverrideSource, listPlaidAccounts, listPlaidItems, setOverride, tx, type DB,
} from './db.ts';
import type { PlaidEnv } from './plaid.ts';

/**
 * Card statements become known amounts. Each card says which bill pays it; the statement's
 * due date picks that bill's nearest scheduled payment, and the statement balance becomes its
 * known amount. Cards sharing a bill and a due period are added together. A known amount typed
 * in by hand is never overwritten.
 */

export interface StatementPlan {
  billCode: string;
  /** The bill's scheduled payment the statement lands on. */
  period: string;
  occurrenceDate: string;
  amountCents: number;
  accountIds: string[];
  /** A known amount was typed in for this payment, so it's left alone. */
  keptManual: boolean;
}

export interface StatementProblem { accountId: string; message: string }

export function planCardStatements(db: DB, env: PlaidEnv): { plans: StatementPlan[]; problems: StatementProblem[] } {
  const liveItems = new Set(listPlaidItems(db).filter((i) => i.status !== 'removed' && i.env === env).map((i) => i.itemId));
  const byKey = new Map<string, StatementPlan>();
  const problems: StatementProblem[] = [];

  for (const a of listPlaidAccounts(db)) {
    if (!liveItems.has(a.itemId) || a.role !== 'card' || !a.billCode) continue;
    const s = a.statement;
    if (!s || s.dueDate === null || s.balanceCents === null) continue;
    const bill = getBill(db, a.billCode);
    if (!bill) { problems.push({ accountId: a.accountId, message: `Bill ${a.billCode} no longer exists.` }); continue; }
    const occ = nearestOccurrence(bill, s.dueDate);
    if (!occ) {
      problems.push({ accountId: a.accountId, message: `${bill.name} has no scheduled payment near the due date.` });
      continue;
    }
    const key = `${bill.code}|${occ.period}`;
    const plan = byKey.get(key) ?? {
      billCode: bill.code, period: occ.period, occurrenceDate: occ.dueDate, amountCents: 0, accountIds: [],
      keptManual: getOverrideSource(db, bill.code, occ.period) === 'manual',
    };
    // A credit balance means nothing is due.
    plan.amountCents += Math.max(0, s.balanceCents);
    plan.accountIds.push(a.accountId);
    byKey.set(key, plan);
  }
  return { plans: [...byKey.values()], problems };
}

/**
 * Writes the known amounts. `before` is the plan from before a card changed bills: anything
 * it set that the new plan doesn't is taken back, so the old bill returns to its estimate.
 */
export function applyCardStatements(db: DB, env: PlaidEnv, before: StatementPlan[] = []): StatementPlan[] {
  const { plans } = planCardStatements(db, env);
  const now = new Set(plans.map((p) => `${p.billCode}|${p.period}`));
  tx(db, () => {
    for (const p of before) {
      if (!now.has(`${p.billCode}|${p.period}`) && getOverrideSource(db, p.billCode, p.period) === 'plaid') {
        setOverride(db, { code: p.billCode, period: p.period, amountCents: null });
      }
    }
    for (const p of plans) {
      if (!p.keptManual) setOverride(db, { code: p.billCode, period: p.period, amountCents: p.amountCents }, 'plaid');
    }
  });
  return plans;
}

/**
 * What each bill's next statement already holds: the cards' current balances, less any
 * statement not yet paid (that one is due first, as its own known amount). The forecast
 * never estimates the bill's next payment below this.
 */
export function cardFloors(db: DB, env: PlaidEnv): { code: string; amountCents: number }[] {
  const liveItems = new Set(listPlaidItems(db).filter((i) => i.status !== 'removed' && i.env === env).map((i) => i.itemId));
  const byBill = new Map<string, number>();
  for (const a of listPlaidAccounts(db)) {
    if (!liveItems.has(a.itemId) || a.role !== 'card' || !a.billCode || a.currentCents === null) continue;
    const s = a.statement;
    let unpaid = 0;
    if (s && s.balanceCents !== null) {
      const paidSince = s.lastPaymentDate && s.date && s.lastPaymentDate >= s.date ? s.lastPaymentCents ?? 0 : 0;
      unpaid = Math.max(0, s.balanceCents - paidSince);
    }
    byBill.set(a.billCode, (byBill.get(a.billCode) ?? 0) + Math.max(0, a.currentCents - unpaid));
  }
  return [...byBill].map(([code, amountCents]) => ({ code, amountCents }));
}
