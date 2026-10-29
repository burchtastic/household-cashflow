import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/server/app.ts';
import { DEMO_COOKIE } from '../src/server/demo.ts';
import {
  DEFAULT_SETTINGS, insertPlanned, insertSnapshot, loadDataset, openDb, SCHEMA_VERSION, upsertBill, type DB,
} from '../src/server/db.ts';
import type { Bill } from '../src/engine/index.ts';
import { Auth, DEFAULT_SESSION, SESSION_COOKIE, type AuthConfig } from '../src/server/auth.ts';
import {
  loadPlaidConfig, openToken, PlaidError, sealToken, type PlaidAccount, type PlaidApi, type PlaidConfig,
  type PlaidCardLiability, type PlaidTransaction, type SyncPage,
} from '../src/server/plaid.ts';
const AUTH: AuthConfig = {
  rpID: 'localhost', rpName: 'Cashflow', origins: ['http://localhost:8787'], ...DEFAULT_SESSION,
};
const key = randomBytes(32);

describe('access tokens at rest', () => {
  it('round-trips, and only for the Item it was sealed for', () => {
    const sealed = sealToken(key, 'item-1', 'access-sandbox-abc');
    expect(sealed).not.toContain('access-sandbox');
    expect(openToken(key, 'item-1', sealed)).toBe('access-sandbox-abc');
    expect(() => openToken(key, 'item-2', sealed)).toThrow();
    expect(() => openToken(randomBytes(32), 'item-1', sealed)).toThrow();
  });
});

describe('credentials file', () => {
  const write = (text: string) => {
    const path = join(mkdtempSync(join(tmpdir(), 'plaid-')), 'plaid.env');
    writeFileSync(path, text);
    return path;
  };
  const good = `# comment\nPLAID_ENV=sandbox\nPLAID_CLIENT_ID=abc\nPLAID_SECRET="s3cret"\nPLAID_TOKEN_KEY=${key.toString('base64')}\n`;

  it('is off when there is no file', () => {
    expect(loadPlaidConfig({ PLAID_CREDENTIALS: join(tmpdir(), 'does-not-exist.env') })).toBeUndefined();
  });

  it('reads the file systemd hands over', () => {
    const path = write(good);
    const dir = path.slice(0, -'plaid.env'.length);
    const cfg = loadPlaidConfig({ CREDENTIALS_DIRECTORY: dir });
    expect(cfg).toMatchObject({ env: 'sandbox', clientId: 'abc', secret: 's3cret', redirectUri: undefined });
    expect(cfg!.tokenKey.equals(key)).toBe(true);
  });

  it('refuses a short key or an unknown environment', () => {
    expect(() => loadPlaidConfig({ PLAID_CREDENTIALS: write(good.replace(key.toString('base64'), 'c2hvcnQ=')) })).toThrow(/32 bytes/);
    expect(() => loadPlaidConfig({ PLAID_CREDENTIALS: write(good.replace('sandbox', 'development')) })).toThrow(/PLAID_ENV/);
  });
});

// ── API, against a stand-in Plaid ────────────────────────────────────────

const ACCOUNTS: PlaidAccount[] = [
  {
    account_id: 'acc-chk', name: 'Checking', official_name: null, mask: '0000', type: 'depository', subtype: 'checking',
    balances: { available: 1234.56, current: 1300.1, iso_currency_code: 'USD' },
  },
  {
    account_id: 'acc-card', name: 'Card', official_name: null, mask: '3333', type: 'credit', subtype: 'credit card',
    balances: { available: null, current: 410.3, iso_currency_code: 'USD' },
  },
];

/** A Plaid transaction on item-1's checking account. */
const txn = (id: string, o: Partial<PlaidTransaction> = {}): PlaidTransaction => ({
  transaction_id: id, account_id: 'acc-chk-1', amount: 12.34, iso_currency_code: 'USD', date: '2026-10-05',
  authorized_date: null, name: `Shop ${id}`, merchant_name: 'Shop', pending: false, pending_transaction_id: null,
  personal_finance_category: { primary: 'GENERAL_MERCHANDISE', detailed: 'GENERAL_MERCHANDISE_OTHER' }, ...o,
});
const page = (o: Partial<SyncPage>): SyncPage => ({
  added: [], modified: [], removed: [], nextCursor: '', hasMore: false, updateStatus: 'HISTORICAL_UPDATE_COMPLETE', ...o,
});

class FakePlaid implements PlaidApi {
  calls: string[] = [];
  next = 1;
  accountsError: PlaidError | null = null;
  async createLinkToken({ accessToken }: { accessToken?: string }) {
    this.calls.push(accessToken ? `link:update:${accessToken}` : 'link:new');
    return 'link-sandbox-123';
  }
  async exchangePublicToken(publicToken: string) {
    this.calls.push(`exchange:${publicToken}`);
    const n = this.next++;
    return { accessToken: `access-sandbox-${n}`, itemId: `item-${n}` };
  }
  async getAccounts(accessToken: string) {
    this.calls.push(`accounts:${accessToken}`);
    if (this.accountsError) throw this.accountsError;
    return ACCOUNTS.map((a) => ({ ...a, account_id: `${a.account_id}-${accessToken.slice(-1)}` }));
  }
  async removeItem(accessToken: string) {
    this.calls.push(`remove:${accessToken}`);
  }
  liabilities: PlaidCardLiability[] | PlaidError = [];
  async getCardLiabilities(accessToken: string) {
    this.calls.push(`liabilities:${accessToken}`);
    if (this.liabilities instanceof PlaidError) throw this.liabilities;
    return this.liabilities;
  }
  /** Scripted pages, by "token|cursor". Anything unscripted: no changes. */
  pages = new Map<string, SyncPage | PlaidError | (() => SyncPage | PlaidError)>();
  async syncTransactions(accessToken: string, cursor: string) {
    this.calls.push(`sync:${accessToken}:${cursor}`);
    let p = this.pages.get(`${accessToken}|${cursor}`);
    if (typeof p === 'function') p = p();
    if (p instanceof PlaidError) throw p;
    return p ?? page({ nextCursor: cursor || 'c-empty' });
  }
}

