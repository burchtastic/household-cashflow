import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/server/app.ts';
import { DEFAULT_SETTINGS, loadDataset, openDb, type DB } from '../src/server/db.ts';
import { Auth, DEFAULT_SESSION, SESSION_COOKIE, type AuthConfig } from '../src/server/auth.ts';
import { DEMO_COOKIE, disguise, wobble } from '../src/server/demo.ts';
import type { Bill } from '../src/engine/index.ts';

const AUTH: AuthConfig = { rpID: 'localhost', rpName: 'Cashflow', origins: ['http://localhost:8787'], ...DEFAULT_SESSION };
const TODAY = '2026-10-06';

const mortgage: Bill = {
  code: 'MORT', name: 'Mortgage', category: 'Housing', direction: 'out', active: true,
  schedule: { kind: 'monthly', day: 15 }, amountMode: 'fixed', amountCents: 2345_67, minCents: null, notes: '', sort: 1,
};
const pay: Bill = {
  ...mortgage, code: 'PAY', name: 'Paycheck', category: 'Income', direction: 'in',
  schedule: { kind: 'interval', anchor: '2026-10-09', everyDays: 14 }, amountCents: 3210_98, sort: 2,
};
const card: Bill = { ...mortgage, code: 'CARD', name: 'Card', category: 'Credit Card', amountMode: 'auto', amountCents: 1876_54, schedule: { kind: 'monthly', day: 25 }, sort: 3 };
const power: Bill = { ...mortgage, code: 'POWER', name: 'Electric', category: 'Utility', amountCents: 187_65, schedule: { kind: 'monthly', day: 3 }, sort: 4 };

let db: DB;
let app: FastifyInstance;
let session = '';
const REAL = new Set<number>();

beforeEach(() => {
  db = openDb(':memory:');
  const transactions = [
    { id: 1, date: '2026-09-15', code: 'MORT', description: 'Mortgage', direction: 'out' as const, amountCents: 2345_67, source: 'manual', note: '', plannedId: null },
    { id: 2, date: '2026-09-25', code: 'CARD', description: 'Card', direction: 'out' as const, amountCents: 1543_21, source: 'manual', note: 'groceries', plannedId: null },
    { id: 3, date: '2026-09-25', code: 'PAY', description: 'Paycheck', direction: 'in' as const, amountCents: 3210_98, source: 'manual', note: '', plannedId: null },
  ];
  const snapshots = [
    { account: 'checking' as const, date: '2026-10-01', amountCents: 6789_01 },
    { account: 'savings' as const, date: '2026-10-01', amountCents: 14321_09 },
  ];
  loadDataset(db, {
    settings: DEFAULT_SETTINGS, bills: [mortgage, pay, card, power], transactions, planned: [],
    overrides: [{ code: 'CARD', period: '2026-10', amountCents: 1999_99 }], snapshots,
  });
  for (const n of [2345_67, 3210_98, 1876_54, 187_65, 1543_21, 6789_01, 14321_09, 1999_99]) REAL.add(n);
  app = buildApp(db, { timeZone: 'America/New_York', auth: AUTH });
  session = `${SESSION_COOKIE}=${new Auth(db, AUTH).createSession()}`;
});
afterEach(async () => {
  await app.close();
  db.close();
});

const demoCookie = `${DEMO_COOKIE}=1`;
const get = (url: string, demo = true) =>
  app.inject({ url, headers: { cookie: demo ? `${session}; ${demoCookie}` : session } });

/** Every number anywhere in a JSON value. */
function numbers(v: unknown, out: number[] = []): number[] {
  if (typeof v === 'number') out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => numbers(x, out));
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => numbers(x, out));
  return out;
}

describe('demo mode', () => {
  it('is switched per browser with a cookie, and reported by the status call', async () => {
    const on = await app.inject({
      method: 'POST', url: '/api/demo', payload: { on: true }, headers: { cookie: session, 'content-type': 'application/json' },
    });
    expect(on.headers['set-cookie']).toMatch(new RegExp(`^${DEMO_COOKIE}=1; Path=/; HttpOnly; Secure; SameSite=Strict`));
    expect((await get('/api/auth/status')).json().demo).toBe(true);
    expect((await get('/api/auth/status', false)).json().demo).toBe(false);
  });

  it('shows none of the real amounts anywhere', async () => {
    for (const url of [`/api/forecast?today=${TODAY}`, `/api/bills?today=${TODAY}`, '/api/transactions', '/api/snapshots', '/api/planned',
      '/api/reports?from=2026-01-01&to=2026-12-31']) {
      const res = await get(url);
      expect(res.statusCode, url).toBe(200);
      const leaked = numbers(res.json()).filter((n) => REAL.has(n));
      expect(leaked, url).toEqual([]);
    }
    // And the real view still has them.
    expect(numbers((await get('/api/snapshots', false)).json())).toContain(6789_01);
  });

  it('scales by kind of money, with a small fixed wobble', async () => {
    const bills = (await get(`/api/bills?today=${TODAY}`)).json().bills as Bill[];
    const ratio = (code: string, real: number) => bills.find((b) => b.code === code)!.amountCents / real;
    const near = (r: number, f: number) => r >= f * 0.94 - 0.001 && r <= f * 1.06 + 0.001;
    expect(near(ratio('PAY', 3210_98), 0.7)).toBe(true);
    expect(near(ratio('CARD', 1876_54), 0.5)).toBe(true);
    expect(near(ratio('MORT', 2345_67), 0.75)).toBe(true);
    expect(near(ratio('POWER', 187_65), 0.6)).toBe(true);
    // Fixed per item: a fixed bill stays fixed across history.
    expect(disguise(2345_67, 'Housing', 'MORT')).toBe(disguise(2345_67, 'Housing', 'MORT'));
    expect(wobble('MORT')).not.toBe(wobble('PAY'));
  });

  it('still forecasts from the disguised numbers', async () => {
    const { forecast } = (await get(`/api/forecast?today=${TODAY}`)).json();
    expect(forecast.start.balanceCents).toBe(disguise(6789_01, 'Balance', 'checking'));
    const mort = forecast.events.find((e: { code: string; period: string }) => e.code === 'MORT' && e.period === '2026-10');
    expect(mort.amountCents).toBe(disguise(2345_67, 'Housing', 'MORT'));
  });

  it('is read-only, except for turning it off', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/snapshots', payload: { account: 'checking', date: '2026-10-05', amountCents: 1 },
      headers: { cookie: `${session}; ${demoCookie}`, 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/Demo mode is on/);
    const off = await app.inject({
      method: 'POST', url: '/api/demo', payload: { on: false },
      headers: { cookie: `${session}; ${demoCookie}`, 'content-type': 'application/json' },
    });
    expect(off.statusCode).toBe(200);
    expect(off.headers['set-cookie']).toMatch(/Max-Age=0/);
  });
});
