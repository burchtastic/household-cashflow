import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/server/app.ts';
import { DEFAULT_SETTINGS, loadDataset, openDb, type DB } from '../src/server/db.ts';
import { Auth, DEFAULT_SESSION, SESSION_COOKIE, type AuthConfig } from '../src/server/auth.ts';
import type { Bill } from '../src/engine/index.ts';

const rent: Bill = {
  code: 'RENT', name: 'Rent', category: 'Housing', direction: 'out', active: true,
  schedule: { kind: 'monthly', day: 15 }, amountMode: 'fixed', amountCents: 1500_00,
  minCents: null, notes: '', sort: 1,
};
const xfer: Bill = {
  ...rent, code: 'XFER', name: 'Transfer from savings', category: 'Savings draw', direction: 'in',
  active: false, schedule: { kind: 'none' }, amountCents: 0, sort: 2,
};

let db: DB;
let app: FastifyInstance;
let sessionCookie = '';
const TODAY = '2026-10-06';
export const AUTH: AuthConfig = {
  rpID: 'localhost', rpName: 'Cashflow', origins: ['http://localhost:8787'], ...DEFAULT_SESSION,
};

beforeEach(() => {
  db = openDb(':memory:');
  loadDataset(db, {
    settings: { ...DEFAULT_SETTINGS, topUpRoundingCents: 0 },
    bills: [rent, xfer],
    transactions: [],
    overrides: [],
    planned: [],
    snapshots: [{ account: 'checking', date: '2026-10-01', amountCents: 1000_00 }],
  });
  app = buildApp(db, { timeZone: 'America/New_York', auth: AUTH });
  sessionCookie = `${SESSION_COOKIE}=${new Auth(db, AUTH).createSession()}`;
});
afterEach(async () => {
  await app.close();
  db.close();
});

/** Requests as the signed-in user. */
const inj = (o: { url: string; method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; payload?: string | object; headers?: Record<string, string> }) =>
  app.inject({ ...o, headers: { cookie: sessionCookie, ...o.headers } });

const json = (method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown, headers = {}) =>
  inj({
    method, url, payload: payload as object,
    headers: payload === undefined ? headers : { 'content-type': 'application/json', ...headers },
  });

