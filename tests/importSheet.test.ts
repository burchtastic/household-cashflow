import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/server/app.ts';
import { DEFAULT_SETTINGS, listBills, listSnapshots, listTransactions, loadDataset, openDb, type DB } from '../src/server/db.ts';
import { Auth, DEFAULT_SESSION, SESSION_COOKIE, type AuthConfig } from '../src/server/auth.ts';
import { makeCode, planImport, readWorkbook, toCents, toISODate, type Cell, type Sheets } from '../src/server/importSheet.ts';

const AUTH: AuthConfig = { rpID: 'localhost', rpName: 'Cashflow', origins: ['http://localhost:8787'], ...DEFAULT_SESSION };

const TEMPLATE = readFileSync('src/web/public/cashflow-import-template.xlsx');
const empty = { bills: [], transactions: [], snapshots: [] };
const sheets = (s: Record<string, Cell[][]>): Sheets => new Map(Object.entries(s));
const BILLS_HEAD = ['Name', 'Money in or out', 'Category', 'Amount', 'Amount varies?', 'How often', 'Day of month', 'Next date', 'Code'];

describe('reading the template', () => {
  it('finds every tab and its example rows', () => {
    const wb = readWorkbook(TEMPLATE);
    expect([...wb.keys()]).toEqual(['start here', 'bills', 'history', 'balances']);
    expect(wb.get('bills')![1]).toEqual(['Mortgage', 'Out', 'Housing', 1850, 'No', 'Monthly', 1, null, 'MORT']);
  });

  it('plans the examples', () => {
    const plan = planImport(readWorkbook(TEMPLATE), empty);
    expect(plan.errors).toEqual([]);
    expect(plan.newBills.map((b) => [b.code, b.direction, b.amountMode, b.schedule])).toEqual([
      ['MORT', 'out', 'fixed', { kind: 'monthly', day: 1 }],
      ['PAY', 'in', 'fixed', { kind: 'interval', anchor: '2026-10-02', everyDays: 14 }],
      ['ELECTRIC', 'out', 'auto', { kind: 'monthly', day: 18 }],
      ['VISACARD', 'out', 'auto', { kind: 'monthly', day: 25 }],
      ['XFER', 'in', 'fixed', { kind: 'none' }],
    ]);
    expect(plan.newTypes.map((b) => [b.code, b.name, b.direction])).toEqual([['PLUMBER', 'Plumber', 'out']]);
    expect(plan.transactions).toContainEqual(expect.objectContaining({
      date: '2026-09-18', code: 'ELECTRIC', amountCents: 162_37, direction: 'out', note: 'AC ran a lot', source: 'import',
    }));
    expect(plan.snapshots).toEqual([
      { account: 'checking', date: '2026-10-01', amountCents: 3250_00 },
      { account: 'savings', date: '2026-10-01', amountCents: 15000_00 },
    ]);
  });

  it("refuses something that isn't a workbook", () => {
    expect(() => readWorkbook(Buffer.from('date,amount\n2026-01-01,5'))).toThrow(/xlsx/);
  });
});

describe('planning', () => {
  it('reads dates and amounts the way people type them', () => {
    expect(toISODate(46296)).toBe('2026-10-01');
    expect(toISODate('10/1/2026')).toBe('2026-10-01');
    expect(toISODate('2026-10-01')).toBe('2026-10-01');
    expect(toISODate('13/45/2026')).toBeNull();
    expect(toCents('$1,234.5')).toBe(1234_50);
    expect(toCents(-45)).toBe(45_00);
    expect(toCents('lots')).toBeNull();
  });

  it('makes unique codes', () => {
    const taken = new Set(['ELECTRIC']);
    expect(makeCode('Electric', taken)).toBe('ELECTRIC2');
    expect(makeCode('***', taken)).toBe('ITEM');
  });

  it('says which row is wrong and why', () => {
    const plan = planImport(sheets({
      bills: [BILLS_HEAD, ['Rent', 'Sideways', 'Housing', 1000, 'No', 'Monthly', 1], ['Gym', 'Out', 'Fun', 40, 'No', 'Monthly', 0]],
      history: [['Date', 'Item', 'Amount'], ['someday', 'Rent', 5], ['2026-01-01', 'Mystery', 5]],
    }), empty);
    expect(plan.errors).toEqual([
      { sheet: 'Bills', row: 2, message: 'Rent: "Money in or out" must be In or Out.' },
      { sheet: 'Bills', row: 3, message: 'Gym: Monthly items need a day of the month (1-31).' },
      { sheet: 'History', row: 2, message: '"someday" isn\'t a date.' },
      { sheet: 'History', row: 3, message: "Mystery isn't on the Bills sheet, so say whether it's money In or Out." },
    ]);
  });

  it('leaves bills already in the app alone and skips history it already has', () => {
    const first = planImport(readWorkbook(TEMPLATE), empty);
    const current = {
      bills: [...first.newBills, ...first.newTypes],
      transactions: first.transactions.map((t, i) => ({ ...t, id: i + 1 })),
      snapshots: first.snapshots,
    };
    const again = planImport(readWorkbook(TEMPLATE), current);
    expect(again).toMatchObject({
      newBills: [], newTypes: [], existingBills: 5, transactions: [], duplicateTransactions: 5, snapshots: [], duplicateSnapshots: 2,
    });
  });
});

describe('import API', () => {
  let db: DB;
  let app: FastifyInstance;
  let cookie = '';
  beforeEach(() => {
    db = openDb(':memory:');
    loadDataset(db, { settings: DEFAULT_SETTINGS, bills: [], transactions: [], overrides: [], planned: [], snapshots: [] });
    app = buildApp(db, { timeZone: 'America/New_York', auth: AUTH });
    cookie = `${SESSION_COOKIE}=${new Auth(db, AUTH).createSession()}`;
  });
  afterEach(async () => { await app.close(); });

  const send = (url: string, body: Buffer) => app.inject({
    method: 'POST', url, payload: body, headers: { cookie, 'content-type': 'application/octet-stream' },
  });

  it('previews without saving, then imports', async () => {
    const preview = await send('/api/import/preview', TEMPLATE);
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({ transactions: 5, errorCount: 0, firstDate: '2026-09-01', lastDate: '2026-09-25' });
    expect(listBills(db)).toEqual([]);

    expect((await send('/api/import', TEMPLATE)).statusCode).toBe(200);
    expect(listBills(db)).toHaveLength(6);
    expect(listTransactions(db)).toHaveLength(5);
    expect(listSnapshots(db)).toHaveLength(2);
    // The forecast now has somewhere to start.
    expect((await app.inject({ method: 'GET', url: '/api/forecast?today=2026-10-07', headers: { cookie } })).statusCode).toBe(200);
  });

  it('turns away a bad file with a reason, and needs a session', async () => {
    const bad = await send('/api/import/preview', Buffer.from('not a spreadsheet'));
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toMatch(/xlsx/);
    const anon = await app.inject({ method: 'POST', url: '/api/import', payload: TEMPLATE, headers: { 'content-type': 'application/octet-stream' } });
    expect(anon.statusCode).toBe(401);
  });

  it('only the import routes take raw bytes', async () => {
    const res = await send('/api/transactions', TEMPLATE);
    expect(res.statusCode).toBe(415);
  });
});
