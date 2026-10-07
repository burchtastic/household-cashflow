import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  Bill, OccurrenceNote, Override, PlannedItem, Schedule, Settings, Snapshot, Transaction,
} from '../engine/index.ts';
import type { Dataset } from './seedData.ts';

const MIGRATIONS: string[] = [
  `
  CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  ) STRICT;

  CREATE TABLE bills (
    code         TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    category     TEXT NOT NULL,
    direction    TEXT NOT NULL CHECK (direction IN ('in','out')),
    active       INTEGER NOT NULL CHECK (active IN (0,1)),
    schedule     TEXT NOT NULL,  -- JSON Schedule
    amount_mode  TEXT NOT NULL CHECK (amount_mode IN ('fixed','auto')),
    amount_cents INTEGER NOT NULL,
    min_cents    INTEGER,
    notes        TEXT NOT NULL DEFAULT '',
    sort         INTEGER NOT NULL DEFAULT 0
  ) STRICT;

  CREATE TABLE planned (
    id           INTEGER PRIMARY KEY,
    date         TEXT NOT NULL,
    code         TEXT NOT NULL,
    description  TEXT NOT NULL,
    direction    TEXT NOT NULL CHECK (direction IN ('in','out')),
    amount_cents INTEGER NOT NULL,
    note         TEXT NOT NULL DEFAULT '',
    status       TEXT NOT NULL CHECK (status IN ('planned','done','skipped'))
  ) STRICT;

  CREATE TABLE transactions (
    id           INTEGER PRIMARY KEY,
    date         TEXT NOT NULL,
    code         TEXT NOT NULL,
    description  TEXT NOT NULL,
    direction    TEXT NOT NULL CHECK (direction IN ('in','out')),
    amount_cents INTEGER NOT NULL,
    source       TEXT NOT NULL,
    note         TEXT NOT NULL DEFAULT '',
    planned_id   INTEGER REFERENCES planned(id) ON DELETE SET NULL,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  ) STRICT;
  CREATE INDEX transactions_code_date ON transactions(code, date);
  CREATE INDEX transactions_date ON transactions(date);

  CREATE TABLE overrides (
    code         TEXT NOT NULL,
    period       TEXT NOT NULL,
    amount_cents INTEGER NOT NULL,
    PRIMARY KEY (code, period)
  ) STRICT;

  CREATE TABLE snapshots (
    id           INTEGER PRIMARY KEY,
    account      TEXT NOT NULL CHECK (account IN ('checking','savings')),
    date         TEXT NOT NULL,
    amount_cents INTEGER NOT NULL,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  ) STRICT;
  `,
  `
  CREATE TABLE auth_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  ) STRICT;

  CREATE TABLE passkeys (
    id           TEXT PRIMARY KEY,          -- base64url credential id
    public_key   BLOB NOT NULL,
    counter      INTEGER NOT NULL,
    transports   TEXT NOT NULL,             -- JSON array
    name         TEXT NOT NULL,
    backed_up    INTEGER NOT NULL,
    created_at   INTEGER NOT NULL,          -- epoch ms
    last_used_at INTEGER
  ) STRICT;

  -- Only SHA-256 hashes of session ids and setup tokens are stored.
  CREATE TABLE sessions (
    id_hash      TEXT PRIMARY KEY,
    created_at   INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    expires_at   INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE setup_tokens (
    token_hash TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL
  ) STRICT;
  `,
  `
  CREATE TABLE occurrence_notes (
    code   TEXT NOT NULL,
    period TEXT NOT NULL,
    note   TEXT NOT NULL,
    PRIMARY KEY (code, period)
  ) STRICT;
  `,
  `
  -- One row per bank login linked through Plaid. Removed Items stay (with the token wiped)
  -- because the Trial plan never gives their slot back, and the count must stay honest.
  CREATE TABLE plaid_items (
    item_id          TEXT PRIMARY KEY,
    env              TEXT NOT NULL CHECK (env IN ('sandbox','production')),
    institution_id   TEXT NOT NULL DEFAULT '',
    institution_name TEXT NOT NULL,
    access_token_enc TEXT NOT NULL,           -- AES-256-GCM (src/server/plaid.ts); '' once removed
    status           TEXT NOT NULL CHECK (status IN ('ok','login_required','error','removed')),
    error            TEXT NOT NULL DEFAULT '',
    created_at       INTEGER NOT NULL,        -- epoch ms
    removed_at       INTEGER
  ) STRICT;

  CREATE TABLE plaid_accounts (
    account_id    TEXT PRIMARY KEY,
    item_id       TEXT NOT NULL REFERENCES plaid_items(item_id) ON DELETE CASCADE,
    name          TEXT NOT NULL,
    official_name TEXT NOT NULL DEFAULT '',
    mask          TEXT NOT NULL DEFAULT '',
    type          TEXT NOT NULL,
    subtype       TEXT NOT NULL DEFAULT '',
    role          TEXT NOT NULL DEFAULT 'ignore' CHECK (role IN ('checking','savings','card','ignore'))
  ) STRICT;
  `,
  `
  ALTER TABLE plaid_items ADD COLUMN cursor TEXT NOT NULL DEFAULT '';
  ALTER TABLE plaid_items ADD COLUMN update_status TEXT NOT NULL DEFAULT 'NOT_READY';
  ALTER TABLE plaid_items ADD COLUMN last_sync_at INTEGER;

  ALTER TABLE plaid_accounts ADD COLUMN available_cents INTEGER;
  ALTER TABLE plaid_accounts ADD COLUMN current_cents INTEGER;
  ALTER TABLE plaid_accounts ADD COLUMN balance_at INTEGER;   -- epoch ms we fetched it

  -- Plaid's transactions as the bank reports them, kept apart from the ledger. They reach
  -- the forecast only through matching (docs/PLAN.md, Phase 2).
  CREATE TABLE bank_transactions (
    transaction_id         TEXT PRIMARY KEY,
    account_id             TEXT NOT NULL REFERENCES plaid_accounts(account_id) ON DELETE CASCADE,
    date                   TEXT NOT NULL,
    authorized_date        TEXT,
    name                   TEXT NOT NULL,
    merchant_name          TEXT NOT NULL DEFAULT '',
    amount_cents           INTEGER NOT NULL,   -- Plaid's sign: positive is money leaving the account
    pending                INTEGER NOT NULL CHECK (pending IN (0,1)),
    pending_transaction_id TEXT,
    category               TEXT NOT NULL DEFAULT '',
    category_detail        TEXT NOT NULL DEFAULT '',
    updated_at             INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX bank_transactions_account_date ON bank_transactions(account_id, date);
  `,
  `
  -- Card statements (Plaid Liabilities), and which bill pays each card.
  ALTER TABLE plaid_accounts ADD COLUMN bill_code TEXT;
  ALTER TABLE plaid_accounts ADD COLUMN statement_date TEXT;
  ALTER TABLE plaid_accounts ADD COLUMN statement_cents INTEGER;
  ALTER TABLE plaid_accounts ADD COLUMN min_due_cents INTEGER;
  ALTER TABLE plaid_accounts ADD COLUMN due_date TEXT;
  ALTER TABLE plaid_accounts ADD COLUMN last_payment_cents INTEGER;
  ALTER TABLE plaid_accounts ADD COLUMN last_payment_date TEXT;
  ALTER TABLE plaid_accounts ADD COLUMN overdue INTEGER;
  ALTER TABLE plaid_accounts ADD COLUMN statement_at INTEGER;   -- epoch ms we fetched it

  -- Known amounts from a card statement are Plaid's to update; ones typed in are never touched.
  ALTER TABLE overrides ADD COLUMN source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','plaid'));
  `,
  `
  -- A ledger transaction that the bank's checking activity confirms (src/server/reconcile.ts).
  ALTER TABLE transactions ADD COLUMN bank_transaction_id TEXT;
  CREATE UNIQUE INDEX transactions_bank ON transactions(bank_transaction_id) WHERE bank_transaction_id IS NOT NULL;

  -- Bank transactions never to match automatically: dismissed (not ours to track), or
  -- review (a match was undone, so it waits for a person).
  CREATE TABLE bank_holds (
    transaction_id TEXT PRIMARY KEY,
    status         TEXT NOT NULL CHECK (status IN ('dismissed','review'))
  ) STRICT;
  `,
];