describe('forecast API', () => {
  it('returns a forecast and a top-up when the floor is breached', async () => {
    const res = await inj({ url: `/api/forecast?today=${TODAY}` });
    expect(res.statusCode).toBe(200);
    const { forecast } = res.json();
    expect(forecast.todayBalanceCents).toBe(1000_00);
    expect(forecast.topUps[0]).toEqual({ by: '2026-10-15', amountCents: 1000_00 });
  });

  it('confirming a payment replaces the estimate', async () => {
    const res = await json('POST', '/api/occurrences/confirm', { code: 'RENT', date: '2026-10-14', amountCents: 1499_00 });
    expect(res.statusCode).toBe(201);
    const { forecast } = (await inj({ url: `/api/forecast?today=${TODAY}` })).json();
    const oct = forecast.events.find((e: { period: string }) => e.period === '2026-10');
    expect(oct).toMatchObject({ status: 'posted', amountCents: 1499_00, date: '2026-10-14' });
  });

  it('a payment set up ahead with the bank counts on its own date', async () => {
    const res = await json('POST', '/api/occurrences/confirm', { code: 'RENT', date: '2026-10-15', amountCents: 1500_00 });
    expect(res.statusCode).toBe(201);
    const { forecast } = (await inj({ url: `/api/forecast?today=${TODAY}` })).json();
    const oct = forecast.events.find((e: { period: string }) => e.period === '2026-10');
    expect(oct).toMatchObject({ status: 'posted', date: '2026-10-15', amountCents: 1500_00 });
    expect(forecast.todayBalanceCents).toBe(1000_00);
  });

  it('completing a one-off records a linked transaction, and deleting it restores the plan', async () => {
    const { id } = (await json('POST', '/api/planned', { date: '2026-10-12', code: 'XFER', amountCents: 2000_00 })).json();
    expect((await json('POST', `/api/planned/${id}/complete`, { date: '2026-10-12', amountCents: 2100_00 })).statusCode).toBe(200);
    const txns = (await inj({ url: '/api/transactions?code=XFER' })).json();
    expect(txns).toHaveLength(1);
    expect(txns[0]).toMatchObject({ plannedId: id, amountCents: 2100_00, direction: 'in' });

    expect((await json('DELETE', `/api/transactions/${txns[0].id}`)).statusCode).toBe(200);
    const planned = (await inj({ url: '/api/planned' })).json();
    expect(planned[0].status).toBe('planned');
  });

  it('logs a one-off that already happened in one step', async () => {
    const res = await json('POST', '/api/planned', { date: '2026-10-05', code: 'XFER', amountCents: 300_00, note: 'Rx', status: 'done' });
    expect(res.statusCode).toBe(201);
    const { id } = res.json();
    expect((await inj({ url: '/api/planned' })).json()[0]).toMatchObject({ id, status: 'done', note: 'Rx' });
    expect((await inj({ url: '/api/transactions?code=XFER' })).json()[0]).toMatchObject({ plannedId: id, amountCents: 300_00, date: '2026-10-05' });
    expect((await json('POST', '/api/planned', { date: '2026-10-05', code: 'XFER', amountCents: 1, status: 'skipped' })).statusCode).toBe(400);
  });

  it('a future one-off marked done stays in the forecast on its own date', async () => {
    // The reported bug: balance entered today, a transfer set up for the 12th, marked done today.
    await json('POST', '/api/snapshots', { account: 'checking', date: TODAY, amountCents: 1000_00 });
    const { id } = (await json('POST', '/api/planned', { date: '2026-10-12', code: 'XFER', amountCents: 1450_00 })).json();
    expect((await json('POST', `/api/planned/${id}/complete`, { date: '2026-10-12', amountCents: 1450_00 })).statusCode).toBe(200);
    const { forecast } = (await inj({ url: `/api/forecast?today=${TODAY}` })).json();
    const xfer = forecast.events.find((e: { code: string }) => e.code === 'XFER');
    expect(xfer).toMatchObject({ date: '2026-10-12', status: 'posted', amountCents: 1450_00, balanceCents: 2450_00 });
    // Set up in one step works the same way.
    const res = await json('POST', '/api/planned', { date: '2026-10-20', code: 'XFER', amountCents: 100_00, status: 'done' });
    expect(res.statusCode).toBe(201);
    const after = (await inj({ url: `/api/forecast?today=${TODAY}` })).json().forecast;
    expect(after.events.filter((e: { code: string }) => e.code === 'XFER').map((e: { date: string }) => e.date))
      .toEqual(['2026-10-12', '2026-10-20']);
  });

  it('can take a logged item out of a balance entered before it', async () => {
    // The checking balance (1000) is dated Oct 1; an Oct 1 expense logged later isn't in it yet.
    const body = { date: '2026-10-01', code: 'XFER', amountCents: 200_00, status: 'done', adjustBalance: true };
    expect((await json('POST', '/api/planned', body)).statusCode).toBe(201);
    const { forecast } = (await inj({ url: `/api/forecast?today=${TODAY}` })).json();
    expect(forecast.start).toEqual({ date: '2026-10-01', balanceCents: 1200_00 }); // XFER is money in
    // Only for done items on or before the balance date.
    expect((await json('POST', '/api/planned', { ...body, date: '2026-10-02' })).statusCode).toBe(400);
    expect((await json('POST', '/api/planned', { ...body, status: 'planned' })).statusCode).toBe(400);
  });

  it('deleting a done one-off removes its transaction too', async () => {
    const { id } = (await json('POST', '/api/planned', { date: '2026-10-05', code: 'XFER', amountCents: 500_00, status: 'done' })).json();
    expect((await json('DELETE', `/api/planned/${id}`)).statusCode).toBe(200);
    expect((await inj({ url: '/api/planned' })).json()).toEqual([]);
    expect((await inj({ url: '/api/transactions?code=XFER' })).json()).toEqual([]);
  });
});

