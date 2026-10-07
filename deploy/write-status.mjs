// Updates the status file the app shows under Settings → App updates.
// Usage: node write-status.mjs <status.json> key=value ...
//   key=value      sets a string field; an empty value removes it
//   key=@file.json sets a field from a JSON file
//   pending=@file  commits, one "sha<TAB>date<TAB>subject" per line
//   log=@file      the last 80 lines of a log
// Writes to a temporary file and renames, so the app never reads half a file.
import { readFileSync, renameSync, writeFileSync } from 'node:fs';

const [file, ...pairs] = process.argv.slice(2);
let status = {};
try { status = JSON.parse(readFileSync(file, 'utf8')); } catch { /* first run */ }

for (const pair of pairs) {
  const i = pair.indexOf('=');
  const key = pair.slice(0, i);
  const value = pair.slice(i + 1);
  if (value === '') delete status[key];
  else if (!value.startsWith('@')) status[key] = value;
  else {
    const text = readFileSync(value.slice(1), 'utf8');
    if (key === 'pending') {
      status[key] = text.split('\n').filter(Boolean).map((line) => {
        const [commit, committedAt, ...subject] = line.split('\t');
        return { commit, committedAt, subject: subject.join('\t') };
      });
    } else if (key === 'log') {
      // Strip terminal colour codes; keep the tail.
      status[key] = text.replace(/\x1b\[[0-9;]*m/g, '').split('\n').filter(Boolean).slice(-80);
    } else status[key] = JSON.parse(text);
  }
}

writeFileSync(`${file}.tmp`, JSON.stringify(status, null, 2), { mode: 0o644 });
renameSync(`${file}.tmp`, file);
