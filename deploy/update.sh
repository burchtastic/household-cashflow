#!/usr/bin/env bash
# Ship the committed code to the Proxmox container, rebuild, back up, restart.
# Normally you update from the app instead (Settings → App updates); this is the fallback
# that works from your PC even if the in-app updater is broken.
# Run from the repo root (Git Bash on Windows works). Needs root SSH to the Proxmox
# host; the key is removed between updates, so re-add it first (docs/DEPLOY.md).
set -euo pipefail

# Your Proxmox host, container and repo come from private/deploy.env (gitignored);
# copy deploy/deploy.env.example there and fill it in.
[ -f private/deploy.env ] && . private/deploy.env
HOST=${PVE_HOST:?Set PVE_HOST in private/deploy.env (see deploy/deploy.env.example)}
CT=${CT_ID:?Set CT_ID in private/deploy.env (see deploy/deploy.env.example)}
KEY=${SSH_KEY:-$HOME/.ssh/cashflow_proxmox}
SSH=(ssh -i "$KEY" -o BatchMode=yes "$HOST")

if ! git diff --quiet HEAD; then
  echo "Uncommitted changes. Commit first so the server runs exactly what is in git." >&2
  exit 1
fi
rev=$(git rev-parse --short HEAD)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
git archive --format=tar.gz -o "$tmp/app.tar.gz" HEAD
sh deploy/version.sh > "$tmp/version.json"

echo "Shipping $rev to container $CT on $HOST"
"${SSH[@]}" 'install -d -m 700 /root/cashflow-xfer'
scp -q -i "$KEY" -o BatchMode=yes "$tmp/app.tar.gz" "$tmp/version.json" "$HOST:/root/cashflow-xfer/"
"${SSH[@]}" "pct push $CT /root/cashflow-xfer/app.tar.gz /root/app.tar.gz && pct push $CT /root/cashflow-xfer/version.json /root/version.json && rm -rf /root/cashflow-xfer"

# Build beside the live copy, back up the database, then swap and restart.
"${SSH[@]}" "pct exec $CT -- bash -s" <<EOF
set -euo pipefail
rm -rf /opt/cashflow.new && mkdir /opt/cashflow.new
tar -xzf /root/app.tar.gz -C /opt/cashflow.new && rm /root/app.tar.gz
mv /root/version.json /opt/cashflow.new/version.json
cd /opt/cashflow.new
npm ci --no-audit --no-fund --loglevel=error
npm run -s build >/dev/null
npm prune --omit=dev --no-audit --no-fund --loglevel=error
chown -R root:root /opt/cashflow.new
systemctl start cashflow-backup.service
systemctl stop cashflow.service
rm -rf /opt/cashflow.old && mv /opt/cashflow /opt/cashflow.old && mv /opt/cashflow.new /opt/cashflow
systemctl start cashflow.service
for i in \$(seq 1 20); do
  curl -sf http://127.0.0.1:8787/api/health >/dev/null && { echo "Running $rev"; exit 0; }
  sleep 1
done
echo "New version did not come up; rolling back" >&2
systemctl stop cashflow.service
rm -rf /opt/cashflow && mv /opt/cashflow.old /opt/cashflow
systemctl start cashflow.service
exit 1
EOF