describe('notes', () => {
  it('a note on an upcoming bill shows in the forecast and carries into the payment', async () => {
    expect((await json('PUT', '/api/occurrences/note', { code: 'RENT', period: '2026-10', note: ' plumbing repair ' })).statusCode).toBe(200);
    const find = async () => (await inj({ url: `/api/forecast?today=${TODAY}` })).json().forecast.events
      .find((e: { period: string }) => e.period === '2026-10');
    expect((await find()).note).toBe('plumbing repair');
    await json('POST', '/api/occurrences/confirm', { code: 'RENT', date: '2026-10-14', amountCents: 1500_00, note: 'plumbing repair' });
    expect(await find()).toMatchObject({ status: 'posted', note: 'plumbing repair' });
    expect((await json('PUT', '/api/occurrences/note', { code: 'RENT', period: '2026-10', note: '' })).statusCode).toBe(200);
  });

  it('editing a transaction note in history updates its one-off too', async () => {
    const { id } = (await json('POST', '/api/planned', { date: '2026-10-05', code: 'XFER', amountCents: 5_00, status: 'done' })).json();
    const [t] = (await inj({ url: '/api/transactions?code=XFER' })).json();
    expect((await json('PATCH', `/api/transactions/${t.id}`, { note: 'Rx' })).statusCode).toBe(200);
    expect((await inj({ url: '/api/transactions?code=XFER' })).json()[0].note).toBe('Rx');
    expect((await inj({ url: '/api/planned' })).json().find((p: { id: number }) => p.id === id).note).toBe('Rx');
    expect((await json('PATCH', '/api/transactions/9999', { note: 'x' })).statusCode).toBe(404);
    expect((await json('PATCH', `/api/transactions/${t.id}`, {})).statusCode).toBe(400);
    expect((await json('PATCH', `/api/transactions/${t.id}`, { description: 'x' })).statusCode).toBe(400);
    expect((await json('PATCH', `/api/transactions/${t.id}`, { date: '2026-13-40' })).statusCode).toBe(400);
  });

  it('editing a done one-off from the One-offs page moves its transaction too', async () => {
    await json('POST', '/api/snapshots', { account: 'checking', date: TODAY, amountCents: 1000_00 });
    const { id } = (await json('POST', '/api/planned', { date: '2026-10-12', code: 'XFER', amountCents: 1450_00 })).json();
    // Completing records the real date and amount on both.
    await json('POST', `/api/planned/${id}/complete`, { date: '2026-10-13', amountCents: 1400_00 });
    const plannedNow = () => inj({ url: '/api/planned' }).then((r) => r.json().find((p: { id: number }) => p.id === id));
    expect(await plannedNow()).toMatchObject({ date: '2026-10-13', amountCents: 1400_00, status: 'done' });

    const res = await json('PUT', `/api/planned/${id}`, { date: '2026-10-15', code: 'XFER', amountCents: 1300_00, note: 'moved' });
    expect(res.statusCode).toBe(200);
    expect((await inj({ url: '/api/transactions?code=XFER' })).json())
      .toMatchObject([{ date: '2026-10-15', amountCents: 1300_00, note: 'moved', plannedId: id }]);
    const { forecast } = (await inj({ url: `/api/forecast?today=${TODAY}` })).json();
    expect(forecast.events.filter((e: { code: string }) => e.code === 'XFER'))
      .toMatchObject([{ date: '2026-10-15', status: 'posted', amountCents: 1300_00 }]);
    // Putting it back on the plan is Undo's job, which removes the transaction.
    expect((await json('PUT', `/api/planned/${id}`, { date: '2026-10-15', code: 'XFER', amountCents: 1300_00, status: 'planned' })).statusCode).toBe(400);
  });

  it('editing a set-up transfer moves it and its one-off, and the forecast follows', async () => {
    await json('POST', '/api/snapshots', { account: 'checking', date: TODAY, amountCents: 1000_00 });
    const { id } = (await json('POST', '/api/planned', { date: '2026-10-12', code: 'XFER', amountCents: 1450_00, status: 'done' })).json();
    const [t] = (await inj({ url: '/api/transactions?code=XFER' })).json();
    const res = await json('PATCH', `/api/transactions/${t.id}`, { date: '2026-10-14', amountCents: 1200_00, note: 'moved' });
    expect(res.statusCode).toBe(200);
    expect((await inj({ url: '/api/planned' })).json().find((p: { id: number }) => p.id === id))
      .toMatchObject({ date: '2026-10-14', amountCents: 1200_00, note: 'moved', status: 'done' });
    const { forecast } = (await inj({ url: `/api/forecast?today=${TODAY}` })).json();
    expect(forecast.events.find((e: { code: string }) => e.code === 'XFER'))
      .toMatchObject({ date: '2026-10-14', status: 'posted', amountCents: 1200_00, note: 'moved', balanceCents: 2200_00 });
  });
});

