import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/server/app.ts';
import { DEFAULT_SETTINGS, listBills, loadDataset, openDb, SCHEMA_VERSION, type DB } from '../src/server/db.ts';
import { Auth, DEFAULT_SESSION, SESSION_COOKIE, type AuthConfig } from '../src/server/auth.ts';
import {
  finishPendingRestore, RcloneError, Restorer, type RcloneRun, type RestoreConfig,
} from '../src/server/restore.ts';
import type { Bill } from '../src/engine/index.ts';

const AUTH: AuthConfig = { rpID: 'localhost', rpName: 'Cashflow', origins: ['http://localhost:8787'], ...DEFAULT_SESSION };
const NOW = Date.parse('2026-10-09T12:00:00Z');
const KEY = 'correct horse battery staple';
const OLD = 'cashflow-2026-10-07-071500.db';
const NEW = 'cashflow-2026-10-08-071500.db';

const bill = (code: string, name: string): Bill => ({
  code, name, category: 'Housing', direction: 'out', active: true, schedule: { kind: 'monthly', day: 15 },
  amountMode: 'fixed', amountCents: 1500_00, minCents: null, notes: '', sort: 1,
});

let dir: string;
let cfg: RestoreConfig;
let db: DB;
let app: FastifyInstance;
let session = '';
let restart: ReturnType<typeof vi.fn<() => void>>;
let calls: { args: string[]; env?: Record<string, string>; input?: string }[];
/** What's "on Google Drive": backup name → a plain database file standing in for its decrypted contents. */
let drive: Map<string, string>;

/** A stand-in for rclone: the crypt remote opens only with the right key, like the real one. */
const rclone: RcloneRun = async (args, o = {}) => {
  calls.push({ args, env: o.env, input: o.input });
  switch (args[0]) {
    case 'config':
      return JSON.stringify({
        gdrive: { type: 'drive', scope: 'drive.file', token: '{}' },
        offsite: {
          type: 'crypt', remote: 'gdrive:Cashflow backups', password: 'STORED-OBSCURED',
          filename_encryption: 'standard', directory_name_encryption: 'true',
        },
      });
    case 'obscure':
      return `obscured(${o.input})\n`;
    case 'lsjson':
      return JSON.stringify([...drive.keys(), 'notes.txt'].map((Name) => ({ Name, Size: 204800 })));
    case 'copyto': {
      if (o.env?.RCLONE_CONFIG_CASHFLOWRESTORE_PASSWORD !== `obscured(${KEY})`) {
        throw new RcloneError('error reading source root directory: directory not found', 3);
      }
      copyFileSync(drive.get(args[1].split(':')[1])!, args[2]);
      return '';
    }
  }
  throw new Error(`unexpected rclone ${args.join(' ')}`);
};

/** A backup as the nightly job would have taken it, with its own (older) passkey. */
function makeBackup(name: string, bills: Bill[]): string {
  const path = join(dir, `drive-${name}`);
  const b = openDb(path);
  loadDataset(b, {
    settings: DEFAULT_SETTINGS, bills, transactions: [
      { id: 1, date: '2026-10-01', code: bills[0].code, description: 'Paid', direction: 'out', amountCents: 1500_00, source: 'manual', note: '', plannedId: null },
    ],
    overrides: [], planned: [], snapshots: [{ account: 'checking', date: '2026-10-05', amountCents: 2345_67 }],
  });
  b.prepare("INSERT INTO passkeys VALUES ('old-key', x'00', 0, '[]', 'Old phone', 0, 1, NULL)").run();
  b.close();
  drive.set(name, path);
  return path;
}

