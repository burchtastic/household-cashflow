# Deploying to Proxmox

The app runs in its own unprivileged Debian LXC container. It listens on loopback only;
**Tailscale Serve** is the only way in, so nothing is exposed to the LAN or the internet,
and HTTPS on the tailnet comes free. The security reasoning is in
[SECURITY.md](SECURITY.md).

```
phone / laptop ──(tailnet, HTTPS)──► tailscale serve ──► 127.0.0.1:8787 (node)
                                          LXC "cashflow"
```

## Production at a glance

| | |
|---|---|
| Proxmox host | Your Proxmox server (web UI on :8006). |
| Container | **"cashflow"** (ID `<ct>`, e.g. 103): Debian 12, unprivileged, 1 core, 512 MB, 4 GB disk, DHCP, starts on boot. Its own SSH server is disabled. |
| Address | **https://cashflow.&lt;your-tailnet&gt;.ts.net** (Tailscale Serve → 127.0.0.1:8787), node tagged `tag:cashflow`. |
| Code | `/opt/cashflow` (root-owned); `version.json` says which commit. |
| Data | `/var/lib/cashflow/cashflow.db` (owner `cashflow`, 600); backups in `/var/lib/cashflow/backups`. |
| Services | `cashflow` (the app) · `cashflow-backup.timer` → `cashflow-backup` → `cashflow-offsite` (nightly 3:15 AM) · `cashflow-deploy.path` → `cashflow-deploy` (app updates). |
| Shell | Proxmox web UI → node `pve` → **Shell**, then `pct enter <ct>`. |

Handy checks from the container shell:

```sh
systemctl status cashflow
journalctl -u cashflow -n 50
journalctl -u cashflow-backup -u cashflow-offsite -n 20
journalctl -u cashflow-deploy -n 50
cat /opt/cashflow/version.json
```

## Building it from scratch

How production is set up, so it can be built or rebuilt. The examples use container ID `103`; pick any free ID.

First, on your PC: copy `deploy/deploy.env.example` to `private/deploy.env` (gitignored) and fill
in your Proxmox host, container ID, GitHub repo and Tailscale name. The deploy scripts read it.

### 1. Create the container (Proxmox host shell)

```sh
pct create 103 local:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst \
  --hostname cashflow --unprivileged 1 --features nesting=1 \
  --cores 1 --memory 512 --swap 512 --rootfs local-lvm:4 \
  --net0 name=eth0,bridge=vmbr0,ip=dhcp --onboot 1
# Tailscale inside an unprivileged LXC needs the TUN device:
cat >> /etc/pve/lxc/103.conf <<'EOF'
lxc.cgroup2.devices.allow: c 10:200 rwm
lxc.mount.entry: /dev/net/tun dev/net/tun none bind,create=file
EOF
pct start 103 && pct enter 103
```

### 2. Inside the container

```sh
apt update && apt full-upgrade -y
apt install -y curl git ca-certificates unattended-upgrades rclone locales
dpkg-reconfigure -plow unattended-upgrades
systemctl disable --now ssh       # reach it through pct enter, never SSH

# Node 24 (NodeSource)
curl -fsSL https://deb.nodesource.com/setup_24.x | bash - && apt install -y nodejs

# Tailscale. Approve the login link, then tag the node tag:cashflow in the admin console.
curl -fsSL https://tailscale.com/install.sh | sh
tailscale up --hostname=cashflow --ssh=false
tailscale serve --bg 8787         # https://cashflow.<tailnet>.ts.net → 127.0.0.1:8787

# App user and data directory
useradd --system --home /opt/cashflow --shell /usr/sbin/nologin cashflow
install -d -o cashflow -g cashflow -m 700 /var/lib/cashflow
```

### 3. First copy of the code

The container has no GitHub access until step 7, so the first
copy is pushed from the PC (the same way `deploy/update.sh` does it):

