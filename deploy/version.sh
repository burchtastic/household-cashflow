#!/bin/sh
# Prints version.json for a commit (default HEAD) of the git repo in the current directory.
# The app shows it under Settings → App updates. For a GitHub merge commit the subject is
# the pull request's title (the first line of the body), not "Merge pull request #…".
set -eu
git log -1 --format='%H%n%cI%n%s%n%b' "${1:-HEAD}" | node -e '
  const [commit, committedAt, subject, ...body] = require("fs").readFileSync(0, "utf8").split("\n");
  const title = body.find((l) => l.trim());
  const s = /^Merge pull request #\d+/.test(subject) && title ? title.trim() : subject.trim();
  process.stdout.write(JSON.stringify({ commit, committedAt, subject: s }) + "\n");
'
