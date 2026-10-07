import { useState } from 'react';
import { auth } from '../api.ts';
import { guessDeviceName } from '../pages/SignIn.tsx';
import { ConfirmButton, ErrorNote, useLoad } from './ui.tsx';

const when = (ms: number | null) =>
  ms === null ? 'never' : new Date(ms).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });

export function Security() {
  const keys = useLoad(auth.passkeys);
  const [name, setName] = useState(guessDeviceName());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try { await fn(); keys.reload(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <section className="card">
      <div className="card-head">
        <h2>Passkeys</h2>
        <span className="muted small">Any of these can sign in. Keep at least two, on different devices.</span>
      </div>
      <ErrorNote error={keys.error ?? error} />
      <div className="table-wrap">
        <table>
          <thead><tr><th>Name</th><th>Added</th><th>Last used</th><th /></tr></thead>
          <tbody>
            {keys.data?.map((k) => (
              <tr key={k.id}>
                <td>{k.name}{k.backedUp && <div className="faint small">Synced (backed up by your password manager or OS)</div>}</td>
                <td className="small">{when(k.createdAt)}</td>
                <td className="small">{when(k.lastUsedAt)}</td>
                <td>
                  <div className="row-actions">
                    <ConfirmButton
                      label="Remove" confirmLabel="Yes, remove" className="small danger"
                      disabled={busy || keys.data!.length <= 1}
                      title={keys.data!.length <= 1 ? "You can't remove your only passkey" : undefined}
                      onConfirm={() => run(() => auth.removePasskey(k.id))}
                    />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <form className="inline-form" style={{ marginTop: 16 }} onSubmit={(e) => { e.preventDefault(); run(() => auth.register(name.trim() || 'Passkey')); }}>
        <label className="field"><span>New passkey name</span><input value={name} maxLength={60} onChange={(e) => setName(e.target.value)} /></label>
        <button type="submit" disabled={busy}>Add a passkey</button>
      </form>
      <p className="hint">To add your phone from this computer, choose "Use a phone or tablet" in the browser prompt and scan the QR code.</p>

      <div className="form-actions" style={{ justifyContent: 'flex-start' }}>
        <button className="danger" disabled={busy} onClick={() => run(() => auth.signOutEverywhere().then(() => location.reload()))}>
          Sign out everywhere
        </button>
      </div>
    </section>
  );
}
