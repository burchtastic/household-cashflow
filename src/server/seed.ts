// Load data/seed.json (from scripts/import_xlsx.py) into the database.
// Usage: npm run seed [-- --force]
import { isEmpty, loadDataset, openDb } from './db.ts';
import { readSeed, seedToDataset } from './seedData.ts';
import { config } from './config.ts';

const force = process.argv.includes('--force');
const seedPath = process.env.SEED_PATH ?? 'data/seed.json';

const db = openDb(config.dbPath);
if (!isEmpty(db) && !force) {
  console.error(`${config.dbPath} already has data. Re-run with --force to replace ALL of it.`);
  process.exit(1);
}
const data = seedToDataset(readSeed(seedPath));
loadDataset(db, data);
console.log(
  `Loaded ${data.bills.length} bills, ${data.transactions.length} transactions, ` +
  `${data.planned.length} planned items into ${config.dbPath}`,
);
db.close();
