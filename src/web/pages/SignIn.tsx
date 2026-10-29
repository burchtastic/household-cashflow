import { useState } from 'react';
import { auth } from '../api.ts';
import { ErrorNote } from '../components/ui.tsx';
import { Logo } from '../components/Logo.tsx';

function useAction(fn: () => Promise<void>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setError(null);
    try { await fn(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return { busy, error, run };
}

export function SignIn({ hasPasskeys, idle, onSignedIn }: { hasPasskeys: boolean; idle?: boolean; onSignedIn: () => void }) {
  const { busy, error, run } = useAction(async () => { await auth.signIn(); onSignedIn(); });
  return (
    <div className="auth-screen">
      <div className="card auth-card">
        <div className="auth-logo"><Logo size={64} /></div>
        <h1>Cash<span className="brand-flow">flow</span></h1>
        {idle && <p className="banner" role="status">Signed out after an hour without use.</p>}
        {hasPasskeys ? (
          <>
            <p className="muted">Sign in with the passkey on this device, or use your phone.</p>
            <button className="primary auth-button" onClick={run} disabled={busy} autoFocus>
              {busy ? 'Waiting for passkey…' : 'Sign in with passkey'}
            </button>
          </>
        ) : (
          <>
            <p className="muted">No passkey has been set up yet. On the server, run:</p>
            <pre className="code">npm run setup-token</pre>
            <p className="muted small">Then open the link it prints. The link works once and expires in 15 minutes.</p>
          </>
        )}
        <ErrorNote error={error} />
      </div>
    </div>
  );
}

export function Setup({ token, onDone }: { token: string; onDone: () => void }) {
  const [name, setName] = useState(guessDeviceName());
  const { busy, error, run } = useAction(async () => {
    await auth.register(name.trim() || 'Passkey', token);
    // Drop the token from the address bar and history.
    history.replaceState(null, '', `${location.pathname}#/`);
    dispatchEvent(new HashChangeEvent('hashchange')); // replaceState doesn't fire it
    onDone();
  });
  return (
    <div className="auth-screen">
      <div className="card auth-card">
        <div className="auth-logo"><Logo size={64} /></div>
        <h1>Create your passkey</h1>
        <p className="muted">
          Your device will ask for your fingerprint, face, or PIN. Nothing secret leaves the device. You can add more
          passkeys (your phone, for example) from Settings afterwards.
        </p>
        <form onSubmit={(e) => { e.preventDefault(); run(); }}>
          <label className="field">
            <span>Name for this passkey</span>
            <input value={name} maxLength={60} required onChange={(e) => setName(e.target.value)} />
          </label>
          <button type="submit" className="primary auth-button" disabled={busy}>
            {busy ? 'Waiting for passkey…' : 'Create passkey'}
          </button>
        </form>
        <ErrorNote error={error} />
      </div>
    </div>
  );
}

export function guessDeviceName(): string {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android phone';
  if (/Windows/.test(ua)) return 'Windows PC';
  if (/Mac OS/.test(ua)) return 'Mac';
  return 'This device';
}