let db: DB;
let app: FastifyInstance;
let fake: FakePlaid;
let cookie = '';

/** The app's clock; tests that care about dates set it. */
let clock = Date.now();
const start = (cfg: Partial<PlaidConfig> | null, at?: string, staticDir?: string) => {
  clock = at ? Date.parse(at) : Date.now();
  db = openDb(':memory:');
  loadDataset(db, { settings: DEFAULT_SETTINGS, bills: [], transactions: [], overrides: [], planned: [], snapshots: [] });
  fake = new FakePlaid();
  app = buildApp(db, {
    timeZone: 'America/New_York', auth: AUTH, now: () => clock, staticDir,
    plaid: cfg ? { config: { env: 'sandbox', clientId: 'c', secret: 's', tokenKey: key, ...cfg }, api: fake } : undefined,
  });
  cookie = `${SESSION_COOKIE}=${new Auth(db, AUTH).createSession()}`;
  if (at) cookie = `${SESSION_COOKIE}=${new Auth(db, AUTH, undefined, () => clock).createSession()}`;
};
/** Moves the clock, with a fresh session for the new time. */
const advance = (to: string) => {
  clock = Date.parse(to);
  cookie = `${SESSION_COOKIE}=${new Auth(db, AUTH, undefined, () => clock).createSession()}`;
};
afterEach(async () => {
  await app?.close();
  db?.close();
});

const get = (url: string) => app.inject({ url, headers: { cookie } });
const send = (method: 'POST' | 'PUT' | 'DELETE', url: string, payload?: object) =>
  app.inject({ method, url, payload, headers: { cookie, ...(payload && { 'content-type': 'application/json' }) } });
const link = (publicToken = 'public-sandbox-aaa') =>
  send('POST', '/api/plaid/exchange', { publicToken, institution: { id: 'ins_1', name: 'First Platypus Bank' } });