const start = () => {
  app = buildApp(db, {
    timeZone: 'America/New_York', auth: AUTH, now: () => NOW,
    restore: { restorer: new Restorer(cfg, rclone, () => NOW), restart },
  });
};
const get = (url: string) => app.inject({ url, headers: { cookie: session } });
const post = (url: string, payload: object) => app.inject({
  method: 'POST', url, payload, headers: { cookie: session, 'content-type': 'application/json' },
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cashflow-restore-'));
  cfg = { rcloneConfig: join(dir, 'rclone.conf'), dbPath: join(dir, 'cashflow.db'), backupDir: join(dir, 'backups') };
  writeFileSync(cfg.rcloneConfig, '[offsite]\n');
  calls = [];
  drive = new Map();
  restart = vi.fn<() => void>();
  makeBackup(OLD, [bill('OLD', 'Old rent')]);
  makeBackup(NEW, [bill('RENT', 'Rent'), bill('CAR', 'Car')]);

  db = openDb(cfg.dbPath);
  loadDataset(db, {
    settings: DEFAULT_SETTINGS, bills: [bill('NOW', 'Today’s bill')], transactions: [], overrides: [], planned: [], snapshots: [],
  });
  db.prepare("INSERT INTO passkeys VALUES ('current-key', x'01', 0, '[]', 'Laptop', 0, 2, NULL)").run();
  session = `${SESSION_COOKIE}=${new Auth(db, AUTH, undefined, () => NOW).createSession()}`;
  start();
});
afterEach(async () => {
  await app.close();
  if (db.isOpen) db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('restore from the off-site backups', () => {
  it('lists the backups on Google Drive, newest first', async () => {
    expect((await get('/api/admin/restore')).json()).toEqual({ enabled: true, last: null });
    const res = await get('/api/admin/restore/backups');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      { name: NEW, size: 204800, takenAt: '2026-10-08T07:15:00Z', beforeRestore: false },
      { name: OLD, size: 204800, takenAt: '2026-10-07T07:15:00Z', beforeRestore: false },
    ]);
  });

  it("won't open a backup with the wrong key", async () => {
    const res = await post('/api/admin/restore/check', { name: NEW, key: 'not it' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/key didn't open/);
    expect((await post('/api/admin/restore/apply', { name: NEW })).statusCode).toBe(409);
    expect(restart).not.toHaveBeenCalled();
  });

  it('opens a backup with the typed key, not the password the server keeps', async () => {
    const res = await post('/api/admin/restore/check', { name: NEW, key: KEY });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      name: NEW, takenAt: '2026-10-08T07:15:00Z', bills: 2, transactions: 1, lastTransaction: '2026-10-01',
      checking: { date: '2026-10-05', amountCents: 2345_67 }, banks: 0,
    });

    // The key goes to rclone on stdin, never as an argument; the stored password isn't reused.
    expect(calls.some((c) => c.args.includes(KEY))).toBe(false);
    expect(calls.find((c) => c.args[0] === 'obscure')?.input).toBe(KEY);
    const copy = calls.find((c) => c.args[0] === 'copyto')!;
    expect(copy.args[1]).toBe(`cashflowrestore:${NEW}`);
    expect(copy.env).toMatchObject({
      RCLONE_CONFIG_CASHFLOWRESTORE_TYPE: 'crypt',
      RCLONE_CONFIG_CASHFLOWRESTORE_REMOTE: 'gdrive:Cashflow backups',
      RCLONE_CONFIG_CASHFLOWRESTORE_FILENAME_ENCRYPTION: 'standard',
      RCLONE_CONFIG_CASHFLOWRESTORE_PASSWORD: `obscured(${KEY})`,
    });
    expect(Object.values(copy.env!)).not.toContain('STORED-OBSCURED');
  });

  it('restores: saves the current data, keeps sign-ins, and swaps the backup in on restart', async () => {
    // Only the backup that was checked.
    await post('/api/admin/restore/check', { name: OLD, key: KEY });
    expect((await post('/api/admin/restore/apply', { name: NEW })).statusCode).toBe(409);
    await post('/api/admin/restore/check', { name: NEW, key: KEY });

    const res = await post('/api/admin/restore/apply', { name: NEW });
    expect(res.statusCode).toBe(202);
    const savedAs = 'cashflow-2026-10-09-120000-before-restore.db';
    expect(res.json()).toEqual({ restarting: true, savedAs });
    await vi.waitFor(() => expect(restart).toHaveBeenCalledOnce());
    // Nothing changes until the restart.
    expect(listBills(db).map((b) => b.code)).toEqual(['NOW']);

    // What main.ts does on the way back up.
    await app.close();
    db.close();
    expect(finishPendingRestore(cfg, NOW + 5000)).toEqual({ name: NEW, at: '2026-10-09T12:00:05.000Z', savedAs });
    db = openDb(cfg.dbPath);
    start();

    expect(listBills(db).map((b) => b.code).sort()).toEqual(['CAR', 'RENT']);
    // Today's passkeys and session, not the backup's.
    expect(db.prepare('SELECT id FROM passkeys').all().map((r) => r.id)).toEqual(['current-key']);
    expect((await get('/api/admin/restore')).json()).toMatchObject({ last: { name: NEW, savedAs } });

    // The data from before is a backup like any other.
    const before = openDb(join(cfg.backupDir, savedAs));
    expect(listBills(before).map((b) => b.code)).toEqual(['NOW']);
    before.close();
    expect(readdirSync(join(dir, 'restore')).sort()).toEqual(['last.json']);
    expect(finishPendingRestore(cfg)).toBeNull();
  });

  it("refuses a damaged backup, or one from a newer version of the app", async () => {
    writeFileSync(drive.get(NEW)!, 'not a database at all, just some text that is long enough');
    const bad = await post('/api/admin/restore/check', { name: NEW, key: KEY });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toMatch(/damaged/);

    const newer = openDb(drive.get(OLD)!);
    newer.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    newer.close();
    const res = await post('/api/admin/restore/check', { name: OLD, key: KEY });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/newer version/);
    expect(existsSync(join(dir, 'restore', 'checked.db'))).toBe(false);
  });

  it('takes only backup names, and needs a signed-in session', async () => {
    expect((await post('/api/admin/restore/check', { name: '../cashflow.db', key: KEY })).statusCode).toBe(400);
    expect((await post('/api/admin/restore/check', { name: 'notes.txt', key: KEY })).statusCode).toBe(400);
    session = '';
    expect((await get('/api/admin/restore/backups')).statusCode).toBe(401);
    expect((await post('/api/admin/restore/check', { name: NEW, key: KEY })).statusCode).toBe(401);
  });

  it('is off until off-site backups are set up', async () => {
    rmSync(cfg.rcloneConfig);
    expect((await get('/api/admin/restore')).json()).toEqual({ enabled: false, last: null });
    expect((await get('/api/admin/restore/backups')).statusCode).toBe(404);
    expect((await post('/api/admin/restore/check', { name: NEW, key: KEY })).statusCode).toBe(404);
  });
});
