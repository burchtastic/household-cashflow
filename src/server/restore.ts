import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb, SCHEMA_VERSION, tx, type DB } from './db.ts';

/**
 * Restoring from the off-site backups (Settings → Restore from a backup). The nightly job copies
 * each backup to Google Drive through the rclone crypt remote "offsite" (deploy/offsite.sh).
 *
 * The app lists those copies with the server's own rclone config, but downloads one only with
 * the key typed in: a crypt remote built from that key, never the password the server keeps for
 * uploading. So every restore also proves the key in the password manager still opens them.
 *
 * A download is checked and summarised first. Restoring then backs up the current data, carries
 * the passkeys and sessions over (so nobody is locked out by an older backup), and stages the file
 * as restore/pending.db. The app restarts, and finishPendingRestore swaps it in before the
 * database is opened.
 */
export interface RestoreConfig {
  /** rclone config holding the "gdrive" and "offsite" remotes (docs/DEPLOY.md). Off while missing. */
  rcloneConfig: string;
  dbPath: string;
  /** Where the copy of the current data goes before a restore (the nightly backups' folder). */
  backupDir: string;
}

export type RcloneRun = (args: string[], opts?: { env?: Record<string, string>; input?: string; timeoutMs?: number }) => Promise<string>;

export class RcloneError extends Error {
  /** rclone's exit code: 3 is "directory not found", 4 "file not found". */
  readonly exitCode: number | null;
  constructor(message: string, exitCode: number | null) {
    super(message);
    this.exitCode = exitCode;
  }
}

/** What a request can show the person: a status code and a message written for them. */
export class RestoreError extends Error {
  readonly statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

/** Runs the real rclone against the server's config. */
export const rcloneRunner = (configPath: string): RcloneRun => (args, o = {}) =>
  new Promise((resolve, reject) => {
    const child = execFile('rclone', args, {
      env: { ...process.env, RCLONE_CONFIG: configPath, ...o.env },
      timeout: o.timeoutMs ?? 60_000,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout);
      const { code } = err as { code?: number | string };
      if (code === 'ENOENT') return reject(new RcloneError('rclone is not installed on the server', null));
      const last = stderr.trim().split('\n').pop()?.replace(/^\d{4}\/\d\d\/\d\d \d\d:\d\d:\d\d\s+/, '');
      reject(new RcloneError(last || err.message, typeof code === 'number' ? code : null));
    });
    child.stdin?.end(o.input ?? '');
  });

/** The crypt remote the nightly job uploads through. */
const OFFSITE = 'offsite';
/** The same remote, rebuilt with the typed-in key (defined only in rclone's environment). */
const WITH_KEY = 'cashflowrestore';
const NAME = /^cashflow-(\d{4})-(\d\d)-(\d\d)-(\d\d)(\d\d)(\d\d)(-before-restore)?\.db$/;
/** Sign-in state stays as it is now, whatever the backup had. */
const AUTH_TABLES = ['auth_meta', 'passkeys', 'sessions', 'setup_tokens'];

export interface BackupFile {
  name: string;
  size: number;
  /** When the backup was taken (from its name, which backup.ts stamps in UTC). */
  takenAt: string;
  /** The copy of the data saved just before an earlier restore. */
  beforeRestore: boolean;
}

export interface BackupSummary {
  name: string;
  takenAt: string;
  bills: number;
  transactions: number;
  lastTransaction: string | null;
  checking: { date: string; amountCents: number } | null;
  banks: number;
}

export interface LastRestore { name: string; at: string; savedAs: string }

function parseName(name: string) {
  const m = NAME.exec(name);
  return m ? { takenAt: `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`, beforeRestore: Boolean(m[7]) } : null;
}

/** Same format as scripts/backup.ts: cashflow-YYYY-MM-DD-HHMMSS, in UTC. */
function stamp(ms: number): string {
  return new Date(ms).toISOString().replace(/[:T]/g, '-').slice(0, 19).replace(/-(\d\d)-(\d\d)$/, '$1$2');
}

function readJson<T>(path: string): T | null {
  try { return JSON.parse(readFileSync(path, 'utf8')) as T; } catch { return null; }
}

const quietChmod = (path: string) => {
  try { chmodSync(path, 0o600); } catch { /* not supported on every filesystem */ }
};

