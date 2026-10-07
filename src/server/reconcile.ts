import {
  addDays, diffDays, estimateBill, matchByAmount, matchSlackDays, occurrences, todayIn,
  type BankItem, type Expected, type ISODate,
} from '../engine/index.ts';
import {
  bankSuccessor, deleteTransaction, getBankTransaction, getPlanned, getSettings, insertTransaction, linkBank,
  listBankHolds, listBankLinks, listBills, listCheckingBankTransactions, listOverrides, listPlaidAccounts,
  listPlaidItems, listPlanned, listTransactions, moveBankHold, tx, updatePlanned, updateTransaction,
  type BankTransaction, type DB,
} from './db.ts';
import type { PlaidEnv } from './plaid.ts';

/**
 * Turns the checking account's bank activity into ledger payments (docs/PLAN.md, Phase 2):
 * by amount, within each item's date window, never more than expected and at most 10% less.
 * A payment already entered by hand is linked rather than added again. Anything that
 * matches nothing waits for review. Cards are left to their statements.
 */

/** Planned one-offs can land this far either side of their date. */
const PLANNED_SLACK_DAYS = 7;
/** A payment typed in by hand and its bank transaction can be this far apart. */
const LINK_SLACK_DAYS = 5;
const LOOKBEHIND_DAYS = 45;

/** Each checking account and the first date it counts from: the day after its bank was connected. */
export function checkingCutovers(db: DB, env: PlaidEnv, timeZone: string): Map<string, ISODate> {
  const items = new Map(listPlaidItems(db)
    .filter((i) => i.status !== 'removed' && i.env === env)
    .map((i) => [i.itemId, addDays(todayIn(timeZone, new Date(i.createdAt)), 1)]));
  return new Map(listPlaidAccounts(db)
    .filter((a) => a.role === 'checking' && items.has(a.itemId))
    .map((a) => [a.accountId, items.get(a.itemId)!]));
}

const toItem = (t: BankTransaction): BankItem => ({
  id: t.transactionId,
  date: t.date,
  // Plaid's sign is the bank's: positive leaves the account.
  direction: t.amountCents > 0 ? 'out' : 'in',
  amountCents: Math.abs(t.amountCents),
});

export interface ReconcileResult { added: number; linked: number; followed: number; dropped: number }

export function reconcile(db: DB, env: PlaidEnv, timeZone: string, now = Date.now()): ReconcileResult {
  const result: ReconcileResult = { added: 0, linked: 0, followed: 0, dropped: 0 };
  const today = todayIn(timeZone, new Date(now));
  tx(db, () => {
    followBank(db, result);

    const cutovers = checkingCutovers(db, env, timeZone);
    if (!cutovers.size) return;
    const linked = new Set(listBankLinks(db).map((l) => l.bankId));
    const holds = listBankHolds(db);
    const bank = listCheckingBankTransactions(db, cutovers)
      .filter((t) => !linked.has(t.transactionId) && !holds.has(t.transactionId) && t.amountCents !== 0);
    if (!bank.length) return;

    const from = bank.reduce((m, t) => (t.date < m ? t.date : m), today);
    const expected = expectedItems(db, addDays(from, -LOOKBEHIND_DAYS), addDays(today, 15), today);
    const matches = matchByAmount(bank.map(toItem), [...expected.values()].map((e) => e.exp));

    for (const [bankId, key] of matches) {
      const t = bank.find((b) => b.transactionId === bankId)!;
      const e = expected.get(key)!;
      const amountCents = Math.abs(t.amountCents);
      if (e.kind === 'link') {
        linkBank(db, e.ledgerId, bankId);
        result.linked++;
      } else if (e.kind === 'occurrence') {
        const id = insertTransaction(db, {
          date: t.date, code: e.code, description: e.name, direction: e.exp.direction, amountCents,
          source: 'plaid', note: '', plannedId: null,
        });
        linkBank(db, id, bankId);
        result.added++;
      } else {
        const p = getPlanned(db, e.plannedId)!;
        const id = insertTransaction(db, {
          date: t.date, code: p.code, description: p.description, direction: p.direction, amountCents,
          source: 'plaid', note: p.note, plannedId: p.id,
        });
        linkBank(db, id, bankId);
        updatePlanned(db, { ...p, date: t.date, amountCents, status: 'done' });
        result.added++;
      }
    }
  });
  return result;
}

