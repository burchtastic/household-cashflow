import { buildApp } from './app.ts';
import { config } from './config.ts';
import { openDb } from './db.ts';
import { PlaidClient } from './plaid.ts';

const db = openDb(config.dbPath);
const app = buildApp(db, {
  timeZone: config.timeZone, auth: config.auth, staticDir: config.staticDir, deploy: config.deploy, logger: true,
  plaid: config.plaid && { config: config.plaid, api: new PlaidClient(config.plaid) },
  // Plaid itself refreshes from most banks a few times a day, so more often gains nothing.
  plaidSyncEveryMs: 4 * 60 * 60_000,
});

const shutdown = async () => {
  await app.close();
  db.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ host: config.host, port: config.port });