const paths = (cfg: RestoreConfig) => {
  const work = join(dirname(cfg.dbPath), 'restore');
  return {
    work,
    download: join(work, 'download.db'),
    checked: join(work, 'checked.db'),
    checkedInfo: join(work, 'checked.json'),
    pending: join(work, 'pending.db'),
    pendingInfo: join(work, 'pending.json'),
    last: join(work, 'last.json'),
  };
};

/**
 * Called at startup before the database is opened: swaps in a staged restore, if there is one.
 * The previous process closed the database cleanly, so its WAL holds nothing unsaved.
 */
export function finishPendingRestore(cfg: RestoreConfig, now = Date.now()): LastRestore | null {
  const p = paths(cfg);
  if (!existsSync(p.pending)) return null;
  const info = readJson<{ name: string; savedAs: string }>(p.pendingInfo);
  for (const suffix of ['-wal', '-shm']) rmSync(cfg.dbPath + suffix, { force: true });
  renameSync(p.pending, cfg.dbPath);
  quietChmod(cfg.dbPath);
  const last: LastRestore = { name: info?.name ?? 'a backup', at: new Date(now).toISOString(), savedAs: info?.savedAs ?? '' };
  writeFileSync(p.last, JSON.stringify(last), { mode: 0o600 });
  rmSync(p.pendingInfo, { force: true });
  return last;
}

export class Restorer {
  private readonly cfg: RestoreConfig;
  private readonly run: RcloneRun;
  private readonly now: () => number;
  private busy = false;

  constructor(cfg: RestoreConfig, run: RcloneRun, now: () => number = Date.now) {
    this.cfg = cfg;
    this.run = run;
    this.now = now;
  }

  enabled(): boolean {
    return existsSync(this.cfg.rcloneConfig);
  }

  last(): LastRestore | null {
    return readJson<LastRestore>(paths(this.cfg).last);
  }

  /** The off-site copies, newest first. */
  async list(): Promise<BackupFile[]> {
    let out: string;
    try {
      out = await this.run(['lsjson', `${OFFSITE}:`, '--files-only', '--include', 'cashflow-*.db']);
    } catch (e) {
      throw new RestoreError(502, `Couldn't list the backups on Google Drive: ${(e as Error).message}`);
    }
    const files: BackupFile[] = [];
    for (const f of JSON.parse(out) as { Name: string; Size: number }[]) {
      const parsed = parseName(f.Name);
      if (parsed) files.push({ name: f.Name, size: f.Size, ...parsed });
    }
    return files.sort((a, b) => b.takenAt.localeCompare(a.takenAt) || Number(a.beforeRestore) - Number(b.beforeRestore));
  }

  /** Downloads one backup with the typed-in key, checks it, and says what's in it. */
  async check(name: string, key: string): Promise<BackupSummary> {
    const parsed = parseName(name);
    if (!parsed) throw new RestoreError(400, 'That is not one of the backups');
    if (this.busy) throw new RestoreError(409, 'A backup is already being downloaded');
    this.busy = true;
    const p = paths(this.cfg);
    try {
      const env = await this.keyRemote(key);
      mkdirSync(p.work, { recursive: true, mode: 0o700 });
      rmSync(p.download, { force: true });
      try {
        await this.run(['copyto', `${WITH_KEY}:${name}`, p.download], { env, timeoutMs: 10 * 60_000 });
      } catch (e) {
        // With the wrong key, the encrypted name it looks for doesn't exist.
        if (e instanceof RcloneError && (e.exitCode === 3 || e.exitCode === 4 || /not found/i.test(e.message))) {
          throw new RestoreError(400, "That key didn't open this backup. Check it against your password manager.");
        }
        throw new RestoreError(502, `Couldn't download the backup: ${(e as Error).message}`);
      }
      if (!existsSync(p.download)) throw new RestoreError(502, "Couldn't download the backup");
      quietChmod(p.download);
      const summary = { name, takenAt: parsed.takenAt, ...inspect(p.download) };
      rmSync(p.checked, { force: true });
      renameSync(p.download, p.checked);
      writeFileSync(p.checkedInfo, JSON.stringify({ name }), { mode: 0o600 });
      return summary;
    } finally {
      rmSync(p.download, { force: true });
      this.busy = false;
    }
  }

