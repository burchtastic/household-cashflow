import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type DeployInfo, type Version } from '../api.ts';
import { ErrorNote } from './ui.tsx';

const short = (sha: string) => sha.slice(0, 7);
const when = (iso: string) =>
  new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

function Commit({ v }: { v: Version }) {
  return (
    <>
      {v.subject} <span className="faint small">· <code>{short(v.commit)}</code> · {when(v.committedAt)}</span>
    </>
  );
}

/**
 * Settings → App updates. Asks the server to check GitHub or install the latest main branch;
 * the work happens in a separate root service (src/server/deploy.ts), so this only polls.
 */
export function AppUpdates() {
  const [info, setInfo] = useState<DeployInfo | null>(null);
  const [error, setError] = useState<string | null>(null); // from a check or update request
  const [confirming, setConfirming] = useState(false);
  // While an update restarts the server, requests fail for a few seconds.
  const [unreachable, setUnreachable] = useState<string | null>(null);
  // The version this page was loaded against; when the server's changes, the page is stale.
  const loadedWith = useRef<string | null | undefined>(undefined);

  const busy = !!info && (info.queued || info.status?.state === 'running');

  const load = useCallback(async () => {
    try {
      const d = await api.deployInfo();
      if (loadedWith.current === undefined) loadedWith.current = d.running?.commit ?? null;
      setInfo(d);
      setUnreachable(null);
    } catch (e) {
      setUnreachable((e as Error).message);
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  // Once a run shows up, an "already running" refusal has said all it needs to.
  useEffect(() => { if (busy) setError(null); }, [busy]);
  useEffect(() => {
    if (!busy && !unreachable) return;
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, [busy, unreachable, load]);

  const ask = async (action: 'check' | 'deploy') => {
    setConfirming(false);
    setError(null);
    try { await api.requestDeploy(action); } catch (e) { setError((e as Error).message); }
    load();
  };

  const head = (
    <div className="card-head">
      <h2>App updates</h2>
      <span className="muted small">Installs the latest version from GitHub. Your data stays put.</span>
    </div>
  );
  if (!info) return <section className="card">{head}{unreachable ? <ErrorNote error={unreachable} /> : <p className="empty">Loading…</p>}</section>;

  if (!info.enabled) {
    return (
      <section className="card">
        {head}
        <p className="hint">
          Not set up on this server yet. Run <code>deploy/setup-app-updates.sh</code> once from your PC (see docs/DEPLOY.md).
        </p>
      </section>
    );
  }

  const { running, status } = info;
  const latest = status?.latest;
  const upToDate = !!latest && !!running && (latest.commit === running.commit || status?.sameAs === running.commit);
  const pending = upToDate ? [] : status?.pending ?? [];
  const updated = loadedWith.current !== undefined && (running?.commit ?? null) !== loadedWith.current;

  return (
    <section className="card">
      {head}

      <p><span className="muted">Running:</span> {running ? <Commit v={running} /> : 'an older version (from before version tracking)'}</p>

      {updated && (
        <div className="update-banner">
          <span>Updated. Reload to use the new version.</span>
          <button className="primary small" onClick={() => location.reload()}>Reload</button>
        </div>
      )}

      {unreachable && busy ? (
        <p className="update-status">Restarting the app…</p>
      ) : busy ? (
        <p className="update-status">
          {info.queued && !(status?.state === 'running')
            ? 'Starting…'
            : status!.action === 'check' ? 'Checking GitHub…' : `Updating: ${status!.step ?? 'working'}…`}
        </p>
      ) : status?.state === 'failed' ? (
        <p className="update-status bad">{status.message ?? 'The last run failed.'}</p>
      ) : status?.finishedAt ? (
        <p className="update-status muted small">
          {upToDate ? 'Up to date. ' : ''}Last checked {when(status.finishedAt)}.
        </p>
      ) : null}
      {!busy && <ErrorNote error={unreachable ?? error} />}

      {!busy && pending.length > 0 && (
        <>
          <p className="small"><strong>{pending.length === 1 ? '1 change' : `${pending.length} changes`}</strong> on GitHub since this version:</p>
          <ul className="commit-list">
            {pending.map((c) => <li key={c.commit}><Commit v={c} /></li>)}
          </ul>
        </>
      )}

      {confirming ? (
        <div className="update-confirm">
          <p className="small">
            This backs up your database, installs {latest ? <code>{short(latest.commit)}</code> : 'the latest version'}, and
            restarts the app. It takes a couple of minutes. If the new version doesn't start, the current one is put back.
          </p>
          <div className="form-actions" style={{ justifyContent: 'flex-start' }}>
            <button className="primary" onClick={() => ask('deploy')}>Update now</button>
            <button onClick={() => setConfirming(false)}>Cancel</button>
          </div>
        </div>
      ) : (
        <div className="form-actions" style={{ justifyContent: 'flex-start' }}>
          <button disabled={busy} onClick={() => ask('check')}>Check for updates</button>
          {pending.length > 0 && <button className="primary" disabled={busy} onClick={() => setConfirming(true)}>Update…</button>}
        </div>
      )}

      {!busy && status?.log && status.log.length > 0 && (
        <details className="update-log" open={status.state === 'failed'}>
          <summary className="small muted">Log of the last run</summary>
          <pre className="code">{status.log.join('\n')}</pre>
        </details>
      )}
    </section>
  );
}