```sh
# PC, Git Bash, repo root
git archive --format=tar.gz -o app.tar.gz HEAD && sh deploy/version.sh > version.json
scp app.tar.gz version.json root@<proxmox-ip>:/root/
# Proxmox host
pct push 103 /root/app.tar.gz /root/app.tar.gz && pct push 103 /root/version.json /root/version.json
# container
mkdir /opt/cashflow && tar -xzf /root/app.tar.gz -C /opt/cashflow && mv /root/version.json /opt/cashflow/
cd /opt/cashflow && npm ci && npm run build && npm prune --omit=dev
chown -R root:root /opt/cashflow  # code is read-only to the service user
```

### 4. Load the data (once)

Copy the data in with `pct push`, never through git. Either a seed file from the
spreadsheet import:

```sh
pct push 103 data/seed.json /var/lib/cashflow/seed.json --user cashflow --perms 600   # host
cd /opt/cashflow && runuser -u cashflow -- env DB_PATH=/var/lib/cashflow/cashflow.db \
  SEED_PATH=/var/lib/cashflow/seed.json npm run seed && shred -u /var/lib/cashflow/seed.json
```

or an existing database (production started from the dev database with its passkey and
session tables emptied), owned by `cashflow` with mode 600.

### 5. Services

In `deploy/cashflow.service`, set `RP_ID` and `ORIGINS` to the exact name
`tailscale serve status` shows. Passkeys are bound to that hostname; if it ever changes,
everyone needs new passkeys.

```sh
cd /opt/cashflow/deploy
cp cashflow.service cashflow-backup.service cashflow-backup.timer cashflow-offsite.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now cashflow.service cashflow-backup.timer
systemctl status cashflow
```

### 6. Create your passkey

```sh
cd /opt/cashflow
runuser -u cashflow -- env DB_PATH=/var/lib/cashflow/cashflow.db \
  RP_ID=cashflow.<your-tailnet>.ts.net ORIGINS=https://cashflow.<your-tailnet>.ts.net \
  node scripts/setup-token.ts
```

Open the printed link (it works once, for 15 minutes) and create a passkey. A passkey
saved in a password manager that syncs works on every device. Otherwise add
one per device from **Settings → Passkeys**.

### 7. App updates and off-site backups

