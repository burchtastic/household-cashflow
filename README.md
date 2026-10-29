<img src="src/web/public/logo-256.png" alt="" width="72" align="left" />

# cashflow

A private, self-hosted web app that keeps the household checking account above its
floor (default $500) while holding as little cash there as possible. It grew out of a
household cashflow spreadsheet.

It **forecasts and advises; it never moves money.** Banks are connected
read-only through Plaid, there's no brokerage connection, and there's no way for the app
to send a transfer. You make transfers at the bank; the app sees them land.

It runs on a home server (Proxmox) and is only reachable from your own devices on a
Tailscale network, behind passkey sign-in.

## What it does

| Page | What you do there |
|---|---|
| **Dashboard** | See today's checking balance, what to do next, and the next 60 days. If checking would ever go **below $0**, a red alarm takes over the top of the page. The decision card says one of: *move $X from savings by a date*; *your planned draw from savings could be smaller (or skipped)*; *no transfers needed*; or *you can sweep $X to savings*. When the bank's balance differs from the ledger's, a notice offers to use the bank's balance. Checking activity that matched no bill waits under **To review**; filing it under a one-off type puts it on the One-offs page. Below it: a projected balance chart with transfers from savings marked, savings runway, and the upcoming ledger, where you mark items Paid/Received, edit amounts and anything already recorded, and add notes (on phones, each row's buttons sit behind a ⋯). **Show recent** lists the last four transactions. |
| **Bills & income** | Recurring bills and income. Each is *fixed* (a set amount) or *auto* (estimated from the last 240 days of history). **History** on a bill shows what it has actually been month by month over 6 months, a year or two years: average, highest, lowest and total, a bar per month against what the forecast expects, and every payment. Edit the bill from there (or with the pencil on wide screens). |
| **One-offs** | Anything unscheduled: transfers from savings, a plumbing repair, a refund. Separate **Add expense** / **Add income** buttons; the "What was it?" field autocompletes from past entries. Log something that already happened, set up a future transfer, or plan one. |
| **History** | Every transaction you have, filtered by a date range picker (defaults to the last 90 days) with category totals. Notes can be added or edited inline. |
| **Settings** | Floors, horizon, estimate mode, transfer rounding; **Import from a spreadsheet** (download the template, fill in bills, history and balances, preview, import); passkeys; **App updates**; **Restore from a backup** (pick an off-site copy, unlock it with the backup key, check what's in it, restore); balance history; a link to **Bank connections**; **Demo mode** (disguised numbers for showing it off, this browser only). |
| **Bank connections** (`/connect`) | Connect banks through Plaid (read-only), fix a sign-in, **Sync now**, and choose what each account is: Checking (the forecast account), Savings, a card, or ignored. Each card shows its latest statement and which bill pays it. |

**What the banks do for you** (every 4 hours, or **Sync now**):

- **Card estimates never go below what's already on the card** (current balance less any unpaid statement).
- **Card statements become known amounts.** Each card's statement balance is set on its bill's payment nearest the due date. Amounts you typed in are never overwritten.
- **Checking payments mark bills paid**, matched by amount: within the bill's date window, at most what was expected and up to 10% under (card returns). Deposits and planned savings transfers match the same way. Payments you already entered are linked, not doubled.
- **Pending counts.** The balance check uses the bank's *available* balance, and a pending payment counts as paid until it posts (or disappears).

The forecast always runs from **today**. There is nothing to roll forward and no slots
to run out of. [docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md) is the full specification.

## How it's built

- **Node 24**, using its built-in SQLite (`node:sqlite`) and native TypeScript, so the
  server runs `.ts` files directly with no compile step.
- **Fastify 5** API, **React 19** front end built with **Vite**, tests in **Vitest**.
- Money is integer cents everywhere; dates are ISO `YYYY-MM-DD` strings in the
  household's time zone (America/New_York).
- The forecast engine (`src/engine/`) is pure: no I/O, no clock, fully unit-tested, and
  checked to the cent against the original spreadsheet.

| Path | What |
|---|---|
| `src/engine/` | Schedules, estimates, matching payments to bills, matching bank activity by amount (`bankmatch.ts`), the forecast. |
| `src/server/` | API (`app.ts`), SQLite storage and migrations (`db.ts`), passkeys (`auth.ts`), app updates (`deploy.ts`). Plaid: read-only client and token encryption (`plaid.ts`), sync (`sync.ts`), card statements (`statements.ts`), matching checking activity (`reconcile.ts`). |
| `src/web/` | React pages and components; `public/` holds the logo and icons. |
| `scripts/` | Spreadsheet import, seeding, backups, passkey setup links, dev server, icon rendering (`render_icons.py`). |
| `deploy/` | systemd units and scripts for the Proxmox container. |
| `tests/` | Engine, API, auth, app-update, Plaid (against a stand-in), and spreadsheet-parity tests. |
| `docs/` | Specification, security, deployment, roadmap (below). |

## Documentation

| Doc | Read it for |
|---|---|
| [HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md) | The forecast rules, statuses, advice, one-offs, notes: what every number means. |
| [SECURITY.md](docs/SECURITY.md) | The security model: what protects the data and what each layer stops. |
| [DEPLOY.md](docs/DEPLOY.md) | How production is set up, how to update it, backups, restore, and recovery. |
| [PLAN.md](docs/PLAN.md) | Principles, what's done, what's next, and the decisions behind it. |

## Day-to-day operations

- **Update the app:** merge a pull request on GitHub, then **Settings → App updates →
  Check for updates → Update**. It backs up the database, builds, swaps, and rolls back by
  itself if the new version doesn't start.
- **Backups:** nightly at 3:15 AM, 30 kept in the container, and an encrypted copy to
  Google Drive (45 days). The encryption password is in your password manager.
- **Restore:** **Settings → Restore from a backup → Show backups**, choose one, paste the
  backup key from the password manager, check what it holds, and restore. Your current
  data is saved first and your passkeys are kept.
- **A bank says "Sign-in needed"?** Bank connections → **Fix sign-in**. Never disconnect
  and reconnect: the Plaid Trial allows 10 connections ever, and removed ones still count.
- **Locked out?** Any passkey works on any device. Lost them all: see Recovery in
  [DEPLOY.md](docs/DEPLOY.md).

## Develop locally

Requires Node 24+, and Python 3 with `openpyxl` for the one-time spreadsheet import.

```sh
npm install
npm run import -- "My Cashflow Tracker.xlsx" data/seed.json
npm run seed
npm run dev                  # http://localhost:5173, API on :8787
npm run setup-token          # prints a one-time link to create a passkey
```

Bank connections locally: put Sandbox keys in `data/plaid.env` (see
[DEPLOY.md](docs/DEPLOY.md) → Bank connections); test logins are `user_good` / `pass_good`.

Use `localhost`, not `127.0.0.1`: passkeys can't be bound to an IP address.

```sh
npm test                     # engine, API, auth, app-update and parity tests
npm run typecheck
npm run build                # front end into dist/
```

The parity test reproduces the sheet's ledger to the cent and only runs where `data/`
exists. The local `data/cashflow.db` is development data; **production's database on
Proxmox is the source of truth.**

### Workflow

Work on a branch, open a pull request, merge to `main`. Merging to `main` is approving a
release: the next **Update** in the app installs it.

## Data stays out of git

`data/` (database, seed, backups), `*.xlsx`, `*.csv`, `.env*` and `claude_share/` are
gitignored. Never commit financial data or secrets.

## License

MIT. See [LICENSE](LICENSE).
