#!/usr/bin/env bash
# Updates the app from GitHub when asked from Settings → App updates.
# Runs as root from cashflow-deploy.service, started by cashflow-deploy.path when the app
# drops a request file. The request can only say "check" or "deploy": it always means the
# main branch on GitHub, so the app decides when to update but never what code runs.
#
# Fetching and building run as the unprivileged cashflow-deploy user, which holds a
# read-only GitHub deploy key. Root only copies the built result into place, backs up the
# database, and restarts, rolling back if the new version doesn't come up (as update.sh does).
set -Eeuo pipefail

REQUEST=/var/lib/cashflow/deploy/request
STATE=/var/lib/cashflow-deploy            # root-owned: status the app reads
WORK=$STATE/home                          # cashflow-deploy's: deploy key, clone, build
SRC=$WORK/src
BUILD=$WORK/build
APP=/opt/cashflow
REF=origin/main
LOG=$STATE/last.log
DIR=$(cd "$(dirname "$0")" && pwd)

st() { node "$DIR/write-status.mjs" "$STATE/status.json" "$@"; }
now() { date -Is; }
as_deploy() { runuser -u cashflow-deploy -- env -i HOME="$WORK" PATH=/usr/local/bin:/usr/bin:/bin "$@"; }

# The request file sits in a directory the app can write, so read it warily: no symlinks,
# a few bytes at most, and only two accepted words.
action=''
if [ -f "$REQUEST" ] && [ ! -L "$REQUEST" ]; then action=$(timeout 5 head -c 16 "$REQUEST" || true); fi
rm -f "$REQUEST"
case "$action" in
  check | deploy) ;;
  *) echo "Ignoring request '$action'"; exit 0 ;;
esac

: > "$LOG"
exec > >(tee -a "$LOG") 2>&1

step='Checking GitHub'
st state=running action="$action" startedAt="$(now)" finishedAt= message= log= step="$step"
trap 'st state=failed finishedAt="$(now)" message="Failed while: $step" log=@"$LOG"' ERR

running=$(node -p 'require(process.argv[1]).commit' "$APP/version.json" 2>/dev/null || true)
as_deploy git -C "$SRC" fetch --quiet origin main
latest=$(as_deploy git -C "$SRC" rev-parse "$REF")
as_deploy sh -c 'cd "$1" && sh "$2" "$3"' _ "$SRC" "$DIR/version.sh" "$REF" > "$STATE/latest.json"
# A merge commit can carry exactly the code already running; that counts as up to date.
same=''
if [ -n "$running" ] && as_deploy git -C "$SRC" diff --quiet "$running" "$REF" 2>/dev/null; then same=$running; fi
if [ -n "$same" ]; then
  : > "$STATE/pending.tsv"
elif [ -n "$running" ] && as_deploy git -C "$SRC" cat-file -e "$running^{commit}" 2>/dev/null; then
  as_deploy git -C "$SRC" log --no-merges --format='%H%x09%cI%x09%s' "$running..$REF" > "$STATE/pending.tsv"
else
  as_deploy git -C "$SRC" log --no-merges --format='%H%x09%cI%x09%s' -10 "$REF" > "$STATE/pending.tsv"
fi
st latest=@"$STATE/latest.json" pending=@"$STATE/pending.tsv" sameAs="$same"

if [ "$action" = check ] || [ -n "$same" ]; then
  [ -n "$same" ] && msg='Up to date' || msg='Updates available'
  st state=ok finishedAt="$(now)" step= message="$msg" log=@"$LOG"
  exit 0
fi

step='Building'
st step="$step"
echo "Building ${latest:0:7}"
as_deploy rm -rf "$BUILD"
as_deploy mkdir "$BUILD"
as_deploy sh -c 'git -C "$1" archive "$2" | tar -x -C "$3"' _ "$SRC" "$REF" "$BUILD"
as_deploy sh -c 'cd "$1" && npm ci --no-audit --no-fund --loglevel=error && npm run -s build && npm prune --omit=dev --no-audit --no-fund --loglevel=error' _ "$BUILD"

# Root takes ownership of a copy, so the build user can't change the code that runs.
step='Installing'
st step="$step"
rm -rf "$APP.new" && mkdir -m 755 "$APP.new"
tar -C "$BUILD" -cf - . | tar -C "$APP.new" -xf - --no-same-owner
chown -R -h root:root "$APP.new"
chmod -R go-w,ug-s "$APP.new"
install -m 644 "$STATE/latest.json" "$APP.new/version.json"
as_deploy rm -rf "$BUILD"

step='Backing up the database'
st step="$step"
systemctl start cashflow-backup.service

step='Restarting'
st step="$step"
systemctl stop cashflow.service
rm -rf "$APP.old" && mv "$APP" "$APP.old" && mv "$APP.new" "$APP"
systemctl start cashflow.service
for _ in $(seq 1 30); do
  if curl -sf http://127.0.0.1:8787/api/health > /dev/null; then
    echo "Running ${latest:0:7}"
    : > "$STATE/pending.tsv"
    st state=ok finishedAt="$(now)" step= message="Updated to ${latest:0:7}" pending=@"$STATE/pending.tsv" sameAs="$latest" log=@"$LOG"
    exit 0
  fi
  sleep 1
done

echo 'New version did not come up; rolling back'
systemctl stop cashflow.service
rm -rf "$APP" && mv "$APP.old" "$APP"
systemctl start cashflow.service
st state=failed finishedAt="$(now)" step= message="The new version didn't start, so the previous one was put back" log=@"$LOG"
exit 1