describe('security', () => {
  it('sets a strict CSP and no-store on API responses', async () => {
    const res = await inj({ url: '/api/health' });
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('refuses cross-origin writes', async () => {
    const res = await json('POST', '/api/snapshots',
      { account: 'checking', date: '2026-10-01', amountCents: 1 },
      { origin: 'https://evil.example', host: 'localhost:8787' });
    expect(res.statusCode).toBe(403);
  });

  it('accepts writes from a configured origin even when a proxy rewrote Host', async () => {
    const res = await json('POST', '/api/snapshots',
      { account: 'checking', date: '2026-10-01', amountCents: 1 },
      { origin: 'http://localhost:8787', host: '127.0.0.1:8787' });
    expect(res.statusCode).toBe(201);
  });

  it('refuses cross-site writes flagged by the browser', async () => {
    const res = await json('POST', '/api/snapshots',
      { account: 'checking', date: '2026-10-01', amountCents: 1 },
      { 'sec-fetch-site': 'cross-site' });
    expect(res.statusCode).toBe(403);
  });

  it('refuses form-encoded bodies', async () => {
    const res = await inj({
      method: 'POST', url: '/api/snapshots',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'account=checking&date=2026-10-01&amountCents=1',
    });
    expect(res.statusCode).toBe(415);
  });

  it('rejects unknown fields, bad dates, and fractional cents', async () => {
    expect((await json('POST', '/api/transactions', { date: '2026-10-01', code: 'RENT', amountCents: 1, extra: 1 })).statusCode).toBe(400);
    expect((await json('POST', '/api/transactions', { date: '2026-02-30', code: 'RENT', amountCents: 1 })).statusCode).toBe(400);
    expect((await json('POST', '/api/transactions', { date: '2026-10-01', code: 'RENT', amountCents: 1.5 })).statusCode).toBe(400);
    expect((await json('POST', '/api/transactions', { date: '2026-10-01', code: 'NOPE', amountCents: 1 })).statusCode).toBe(400);
  });

  it('does not leak internals on errors', async () => {
    const res = await inj({ url: '/api/forecast?today=garbage' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'today must be YYYY-MM-DD' });
  });
});

describe('static files', () => {
  it('serves assets added after startup, and 404s missing ones instead of returning HTML', async () => {
    const { mkdtempSync, writeFileSync, mkdirSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'cf-static-'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><div id="root"></div>');
    const s = buildApp(db, { timeZone: 'America/New_York', auth: AUTH, staticDir: dir });
    await s.ready();
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'assets', 'late.js'), 'export {}');

    const late = await s.inject({ url: '/assets/late.js' });
    expect(late.statusCode).toBe(200);
    expect(late.headers['content-type']).toContain('javascript');
    expect((await s.inject({ url: '/assets/missing.js' })).statusCode).toBe(404);
    const page = await s.inject({ url: '/bills' });
    expect(page.headers['content-type']).toContain('text/html');
    await s.close();
  });
});
