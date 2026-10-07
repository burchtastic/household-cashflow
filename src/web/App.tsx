import { useCallback, useEffect, useState } from 'react';
import { api, auth, SIGNED_OUT_EVENT } from './api.ts';
import { Setup, SignIn } from './pages/SignIn.tsx';
import { Bills } from './pages/Bills.tsx';
import { Connect } from './pages/Connect.tsx';
import { Wordmark } from './components/Logo.tsx';
import { Dashboard } from './pages/Dashboard.tsx';
import { History } from './pages/History.tsx';
import { OneOffs } from './pages/OneOffs.tsx';
import { SettingsPage } from './pages/SettingsPage.tsx';

const ROUTES = [
  { hash: '#/', label: 'Dashboard', page: Dashboard },
  { hash: '#/bills', label: 'Bills', page: Bills },
  { hash: '#/one-offs', label: 'One-offs', page: OneOffs },
  { hash: '#/history', label: 'History', page: History },
  { hash: '#/settings', label: 'Settings', page: SettingsPage },
];

function useHash() {
  const [hash, setHash] = useState(location.hash || '#/');
  useEffect(() => {
    const on = () => setHash(location.hash || '#/');
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  return hash;
}

type AuthState = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'out'; hasPasskeys: boolean } | { kind: 'in'; demo: boolean };

export function App() {
  const hash = useHash();
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => setMenuOpen(false), [hash]);
  const [state, setState] = useState<AuthState>({ kind: 'loading' });

  const refresh = useCallback(() => {
    auth.status().then(
      (s) => setState(s.authenticated ? { kind: 'in', demo: s.demo } : { kind: 'out', hasPasskeys: s.hasPasskeys }),
      (e: Error) => setState({ kind: 'error', message: e.message }),
    );
  }, []);
  useEffect(refresh, [refresh]);
  useEffect(() => {
    addEventListener(SIGNED_OUT_EVENT, refresh);
    return () => removeEventListener(SIGNED_OUT_EVENT, refresh);
  }, [refresh]);

  const setupToken = hash.startsWith('#/setup') ? new URLSearchParams(hash.split('?')[1] ?? '').get('token') : null;
  if (setupToken) return <Setup token={setupToken} onDone={refresh} />;
  if (state.kind === 'loading') return null;
  if (state.kind === 'error') return <div className="auth-screen"><p className="error">{state.message}</p></div>;
  if (state.kind === 'out') return <SignIn hasPasskeys={state.hasPasskeys} onSignedIn={refresh} />;

  // Bank connections live on real paths, the only pages allowed to load Plaid Link.
  const connect = ['/connect', '/plaid-oauth'].includes(location.pathname);
  const route = connect ? null : ROUTES.find((r) => r.hash === hash) ?? ROUTES[0];
  const Page = route?.page ?? Connect;
  return (
    <div className="shell">
      <header className="topbar">
        <a href="/#/" className="brand-link" aria-label="Cashflow, home"><Wordmark size={26} /></a>
        {/* On phones the links and Sign out fold into a menu button. */}
        <button
          className="menu-toggle" aria-label="Menu" aria-expanded={menuOpen} aria-controls="main-menu"
          onClick={() => setMenuOpen(!menuOpen)}
        >
          <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            {menuOpen ? <path d="M5 5l10 10M15 5L5 15" /> : <path d="M3 5h14M3 10h14M3 15h14" />}
          </svg>
        </button>
        <div id="main-menu" className={`menu${menuOpen ? ' open' : ''}`}>
          <nav className="nav" aria-label="Main">
            {ROUTES.map((r) => (
              <a key={r.hash} href={`/${r.hash}`} aria-current={r === route ? 'page' : undefined} onClick={() => setMenuOpen(false)}>
                {r.label}
              </a>
            ))}
          </nav>
          <button className="small signout" onClick={() => auth.signOut().finally(refresh)}>Sign out</button>
        </div>
      </header>
      {state.demo && (
        <div className="demo-banner" role="status">
          <strong>DEMO</strong>
          <span>Every number here is made up. Nothing can be changed.</span>
          <button className="small" onClick={() => api.setDemo(false).then(() => location.reload())}>Turn off</button>
        </div>
      )}
      <main>
        <Page key={route?.hash ?? 'connect'} />
      </main>
    </div>
  );
}