export type DB = DatabaseSync;

export function openDb(path: string): DB {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }
  const isNew = path === ':memory:' || !existsSync(path);
  const db = new DatabaseSync(path);
  if (isNew && path !== ':memory:') {
    try { chmodSync(path, 0o600); } catch { /* not supported on every filesystem */ }
  }
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
}

function migrate(db: DB): void {
  const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  for (let v = version; v < MIGRATIONS.length; v++) {
    tx(db, () => {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    });
  }
}

const txDepth = new WeakMap<DB, number>();

/** Runs fn in a transaction. Nested calls join the outer one. */
export function tx<T>(db: DB, fn: () => T): T {
  const depth = txDepth.get(db) ?? 0;
  if (depth > 0) {
    txDepth.set(db, depth + 1);
    try { return fn(); } finally { txDepth.set(db, depth); }
  }
  txDepth.set(db, 1);
  try { return outerTx(db, fn); } finally { txDepth.set(db, 0); }
}

function outerTx<T>(db: DB, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// ── Reads ────────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;

const toBill = (r: Row): Bill => ({
  code: r.code as string,
  name: r.name as string,
  category: r.category as string,
  direction: r.direction as Bill['direction'],
  active: r.active === 1,
  schedule: JSON.parse(r.schedule as string) as Schedule,
  amountMode: r.amount_mode as Bill['amountMode'],
  amountCents: r.amount_cents as number,
  minCents: (r.min_cents as number | null) ?? null,
  notes: r.notes as string,
  sort: r.sort as number,
});

const toTxn = (r: Row): Transaction => ({
  id: r.id as number,
  date: r.date as string,
  code: r.code as string,
  description: r.description as string,
  direction: r.direction as Transaction['direction'],
  amountCents: r.amount_cents as number,
  source: r.source as string,
  note: r.note as string,
  plannedId: (r.planned_id as number | null) ?? null,
});

const toPlanned = (r: Row): PlannedItem => ({
  id: r.id as number,
  date: r.date as string,
  code: r.code as string,
  description: r.description as string,
  direction: r.direction as PlannedItem['direction'],
  amountCents: r.amount_cents as number,
  note: r.note as string,
  status: r.status as PlannedItem['status'],
});

export const DEFAULT_SETTINGS: Settings = {
  bufferFloorCents: 500_00,
  savingsFloorCents: 4000_00,
  horizonDays: 60,
  lookbackDays: 240,
  estimateMode: 'average',
  topUpRoundingCents: 50_00,
  savingsDrawCodes: ['XFER'],
};

export function getSettings(db: DB): Settings {
  const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
  const stored = Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value)]));
  return { ...DEFAULT_SETTINGS, ...stored };
}