- **App updates:** with the SSH key on the host, run `bash deploy/setup-app-updates.sh`
  from the PC (see [Updating](#updating)).
- **Off-site backups:** see [Off-site backups](#off-site-backups-google-drive-encrypted).

### 8. Lock down the tailnet

Tailscale admin console → **Access controls**. Production's policy:

```jsonc
{
  "tagOwners": { "tag:cashflow": ["autogroup:admin"] },
  "grants": [
    // Our own devices can reach each other.
    {"src": ["autogroup:member"], "dst": ["autogroup:self"], "ip": ["*"]},
    // Exit nodes keep working.
    {"src": ["autogroup:member"], "dst": ["autogroup:internet"], "ip": ["*"]},
    // Only we can open Cashflow, and only over HTTPS.
    // Nothing is granted FROM tag:cashflow, so the server can't reach our devices.
    {"src": ["autogroup:member"], "dst": ["tag:cashflow"], "ip": ["tcp:443"]},
  ],
}
```

Leave **Funnel off**: it would put the app on the public internet.

## Updating

### From the app (normal)

**Settings → App updates** shows the version running, what has landed on GitHub's `main`
branch since, and an **Update** button. Updating backs up the database, builds the new
version beside the running one, swaps it in and restarts; if it doesn't come up, the
previous version is put back. It takes a couple of minutes.

How it stays safe:

- The app never runs the update. It can only drop a request file saying `check` or `deploy`
  in `/var/lib/cashflow/deploy/`. A root systemd unit (`cashflow-deploy.path` →
  `cashflow-deploy.service` → `deploy/self-update.sh`) picks it up. Whatever the request
  says, it means "the `main` branch on GitHub", so the app chooses *when*, never *what*.
- Fetching and building (`npm ci`, `vite build`) run as a separate unprivileged user,
  `cashflow-deploy`, whose GitHub access is a **read-only deploy key** for this one repo.
  Root only copies the finished build into place, owned by root, and restarts.
- GitHub's host keys are pinned from GitHub's published list, not trusted on first use.
- So whoever can merge to `main` on GitHub decides what runs. Keep the GitHub account
  on two-factor, and treat merging a pull request as approving a release.

Progress and the last run's log are in `/var/lib/cashflow-deploy/` (`status.json`,
`last.log`), or `journalctl -u cashflow-deploy`.

### One-time setup

Re-add the SSH key (below), then from the repo root in Git Bash, with `gh` signed in:

```sh
bash deploy/update.sh               # ship a version that includes the updater
bash deploy/setup-app-updates.sh    # user, deploy key, clone, systemd units
```

The setup script creates the `cashflow-deploy` user and its key in the container, adds
the key to the GitHub repo as a read-only deploy key ("cashflow container (read-only)"),
clones the repo, installs `cashflow-deploy.path`/`.service`, and adds the drop-in
`/etc/systemd/system/cashflow.service.d/updates.conf` that turns the page on. To turn it
off: `systemctl disable --now cashflow-deploy.path` and delete the deploy key on GitHub.

### From your PC (fallback)

`deploy/update.sh` packs the committed code, copies it in over SSH, rebuilds beside the
live copy, takes a backup, swaps, and rolls back if the new version doesn't come up. Use
it if the in-app updater is broken. The setup SSH key is removed from Proxmox between
uses. To use it:

1. In the Proxmox web UI, open the node's **Shell** and re-add the key
   (the public half is in `~/.ssh/cashflow_proxmox.pub` on your PC):
   `echo '<contents of cashflow_proxmox.pub>' >> /root/.ssh/authorized_keys`
2. From the repo root in Git Bash: `bash deploy/update.sh`
3. Remove the key again:
   `sed -i '/cashflow-setup-temporary/d' /root/.ssh/authorized_keys`

Host and container come from `private/deploy.env` (`PVE_HOST`, `CT_ID`).

## Bank connections (Plaid)

Read-only links to the banks: balances, transactions and card statements. Off until the
server has a credentials file. Plan and limits: `docs/PLAN.md` → Phase 2.

### Turning it on

1. Merge the pull request and update from **Settings → App updates**.
2. In the Proxmox web UI, open the node's **Shell**, then `pct enter <ct>` and run
   `bash /opt/cashflow/deploy/setup-plaid.sh`. It asks for the environment (`sandbox` first),
   the client ID and that environment's secret (from Plaid Dashboard → Developers → Keys).
3. The first time, it prints a **token key**. Save it in your password manager as "Cashflow Plaid
   token key". It decrypts the bank access tokens in the database, so restoring a backup on a new
   container needs it.
4. Open **Settings → Manage bank connections**.

### Sync

The app pulls balances and transactions from Plaid a minute after it starts and every 4
hours after that, plus whenever you press **Sync now** on the Bank connections page. They
land in their own tables (`plaid_accounts`, `bank_transactions`) and don't touch the
ledger or the forecast until matching exists. Each run logs one line per bank:
`journalctl -u cashflow | grep 'bank sync'`. A bank that needs signing in again shows
**Fix sign-in** on the page; the others keep syncing.

To go live, run the script again with `production` and the production secret. The token
key is kept. Sandbox connections then stop showing.

### How it's kept safe

- The keys live in `/etc/cashflow/plaid.env` (root, mode 600). The drop-in
  `/etc/systemd/system/cashflow.service.d/plaid.conf` hands the file to the service with
  `LoadCredential`, so the `cashflow` user never reads the original.
- Bank access tokens are stored AES-256-GCM encrypted with that key, never sent to the
  browser. A copy of the database alone (including the off-site backups) can't use them.
- Only Transactions and Liabilities are requested. Never Auth or Identity, which return
  account and routing numbers, and never Transfer or Payments.
- Plaid Link (the bank sign-in window) can load only on `/connect` and `/plaid-oauth`.
  Those pages also let in the one `<style>` Link adds on phones, by a nonce that's new on
  every load. Every other page keeps the strict `'self'`-only Content-Security-Policy.
- OAuth banks (most big ones) return to `https://cashflow.<your-tailnet>.ts.net/plaid-oauth`,
  which must be listed under **Allowed redirect URIs** in the Plaid Dashboard.
- Trial plan: 10 connections, ever. Removing one doesn't free its slot, so the app counts
  removed ones too and fixes broken sign-ins with Link's update mode.

To turn it off: delete the drop-in and `/etc/cashflow/plaid.env`, then
`systemctl daemon-reload && systemctl restart cashflow`. Disconnect banks in the app
first, so Plaid forgets them too.

### Locally

Put the same five lines in `data/plaid.env` (gitignored) with `PLAID_ENV=sandbox`. Leave out
`PLAID_REDIRECT_URI`, so OAuth banks are skipped. Sandbox test logins are `user_good` /
`pass_good`.

## Off-site backups (Google Drive, encrypted)

After each nightly backup, `cashflow-offsite.service` copies it to Google Drive through an
rclone **crypt** remote: contents and file names are encrypted in the container before
upload, so Drive only ever holds scrambled files in the folder `Cashflow backups`. The
Google connection uses the `drive.file` scope (it can only see files it created). Copies
are kept 45 days (`OFFSITE_KEEP_DAYS` in the unit). Settings live in
`/var/lib/cashflow/rclone.conf` (owner `cashflow`, 600).

App updates replace `/opt/cashflow` but not the units in `/etc/systemd/system`, so a change
to a unit file needs copying there by hand. For example, after the retention went from 90 to
45 days: `install -m 644 /opt/cashflow/deploy/cashflow-offsite.service /etc/systemd/system/ && systemctl daemon-reload`.

**The encryption password is stored only in your password manager** (e.g. an entry named
"Cashflow off-site backup"). Without it the off-site copies cannot be opened.

Check it ran: `pct exec <ct> -- journalctl -u cashflow-offsite.service -n 5`.

### Setting it up

1. On the PC, sign in to Google for rclone: `rclone authorize "drive"` (scope `drive.file`).
   It prints a token.
2. In the container, write `/var/lib/cashflow/rclone.conf` (owner `cashflow`, mode 600) with
   two remotes: `gdrive` (type `drive`, scope `drive.file`, that token) and `offsite`
   (type `crypt`, remote `gdrive:Cashflow backups`, filename encryption `standard`,
   directory name encryption `true`, `password` = `rclone obscure <new password>`).
   Save the password in your password manager first; shred any plaintext copy.
3. `systemctl start cashflow-backup` and check `journalctl -u cashflow-offsite`.

### Restoring from the app

**Settings → Restore from a backup → Show backups** lists the copies on Google Drive.
Choose one, paste the backup encryption password from the password manager, and **Unlock
and check**: the server downloads and decrypts it with that password (not the one in
`rclone.conf`), checks the database, and shows what it holds. **Replace my data with this
backup** then:

1. carries today's passkeys and sessions into it, so nobody is locked out;
2. saves the current data as `backups/cashflow-<time>-before-restore.db` (it goes
   off-site too, so a restore can be undone the same way);
3. restarts the app, which swaps the backup in before opening the database.

It needs only what's already there: `rclone.conf` beside the database and rclone installed.
The card says so when they're missing. On a rebuilt container, set up off-site backups
first (above), then restore from the app.

### Restoring from Google Drive on any computer

1. Install rclone (`winget install Rclone.Rclone`, or rclone.org/downloads).
2. `rclone config` → new remote `gdrive`, type `drive`, scope `drive.file`, sign in.
3. `rclone config` → new remote `offsite`, type `crypt`, remote `gdrive:Cashflow backups`,
   filename encryption `standard`, encrypt directory names `true`, password = the saved
   password, no second password (salt).
4. `rclone ls offsite:` lists the backups by date; `rclone copy offsite:cashflow-YYYY-MM-DD-HHMMSS.db .`
   downloads and decrypts one. It is a normal SQLite database for the app.

## Recovery

- Lost every passkey: in the Proxmox web Shell, `pct enter <ct>`, then run `cd /opt/cashflow && runuser -u cashflow -- env DB_PATH=/var/lib/cashflow/cashflow.db RP_ID=<name> ORIGINS=https://<name> node scripts/setup-token.ts`.
- Bad data: restore from the app (above). Or by hand: backups are in
  `/var/lib/cashflow/backups`. Stop the service, copy a backup over `cashflow.db` (owner
  `cashflow`, mode 600), start it.
