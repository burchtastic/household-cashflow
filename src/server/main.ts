import { buildApp } from './app.ts';
import { config } from './config.ts';
import { openDb } from './db.ts';
import { PlaidClient } from './plaid.ts';
import { finishPendingRestore, rcloneRunner, Restorer } from './restore.ts';

// A restore from Settings is swapped in here, before anything opens the database.
const restored = finishPendingRestore(config.restore);
if (restored) console.log(`Restored the database from ${restored.name}; the data before it is in ${restored.savedAs}`);

const db = openDb(config.dbPath);
const app = buildApp(db, {
  timeZone: config.timeZone, auth: config.auth, staticDir: config.staticDir, deploy: config.deploy, logger: true,
  plaid: config.plaid && { config: config.plaid, api: new PlaidClient(config.plaid) },
  // Plaid itself refreshes from most banks a few times a day, so more often gains nothing.
  plaidSyncEveryMs: 4 * 60 * 60_000,
  restore: {
    restorer: new Restorer(config.restore, rcloneRunner(config.restore.rcloneConfig)),
    // A failure exit, so systemd (Restart=on-failure) starts the app again on the restored data.
    // In development, start it again yourself.
    restart: () => { void shutdown(75); },
  },
});

const shutdown = async (code = 0) => {
  await app.close();
  db.close();
  process.exit(code);
};
process.on('SIGINT', () => shutdown());
process.on('SIGTERM', () => shutdown());

await app.listen({ host: config.host, port: config.port });