export function listBills(db: DB): Bill[] {
  return (db.prepare('SELECT * FROM bills ORDER BY sort, code').all() as Row[]).map(toBill);
}

export function getBill(db: DB, code: string): Bill | null {
  const r = db.prepare('SELECT * FROM bills WHERE code = ?').get(code) as Row | undefined;
  return r ? toBill(r) : null;
}

export function listTransactions(db: DB, from?: string, to?: string): Transaction[] {
  const rows = db
    .prepare('SELECT * FROM transactions WHERE date >= ? AND date <= ? ORDER BY date, id')
    .all(from ?? '0000-01-01', to ?? '9999-12-31') as Row[];
  return rows.map(toTxn);
}

export function listOverrides(db: DB): Override[] {
  return (db.prepare('SELECT code, period, amount_cents FROM overrides').all() as Row[]).map((r) => ({
    code: r.code as string, period: r.period as string, amountCents: r.amount_cents as number,
  }));
}

export function listOccurrenceNotes(db: DB): OccurrenceNote[] {
  return (db.prepare('SELECT code, period, note FROM occurrence_notes').all() as Row[]).map((r) => ({
    code: r.code as string, period: r.period as string, note: r.note as string,
  }));
}

/** An empty note removes it. */
export function setOccurrenceNote(db: DB, n: OccurrenceNote): void {
  if (n.note === '') {
    db.prepare('DELETE FROM occurrence_notes WHERE code = ? AND period = ?').run(n.code, n.period);
  } else {
    db.prepare(`
      INSERT INTO occurrence_notes (code, period, note) VALUES (?, ?, ?)
      ON CONFLICT (code, period) DO UPDATE SET note = excluded.note
    `).run(n.code, n.period, n.note);
  }
}

