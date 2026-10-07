import {
  applyTransactionSync, listPlaidItems, saveCardStatement, setPlaidItemStatus, upsertPlaidAccounts,
  type AccountRole, type BankTransaction, type DB, type NewPlaidAccount, type PlaidItemRow,
} from './db.ts';
import {
  openToken, PlaidError, type PlaidAccount, type PlaidApi, type PlaidConfig, type PlaidTransaction,
} from './plaid.ts';
import { applyCardStatements } from './statements.ts';
import { reconcile } from './reconcile.ts';

/**
 * Pulls balances and transactions for every connected bank into the raw Plaid tables.
 * Nothing here touches the ledger; matching does that later (docs/PLAN.md, Phase 2).
 */

const cents = (dollars: number | null) => (dollars === null ? null : Math.round(dollars * 100));

export function toAccountRow(itemId: string, a: PlaidAccount, at: number): NewPlaidAccount {
  return {
    accountId: a.account_id, itemId, name: a.name, officialName: a.official_name ?? '',
    mask: a.mask ?? '', type: a.type, subtype: a.subtype ?? '',
    availableCents: cents(a.balances?.available ?? null),
    currentCents: cents(a.balances?.current ?? null),
    balanceAt: at,
  };
}

/** Cards are obvious. Which checking and savings accounts count is ours to say. */
export const defaultRole = (a: NewPlaidAccount): AccountRole => (a.type === 'credit' ? 'card' : 'ignore');

const toBankTxn = (t: PlaidTransaction): BankTransaction => ({
  transactionId: t.transaction_id,
  accountId: t.account_id,
  date: t.date,
  authorizedDate: t.authorized_date,
  name: t.name,
  merchantName: t.merchant_name ?? '',
  amountCents: Math.round(t.amount * 100),
  pending: t.pending,
  pendingTransactionId: t.pending_transaction_id,
  category: t.personal_finance_category?.primary ?? '',
  categoryDetail: t.personal_finance_category?.detailed ?? '',
});

export interface ItemSyncResult {
  itemId: string;
  institutionName: string;
  ok: boolean;
  saved?: number;
  removed?: number;
  error?: string;
}

/** Plaid restarts pagination if the data changed mid-run; give up after this many tries. */
const MAX_RESTARTS = 3;

export async function syncItem(db: DB, cfg: PlaidConfig, api: PlaidApi, item: PlaidItemRow, now: () => number): Promise<ItemSyncResult> {
  const base = { itemId: item.itemId, institutionName: item.institutionName };
  try {
    const token = openToken(cfg.tokenKey, item.itemId, item.accessTokenEnc);
    // Accounts first, so every transaction has its account to belong to.
    const accounts = await api.getAccounts(token);
    upsertPlaidAccounts(db, accounts.map((a) => toAccountRow(item.itemId, a, now())), defaultRole);

    for (let attempt = 0; ; attempt++) {
      const byId = new Map<string, BankTransaction>();
      const removed = new Set<string>();
      let cursor = item.cursor;
      let page;
      try {
        do {
          page = await api.syncTransactions(token, cursor);
          for (const t of [...page.added, ...page.modified]) {
            byId.set(t.transaction_id, toBankTxn(t));
            removed.delete(t.transaction_id);
          }
          for (const r of page.removed) {
            byId.delete(r.transaction_id);
            removed.add(r.transaction_id);
          }
          cursor = page.nextCursor;
        } while (page.hasMore);
      } catch (e) {
        if (e instanceof PlaidError && e.code === 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION' && attempt < MAX_RESTARTS) continue;
        throw e;
      }
      const r = applyTransactionSync(db, item.itemId, {
        upserts: [...byId.values()], removed: [...removed], cursor, updateStatus: page.updateStatus, at: now(),
      });
      if (accounts.some((a) => a.type === 'credit')) await saveStatements(db, api, token, now);
      return { ...base, ok: true, saved: r.saved, removed: r.removed };
    }
  } catch (e) {
    // Recorded on the bank's card; one failing bank never stops the others.
    if (!(e instanceof PlaidError)) {
      const message = (e as Error).message || 'Sync failed';
      setPlaidItemStatus(db, item.itemId, 'error', message);
      return { ...base, ok: false, error: message };
    }
    const status = e.code === 'ITEM_LOGIN_REQUIRED' ? 'login_required' : 'error';
    setPlaidItemStatus(db, item.itemId, status, e.message);
    return { ...base, ok: false, error: `${e.message} (${e.code})` };
  }
}

/**
 * Card statements. Optional extra: a bank without Liabilities, or with it not ready yet,
 * just has no statement, and never fails the sync.
 */
async function saveStatements(db: DB, api: PlaidApi, token: string, now: () => number): Promise<void> {
  let cards;
  try { cards = await api.getCardLiabilities(token); } catch (e) {
    if (e instanceof PlaidError) return;
    throw e;
  }
  for (const c of cards) {
    if (!c.account_id) continue;
    saveCardStatement(db, c.account_id, {
      date: c.last_statement_issue_date,
      balanceCents: cents(c.last_statement_balance),
      minDueCents: cents(c.minimum_payment_amount),
      dueDate: c.next_payment_due_date,
      lastPaymentCents: cents(c.last_payment_amount),
      lastPaymentDate: c.last_payment_date,
      overdue: c.is_overdue,
      fetchedAt: now(),
    });
  }
}

/** Runs one sync at a time; a request while one is running waits for that one. */
export class Syncer {
  private running: Promise<ItemSyncResult[]> | null = null;
  private readonly db: DB;
  private readonly cfg: PlaidConfig;
  private readonly api: PlaidApi;
  private readonly now: () => number;
  private readonly timeZone: string;

  constructor(db: DB, cfg: PlaidConfig, api: PlaidApi, timeZone: string, now: () => number = Date.now) {
    this.db = db;
    this.cfg = cfg;
    this.api = api;
    this.timeZone = timeZone;
    this.now = now;
  }

  syncAll(): Promise<ItemSyncResult[]> {
    this.running ??= this.run().finally(() => { this.running = null; });
    return this.running;
  }

  private async run(): Promise<ItemSyncResult[]> {
    const items = listPlaidItems(this.db).filter((i) => i.status !== 'removed' && i.env === this.cfg.env);
    const results: ItemSyncResult[] = [];
    // One bank at a time: gentler on Plaid's rate limits, and nothing here is urgent.
    for (const item of items) results.push(await syncItem(this.db, this.cfg, this.api, item, this.now));
    applyCardStatements(this.db, this.cfg.env);
    // After statements, so card payments match against this month's statement.
    reconcile(this.db, this.cfg.env, this.timeZone, this.now());
    return results;
  }
}
