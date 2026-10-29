# Plan

## Principles

1. **Read-only by construction.** The app can never move money. No brokerage trading APIs
   (never a brokerage trading API), and bank data only through read-only products.
2. **Not on the internet.** Loopback-bound, reachable only through Tailscale.
3. **Financial data never enters git.**
4. **The engine is pure and tested.** Every number on screen comes from `src/engine`, which
   is unit-tested and checked against the original sheet.
5. **Simple to run.** One small container, one SQLite file, updates from a button.

How the forecast works is specified in [HOW-IT-WORKS.md](HOW-IT-WORKS.md); the security
model in [SECURITY.md](SECURITY.md).

## Done

### Phase 1: Forecast engine and dashboard
Spreadsheet import (full transaction history), forecast engine with parity to the sheet,
API, and the Dashboard, Bills, One-offs, History and Settings pages.

### Phase 1b: Safe to rely on
- [x] Passkey sign-in (WebAuthn) in front of the whole API.
- [x] Deployed to Proxmox: an LXC container, Tailscale Serve, hardened systemd units (Oct 2026).
- [x] Tailnet policy: only our devices, only HTTPS, nothing out from the server.
- [x] Nightly backups plus encrypted off-site copies on Google Drive; restore tested.
- [x] Updates from the app (Settings → App updates), with backup and automatic rollback.
- [x] Restore from the off-site backups in the app (Settings → Restore from a backup), unlocked
  with the backup key, which proves the key in the password manager still works.

### Feedback rounds (Oct 2026)
- Fixed amounts get an edit pencil; only estimates get "Set amount"; estimates are grey.
- Bills can't be marked paid months ahead (next one, up to 14 days early).
- History: GA-style date range picker, default last 90 days; inline note editing.
- One-offs: separate expense/income, quick form with autocomplete, inline new types,
  "already happened", "already set up with the bank", and the balance question.
- Notes on upcoming occurrences that carry into the payment and History.
- Advice understands savings draws: offers to trim or skip the next draw, and never
  suggests sweeping to savings while drawing from it.
- Fix: a future one-off marked done vanished. It was recorded as today, before the
  balance date; Done now keeps the item's own date.
- Edit set-up, paid and received items from the Dashboard, History and One-offs.
- Savings transfers are marked on the chart, and a loud red alarm shows whenever
  checking would go below $0.
- A logo and favicon: the balance line dipping toward a dashed floor and climbing away.
- A bill payment already scheduled with the bank can be marked ahead, up to its due date
  ("Paid / set up…"); it shows as Set up and the bank sync links it when it lands.
- Planned one-offs: gold chip, and editable (or deletable) from the Dashboard.
- Card estimates never below what's already on the card (current balance less any unpaid
  statement), flagged on the row.