/** Updates a transaction's note, and its one-off's note so the two never disagree. */
/** Changes a recorded transaction; a one-off's planned item follows, so the two never disagree. */
export function updateTransaction(
  db: DB, id: number, patch: Partial<Pick<Transaction, 'date' | 'amountCents' | 'note'>>,
): boolean {
  const r = db.prepare('SELECT * FROM transactions WHERE id = ?').get(id) as Row | undefined;
  if (!r) return false;
  const t = { ...toTxn(r), ...patch };
  tx(db, () => {
    db.prepare('UPDATE transactions SET date = ?, amount_cents = ?, note = ? WHERE id = ?').run(t.date, t.amountCents, t.note, id);
    if (t.plannedId !== null) {
      db.prepare('UPDATE planned SET date = ?, amount_cents = ?, note = ? WHERE id = ?').run(t.date, t.amountCents, t.note, t.plannedId);
    }
  });
  return true;
}

export function listPlanned(db: DB): PlannedItem[] {
  return (db.prepare('SELECT * FROM planned ORDER BY date, id').all() as Row[]).map(toPlanned);
}

export function getPlanned(db: DB, id: number): PlannedItem | null {
  const r = db.prepare('SELECT * FROM planned WHERE id = ?').get(id) as Row | undefined;
  return r ? toPlanned(r) : null;
}

export function listSnapshots(db: DB): (Snapshot & { id: number })[] {
  return (db.prepare('SELECT * FROM snapshots ORDER BY date, id').all() as Row[]).map((r) => ({
    id: r.id as number,
    account: r.account as Snapshot['account'],
    date: r.date as string,
    amountCents: r.amount_cents as number,
  }));
}

// ── Writes ───────────────────────────────────────────────────────────────

export function putSettings(db: DB, patch: Partial<Settings>): void {
  const stmt = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  );
  tx(db, () => {
    for (const [k, v] of Object.entries(patch)) stmt.run(k, JSON.stringify(v));
  });
}

export function upsertBill(db: DB, b: Bill): void {
  db.prepare(`
    INSERT INTO bills (code, name, category, direction, active, schedule, amount_mode, amount_cents, min_cents, notes, sort)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(code) DO UPDATE SET
      name = excluded.name, category = excluded.category, direction = excluded.direction,
      active = excluded.active, schedule = excluded.schedule, amount_mode = excluded.amount_mode,
      amount_cents = excluded.amount_cents, min_cents = excluded.min_cents, notes = excluded.notes,
      sort = excluded.sort
  `).run(
    b.code, b.name, b.category, b.direction, b.active ? 1 : 0, JSON.stringify(b.schedule),
    b.amountMode, b.amountCents, b.minCents, b.notes, b.sort,
  );
}

