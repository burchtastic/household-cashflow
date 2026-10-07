/**
 * Plaid Link, the bank sign-in window. Its script loads only on /connect and /plaid-oauth,
 * the two pages whose Content-Security-Policy allows it (src/server/app.ts).
 */

const SCRIPT = 'https://cdn.plaid.com/link/v2/stable/link-initialize.js';
/** The Link session in progress, so the OAuth return page can pick it up. */
const PENDING = 'cashflow:plaid-link';

interface LinkError { error_code: string; error_message: string; display_message: string | null }
interface SuccessMeta { institution: { name: string; institution_id: string } | null }
interface Handler { open: () => void; destroy: () => void }
declare global {
  interface Window {
    Plaid?: {
      create: (o: {
        token: string;
        receivedRedirectUri?: string;
        onSuccess: (publicToken: string, meta: SuccessMeta) => void;
        onExit: (err: LinkError | null) => void;
      }) => Handler;
    };
  }
}

let loading: Promise<void> | null = null;
function loadScript(): Promise<void> {
  loading ??= new Promise<void>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = SCRIPT;
    s.onload = () => resolve();
    s.onerror = () => { loading = null; reject(new Error("Couldn't load Plaid Link. Check the connection and try again.")); };
    document.head.appendChild(s);
  });
  return loading;
}

export interface Pending { token: string; itemId?: string }

export type LinkResult =
  | { kind: 'linked'; publicToken: string; institution: { id: string; name: string } }
  | { kind: 'repaired'; itemId: string }
  | { kind: 'exited'; error: string | null };

/** Opens Link. With `receivedRedirectUri`, resumes a session after a bank's OAuth page. */
export async function runLink(pending: Pending, receivedRedirectUri?: string): Promise<LinkResult> {
  await loadScript();
  if (!window.Plaid) throw new Error('Plaid Link did not start.');
  try { sessionStorage.setItem(PENDING, JSON.stringify(pending)); } catch { /* OAuth resume won't work; Link still does */ }
  return new Promise<LinkResult>((resolve) => {
    const done = (r: LinkResult) => {
      try { sessionStorage.removeItem(PENDING); } catch { /* ignore */ }
      handler.destroy();
      resolve(r);
    };
    const handler = window.Plaid!.create({
      token: pending.token,
      receivedRedirectUri,
      onSuccess: (publicToken, meta) => done(pending.itemId
        ? { kind: 'repaired', itemId: pending.itemId }
        : {
          kind: 'linked', publicToken,
          institution: { id: meta.institution?.institution_id ?? '', name: meta.institution?.name ?? 'Bank' },
        }),
      onExit: (err) => done({ kind: 'exited', error: err ? err.display_message || err.error_message : null }),
    });
    handler.open();
  });
}

export function takePending(): Pending | null {
  try {
    const raw = sessionStorage.getItem(PENDING);
    return raw ? JSON.parse(raw) as Pending : null;
  } catch { return null; }
}