  /**
   * Stages the checked backup to replace the live database at the next start. Backs up the
   * current data first. The caller restarts the app.
   */
  stage(db: DB, name: string): { savedAs: string } {
    const p = paths(this.cfg);
    if (this.busy) throw new RestoreError(409, 'A backup is still being downloaded');
    if (readJson<{ name: string }>(p.checkedInfo)?.name !== name || !existsSync(p.checked)) {
      throw new RestoreError(409, 'Check the backup with your key first');
    }

    const restored = new DatabaseSync(p.checked);
    try {
      tx(restored, () => {
        for (const table of AUTH_TABLES) {
          restored.exec(`DELETE FROM ${table}`);
          for (const row of db.prepare(`SELECT * FROM ${table}`).all()) {
            const cols = Object.keys(row);
            restored.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
              .run(...cols.map((c) => row[c] as never));
          }
        }
      });
    } finally {
      restored.close();
    }

    mkdirSync(this.cfg.backupDir, { recursive: true });
    const savedAs = `cashflow-${stamp(this.now())}-before-restore.db`;
    const savedPath = join(this.cfg.backupDir, savedAs);
    db.prepare('VACUUM INTO ?').run(savedPath);
    quietChmod(savedPath);

    renameSync(p.checked, p.pending);
    writeFileSync(p.pendingInfo, JSON.stringify({ name, savedAs }), { mode: 0o600 });
    rmSync(p.checkedInfo, { force: true });
    return { savedAs };
  }

  /** Environment that defines the crypt remote again, with the typed-in key as its password. */
  private async keyRemote(key: string): Promise<Record<string, string>> {
    let remotes: Record<string, Record<string, unknown>>;
    try {
      remotes = JSON.parse(await this.run(['config', 'dump']));
    } catch (e) {
      throw new RestoreError(502, `Couldn't read the off-site settings: ${(e as Error).message}`);
    }
    const offsite = remotes[OFFSITE];
    if (offsite?.type !== 'crypt') throw new RestoreError(404, 'Off-site backups are not set up on this server');
    const obscured = (await this.run(['obscure', '-'], { input: key })).trim();
    const env: Record<string, string> = {};
    const prefix = `RCLONE_CONFIG_${WITH_KEY.toUpperCase()}_`;
    // Everything but the password: the folder, the name encryption and any salt.
    for (const [k, v] of Object.entries(offsite)) {
      if (k !== 'password' && typeof v === 'string') env[prefix + k.toUpperCase()] = v;
    }
    env[`${prefix}PASSWORD`] = obscured;
    return env;
  }
}

/** Opens a downloaded backup: sound, from this app, brought up to the current schema. */
function inspect(file: string): Omit<BackupSummary, 'name' | 'takenAt'> {
  let version: number;
  try {
    const ro = new DatabaseSync(file, { readOnly: true });
    try {
      const check = ro.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
      if (check.integrity_check !== 'ok') throw new Error(check.integrity_check);
      version = (ro.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    } finally {
      ro.close();
    }
  } catch {
    throw new RestoreError(400, "This backup is damaged or isn't a Cashflow database, so it can't be restored");
  }
  if (version < 2) throw new RestoreError(400, "This backup isn't a Cashflow database, so it can't be restored");
  if (version > SCHEMA_VERSION) {
    throw new RestoreError(409, 'This backup is from a newer version of the app. Update the app first (App updates).');
  }

  const db = openDb(file);
  try {
    const n = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
    const txns = db.prepare('SELECT COUNT(*) AS n, MAX(date) AS last FROM transactions').get() as { n: number; last: string | null };
    const checking = db.prepare(
      "SELECT date, amount_cents FROM snapshots WHERE account = 'checking' ORDER BY date DESC, id DESC LIMIT 1",
    ).get() as { date: string; amount_cents: number } | undefined;
    return {
      bills: n('SELECT COUNT(*) AS n FROM bills WHERE active = 1'),
      transactions: txns.n,
      lastTransaction: txns.last,
      checking: checking ? { date: checking.date, amountCents: checking.amount_cents } : null,
      banks: n("SELECT COUNT(*) AS n FROM plaid_items WHERE status <> 'removed'"),
    };
  } finally {
    // One file again, so it can be moved into place on its own.
    db.exec('PRAGMA journal_mode = DELETE');
    db.close();
  }
}
