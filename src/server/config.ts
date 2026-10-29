import { dirname, join } from 'node:path';
import { DEFAULT_SESSION, type AuthConfig } from './auth.ts';
import { loadPlaidConfig } from './plaid.ts';

const list = (s: string | undefined, fallback: string[]) =>
  s ? s.split(',').map((x) => x.trim()).filter(Boolean) : fallback;

const dbPath = process.env.DB_PATH ?? 'data/cashflow.db';

export const config = {
  dbPath,
  // Loopback by default. On Proxmox, Tailscale Serve proxies to this (see docs/DEPLOY.md).
  host: process.env.HOST ?? '127.0.0.1',
  port: Number(process.env.PORT ?? 8787),
  // "Today" is a calendar date in the household's time zone, not the server's.
  timeZone: process.env.TZ_HOUSEHOLD ?? 'America/New_York',
  staticDir: process.env.STATIC_DIR ?? 'dist',
  // Updating from the app: on only when the server is set up for it (docs/DEPLOY.md).
  deploy: process.env.DEPLOY_REQUEST_DIR && process.env.DEPLOY_STATUS_FILE
    ? {
      requestDir: process.env.DEPLOY_REQUEST_DIR,
      statusFile: process.env.DEPLOY_STATUS_FILE,
      versionFile: process.env.VERSION_FILE ?? 'version.json',
    }
    : undefined,
  // Restoring from the off-site backups: on only while the rclone config beside the database
  // exists (docs/DEPLOY.md → Off-site backups). The backups folder takes the pre-restore copy.
  restore: {
    rcloneConfig: process.env.RCLONE_CONFIG ?? join(dirname(dbPath), 'rclone.conf'),
    dbPath,
    backupDir: process.env.BACKUP_DIR ?? join(dirname(dbPath), 'backups'),
  },
  // Bank connections: on only when a credentials file exists (docs/DEPLOY.md → Plaid).
  plaid: loadPlaidConfig(),
  auth: {
    // Passkeys are bound to this hostname. WebAuthn does not allow IP addresses,
    // so browse to http://localhost:8787 locally, not 127.0.0.1.
    rpID: process.env.RP_ID ?? 'localhost',
    rpName: 'Cashflow',
    origins: list(process.env.ORIGINS, ['http://localhost:8787', 'http://localhost:5173']),
    ...DEFAULT_SESSION,
  } satisfies AuthConfig,
};