describe('bank connections API', () => {
  describe('when Plaid is not set up', () => {
    beforeEach(() => start(null));
    it('says so, and refuses everything else', async () => {
      expect((await get('/api/plaid')).json()).toEqual({ enabled: false });
      expect((await send('POST', '/api/plaid/link-token', {})).statusCode).toBe(404);
    });
    it('keeps the strict security policy on the connect page', async () => {
      expect((await get('/connect')).headers['content-security-policy']).not.toContain('plaid');
    });
  });

  describe('in sandbox', () => {
    beforeEach(() => start({}));

    it('needs a session', async () => {
      expect((await app.inject({ url: '/api/plaid' })).statusCode).toBe(401);
    });

    it('lets Plaid Link in on the connect pages only', async () => {
      for (const path of ['/connect', '/plaid-oauth']) {
        const res = await get(path);
        expect(res.headers['content-security-policy']).toContain('https://cdn.plaid.com/link/v2/stable/link-initialize.js');
        expect(res.headers['content-security-policy']).toContain('frame-src https://cdn.plaid.com/');
        expect(res.headers['cross-origin-opener-policy']).toBe('same-origin-allow-popups');
      }
      for (const path of ['/', '/api/plaid']) {
        const res = await get(path);
        expect(res.headers['content-security-policy']).not.toContain('plaid');
        expect(res.headers['cross-origin-opener-policy']).toBe('same-origin');
      }
    });

    it("gives each connect page a fresh nonce for Link's phone stylesheet, and no other page one", async () => {
      const dir = mkdtempSync(join(tmpdir(), 'cf-static-'));
      writeFileSync(join(dir, 'index.html'), '<!doctype html><html><head><title>Cashflow</title></head><body></body></html>');
      await app.close();
      start({}, undefined, dir);
      const seen = new Set<string>();
      for (const path of ['/connect', '/plaid-oauth', '/plaid-oauth?oauth_state_id=abc', '/connect']) {
        const res = await get(path);
        expect(res.statusCode).toBe(200);
        expect(res.headers['content-type']).toContain('text/html');
        expect(res.headers['cache-control']).toBe('no-store');
        const nonce = /<meta property="csp-nonce" nonce="([A-Za-z0-9+/=]{24})" \/>/.exec(res.body)?.[1];
        expect(nonce).toBeDefined();
        expect(res.headers['content-security-policy']).toContain(`style-src 'self' 'nonce-${nonce}';`);
        seen.add(nonce!);
      }
      expect(seen.size).toBe(4);
      const home = await get('/bills');
      expect(home.body).not.toContain('csp-nonce');
      expect(home.headers['content-security-policy']).toContain("style-src 'self';");
    });

    it('links a bank, storing the token encrypted and guessing only card roles', async () => {
      expect((await send('POST', '/api/plaid/link-token', {})).json()).toEqual({ linkToken: 'link-sandbox-123' });
      expect((await link()).statusCode).toBe(201);

      const stored = db.prepare('SELECT access_token_enc FROM plaid_items').get() as { access_token_enc: string };
      expect(stored.access_token_enc).not.toContain('access-sandbox');
      expect(openToken(key, 'item-1', stored.access_token_enc)).toBe('access-sandbox-1');

      const info = (await get('/api/plaid')).json();
      expect(JSON.stringify(info)).not.toContain('access');
      expect(info.items).toHaveLength(1);
      expect(info.items[0]).toMatchObject({ itemId: 'item-1', institutionName: 'First Platypus Bank', status: 'ok' });
      expect(info.items[0].accounts.map((a: { role: string }) => a.role).sort()).toEqual(['card', 'ignore']);
    });

    it('rejects anything that is not a public token', async () => {
      expect((await link('access-sandbox-1')).statusCode).toBe(400);
    });

    it('keeps the connection when fetching accounts fails, and marks it', async () => {
      fake.accountsError = new PlaidError(400, { error_type: 'ITEM_ERROR', error_code: 'ITEM_LOGIN_REQUIRED', error_message: 'login required' });
      expect((await link()).statusCode).toBe(201);
      const [item] = (await get('/api/plaid')).json().items;
      expect(item).toMatchObject({ status: 'login_required', error: 'login required' });

      // Fixing it uses update mode with the existing token, not a new Item.
      await send('POST', '/api/plaid/link-token', { itemId: 'item-1' });
      expect(fake.calls).toContain('link:update:access-sandbox-1');
      fake.accountsError = null;
      expect((await send('POST', '/api/plaid/items/item-1/refresh')).statusCode).toBe(200);
      const [fixed] = (await get('/api/plaid')).json().items;
      expect(fixed).toMatchObject({ status: 'ok', error: '' });
      expect(fixed.accounts).toHaveLength(2);
    });

    it('shows Plaid errors to the user', async () => {
      await link();
      fake.accountsError = new PlaidError(400, { error_type: 'ITEM_ERROR', error_code: 'ITEM_LOGIN_REQUIRED', display_message: 'Sign in again' });
      const res = await send('POST', '/api/plaid/items/item-1/refresh');
      expect(res.statusCode).toBe(502);
      expect(res.json().error).toBe('Sign in again (ITEM_LOGIN_REQUIRED)');
    });

    it('sets roles, but keeps them when accounts refresh', async () => {
      await link();
      expect((await send('PUT', '/api/plaid/accounts/acc-chk-1', { role: 'checking' })).statusCode).toBe(200);
      expect((await send('PUT', '/api/plaid/accounts/acc-chk-1', { role: 'brokerage' })).statusCode).toBe(400);
      expect((await send('PUT', '/api/plaid/accounts/nope', { role: 'savings' })).statusCode).toBe(404);
      await send('POST', '/api/plaid/items/item-1/refresh');
      const accounts = (await get('/api/plaid')).json().items[0].accounts;
      expect(accounts.find((a: { accountId: string }) => a.accountId === 'acc-chk-1').role).toBe('checking');
    });

    it('disconnecting removes the Item at Plaid and wipes the token here', async () => {
      await link();
      expect((await send('DELETE', '/api/plaid/items/item-1')).statusCode).toBe(200);
      expect(fake.calls).toContain('remove:access-sandbox-1');
      expect((await get('/api/plaid')).json().items).toEqual([]);
      const row = db.prepare('SELECT status, access_token_enc FROM plaid_items').get();
      expect(row).toEqual({ status: 'removed', access_token_enc: '' });
      expect(db.prepare('SELECT COUNT(*) AS n FROM plaid_accounts').get()).toEqual({ n: 0 });
      expect((await send('DELETE', '/api/plaid/items/item-1')).statusCode).toBe(404);
    });
  });

  describe('in production', () => {
    beforeEach(() => start({ env: 'production' }));

    it('counts removed connections against the Trial limit and stops at 10', async () => {
      for (let i = 0; i < 10; i++) expect((await link(`public-production-${i}`)).statusCode).toBe(201);
      await send('DELETE', '/api/plaid/items/item-1');
      const info = (await get('/api/plaid')).json();
      expect(info.slots).toEqual({ used: 10, limit: 10 });
      expect(info.items).toHaveLength(9);

      const res = await send('POST', '/api/plaid/link-token', {});
      expect(res.statusCode).toBe(409);
      // Repairing an existing connection is still allowed.
      expect((await send('POST', '/api/plaid/link-token', { itemId: 'item-2' })).statusCode).toBe(200);
    });
  });
});

