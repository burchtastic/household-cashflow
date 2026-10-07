#!/usr/bin/env bash
# One-time setup for Settings → App updates on the Proxmox container. Run from the repo root
# in Git Bash, after deploy/update.sh has shipped a version that includes this feature.
# Needs the temporary root SSH key on the Proxmox host (docs/DEPLOY.md) and the gh CLI
# signed in to GitHub, which adds the container's read-only deploy key to the repo.
set -euo pipefail

# Your Proxmox host, container and repo come from private/deploy.env (gitignored);
# copy deploy/deploy.env.example there and fill it in.
[ -f private/deploy.env ] && . private/deploy.env
HOST=${PVE_HOST:?Set PVE_HOST in private/deploy.env (see deploy/deploy.env.example)}
CT=${CT_ID:?Set CT_ID in private/deploy.env (see deploy/deploy.env.example)}
KEY=${SSH_KEY:-$HOME/.ssh/cashflow_proxmox}
REPO=${REPO:-$(gh repo view --json nameWithOwner --jq .nameWithOwner)}
SSH=(ssh -i "$KEY" -o BatchMode=yes "$HOST")
W=/var/lib/cashflow-deploy/home

# GitHub's published SSH host keys, so the container trusts github.com without guessing.
known=$(gh api meta --jq '.ssh_keys[] | "github.com " + .')

echo "Preparing container $CT"
pub=$("${SSH[@]}" "pct exec $CT -- bash -s" <<EOF
set -euo pipefail
[ -f /opt/cashflow/deploy/cashflow-deploy.path ] || { echo 'Run deploy/update.sh first' >&2; exit 1; }
command -v git >/dev/null && command -v ssh-keygen >/dev/null \
  || { apt-get update -qq && apt-get install -y -qq git openssh-client >/dev/null; }
id cashflow-deploy >/dev/null 2>&1 \
  || useradd --system --home-dir $W --no-create-home --shell /usr/sbin/nologin cashflow-deploy
install -d -o root -g root -m 755 /var/lib/cashflow-deploy
install -d -o cashflow-deploy -g cashflow-deploy -m 700 $W $W/.ssh
install -d -o cashflow -g cashflow -m 700 /var/lib/cashflow/deploy
printf '%s\n' "$known" > $W/.ssh/known_hosts
chown cashflow-deploy:cashflow-deploy $W/.ssh/known_hosts
[ -f $W/.ssh/deploy_key ] \
  || runuser -u cashflow-deploy -- ssh-keygen -q -t ed25519 -N '' -C cashflow-container-read-only -f $W/.ssh/deploy_key
cat $W/.ssh/deploy_key.pub
EOF
)

# Read-only (no --allow-write): the container can fetch the code, never push.
title='cashflow container (read-only)'
if gh repo deploy-key list -R "$REPO" | grep -qF "$title"; then
  echo "Deploy key already on GitHub"
else
  tmp=$(mktemp)
  printf '%s\n' "$pub" > "$tmp"
  gh repo deploy-key add "$tmp" -R "$REPO" --title "$title"
  rm -f "$tmp"
fi

echo "Cloning and installing the updater"
"${SSH[@]}" "pct exec $CT -- bash -s" <<EOF
set -euo pipefail
if [ ! -d $W/src ]; then
  runuser -u cashflow-deploy -- env -i HOME=$W PATH=/usr/bin:/bin git clone --quiet --no-checkout \
    -c core.sshCommand='ssh -i $W/.ssh/deploy_key -o IdentitiesOnly=yes -o UserKnownHostsFile=$W/.ssh/known_hosts -o StrictHostKeyChecking=yes' \
    git@github.com:$REPO.git $W/src
fi
install -m 644 /opt/cashflow/deploy/cashflow-deploy.path /opt/cashflow/deploy/cashflow-deploy.service /etc/systemd/system/
install -d -m 755 /etc/systemd/system/cashflow.service.d
install -m 644 /opt/cashflow/deploy/cashflow-updates.conf /etc/systemd/system/cashflow.service.d/updates.conf
systemctl daemon-reload
systemctl enable --now cashflow-deploy.path
systemctl restart cashflow.service
# A first check, so the page has something to show.
runuser -u cashflow -- sh -c 'printf check > /var/lib/cashflow/deploy/request'
EOF
echo "Done. Settings → App updates now works."
