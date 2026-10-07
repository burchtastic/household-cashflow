#!/bin/sh
# Copies the nightly backups to encrypted off-site storage: the rclone remote "offsite"
# (a crypt remote over Google Drive, see docs/DEPLOY.md). Files are encrypted before
# they leave the container. Runs after cashflow-backup.service succeeds.
set -eu

export RCLONE_CONFIG="${RCLONE_CONFIG:-/var/lib/cashflow/rclone.conf}"
DIR="${BACKUP_DIR:-/var/lib/cashflow/backups}"
KEEP_DAYS="${OFFSITE_KEEP_DAYS:-90}"
MIN_RECENT=7

if [ ! -f "$RCLONE_CONFIG" ]; then
  echo "No off-site config at $RCLONE_CONFIG; skipping."
  exit 0
fi

# Copy only: a wiped local folder must never delete anything off-site.
rclone copy "$DIR" offsite: --include 'cashflow-*.db' --immutable

# Prune old copies, but only while plenty of recent ones exist, so a long run of
# failed backups can't age the last good copies away.
recent=$(rclone lsf offsite: --include 'cashflow-*.db' --max-age "${KEEP_DAYS}d" | wc -l)
if [ "$recent" -ge "$MIN_RECENT" ]; then
  rclone delete offsite: --include 'cashflow-*.db' --min-age "${KEEP_DAYS}d"
fi

echo "Off-site copy done: $(rclone lsf offsite: --include 'cashflow-*.db' | wc -l) backups stored."