describe('bank sync', () => {
  beforeEach(() => start({}));
  const sync = async () => (await send('POST', '/api/plaid/sync')).json().results;
  const recent = async (accountId = 'acc-chk-1') => (await get(`/api/plaid/accounts/${accountId}/transactions`)).json();
  const ledgerCount = () => (db.prepare('SELECT COUNT(*) AS n FROM transactions').get() as { n: number }).n;

  it('saves balances in cents and every page of transactions, and nothing in the ledger', async () => {
    await link();
    fake.pages.set('access-sandbox-1|', page({ added: [txn('t1'), txn('t2', { pending: true })], nextCursor: 'c1', hasMore: true, updateStatus: 'INITIAL_UPDATE_COMPLETE' }));
    fake.pages.set('access-sandbox-1|c1', page({ added: [txn('t3', { amount: -2000, name: 'Payroll' })], nextCursor: 'c2' }));

    expect(await sync()).toEqual([{ itemId: 'item-1', institutionName: 'First Platypus Bank', ok: true, saved: 3, removed: 0 }]);

    const info = (await get('/api/plaid')).json();
    const [item] = info.items;
    expect(item).toMatchObject({ updateStatus: 'HISTORICAL_UPDATE_COMPLETE', status: 'ok' });
    expect(item.lastSyncAt).toBeTypeOf('number');
    expect(item).not.toHaveProperty('cursor');
    const chk = item.accounts.find((a: { accountId: string }) => a.accountId === 'acc-chk-1');
    expect(chk).toMatchObject({ availableCents: 1234_56, currentCents: 1300_10, transactionCount: 3 });
    expect(item.accounts.find((a: { accountId: string }) => a.accountId === 'acc-card-1').availableCents).toBeNull();

    const txns = await recent();
    expect(txns[0]).toMatchObject({ transactionId: 't2', pending: true });
    expect(txns.find((t: { transactionId: string }) => t.transactionId === 't3')).toMatchObject({ amountCents: -2000_00, name: 'Payroll' });
    expect(ledgerCount()).toBe(0);
  });

  it('carries on from the saved cursor: edits, removals, and a pending charge posting', async () => {
    await link();
    fake.pages.set('access-sandbox-1|', page({ added: [txn('p1', { pending: true }), txn('t2')], nextCursor: 'c1' }));
    await sync();
    fake.pages.set('access-sandbox-1|c1', page({
      added: [txn('t1', { pending_transaction_id: 'p1', amount: 12.5 })],
      modified: [txn('t2', { name: 'Renamed' })],
      removed: [{ transaction_id: 'p1' }],
      nextCursor: 'c2',
    }));
    expect((await sync())[0]).toMatchObject({ ok: true, saved: 2, removed: 1 });
    const txns = await recent();
    expect(txns.map((t: { transactionId: string }) => t.transactionId).sort()).toEqual(['t1', 't2']);
    expect(txns.find((t: { transactionId: string }) => t.transactionId === 't1')).toMatchObject({ amountCents: 12_50, pending: false, pendingTransactionId: 'p1' });
    expect(txns.find((t: { transactionId: string }) => t.transactionId === 't2').name).toBe('Renamed');
    expect(fake.calls).toContain('sync:access-sandbox-1:c1');
  });

  it('keeps a transaction removed and re-added in the same run', async () => {
    await link();
    fake.pages.set('access-sandbox-1|', page({ removed: [{ transaction_id: 't1' }], nextCursor: 'c1', hasMore: true }));
    fake.pages.set('access-sandbox-1|c1', page({ added: [txn('t1')], nextCursor: 'c2' }));
    await sync();
    expect(await recent()).toHaveLength(1);
  });

  it('starts over when Plaid says the data changed mid-run', async () => {
    await link();
    let tries = 0;
    fake.pages.set('access-sandbox-1|', page({ added: [txn('t1')], nextCursor: 'c1', hasMore: true }));
    fake.pages.set('access-sandbox-1|c1', () => (++tries === 1
      ? new PlaidError(400, { error_type: 'TRANSACTIONS_ERROR', error_code: 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION' })
      : page({ added: [txn('t2')], nextCursor: 'c2' })));
    expect((await sync())[0]).toMatchObject({ ok: true, saved: 2 });
    expect(fake.calls.filter((c) => c === 'sync:access-sandbox-1:')).toHaveLength(2);
  });

  it('saves nothing and keeps the cursor when a run fails part-way', async () => {
    await link();
    fake.pages.set('access-sandbox-1|', page({ added: [txn('t1')], nextCursor: 'c1', hasMore: true }));
    fake.pages.set('access-sandbox-1|c1', new PlaidError(500, { error_type: 'API_ERROR', error_code: 'INTERNAL_SERVER_ERROR', error_message: 'oops' }));
    expect((await sync())[0]).toMatchObject({ ok: false, error: 'oops (INTERNAL_SERVER_ERROR)' });
    expect(await recent()).toEqual([]);
    expect((await get('/api/plaid')).json().items[0]).toMatchObject({ status: 'error', error: 'oops', lastSyncAt: null });
    // The next run starts from the same place, and a success clears the error.
    fake.pages.delete('access-sandbox-1|c1');
    await sync();
    expect((await get('/api/plaid')).json().items[0]).toMatchObject({ status: 'ok', error: '' });
  });

  it('a bank needing sign-in is marked, and the others still sync', async () => {
    await link('public-sandbox-a');
    await link('public-sandbox-b');
    fake.pages.set('access-sandbox-1|', new PlaidError(400, { error_type: 'ITEM_ERROR', error_code: 'ITEM_LOGIN_REQUIRED', display_message: 'Sign in again' }));
    fake.pages.set('access-sandbox-2|', page({ added: [txn('t9', { account_id: 'acc-chk-2' })], nextCursor: 'c1' }));
    const results = await sync();
    expect(results.map((r: { ok: boolean }) => r.ok)).toEqual([false, true]);
    const items = (await get('/api/plaid')).json().items;
    expect(items[0]).toMatchObject({ status: 'login_required', error: 'Sign in again' });
    expect(await recent('acc-chk-2')).toHaveLength(1);
  });

  it('skips transactions for an account Plaid did not list', async () => {
    await link();
    fake.pages.set('access-sandbox-1|', page({ added: [txn('t1'), txn('t2', { account_id: 'acc-mystery' })], nextCursor: 'c1' }));
    expect((await sync())[0]).toMatchObject({ saved: 1 });
  });

  it('runs one sync at a time', async () => {
    await link();
    const [a, b] = await Promise.all([send('POST', '/api/plaid/sync'), send('POST', '/api/plaid/sync')]);
    expect(a.json()).toEqual(b.json());
    expect(fake.calls.filter((c) => c.startsWith('sync:'))).toHaveLength(1);
  });

  it('disconnecting a bank deletes its raw transactions', async () => {
    await link();
    fake.pages.set('access-sandbox-1|', page({ added: [txn('t1')], nextCursor: 'c1' }));
    await sync();
    await send('DELETE', '/api/plaid/items/item-1');
    expect(db.prepare('SELECT COUNT(*) AS n FROM bank_transactions').get()).toEqual({ n: 0 });
  });

  it('lists only known accounts', async () => {
    expect((await get('/api/plaid/accounts/nope/transactions')).statusCode).toBe(404);
  });
});

describe('card statements', () => {
  const card: Bill = {
    code: 'CHASE', name: 'Chase card', category: 'Credit Card', direction: 'out', active: true,
    schedule: { kind: 'monthly', day: 25 }, amountMode: 'auto', amountCents: 800_00, minCents: null, notes: '', sort: 1,
  };
  const other: Bill = { ...card, code: 'AMEX', name: 'Amex', schedule: { kind: 'monthly', day: 10 } };
  const pay: Bill = { ...card, code: 'PAY', name: 'Paycheck', direction: 'in', category: 'Income' };
  const statement = (o: Partial<PlaidCardLiability> = {}): PlaidCardLiability => ({
    account_id: 'acc-card-1', last_statement_issue_date: '2026-10-03', last_statement_balance: 1234.56,
    minimum_payment_amount: 35, next_payment_due_date: '2026-10-28', last_payment_amount: 900,
    last_payment_date: '2026-09-27', is_overdue: false, ...o,
  });
  const overrides = () => db.prepare('SELECT code, period, amount_cents, source FROM overrides ORDER BY code, period').all();
  const cardInfo = async (id = 'acc-card-1') => (await get('/api/plaid')).json().items
    .flatMap((i: { accounts: unknown[] }) => i.accounts).find((a: { accountId: string }) => a.accountId === id);

  beforeEach(async () => {
    start({});
    for (const b of [card, other, pay]) upsertBill(db, b);
    await link();
  });

  it('saves the statement, and sets it as the known amount on the payment nearest the due date', async () => {
    fake.liabilities = [statement()];
    await send('POST', '/api/plaid/sync');
    expect((await cardInfo()).statement).toMatchObject({
      date: '2026-10-03', balanceCents: 1234_56, minDueCents: 35_00, dueDate: '2026-10-28',
      lastPaymentCents: 900_00, lastPaymentDate: '2026-09-27', overdue: false,
    });
    expect(overrides()).toEqual([]);

    expect((await send('PUT', '/api/plaid/accounts/acc-card-1', { billCode: 'CHASE' })).statusCode).toBe(200);
    expect(overrides()).toEqual([{ code: 'CHASE', period: '2026-10', amount_cents: 1234_56, source: 'plaid' }]);
    expect((await cardInfo()).statementUse).toMatchObject({ billCode: 'CHASE', occurrenceDate: '2026-10-25', keptManual: false });

    // It's an ordinary known amount to the forecast.
    insertSnapshot(db, { account: 'checking', date: '2026-10-01', amountCents: 5000_00 });
    const { forecast } = (await get('/api/forecast?today=2026-10-06')).json();
    expect(forecast.events.find((e: { code: string }) => e.code === 'CHASE')).toMatchObject({ status: 'known', amountCents: 1234_56 });
  });

  it('follows the next statement, and never overwrites an amount typed in', async () => {
    fake.liabilities = [statement()];
    await send('PUT', '/api/plaid/accounts/acc-card-1', { billCode: 'CHASE' });
    await send('POST', '/api/plaid/sync');
    fake.liabilities = [statement({ last_statement_balance: 1300 })];
    await send('POST', '/api/plaid/sync');
    expect(overrides()).toEqual([{ code: 'CHASE', period: '2026-10', amount_cents: 1300_00, source: 'plaid' }]);

    await send('PUT', '/api/overrides', { code: 'CHASE', period: '2026-10', amountCents: 1000_00 });
    await send('POST', '/api/plaid/sync');
    expect(overrides()).toEqual([{ code: 'CHASE', period: '2026-10', amount_cents: 1000_00, source: 'manual' }]);
    expect((await cardInfo()).statementUse.keptManual).toBe(true);
  });

  it('adds up cards paid by the same bill, and a credit balance counts as nothing due', async () => {
    fake.liabilities = [statement(), statement({ account_id: 'acc-card-2', last_statement_balance: -20 })];
    await link('public-sandbox-second');
    await send('PUT', '/api/plaid/accounts/acc-card-1', { billCode: 'CHASE' });
    await send('PUT', '/api/plaid/accounts/acc-card-2', { billCode: 'CHASE' });
    await send('POST', '/api/plaid/sync');
    expect(overrides()).toEqual([{ code: 'CHASE', period: '2026-10', amount_cents: 1234_56, source: 'plaid' }]);
    fake.liabilities = [statement({ last_statement_balance: 100 }), statement({ account_id: 'acc-card-2', last_statement_balance: 50 })];
    await send('POST', '/api/plaid/sync');
    expect(overrides()).toEqual([{ code: 'CHASE', period: '2026-10', amount_cents: 150_00, source: 'plaid' }]);
  });

  it('moving a card to another bill takes the amount back from the old one', async () => {
    fake.liabilities = [statement({ next_payment_due_date: '2026-10-12' })];
    await send('POST', '/api/plaid/sync');
    await send('PUT', '/api/plaid/accounts/acc-card-1', { billCode: 'CHASE' });
    expect(overrides()).toEqual([{ code: 'CHASE', period: '2026-10', amount_cents: 1234_56, source: 'plaid' }]);
    await send('PUT', '/api/plaid/accounts/acc-card-1', { billCode: 'AMEX' });
    expect(overrides()).toEqual([{ code: 'AMEX', period: '2026-10', amount_cents: 1234_56, source: 'plaid' }]);
    await send('PUT', '/api/plaid/accounts/acc-card-1', { billCode: null });
    expect(overrides()).toEqual([]);
  });

  it('says so when the bill has no payment near the due date', async () => {
    upsertBill(db, { ...card, code: 'RARE', schedule: { kind: 'none' } });
    fake.liabilities = [statement({ next_payment_due_date: '2026-11-15' })];
    await send('POST', '/api/plaid/sync');
    await send('PUT', '/api/plaid/accounts/acc-card-1', { billCode: 'RARE' });
    expect((await cardInfo()).statementUse).toEqual({ problem: 'Chase card has no scheduled payment near the due date.' });
    expect(overrides()).toEqual([]);
  });

  it("raises the next payment after the statement to what's already on the card", async () => {
    upsertBill(db, { ...card, amountMode: 'fixed', amountCents: 200_00 });
    // Card balance $410.30, of which the $100 statement isn't paid yet: $310.30 is new charges.
    fake.liabilities = [statement({ last_statement_balance: 100, last_payment_date: '2026-09-27' })];
    await send('PUT', '/api/plaid/accounts/acc-card-1', { billCode: 'CHASE' });
    await send('POST', '/api/plaid/sync');
    insertSnapshot(db, { account: 'checking', date: '2026-10-01', amountCents: 5000_00 });
    const { forecast } = (await get('/api/forecast?today=2026-10-06')).json();
    const events = forecast.events.filter((e: { code: string }) => e.code === 'CHASE')
      .map((e: { period: string; amountCents: number; status: string; raisedFromCents: number | null }) => [e.period, e.status, e.amountCents, e.raisedFromCents]);
    expect(events.slice(0, 2)).toEqual([['2026-10', 'known', 100_00, null], ['2026-11', 'scheduled', 310_30, 200_00]]);
  });

  it('only outgoing bills can pay a card', async () => {
    expect((await send('PUT', '/api/plaid/accounts/acc-card-1', { billCode: 'PAY' })).statusCode).toBe(400);
    expect((await send('PUT', '/api/plaid/accounts/acc-card-1', { billCode: 'NOPE' })).statusCode).toBe(400);
  });

  it('a bank without statements still syncs', async () => {
    fake.liabilities = new PlaidError(400, { error_type: 'ITEM_ERROR', error_code: 'PRODUCTS_NOT_SUPPORTED' });
    const [r] = (await send('POST', '/api/plaid/sync')).json().results;
    expect(r.ok).toBe(true);
    expect((await cardInfo()).statement).toBeNull();
  });
});

describe('bank balance check', () => {
  const balances = async () => (await get('/api/plaid/balances')).json();

  it('is off without Plaid', async () => {
    start(null);
    expect(await balances()).toEqual({ enabled: false });
  });

  describe('with a bank', () => {
    beforeEach(async () => {
      start({});
      await link();
      await send('POST', '/api/plaid/sync');
    });

    it('has nothing to compare until an account is set as checking', async () => {
      expect(await balances()).toEqual({ enabled: true, checking: null, savings: null });
      const res = await send('POST', '/api/plaid/use-balance?today=2026-10-06', { account: 'checking' });
      expect(res.statusCode).toBe(409);
    });

    it("reports the available balance, and records it as today's balance on request", async () => {
      await send('PUT', '/api/plaid/accounts/acc-chk-1', { role: 'checking' });
      const b = await balances();
      expect(b.checking).toMatchObject({
        amountCents: 1234_56,
        accounts: [{ name: 'Checking', mask: '0000', institution: 'First Platypus Bank' }],
      });
      expect(b.checking.fetchedAt).toBeTypeOf('number');

      const res = await send('POST', '/api/plaid/use-balance?today=2026-10-06', { account: 'checking' });
      expect(res.statusCode).toBe(201);
      expect(db.prepare("SELECT date, amount_cents FROM snapshots WHERE account = 'checking'").all())
        .toEqual([{ date: '2026-10-06', amount_cents: 1234_56 }]);
    });

    it('adds up accounts with the same role, using current where available is missing', async () => {
      await send('PUT', '/api/plaid/accounts/acc-chk-1', { role: 'savings' });
      await send('PUT', '/api/plaid/accounts/acc-card-1', { role: 'savings' });
      expect((await balances()).savings.amountCents).toBe(1234_56 + 410_30);
    });

    it('ignores disconnected banks', async () => {
      await send('PUT', '/api/plaid/accounts/acc-chk-1', { role: 'checking' });
      await send('DELETE', '/api/plaid/items/item-1');
      expect((await balances()).checking).toBeNull();
    });
  });
});

describe('matching checking activity', () => {
  const chase: Bill = {
    code: 'CHASE', name: 'Chase card', category: 'Credit Card', direction: 'out', active: true,
    schedule: { kind: 'monthly', day: 25 }, amountMode: 'auto', amountCents: 800_00, minCents: null, notes: '', sort: 1,
  };
  const xfer: Bill = {
    ...chase, code: 'XFER', name: 'Transfer from savings', category: 'Savings draw', direction: 'in',
    schedule: { kind: 'none' }, amountMode: 'fixed', amountCents: 0, sort: 2,
  };
  const venmo: Bill = { ...xfer, code: 'MISC', name: 'Other spending', category: 'Uncategorized', direction: 'out', sort: 3 };

  // Plaid's pages for item-1, one per sync.
  let cursor = '';
  const next = (o: Partial<SyncPage>) => {
    const nextCursor = `c${cursor.length + 1}x`;
    fake.pages.set(`access-sandbox-1|${cursor}`, page({ nextCursor, ...o }));
    cursor = nextCursor;
  };
  const sync = () => send('POST', '/api/plaid/sync');
  const ledger = () => db.prepare('SELECT code, date, amount_cents, source, bank_transaction_id, planned_id FROM transactions ORDER BY id').all();
  const review = async () => (await get('/api/bank-review')).json();

  beforeEach(async () => {
    cursor = '';
    // Connected Oct 1 (Eastern), so activity counts from Oct 2.
    start({}, '2026-10-01T16:00:00Z');
    for (const b of [chase, xfer, venmo]) upsertBill(db, b);
    insertSnapshot(db, { account: 'checking', date: '2026-10-01', amountCents: 5000_00 });
    await link();
    await send('PUT', '/api/plaid/accounts/acc-chk-1', { role: 'checking' });
    await send('PUT', '/api/overrides', { code: 'CHASE', period: '2026-10', amountCents: 1200_00 });
    advance('2026-10-28T16:00:00Z');
  });

  it('marks a bill paid when a payment fits its amount, a little under for returns', async () => {
    next({ added: [txn('b1', { date: '2026-10-26', amount: 1150, name: 'CHASE CREDIT CRD AUTOPAY' })] });
    await sync();
    expect(ledger()).toEqual([{ code: 'CHASE', date: '2026-10-26', amount_cents: 1150_00, source: 'plaid', bank_transaction_id: 'b1', planned_id: null }]);
    expect(await review()).toEqual([]);
    const { forecast } = (await get('/api/forecast')).json();
    expect(forecast.events.find((e: { code: string }) => e.code === 'CHASE')).toMatchObject({ status: 'posted', amountCents: 1150_00 });
  });

  it('sends anything more than expected, or too far under, to review', async () => {
    next({ added: [txn('over', { date: '2026-10-26', amount: 1250 }), txn('under', { date: '2026-10-26', amount: 900 })] });
    await sync();
    expect(ledger()).toEqual([]);
    expect((await review()).map((r: { transactionId: string }) => r.transactionId).sort()).toEqual(['over', 'under']);
  });

  it('links a payment already entered by hand instead of adding it again', async () => {
    await send('POST', '/api/occurrences/confirm', { code: 'CHASE', date: '2026-10-24', amountCents: 1200_00 });
    next({ added: [txn('b1', { date: '2026-10-26', amount: 1200 })] });
    await sync();
    expect(ledger()).toEqual([{ code: 'CHASE', date: '2026-10-24', amount_cents: 1200_00, source: 'manual', bank_transaction_id: 'b1', planned_id: null }]);
  });

  it('completes a planned transfer from savings when the deposit lands', async () => {
    const { id } = (await send('POST', '/api/planned', { date: '2026-10-10', code: 'XFER', amountCents: 2000_00 })).json();
    next({ added: [txn('dep', { date: '2026-10-11', amount: -2000 })] });
    await sync();
    expect(ledger()).toEqual([{ code: 'XFER', date: '2026-10-11', amount_cents: 2000_00, source: 'plaid', bank_transaction_id: 'dep', planned_id: id }]);
    expect((await get('/api/planned')).json()[0]).toMatchObject({ status: 'done', date: '2026-10-11' });
  });

  it('follows a pending payment when it posts, and drops one that never does', async () => {
    next({ added: [txn('p1', { date: '2026-10-25', amount: 1200, pending: true })] });
    await sync();
    expect(ledger()).toHaveLength(1);
    next({ removed: [{ transaction_id: 'p1' }], added: [txn('t1', { date: '2026-10-26', amount: 1190, pending_transaction_id: 'p1' })] });
    await sync();
    expect(ledger()).toEqual([{ code: 'CHASE', date: '2026-10-26', amount_cents: 1190_00, source: 'plaid', bank_transaction_id: 't1', planned_id: null }]);

    next({ added: [txn('p2', { date: '2026-10-27', amount: -2000, pending: true })] });
    const { id } = (await send('POST', '/api/planned', { date: '2026-10-27', code: 'XFER', amountCents: 2000_00 })).json();
    await sync();
    expect((await get('/api/planned')).json().find((p: { id: number }) => p.id === id).status).toBe('done');
    next({ removed: [{ transaction_id: 'p2' }] });
    await sync();
    expect(ledger()).toHaveLength(1);
    expect((await get('/api/planned')).json().find((p: { id: number }) => p.id === id).status).toBe('planned');
  });

  it('ignores activity from before the cutover, and from accounts other than checking', async () => {
    next({ added: [txn('old', { date: '2026-10-01', amount: 1200 }), txn('card', { account_id: 'acc-card-1', date: '2026-10-26', amount: 1200 })] });
    await sync();
    expect(ledger()).toEqual([]);
    expect(await review()).toEqual([]);
  });

  it('review: file an item under a code, or dismiss it', async () => {
    next({ added: [txn('v1', { date: '2026-10-20', amount: 45, name: 'VENMO' }), txn('atm', { date: '2026-10-21', amount: 60, name: 'ATM' })] });
    await sync();
    const items = await review();
    expect(items.map((r: { transactionId: string; direction: string; amountCents: number }) => [r.transactionId, r.direction, r.amountCents]))
      .toEqual([['atm', 'out', 60_00], ['v1', 'out', 45_00]]);

    expect((await send('POST', '/api/bank-review/v1/assign', { code: 'MISC', note: 'Dinner' })).statusCode).toBe(201);
    expect((await send('POST', '/api/bank-review/atm/dismiss')).statusCode).toBe(200);
    expect(await review()).toEqual([]);
    // An off-schedule type is a one-off: it shows on the One-offs page as done.
    const [oneOff] = (await get('/api/planned')).json();
    expect(oneOff).toMatchObject({ code: 'MISC', date: '2026-10-20', amountCents: 45_00, direction: 'out', note: 'Dinner', status: 'done' });
    expect(ledger()).toEqual([{ code: 'MISC', date: '2026-10-20', amount_cents: 45_00, source: 'plaid', bank_transaction_id: 'v1', planned_id: oneOff.id }]);
    expect((await send('POST', '/api/bank-review/atm/dismiss')).statusCode).toBe(404);
    expect((await send('POST', '/api/bank-review/v1/assign', { code: 'NOPE' })).statusCode).toBe(404);

    // Deleting it from One-offs sends the bank item back to review.
    expect((await send('DELETE', `/api/planned/${oneOff.id}`)).statusCode).toBe(200);
    expect(ledger()).toEqual([]);
    expect(await review()).toMatchObject([{ transactionId: 'v1', undone: true }]);
  });

  it('review: filing under a regular bill pays that bill, not a one-off', async () => {
    next({ added: [txn('big', { date: '2026-10-26', amount: 1500, name: 'CHASE CREDIT CRD AUTOPAY' })] });
    await sync();
    expect((await send('POST', '/api/bank-review/big/assign', { code: 'CHASE' })).statusCode).toBe(201);
    expect((await get('/api/planned')).json()).toEqual([]);
    expect(ledger()).toEqual([{ code: 'CHASE', date: '2026-10-26', amount_cents: 1500_00, source: 'plaid', bank_transaction_id: 'big', planned_id: null }]);
    const { forecast } = (await get('/api/forecast')).json();
    expect(forecast.events.find((e: { code: string }) => e.code === 'CHASE')).toMatchObject({ status: 'posted', amountCents: 1500_00 });
  });

  it('gives items filed before this a done one-off when the database is next opened', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'cashflow-')), 'old.db');
    const old = openDb(path);
    for (const b of [chase, venmo]) upsertBill(old, b);
    const planned = insertPlanned(old, { date: '2026-10-05', code: 'MISC', description: 'Other spending', direction: 'out', amountCents: 10_00, note: 'Lunch', status: 'done' });
    const add = old.prepare(`INSERT INTO transactions (date, code, description, direction, amount_cents, source, note, planned_id, bank_transaction_id)
      VALUES (?, ?, ?, 'out', ?, ?, ?, ?, ?)`);
    add.run('2026-10-05', 'MISC', 'Other spending', 10_00, 'manual', 'Lunch', planned, null);
    add.run('2026-10-20', 'MISC', 'Other spending', 45_00, 'plaid', 'Dinner', null, 'v1');   // filed from review
    add.run('2026-10-26', 'CHASE', 'Chase card', 1200_00, 'plaid', '', null, 'b1');          // a bill payment
    add.run('2026-10-27', 'MISC', 'Other spending', 8_00, 'manual', '', null, null);          // typed into History
    old.exec(`PRAGMA user_version = ${SCHEMA_VERSION - 1}`);
    old.close();

    const reopened = openDb(path);
    expect(reopened.prepare('SELECT id, date, code, amount_cents, note, status FROM planned ORDER BY id').all()).toEqual([
      { id: planned, date: '2026-10-05', code: 'MISC', amount_cents: 10_00, note: 'Lunch', status: 'done' },
      { id: planned + 1, date: '2026-10-20', code: 'MISC', amount_cents: 45_00, note: 'Dinner', status: 'done' },
    ]);
    expect(reopened.prepare('SELECT code, amount_cents, planned_id FROM transactions ORDER BY id').all()).toEqual([
      { code: 'MISC', amount_cents: 10_00, planned_id: planned },
      { code: 'MISC', amount_cents: 45_00, planned_id: planned + 1 },
      { code: 'CHASE', amount_cents: 1200_00, planned_id: null },
      { code: 'MISC', amount_cents: 8_00, planned_id: null },
    ]);
    reopened.close();
  });

  it('a match you delete goes to review and is not made again', async () => {
    next({ added: [txn('b1', { date: '2026-10-26', amount: 1200 })] });
    await sync();
    const [{ id }] = db.prepare('SELECT id FROM transactions').all() as { id: number }[];
    expect((await send('DELETE', `/api/transactions/${id}`)).statusCode).toBe(200);
    await sync();
    expect(ledger()).toEqual([]);
    expect(await review()).toMatchObject([{ transactionId: 'b1', undone: true }]);
  });
});

describe('bank connections in demo mode', () => {
  beforeEach(async () => {
    start({});
    await link();
    fake.pages.set('access-sandbox-1|', page({ added: [txn('t1', { name: 'ACME DAYCARE LLC', merchant_name: 'Acme Daycare' })], nextCursor: 'c1' }));
    await send('POST', '/api/plaid/sync');
  });
  const demoGet = (url: string) => app.inject({ url, headers: { cookie: `${cookie}; ${DEMO_COOKIE}=1` } });

  it('hides account numbers, disguises balances, and shows categories instead of merchants', async () => {
    const [item] = (await demoGet('/api/plaid')).json().items;
    const chk = item.accounts.find((a: { accountId: string }) => a.accountId === 'acc-chk-1');
    expect(chk.mask).toBe('');
    expect(chk.availableCents).not.toBe(1234_56);
    const [t] = (await demoGet('/api/plaid/accounts/acc-chk-1/transactions')).json();
    expect(t).toMatchObject({ name: 'General merchandise', merchantName: '' });
    expect(t.amountCents).not.toBe(12_34);
    expect((await demoGet('/api/plaid/balances')).json()).toEqual({ enabled: true, checking: null, savings: null });
  });
});
