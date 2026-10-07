// Consistent online backup of the SQLite database (safe while the server runs).
// Usage: npm run backup            → data/backups/cashflow-YYYY-MM-DD-HHMMSS.db
// Keeps the newest BACKUP_KEEP files (default 30).
import { chmodSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../src/server/config.ts';

const dir = process.env.BACKUP_DIR ?? 'data/backups';
const keep = Number(process.env.BACKUP_KEEP ?? 30);
mkdirSync(dir, { recursive: true });

const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19).replace(/-(\d\d)-(\d\d)$/, '$1$2');
const out = join(dir, `cashflow-${stamp}.db`);
const db = new DatabaseSync(config.dbPath, { readOnly: true });
db.prepare('VACUUM INTO ?').run(out);
db.close();
try { chmodSync(out, 0o600); } catch { /* not supported on every filesystem */ }

const old = readdirSync(dir).filter((f) => /^cashflow-.*\.db$/.test(f)).sort().reverse().slice(keep);
for (const f of old) rmSync(join(dir, f));
console.log(`Backed up to ${out}${old.length ? ` (pruned ${old.length})` : ''}`);
