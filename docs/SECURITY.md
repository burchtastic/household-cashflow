# Security model

The app holds the household's full transaction history and balances. It is protected in
layers, so no single mistake exposes it.

## Ground rules

1. **It can't move money.** No bank credentials, no payment or transfer APIs, and no
   brokerage trading API is ever to be integrated. Bank connections go through Plaid with
   read-only products only (Transactions, Liabilities), never Auth or Identity.
2. **It isn't on the internet.** No public address, no port forwarding, Tailscale Funnel off.
3. **Financial data and secrets never go in git.** `data/`, `*.xlsx`, `*.csv`, `.env*` and
   `claude_share/` and `private/` are gitignored.

## Layers, outside in

| Layer | What it does | What it stops |
|---|---|---|
| **Tailscale** | The only way in is `https://cashflow.<your-tailnet>.ts.net`, via Tailscale Serve. The tailnet policy grants our own devices `tcp:443` to `tag:cashflow` and nothing else. Nothing is granted *from* the tag. | Anyone not on our tailnet, including other LAN devices; a compromised container reaching our other devices. |
| **Loopback only** | Node listens on `127.0.0.1:8787` inside the container. | Direct access around Tailscale Serve. |
| **Passkeys** | Every API call except sign-in and the health check needs a session. Sign-in is passkeys (WebAuthn) only, with no passwords. The first passkey needs a one-time setup link (15 minutes), which only someone with a shell on the container can create. | Someone on a trusted device who isn't us; password reuse and phishing. |
| **Sessions** | `__Host-` cookies: HttpOnly, Secure, SameSite=Strict. 12 hours idle, 7 days maximum. The app also signs itself out after an hour without a tap, key or scroll in any tab, checked again when the page is reopened or the device wakes, so balances don't stay on an unattended screen. "Sign out everywhere" in Settings. Session ids and setup tokens are stored only as SHA-256 hashes. Sign-in attempts are rate-limited (30 a minute). | Cookie theft through scripts, cross-site use, a leaked database copy granting a session. |
| **Request checks** | Writes must be same-origin (`Origin` and `Sec-Fetch-Site` are checked). Every body is validated against a strict JSON schema. 64 KB body limit. | Cross-site request forgery, malformed input. |
| **Browser headers** | Strict Content-Security-Policy (`'self'` only, no inline scripts), no framing, no referrer, `nosniff`, `no-store` on API responses. | Injected scripts, clickjacking, data in caches. |
| **Service sandbox** | Runs as the unprivileged `cashflow` user under systemd hardening: read-only filesystem except `/var/lib/cashflow`, no capabilities, private `/tmp` and devices. Code in `/opt/cashflow` is owned by root. | A bug in the app modifying its own code or the system. |
| **Container** | Unprivileged Proxmox LXC; its own SSH server disabled; unattended security upgrades. | Escape to the Proxmox host; stale packages. |

## App updates

**Settings → App updates** can install new code, so it is designed so the app decides
*when*, never *what*:

- The app can only write a file saying `check` or `deploy`. A root systemd service reads
  it (rejecting symlinks, anything over a few bytes, and any other word) and always
  installs **GitHub's `main` branch**.
- Fetching and building run as a separate unprivileged user holding a **read-only deploy
  key** for this one repository. GitHub's host keys are pinned.
- Root copies the finished build into place owned by root, backs up the database, and
  rolls back if the new version doesn't start.

The consequence: **whoever can merge to `main` controls what runs.** Keep two-factor sign-in on
the GitHub account, and treat merging a pull request as approving a release.

## Bank connections (Plaid)

- Plaid keys and the token-encryption key are in a root-only file handed to the service by
  systemd (`LoadCredential`), never in the database, git or the browser.
- Each bank's access token is AES-256-GCM encrypted and bound to its connection, so a
  copied database or backup can't use it without the key. That key is also kept in a password manager.
- Plaid Link's script and frame are allowed only on `/connect` and `/plaid-oauth`.
- Plaid is called with plain `fetch`, with no SDK and no new dependencies.
- No webhooks: nothing from the internet can reach the app.

## Backups

- Nightly online backup (`VACUUM INTO`) at 3:15 AM, 30 kept, mode 600, in the container.
- Then copied off-site to Google Drive through **rclone crypt**: encrypted (contents and
  file names) inside the container before upload. The Google connection uses the
  `drive.file` scope, so it can see only the files it created. Copy-only, never sync: a
  wiped local folder can't delete the off-site copies. Old copies are pruned after 45 days
  only while at least 7 recent ones exist.
- The encryption password lives **only in a password manager**. It was
  never written to the repo and the plaintext copy on the server was shredded.
- **Restoring from the app** downloads a backup only with the password typed in, used to
  build the crypt remote afresh (passed to rclone on stdin and in its environment, never as an
  argument, and never stored or logged). Tries are limited to 10 a minute. A restore keeps the
  current passkeys and sessions, saves the current data as a backup first, and refuses a
  damaged database or one from a newer version of the app.

## Admin access

- Proxmox root SSH from the development PC uses a dedicated key that is **removed between
  sessions** (re-added through the Proxmox web shell when needed). With in-app updates it
  is only needed for break-glass work.
- Recovery from losing every passkey requires a shell on the container
  (`docs/DEPLOY.md` → Recovery).

## Known trade-offs

- A signed-in session can trigger an update, but only to code already on `main`.
- One household login: every passkey has full access. There are no per-person roles yet.
- A synced bank can mark bills paid and file known amounts on its own (by amount, never
  more than expected). It can't move money, and a wrong match is undone by deleting it.
- Demo mode disguises numbers; it isn't access control. Anyone signed in can turn it off,
  so only show it to people you'd let use your signed-in device anyway. Notes keep their text.
- The `/connect` page trusts Plaid's script from `cdn.plaid.com`. Plaid doesn't publish
  fixed hashes for it, so it can't be pinned.
