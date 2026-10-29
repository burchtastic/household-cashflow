import { useEffect, useState } from 'react';
import { api, type BackupFile, type BackupSummary, type LastRestore } from '../api.ts';
import { longDate, money } from '../format.ts';
import { ErrorNote } from './ui.tsx';

const when = (iso: string) =>
  new Date(iso).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
const size = (bytes: number) => `${Math.max(1, Math.round(bytes / 1024)).toLocaleString('en-US')} KB`;
const SHOWN = 10;

/**
 * Settings → Restore from a backup. Lists the encrypted copies on Google Drive; the key from the
 * password manager downloads and checks one, then a confirm swaps it in and the app restarts
 * (src/server/restore.ts).
 */
export function RestoreBackup() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [last, setLast] = useState<LastRestore | null>(null);
  const [backups, setBackups] = useState<BackupFile[] | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [chosen, setChosen] = useState<BackupFile | null>(null);
  const [key, setKey] = useState('');
  const [summary, setSummary] = useState<BackupSummary | null>(null);
  const [busy, setBusy] = useState<string | null>(null); // what's happening, while it happens
  const [error, setError] = useState<string | null>(null);
  // Set once a restore is sent (to the last restore before it): the app restarts, then reports a new one.
  const [restoringAfter, setRestoringAfter] = useState<string | null>(null);
  const [restored, setRestored] = useState<LastRestore | null>(null);

  useEffect(() => {
    api.restoreInfo().then((r) => { setEnabled(r.enabled); setLast(r.last); }, (e: Error) => setError(e.message));
  }, []);

  // While the app restarts, requests fail for a few seconds; keep asking until it says it's done.
  useEffect(() => {
    if (restoringAfter === null) return;
    const t = setInterval(() => {
      api.restoreInfo().then((r) => {
        if (r.last && r.last.at !== restoringAfter) {
          setRestored(r.last);
          setLast(r.last);
          setRestoringAfter(null);
        }
      }, () => { /* still restarting */ });
    }, 2000);
    return () => clearInterval(t);
  }, [restoringAfter]);

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    try { await fn(); } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  };
  const choose = (b: BackupFile | null) => {
    setChosen(b);
    setKey('');
    setSummary(null);
    setError(null);
  };

  const head = (
    <div className="card-head">
      <h2>Restore from a backup</h2>
      <span className="muted small">Encrypted nightly copies on Google Drive, kept 45 days.</span>
    </div>
  );
  if (enabled === null) return <section className="card">{head}{error ? <ErrorNote error={error} /> : <p className="empty">Loading…</p>}</section>;
  if (!enabled) {
    return (
      <section className="card">
        {head}
        <p className="hint">Off-site backups aren't set up on this server yet (see docs/DEPLOY.md → Off-site backups).</p>
      </section>
    );
  }

  if (restored || restoringAfter !== null) {
    return (
      <section className="card">
        {head}
        {restored ? (
          <div className="update-banner" role="status">
            <span>Restored the backup from {chosen ? when(chosen.takenAt) : restored.name}. Reload to see it.</span>
            <button className="primary small" onClick={() => location.reload()}>Reload</button>
          </div>
        ) : (
          <p className="update-status">Restoring and restarting the app…</p>
        )}
      </section>
    );
  }

  const shown = backups && (showAll ? backups : backups.slice(0, SHOWN));

  return (
    <section className="card">
      {head}
      <p className="hint">
        Restoring replaces everything in the app (bills, history, balances and bank connections) with the backup. Your
        passkeys stay as they are, and your current data is saved first, so a restore can be undone by restoring that copy.
        You'll need the backup encryption key from your password manager.
      </p>
      {last && (
        <p className="muted small">
          Last restore: {when(last.at)}, from <code>{last.name}</code>.
          {last.savedAs && <> The data before it was saved as <code>{last.savedAs}</code>.</>}
        </p>
      )}

      {!backups ? (
        <div className="form-actions" style={{ justifyContent: 'flex-start' }}>
          <button disabled={busy !== null} onClick={() => run('Looking on Google Drive…', async () => setBackups(await api.backups()))}>
            Show backups
          </button>
        </div>
      ) : backups.length === 0 ? (
        <p className="empty">No backups on Google Drive yet. The first copy goes up after the next nightly backup.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Taken</th><th className="num">Size</th><th /></tr></thead>
            <tbody>
              {shown!.map((b) => (
                <tr key={b.name} className={chosen?.name === b.name ? 'selected' : undefined}>
                  <td>
                    {when(b.takenAt)}
                    {b.beforeRestore && <div className="faint small">Your data just before a restore</div>}
                  </td>
                  <td className="num small">{size(b.size)}</td>
                  <td>
                    <div className="row-actions">
                      <button className="small" disabled={busy !== null || chosen?.name === b.name} onClick={() => choose(b)}>Restore…</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {backups.length > SHOWN && (
            <button className="small link" onClick={() => setShowAll(!showAll)}>
              {showAll ? 'Show fewer' : `Show all ${backups.length}`}
            </button>
          )}
        </div>
      )}

      {busy && <p className="update-status muted small">{busy}</p>}
      {!chosen && <ErrorNote error={error} />}

      {chosen && (
        <div className="update-confirm">
          <p><strong>Backup from {when(chosen.takenAt)}</strong></p>
          {!summary ? (
            <form
              className="inline-form"
              onSubmit={(e) => {
                e.preventDefault();
                run('Downloading and checking the backup…', async () => setSummary(await api.checkBackup(chosen.name, key)));
              }}
            >
              {/* The username field is for password managers, which fill keys more reliably beside one. */}
              <input type="text" name="username" value="Cashflow off-site backup" autoComplete="username" readOnly hidden />
              <label className="field">
                <span>Backup encryption key</span>
                <input
                  type="password" autoComplete="current-password" autoFocus required maxLength={1024}
                  value={key} onChange={(e) => setKey(e.target.value)} disabled={busy !== null}
                />
              </label>
              <button type="submit" className="primary" disabled={busy !== null || !key}>Unlock and check</button>
              <button type="button" disabled={busy !== null} onClick={() => choose(null)}>Cancel</button>
            </form>
          ) : (
            <>
              <p className="small">The key works and the backup is sound. It holds:</p>
              <ul className="small">
                <li>{summary.bills} active bills</li>
                <li>
                  {summary.transactions.toLocaleString('en-US')} transactions
                  {summary.lastTransaction && `, the latest on ${longDate(summary.lastTransaction)}`}
                </li>
                {summary.checking && <li>Checking balance {money(summary.checking.amountCents)} as of {longDate(summary.checking.date)}</li>}
                <li>{summary.banks === 1 ? '1 bank connection' : `${summary.banks} bank connections`}</li>
              </ul>
              <p className="small">
                Anything entered since this backup will be gone from the app (it stays in the copy saved first). Bank
                connections made since then will need connecting again.
              </p>
              <div className="form-actions" style={{ justifyContent: 'flex-start' }}>
                <button
                  className="danger" disabled={busy !== null}
                  onClick={() => run('Restoring…', async () => {
                    await api.restoreBackup(chosen.name);
                    setRestoringAfter(last?.at ?? '');
                  })}
                >
                  Replace my data with this backup
                </button>
                <button disabled={busy !== null} onClick={() => choose(null)}>Cancel</button>
              </div>
            </>
          )}
          <ErrorNote error={error} />
        </div>
      )}
    </section>
  );
}
