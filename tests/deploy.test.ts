import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, type AppOptions } from '../src/server/app.ts';
import { openDb, type DB } from '../src/server/db.ts';
import { Auth, DEFAULT_SESSION, SESSION_COOKIE, type AuthConfig } from '../src/server/auth.ts';
import type { DeployConfig } from '../src/server/deploy.ts';

const AUTH: AuthConfig = { rpID: 'localhost', rpName: 'Cashflow', origins: ['http://localhost:8787'], ...DEFAULT_SESSION };

const NOW = Date.parse('2026-10-07T12:00:00Z');
let dir: string;
let cfg: DeployConfig;
let db: DB;
let app: FastifyInstance;
let cookie = '';

const start = (extra: Partial<AppOptions> = {}) => {
  app = buildApp(db, { timeZone: 'America/New_York', auth: AUTH, deploy: cfg, now: () => NOW, ...extra });
  cookie = `${SESSION_COOKIE}=${new Auth(db, AUTH, undefined, () => NOW).createSession()}`;
};
const get = () => app.inject({ url: '/api/admin/deploy', headers: { cookie } });
const post = (action: string) => app.inject({
  method: 'POST', url: '/api/admin/deploy', payload: { action },
  headers: { cookie, 'content-type': 'application/json' },
});
const status = (s: object) => writeFileSync(cfg.statusFile, JSON.stringify(s));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cashflow-deploy-'));
  cfg = { requestDir: join(dir, 'req'), statusFile: join(dir, 'status.json'), versionFile: join(dir, 'version.json') };
  mkdirSync(cfg.requestDir);
  writeFileSync(cfg.versionFile, JSON.stringify({ commit: 'a'.repeat(40), committedAt: '2026-10-06T10:00:00-04:00', subject: 'Old' }));
  db = openDb(':memory:');
});
afterEach(async () => {
  await app.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('app updates API', () => {
  it('reports the running version and writes only a check or deploy request', async () => {
    start();
    const res = await get();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ enabled: true, running: { subject: 'Old' }, status: null, queued: false });

    expect((await post('deploy')).statusCode).toBe(202);
    expect(readFileSync(join(cfg.requestDir, 'request'), 'utf8')).toBe('deploy');
    expect((await get()).json().queued).toBe(true);
    // One at a time.
    expect((await post('check')).statusCode).toBe(409);

    expect((await post('rm -rf /')).statusCode).toBe(400);
    expect((await post('deploy; reboot')).statusCode).toBe(400);
  });

  it('refuses while a run is in progress, unless that run went stale', async () => {
    start();
    status({ state: 'running', action: 'deploy', startedAt: new Date(NOW - 60_000).toISOString(), step: 'Building' });
    expect((await post('check')).statusCode).toBe(409);
    expect(existsSync(join(cfg.requestDir, 'request'))).toBe(false);

    status({ state: 'running', action: 'deploy', startedAt: new Date(NOW - 60 * 60_000).toISOString() });
    expect((await get()).json().status.state).toBe('failed');
    expect((await post('check')).statusCode).toBe(202);
  });

  it('requires a signed-in session', async () => {
    start();
    expect((await app.inject({ url: '/api/admin/deploy' })).statusCode).toBe(401);
    const res = await app.inject({
      method: 'POST', url: '/api/admin/deploy', payload: { action: 'deploy' }, headers: { 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(401);
    expect(existsSync(join(cfg.requestDir, 'request'))).toBe(false);
  });

  it('is off when the server is not set up for it', async () => {
    start({ deploy: undefined });
    expect((await get()).json()).toMatchObject({ enabled: false, running: null });
    expect((await post('deploy')).statusCode).toBe(404);
  });
});