- Demo mode for showing the app off: every amount disguised, per browser, read-only.
- Fix: editing any bill failed with "body must NOT have additional properties" (the form
  sent the row's history stats back).

## Next

- [ ] **Retire the sheet** once a full month has run on the app alone.
- [ ] Show the last off-site backup time (and any failure) in Settings.

### Phase 2: Plaid, read-only

**Plan and limits.** Plaid Trial plan: free, real Production data, at most
**10 Items ever**. Removing an Item does not free its slot, so a broken login
is repaired with Link *update mode*, never by linking again. Never submit the paid "Request Production access" form; it
ends the trial and asks for a card.

**Products.** Transactions, Liabilities, and balances from `/accounts/get`.
**Not** Auth or Identity (account and routing numbers are what moving money
needs), and never Transfer or Payment products.

**Security.**
- Plaid client id, secret and the token key live in a root-owned systemd
  credentials file, never in the database, git or the browser.
- Access tokens are AES-256-GCM encrypted in the database. Backups hold only
  ciphertext, so the key is also kept in a password manager for restores.
- Plain `fetch` against about six endpoints, no Plaid SDK (keeps axios and its
  tree out).
- The Link script and frame (`cdn.plaid.com`) are allowed by CSP only on the
  page that opens Link.
- OAuth banks return to `https://<tailnet name>/plaid-oauth`,
  a real path because Plaid rejects `#` routes. Registered in the Plaid
  Dashboard under allowed redirect URIs.
- Scheduled sync instead of webhooks (nothing public to receive them).

**Steps (one PR each).**
1. [x] Plaid Dashboard: Trial team, 2FA, app display info, company info,
   security questionnaire (some banks require it), redirect URI.
2. [x] Plumbing, tested in Sandbox (Oct 2026): token encryption,
   `plaid_items` and `plaid_accounts`, `/connect` (connect, fix sign-in,
   disconnect, account roles).
3. [x] Sync: `/transactions/sync` with a cursor into a raw `bank_transactions`
   table kept apart from the ledger, pending included. Every few hours plus
   "Sync now". Balances (available and current) saved per account.
4. [x] Card statements (Liabilities): for each card, the last statement's
   date, balance and due date, plus the minimum due. The statement balance
   becomes the known amount for that card's bill in the period it's due.
5. [x] Balance check on the Dashboard: when the bank's *available* checking
   balance differs from the ledger's balance for today, a notice shows both
   and the difference, with "Use the bank's balance" (records a snapshot).
   Nothing is overwritten silently. Savings works the same way.
6. [x] Matching and review, checking only: by **amount**, not name (bank
   descriptions don't look like bill names). A payment or deposit within an
   item's date window, never more than expected and at most 10% less (card
   returns), marks it paid automatically (`source='plaid'`). Expected is the
   known amount (e.g. the statement) or the estimate; planned one-offs such
   as savings transfers match too. A payment already entered by hand is
   linked, not added again. Pending counts; the ledger follows it when it
   posts and drops it if it never does. Anything unmatched waits in **To
   review** on the Dashboard: file it under a code, or dismiss. Deleting an
   automatic match sends it to review instead of matching it again. Card
   purchases are never itemized: statements cover them.
7. [x] Production: banks connected (Oct 2026). A bank that hangs at sign-in can be
   retried later; a failed sign-in uses no slot.

**Decisions (Oct 2026).**
- Cutover: each bank's transactions reach the ledger only from the day after
  it's connected in Production. Plaid's older history stays in the raw table,
  so it never doubles the sheet's history.
- Pending: counted. Balances use Plaid's *available* figure, which already
  subtracts pending charges.
- Unmatched activity: a review list, never filed silently.
- Matching: amount only, automatic, up to 10% under; deposits too (Oct 2026).

**Maybe next.**
- Bills whose amount varies (utilities, paychecks) can come in above their estimate and
  land in To review. If that's common, allow some slack above estimates (not statements).
- Adding accounts left unshared at connect time needs Link's account-selection update mode.
- Savings runway is hard to read. Ideas: call the tile "Savings lasts until <date>", and
  show what makes up the monthly shortfall, since one lumpy bill in the 60-day window can
  overstate it.

### Phase 3: Insight and alerts
- Card spending by category (what "Card detail" never managed).
- Alerts when a projected dip appears or a known amount lands, possibly via Home Assistant.

### Phase 4: Maybe
- Brokerage balances, read-only through Plaid.
- A second login for another household member.

## Decisions

| Decision | Why |
|---|---|
| Node's built-in SQLite and TypeScript | No native modules or compile step; fewer dependencies to trust. |
| Integer cents, ISO date strings | No floating-point drift; dates compare as strings. |
| Forecast from the latest balance; earlier items assumed included | Matches how a bank balance works; no roll-forward. |
| Passkeys only | Phishing-resistant, nothing to reuse or leak; synced passkeys (password manager) cover device loss. |
| Tailscale Serve instead of a public host | HTTPS and device-level access control with no open ports. |
| Updates pull from GitHub `main` via a root path unit | One click, but the app can't choose the code; the build runs unprivileged with a read-only key. |
| rclone crypt to Google Drive, `drive.file` scope | Same habit as Home Assistant's Drive backups, encrypted before it leaves, and Drive access limited to its own files. |
| Pull requests for every change | Merging is the release approval for in-app updates. |
| Plaid Trial, plain `fetch`, Transactions + Liabilities only | Free for a few banks; no SDK dependency tree; no product that exposes account numbers or moves money. |
| Sync on a timer, no webhooks | Nothing on the internet can reach the app. |
| Cards via statements, checking via amount matching | Card purchases don't matter one by one; bank descriptions never look like bill names, but amounts do. |
| Nothing from the bank overwrites what you typed | Statement amounts and balance changes are suggestions or fill-ins; a typed known amount or balance wins. |
| Demo mode per browser, disguised server-side, read-only | Showing it off can't leak real figures (none leave the server) or save fake ones. |