export function insertTransaction(db: DB, t: Omit<Transaction, 'id'> & { id?: number }): number {
  const r = db.prepare(`
    INSERT INTO transactions (id, date, code, description, direction, amount_cents, source, note, planned_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(t.id ?? null, t.date, t.code, t.description, t.direction, t.amountCents, t.source, t.note, t.plannedId);
  return Number(r.lastInsertRowid);
}

export function deleteTransaction(db: DB, id: number): Transaction | null {
  const r = db.prepare('SELECT * FROM transactions WHERE id = ?').get(id) as Row | undefined;
  if (!r) return null;
  const t = toTxn(r);
  tx(db, () => {
    // Deleting a bank-confirmed payment means the match was wrong: don't make it again.
    if (r.bank_transaction_id) setBankHold(db, r.bank_transaction_id as string, 'review');
    db.prepare('DELETE FROM transactions WHERE id = ?').run(id);
    // Un-confirming a one-off puts it back on the plan.
    if (t.plannedId !== null) db.prepare("UPDATE planned SET status = 'planned' WHERE id = ?").run(t.plannedId);
  });
  return t;
}

export function setOverride(
  db: DB, o: Override | { code: string; period: string; amountCents: null }, source: 'manual' | 'plaid' = 'manual',
): void {
  if (o.amountCents === null) {
    db.prepare('DELETE FROM overrides WHERE code = ? AND period = ?').run(o.code, o.period);
  } else {
    db.prepare(`
      INSERT INTO overrides (code, period, amount_cents, source) VALUES (?, ?, ?, ?)
      ON CONFLICT(code, period) DO UPDATE SET amount_cents = excluded.amount_cents, source = excluded.source
    `).run(o.code, o.period, o.amountCents, source);
  }
}

export function insertPlanned(db: DB, p: Omit<PlannedItem, 'id'> & { id?: number }): number {
  const r = db.prepare(`
    INSERT INTO planned (id, date, code, description, direction, amount_cents, note, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(p.id ?? null, p.date, p.code, p.description, p.direction, p.amountCents, p.note, p.status);
  return Number(r.lastInsertRowid);
}

export function updatePlanned(db: DB, p: PlannedItem): void {
  tx(db, () => {
    db.prepare(`
      UPDATE planned SET date = ?, code = ?, description = ?, direction = ?, amount_cents = ?, note = ?, status = ?
      WHERE id = ?
    `).run(p.date, p.code, p.description, p.direction, p.amountCents, p.note, p.status, p.id);
    // A done one-off's transaction follows it, so the two never disagree.
    if (p.status === 'done') {
      db.prepare(`
        UPDATE transactions SET date = ?, code = ?, description = ?, direction = ?, amount_cents = ?, note = ?
        WHERE planned_id = ?
      `).run(p.date, p.code, p.description, p.direction, p.amountCents, p.note, p.id);
    }
  });
}

/** Removes a one-off and anything recorded against it. */
export function deletePlanned(db: DB, id: number): void {
  tx(db, () => {
    const linked = db.prepare('SELECT bank_transaction_id FROM transactions WHERE planned_id = ? AND bank_transaction_id IS NOT NULL')
      .all(id) as { bank_transaction_id: string }[];
    for (const l of linked) setBankHold(db, l.bank_transaction_id, 'review');
    db.prepare('DELETE FROM transactions WHERE planned_id = ?').run(id);
    db.prepare('DELETE FROM planned WHERE id = ?').run(id);
  });
}

export function insertSnapshot(db: DB, s: Snapshot): number {
  const r = db.prepare('INSERT INTO snapshots (account, date, amount_cents) VALUES (?, ?, ?)')
    .run(s.account, s.date, s.amountCents);
  return Number(r.lastInsertRowid);
}

export function isEmpty(db: DB): boolean {
  return (db.prepare('SELECT COUNT(*) AS n FROM bills').get() as { n: number }).n === 0;
}

export function loadDataset(db: DB, d: Dataset): void {
  tx(db, () => {
    for (const k of ['transactions', 'planned', 'overrides', 'snapshots', 'bills', 'settings']) {
      db.exec(`DELETE FROM ${k}`);
    }
    const settingsStmt = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');
    for (const [k, v] of Object.entries(d.settings)) settingsStmt.run(k, JSON.stringify(v));
    for (const b of d.bills) upsertBill(db, b);
    for (const p of d.planned) insertPlanned(db, p);
    for (const t of d.transactions) insertTransaction(db, t);
    for (const o of d.overrides) setOverride(db, o);
    for (const s of d.snapshots) insertSnapshot(db, s);
  });
}

// ── Plaid ────────────────────────────────────────────────────────────────

export type PlaidItemStatus = 'ok' | 'login_required' | 'error' | 'removed';
export type AccountRole = 'checking' | 'savings' | 'card' | 'ignore';

export interface PlaidItemRow {
  itemId: string;
  cursor: string;
  updateStatus: string;
  lastSyncAt: number | null;
  env: 'sandbox' | 'production';
  institutionId: string;
  institutionName: string;
  accessTokenEnc: string;
  status: PlaidItemStatus;
  error: string;
  createdAt: number;
  removedAt: number | null;
}

export interface PlaidAccountRow {
  accountId: string;
  itemId: string;
  name: string;
  officialName: string;
  mask: string;
  type: string;
  subtype: string;
  role: AccountRole;
  availableCents: number | null;
  currentCents: number | null;
  balanceAt: number | null;
  /** The bill that pays this card. */
  billCode: string | null;
  statement: CardStatement | null;
}

export interface CardStatement {
  date: string | null;
  balanceCents: number | null;
  minDueCents: number | null;
  dueDate: string | null;
  lastPaymentCents: number | null;
  lastPaymentDate: string | null;
  overdue: boolean | null;
  fetchedAt: number;
}

export interface BankTransaction {
  transactionId: string;
  accountId: string;
  date: string;
  authorizedDate: string | null;
  name: string;
  merchantName: string;
  /** Plaid's sign: positive is money leaving the account. */
  amountCents: number;
  pending: boolean;
  pendingTransactionId: string | null;
  category: string;
  categoryDetail: string;
}

const toItem = (r: Row): PlaidItemRow => ({
  itemId: r.item_id as string,
  cursor: r.cursor as string,
  updateStatus: r.update_status as string,
  lastSyncAt: (r.last_sync_at as number | null) ?? null,
  env: r.env as PlaidItemRow['env'],
  institutionId: r.institution_id as string,
  institutionName: r.institution_name as string,
  accessTokenEnc: r.access_token_enc as string,
  status: r.status as PlaidItemStatus,
  error: r.error as string,
  createdAt: r.created_at as number,
  removedAt: (r.removed_at as number | null) ?? null,
});

const toAccount = (r: Row): PlaidAccountRow => ({
  accountId: r.account_id as string,
  itemId: r.item_id as string,
  name: r.name as string,
  officialName: r.official_name as string,
  mask: r.mask as string,
  type: r.type as string,
  subtype: r.subtype as string,
  role: r.role as AccountRole,
  availableCents: (r.available_cents as number | null) ?? null,
  currentCents: (r.current_cents as number | null) ?? null,
  balanceAt: (r.balance_at as number | null) ?? null,
  billCode: (r.bill_code as string | null) ?? null,
  statement: r.statement_at === null || r.statement_at === undefined ? null : {
    date: r.statement_date as string | null,
    balanceCents: r.statement_cents as number | null,
    minDueCents: r.min_due_cents as number | null,
    dueDate: r.due_date as string | null,
    lastPaymentCents: r.last_payment_cents as number | null,
    lastPaymentDate: r.last_payment_date as string | null,
    overdue: r.overdue === null ? null : r.overdue === 1,
    fetchedAt: r.statement_at as number,
  },
});

const toBankTxn = (r: Row): BankTransaction => ({
  transactionId: r.transaction_id as string,
  accountId: r.account_id as string,
  date: r.date as string,
  authorizedDate: (r.authorized_date as string | null) ?? null,
  name: r.name as string,
  merchantName: r.merchant_name as string,
  amountCents: r.amount_cents as number,
  pending: r.pending === 1,
  pendingTransactionId: (r.pending_transaction_id as string | null) ?? null,
  category: r.category as string,
  categoryDetail: r.category_detail as string,
});

export function listPlaidItems(db: DB): PlaidItemRow[] {
  return (db.prepare('SELECT * FROM plaid_items ORDER BY created_at').all() as Row[]).map(toItem);
}

export function getPlaidItem(db: DB, itemId: string): PlaidItemRow | null {
  const r = db.prepare('SELECT * FROM plaid_items WHERE item_id = ?').get(itemId) as Row | undefined;
  return r ? toItem(r) : null;
}

export function insertPlaidItem(
  db: DB, i: Omit<PlaidItemRow, 'removedAt' | 'error' | 'status' | 'cursor' | 'updateStatus' | 'lastSyncAt'>,
): void {
  db.prepare(`
    INSERT INTO plaid_items (item_id, env, institution_id, institution_name, access_token_enc, status, created_at)
    VALUES (?, ?, ?, ?, ?, 'ok', ?)
  `).run(i.itemId, i.env, i.institutionId, i.institutionName, i.accessTokenEnc, i.createdAt);
}

export function setPlaidItemStatus(db: DB, itemId: string, status: Exclude<PlaidItemStatus, 'removed'>, error = ''): void {
  db.prepare("UPDATE plaid_items SET status = ?, error = ? WHERE item_id = ? AND status <> 'removed'").run(status, error, itemId);
}

/** Wipes the token and the accounts; the row stays so the Trial slot count stays honest. */
export function markPlaidItemRemoved(db: DB, itemId: string, at: number): void {
  tx(db, () => {
    db.prepare('DELETE FROM plaid_accounts WHERE item_id = ?').run(itemId);
    db.prepare(`
      UPDATE plaid_items SET status = 'removed', access_token_enc = '', error = '', removed_at = ? WHERE item_id = ?
    `).run(at, itemId);
  });
}

export function listPlaidAccounts(db: DB): PlaidAccountRow[] {
  return (db.prepare('SELECT * FROM plaid_accounts ORDER BY item_id, type, name').all() as Row[]).map(toAccount);
}

export type NewPlaidAccount = Omit<PlaidAccountRow, 'role' | 'billCode' | 'statement'>;

/** Adds new accounts and refreshes names and balances; keeps the role already chosen. */
export function upsertPlaidAccounts(db: DB, accounts: NewPlaidAccount[], defaultRole: (a: NewPlaidAccount) => AccountRole): void {
  const stmt = db.prepare(`
    INSERT INTO plaid_accounts (account_id, item_id, name, official_name, mask, type, subtype, role,
                                available_cents, current_cents, balance_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(account_id) DO UPDATE SET
      name = excluded.name, official_name = excluded.official_name, mask = excluded.mask,
      type = excluded.type, subtype = excluded.subtype, available_cents = excluded.available_cents,
      current_cents = excluded.current_cents, balance_at = excluded.balance_at
  `);
  tx(db, () => {
    for (const a of accounts) {
      stmt.run(
        a.accountId, a.itemId, a.name, a.officialName, a.mask, a.type, a.subtype, defaultRole(a),
        a.availableCents, a.currentCents, a.balanceAt,
      );
    }
  });
}

/**
 * Applies one complete /transactions/sync run and moves the cursor, all or nothing, so a
 * failure part-way leaves the cursor where it was and the next run repeats the same changes.
 */
export function applyTransactionSync(db: DB, itemId: string, s: {
  upserts: BankTransaction[]; removed: string[]; cursor: string; updateStatus: string; at: number;
}): { saved: number; removed: number; skipped: number } {
  const known = new Set(
    (db.prepare('SELECT account_id FROM plaid_accounts WHERE item_id = ?').all(itemId) as { account_id: string }[])
      .map((r) => r.account_id),
  );
  const upsert = db.prepare(`
    INSERT INTO bank_transactions (transaction_id, account_id, date, authorized_date, name, merchant_name,
      amount_cents, pending, pending_transaction_id, category, category_detail, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(transaction_id) DO UPDATE SET
      account_id = excluded.account_id, date = excluded.date, authorized_date = excluded.authorized_date,
      name = excluded.name, merchant_name = excluded.merchant_name, amount_cents = excluded.amount_cents,
      pending = excluded.pending, pending_transaction_id = excluded.pending_transaction_id,
      category = excluded.category, category_detail = excluded.category_detail, updated_at = excluded.updated_at
  `);
  const del = db.prepare('DELETE FROM bank_transactions WHERE transaction_id = ?');
  return tx(db, () => {
    let saved = 0, removed = 0, skipped = 0;
    for (const t of s.upserts) {
      // An account Plaid didn't list can't be shown or given a role: leave it out.
      if (!known.has(t.accountId)) { skipped++; continue; }
      upsert.run(
        t.transactionId, t.accountId, t.date, t.authorizedDate, t.name, t.merchantName, t.amountCents,
        t.pending ? 1 : 0, t.pendingTransactionId, t.category, t.categoryDetail, s.at,
      );
      saved++;
    }
    for (const id of s.removed) removed += Number(del.run(id).changes);
    db.prepare(`
      UPDATE plaid_items SET cursor = ?, update_status = ?, last_sync_at = ?, status = 'ok', error = ''
      WHERE item_id = ? AND status <> 'removed'
    `).run(s.cursor, s.updateStatus, s.at, itemId);
    return { saved, removed, skipped };
  });
}

export function listBankTransactions(db: DB, accountId: string, limit: number): BankTransaction[] {
  return (db.prepare(`
    SELECT * FROM bank_transactions WHERE account_id = ? ORDER BY pending DESC, date DESC, transaction_id LIMIT ?
  `).all(accountId, limit) as Row[]).map(toBankTxn);
}

export function countBankTransactions(db: DB): Map<string, number> {
  const rows = db.prepare('SELECT account_id, COUNT(*) AS n FROM bank_transactions GROUP BY account_id')
    .all() as { account_id: string; n: number }[];
  return new Map(rows.map((r) => [r.account_id, r.n]));
}

export function setPlaidAccountRole(db: DB, accountId: string, role: AccountRole): boolean {
  return db.prepare('UPDATE plaid_accounts SET role = ? WHERE account_id = ?').run(role, accountId).changes > 0;
}

export function setPlaidAccountBill(db: DB, accountId: string, billCode: string | null): boolean {
  return db.prepare('UPDATE plaid_accounts SET bill_code = ? WHERE account_id = ?').run(billCode, accountId).changes > 0;
}

export function saveCardStatement(db: DB, accountId: string, s: CardStatement): void {
  db.prepare(`
    UPDATE plaid_accounts SET statement_date = ?, statement_cents = ?, min_due_cents = ?, due_date = ?,
      last_payment_cents = ?, last_payment_date = ?, overdue = ?, statement_at = ?
    WHERE account_id = ?
  `).run(
    s.date, s.balanceCents, s.minDueCents, s.dueDate, s.lastPaymentCents, s.lastPaymentDate,
    s.overdue === null ? null : s.overdue ? 1 : 0, s.fetchedAt, accountId,
  );
}

export function getOverrideSource(db: DB, code: string, period: string): 'manual' | 'plaid' | null {
  const r = db.prepare('SELECT source FROM overrides WHERE code = ? AND period = ?').get(code, period) as { source: string } | undefined;
  return (r?.source as 'manual' | 'plaid' | undefined) ?? null;
}

// ── Bank matching ────────────────────────────────────────────────────────

export interface BankLink { ledgerId: number; bankId: string; source: string; plannedId: number | null }

export function listBankLinks(db: DB): BankLink[] {
  return (db.prepare('SELECT id, bank_transaction_id, source, planned_id FROM transactions WHERE bank_transaction_id IS NOT NULL')
    .all() as Row[]).map((r) => ({
    ledgerId: r.id as number, bankId: r.bank_transaction_id as string, source: r.source as string,
    plannedId: (r.planned_id as number | null) ?? null,
  }));
}

export function linkBank(db: DB, ledgerId: number, bankId: string | null): void {
  db.prepare('UPDATE transactions SET bank_transaction_id = ? WHERE id = ?').run(bankId, ledgerId);
}

export function getBankTransaction(db: DB, id: string): BankTransaction | null {
  const r = db.prepare('SELECT * FROM bank_transactions WHERE transaction_id = ?').get(id) as Row | undefined;
  return r ? toBankTxn(r) : null;
}

/** The posted transaction that replaced a pending one, if it has arrived. */
export function bankSuccessor(db: DB, pendingId: string): BankTransaction | null {
  const r = db.prepare('SELECT * FROM bank_transactions WHERE pending_transaction_id = ?').get(pendingId) as Row | undefined;
  return r ? toBankTxn(r) : null;
}

/** Checking activity from these accounts, on or after each account's cutover date. */
export function listCheckingBankTransactions(db: DB, cutoverByAccount: Map<string, string>): BankTransaction[] {
  const out: BankTransaction[] = [];
  const stmt = db.prepare('SELECT * FROM bank_transactions WHERE account_id = ? AND date >= ? ORDER BY date, transaction_id');
  for (const [accountId, from] of cutoverByAccount) out.push(...(stmt.all(accountId, from) as Row[]).map(toBankTxn));
  return out;
}

export function listBankHolds(db: DB): Map<string, 'dismissed' | 'review'> {
  const rows = db.prepare('SELECT transaction_id, status FROM bank_holds').all() as { transaction_id: string; status: 'dismissed' | 'review' }[];
  return new Map(rows.map((r) => [r.transaction_id, r.status]));
}

export function setBankHold(db: DB, bankId: string, status: 'dismissed' | 'review' | null): void {
  if (status === null) db.prepare('DELETE FROM bank_holds WHERE transaction_id = ?').run(bankId);
  else {
    db.prepare(`
      INSERT INTO bank_holds (transaction_id, status) VALUES (?, ?)
      ON CONFLICT(transaction_id) DO UPDATE SET status = excluded.status
    `).run(bankId, status);
  }
}

export function moveBankHold(db: DB, from: string, to: string | null): void {
  if (to) db.prepare('UPDATE OR REPLACE bank_holds SET transaction_id = ? WHERE transaction_id = ?').run(to, from);
  else db.prepare('DELETE FROM bank_holds WHERE transaction_id = ?').run(from);
}
