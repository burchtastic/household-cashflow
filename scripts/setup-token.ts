// Prints a one-time link (valid 15 minutes) for enrolling a passkey.
// Use it for the first passkey, or to recover if every passkey is lost.
// Only someone with a shell on the server can run this, which is the point.
import { Auth } from '../src/server/auth.ts';
import { config } from '../src/server/config.ts';
import { openDb } from '../src/server/db.ts';

const db = openDb(config.dbPath);
const auth = new Auth(db, config.auth);
const { token, expiresAt } = auth.createSetupToken();
const origin = config.auth.origins[0];

console.log(auth.hasPasskeys()
  ? 'Passkeys already exist. This link adds another (recovery).'
  : 'No passkeys yet. Open this link to create the first one.');
console.log(`\n  ${origin}/#/setup?token=${token}\n`);
console.log(`Expires ${new Date(expiresAt).toLocaleTimeString()}. Works once.`);
db.close();