/**
 * Keeps links in step with the bank. A pending transaction that posts arrives under a new
 * id, and the ledger follows it (taking the posted date and amount when the app made the
 * entry). One that vanishes without posting was never paid: the app's entry goes, a hand-made
 * one just loses its link.
 */
function followBank(db: DB, result: ReconcileResult): void {
  for (const l of listBankLinks(db)) {
    if (getBankTransaction(db, l.bankId)) continue;
    const next = bankSuccessor(db, l.bankId);
    if (next) {
      linkBank(db, l.ledgerId, next.transactionId);
      if (l.source === 'plaid') {
        const patch = { date: next.date, amountCents: Math.abs(next.amountCents) };
        updateTransaction(db, l.ledgerId, patch);
      }
      result.followed++;
    } else if (l.source === 'plaid') {
      linkBank(db, l.ledgerId, null);
      deleteTransaction(db, l.ledgerId);
      result.dropped++;
    } else {
      linkBank(db, l.ledgerId, null);
      result.dropped++;
    }
  }
  for (const id of listBankHolds(db).keys()) {
    if (!getBankTransaction(db, id)) moveBankHold(db, id, bankSuccessor(db, id)?.transactionId ?? null);
  }
}

type ExpectedEntry =
  | { kind: 'occurrence'; exp: Expected; code: string; name: string }
  | { kind: 'planned'; exp: Expected; plannedId: number }
  | { kind: 'link'; exp: Expected; ledgerId: number };

/** What the ledger expects between from and to: unpaid bill payments, planned one-offs, and hand-entered payments not yet confirmed by the bank. */
function expectedItems(db: DB, from: ISODate, to: ISODate, today: ISODate): Map<string, ExpectedEntry> {
  const out = new Map<string, ExpectedEntry>();
  const settings = getSettings(db);
  const txns = listTransactions(db, addDays(from, -LOOKBEHIND_DAYS), addDays(to, LOOKBEHIND_DAYS));
  const linked = new Set(listBankLinks(db).map((l) => l.ledgerId));
  const overrides = new Map(listOverrides(db).map((o) => [`${o.code}|${o.period}`, o.amountCents]));
  const allTxns = listTransactions(db);

  for (const bill of listBills(db)) {
    if (!bill.active) continue;
    const slack = matchSlackDays(bill);
    const estimate = estimateBill(bill, allTxns, today, settings).estimateCents;
    for (const occ of occurrences(bill, from, to)) {
      // Already paid (by hand or by the bank): nothing to match, though a hand-made entry may still get its link below.
      const paid = txns.some((t) => t.code === bill.code && Math.abs(diffDays(t.date, occ.dueDate)) <= slack);
      if (paid) continue;
      const key = `occ:${bill.code}:${occ.period}`;
      out.set(key, {
        kind: 'occurrence', code: bill.code, name: bill.name,
        exp: {
          key, date: occ.dueDate, direction: bill.direction, slackDays: slack,
          amountCents: overrides.get(`${bill.code}|${occ.period}`) ?? estimate,
        },
      });
    }
  }

  for (const p of listPlanned(db)) {
    if (p.status !== 'planned' || p.date < from || p.date > to) continue;
    const key = `plan:${p.id}`;
    out.set(key, {
      kind: 'planned', plannedId: p.id,
      exp: { key, date: p.date, direction: p.direction, amountCents: p.amountCents, slackDays: PLANNED_SLACK_DAYS },
    });
  }

  for (const t of txns) {
    if (linked.has(t.id) || t.date < from || t.date > to) continue;
    const key = `link:${t.id}`;
    out.set(key, {
      kind: 'link', ledgerId: t.id,
      exp: { key, date: t.date, direction: t.direction, amountCents: t.amountCents, slackDays: LINK_SLACK_DAYS },
    });
  }
  return out;
}

/** Checking activity that matched nothing, for a person to sort out. Dismissed items stay out. */
export function reviewList(db: DB, env: PlaidEnv, timeZone: string): BankTransaction[] {
  const cutovers = checkingCutovers(db, env, timeZone);
  const linked = new Set(listBankLinks(db).map((l) => l.bankId));
  const holds = listBankHolds(db);
  return listCheckingBankTransactions(db, cutovers)
    .filter((t) => !linked.has(t.transactionId) && holds.get(t.transactionId) !== 'dismissed' && t.amountCents !== 0)
    .sort((a, b) => b.date.localeCompare(a.date) || a.transactionId.localeCompare(b.transactionId));
}
