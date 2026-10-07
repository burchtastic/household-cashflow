#!/usr/bin/env bash
# Turns on bank connections (Plaid, read-only). Run as root inside the container:
#   pct enter <container id>, then: bash /opt/cashflow/deploy/setup-plaid.sh
# Asks for the Plaid keys, so they're typed here and never pass through anything else.
# Run it again to switch from sandbox to production; the token key is kept.
set -euo pipefail

FILE=/etc/cashflow/plaid.env
[ "$(id -u)" = 0 ] || { echo 'Run as root' >&2; exit 1; }
[ -f /opt/cashflow/deploy/cashflow-plaid.conf ] || { echo 'Update the app first (Settings → App updates)' >&2; exit 1; }

read -rp 'Environment (sandbox or production): ' env
[ "$env" = sandbox ] || [ "$env" = production ] || { echo 'Type sandbox or production' >&2; exit 1; }
read -rp 'Plaid client_id: ' client_id
read -rsp "Plaid $env secret (hidden): " secret; echo
[ -n "$client_id" ] && [ -n "$secret" ] || { echo 'Both are needed' >&2; exit 1; }
# Default: the app's own address (RP_ID in the service), which OAuth banks return to.
host=$(systemctl show cashflow -p Environment | grep -o 'RP_ID=[^ ]*' | cut -d= -f2 || true)
default=${host:+https://$host/plaid-oauth}
read -rp "Redirect URI [${default:-https://cashflow.<your-tailnet>.ts.net/plaid-oauth}]: " redirect
redirect=${redirect:-$default}
[ -n "$redirect" ] || { echo 'A redirect URI is needed' >&2; exit 1; }

# The key that encrypts bank access tokens in the database. Keep the existing one, or
# every saved connection becomes unreadable.
key=$(sed -n 's/^PLAID_TOKEN_KEY=//p' "$FILE" 2>/dev/null || true)
new_key=no
if [ -z "$key" ]; then key=$(openssl rand -base64 32); new_key=yes; fi

install -d -o root -g root -m 700 /etc/cashflow
umask 077
cat > "$FILE.tmp" <<EOF
PLAID_ENV=$env
PLAID_CLIENT_ID=$client_id
PLAID_SECRET=$secret
PLAID_TOKEN_KEY=$key
PLAID_REDIRECT_URI=$redirect
EOF
chmod 600 "$FILE.tmp" && mv "$FILE.tmp" "$FILE"

install -d -m 755 /etc/systemd/system/cashflow.service.d
install -m 644 /opt/cashflow/deploy/cashflow-plaid.conf /etc/systemd/system/cashflow.service.d/plaid.conf
systemctl daemon-reload
systemctl restart cashflow
sleep 2
systemctl is-active --quiet cashflow || { journalctl -u cashflow -n 20 --no-pager; exit 1; }

echo "Bank connections are on ($env). Open Settings → Manage bank connections."
if [ "$new_key" = yes ]; then
  echo
  echo 'Save this in your password manager as "Cashflow Plaid token key". Restoring a backup on a new'
  echo 'container needs it, or every bank connection has to be made again:'
  echo
  echo "  $key"
  echo
fi
