import { useEffect, useRef, useState } from 'react';
import { api, type AccountRole, type PlaidAccount, type PlaidItem } from '../api.ts';
import { runLink, takePending, type LinkResult, type Pending } from '../plaidLink.ts';
import { ErrorNote, useLoad } from '../components/ui.tsx';
import { money, shortDate } from '../format.ts';

const when = (ms: number) =>
  new Date(ms).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

const HISTORY: Record<string, string> = {
  NOT_READY: 'Plaid is still fetching from the bank. Try Sync now in a few minutes.',
  INITIAL_UPDATE_COMPLETE: 'Recent activity is in; older history is still arriving.',
};

const ROLES: { value: AccountRole; label: string }[] = [
  { value: 'checking', label: 'Checking (the forecast account)' },
  { value: 'savings', label: 'Savings' },
  { value: 'card', label: 'Credit card' },
  { value: 'ignore', label: 'Ignore' },
];

const STATUS: Record<PlaidItem['status'], string> = {
  ok: 'Connected', login_required: 'Sign-in needed', error: 'Problem', removed: 'Removed',
};

/**
 * Bank connections. Lives at /connect (a real path, not a #route) so only this page's
 * Content-Security-Policy lets Plaid Link in. /plaid-oauth is the same page, picking up
 * a Link session where a bank's own sign-in page handed back.
 */
export function Connect() {
  const info = useLoad(api.plaid);
  // Bills that can pay a card.
  const bills = useLoad(api.bills);
  const cardBills = (bills.data?.bills ?? []).filter((b) => b.direction === 'out' && b.active);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

  const finish = async (r: LinkResult) => {
    if (r.kind === 'linked') {
      await api.plaidExchange(r.publicToken, r.institution);
      setMessage(`${r.institution.name} connected. Choose what each account is for below.`);
      // Balances now; transactions too if Plaid has them yet.
      await api.plaidSync();
    } else if (r.kind === 'repaired') {
      await api.plaidRefresh(r.itemId);
      setMessage('Sign-in fixed.');
    } else if (r.error) {
      throw new Error(r.error);
    }
  };

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try { await fn(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); info.reload(); }
  };

  const openLink = (itemId?: string) => run(async () => {
    const { linkToken } = await api.plaidLinkToken(itemId);
    const pending: Pending = { token: linkToken, ...(itemId && { itemId }) };
    await finish(await runLink(pending));
  });

  // Back from a bank's OAuth page: resume the Link session it interrupted.
  const resumed = useRef(false);
  useEffect(() => {
    if (location.pathname !== '/plaid-oauth' || resumed.current) return;
    resumed.current = true;
    const pending = takePending();
    const here = location.href;
    history.replaceState(null, '', '/connect');
    if (!pending) {
      setMessage('Bank sign-in finished. If this is a separate window, you can close it.');
      return;
    }
    run(async () => finish(await runLink(pending, here)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const d = info.data;
  if (info.error) return <ErrorNote error={info.error} />;
  if (!d) return <p className="empty">Loading…</p>;
  if (!d.enabled) {
    return (
      <>
        <div className="page-head"><h1>Bank connections</h1></div>
        <section className="card">
          <p>Bank connections aren't set up on this server. See <code>docs/DEPLOY.md</code> → Plaid.</p>
          <p><a href="/#/settings">Back to Settings</a></p>
        </section>
      </>
    );
  }

  const full = d.env === 'production' && d.slots.used >= d.slots.limit;
  return (
    <>
      <div className="page-head">
        <h1>Bank connections</h1>
        <span className="chip">{d.env === 'sandbox' ? 'Sandbox (test data)' : 'Live'}</span>
      </div>

      {message && <div className="banner">{message}</div>}
      <ErrorNote error={error} />

      <section className="card">
        <div className="card-head">
          <h2>Connect a bank</h2>
          {d.env === 'production' && (
            <span className="muted small">{d.slots.used} of {d.slots.limit} connections used</span>
          )}
        </div>
        <p className="hint">
          Read-only: Cashflow sees balances, transactions and card statements, and can't move money.
          {d.syncEveryMs && <> Syncs every {Math.round(d.syncEveryMs / 3_600_000)} hours.</>}
          {d.env === 'production' && <> Each new connection uses one of {d.slots.limit} for good, even if it's later
          removed. If a bank below stops working, use <strong>Fix sign-in</strong> rather than connecting it again.</>}
        </p>
        <div className="form-actions" style={{ justifyContent: 'flex-start' }}>
          <button className="primary" disabled={busy || full} onClick={() => openLink()}>
            {busy ? 'Working…' : 'Connect a bank'}
          </button>
          {d.items.length > 0 && (
            <button
              disabled={busy}
              onClick={() => run(async () => {
                const { results } = await api.plaidSync();
                const failed = results.filter((r) => !r.ok);
                if (failed.length) throw new Error(failed.map((r) => `${r.institutionName}: ${r.error}`).join(' · '));
                const saved = results.reduce((n, r) => n + (r.saved ?? 0), 0);
                setMessage(saved ? `Synced. ${saved} new or changed transaction${saved === 1 ? '' : 's'}.` : 'Synced. Nothing new.');
              })}
            >
              Sync now
            </button>
          )}
          <a href="/#/settings">Back to Settings</a>
        </div>
      </section>

      {d.items.length === 0 && <p className="empty">No banks connected yet.</p>}

      {d.items.map((item) => (
        <section className="card" key={item.itemId}>
          <div className="card-head">
            <h2>{item.institutionName}</h2>
            <span className={`status-label ${item.status === 'ok' ? 'good' : 'critical'}`}>{STATUS[item.status]}</span>
          </div>
          {item.error && <p className="error">{item.error}</p>}
          <p className="muted small">
            {item.lastSyncAt ? `Last synced ${when(item.lastSyncAt)}.` : 'Not synced yet.'}
            {item.lastSyncAt && HISTORY[item.updateStatus] && <> {HISTORY[item.updateStatus]}</>}
          </p>

          {item.accounts.length > 0 && (
            <div className="table-wrap">
              <table>
                <thead><tr><th>Account</th><th>Type</th><th className="num">Balance</th><th>Use as</th></tr></thead>
                <tbody>
                  {item.accounts.map((a) => (
                    <tr key={a.accountId}>
                      <td>
                        {a.name}{a.mask && <span className="faint"> ••{a.mask}</span>}
                        {a.role === 'card' && <CardStatement account={a} billName={(c) => cardBills.find((b) => b.code === c)?.name ?? c} />}
                        {a.transactionCount > 0 && <RecentActivity account={a} />}
                      </td>
                      <td className="small">{a.subtype || a.type}</td>
                      <td className="num"><Balance account={a} /></td>
                      <td>
                        <select
                          value={a.role}
                          disabled={busy}
                          aria-label={`Use ${a.name} as`}
                          onChange={(e) => run(() => api.plaidSetRole(a.accountId, e.target.value as AccountRole))}
                        >
                          {ROLES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                        </select>
                        {a.role === 'card' && (
                          <label className="field small" style={{ marginTop: 6 }} title="The entry on your Bills & income page for paying this card, e.g. 'Chase card'. Its statement becomes that bill's known amount.">
                            <span>Its payment on Bills &amp; income</span>
                            <select
                              value={a.billCode ?? ''}
                              disabled={busy}
                              onChange={(e) => run(() => api.plaidSetCardBill(a.accountId, e.target.value || null))}
                            >
                              <option value="">None chosen</option>
                              {cardBills.map((b) => <option key={b.code} value={b.code}>{b.name}</option>)}
                            </select>
                          </label>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="form-actions" style={{ justifyContent: 'flex-start' }}>
            {item.status !== 'ok' && (
              <button className="primary" disabled={busy} onClick={() => openLink(item.itemId)}>Fix sign-in</button>
            )}
            <button disabled={busy} onClick={() => run(() => api.plaidRefresh(item.itemId))}>Refresh accounts</button>
            {confirmRemove === item.itemId ? (
              <>
                <button className="danger" disabled={busy} onClick={() => { setConfirmRemove(null); run(() => api.plaidRemove(item.itemId)); }}>
                  Yes, disconnect
                </button>
                <button disabled={busy} onClick={() => setConfirmRemove(null)}>Keep it</button>
                {d.env === 'production' && <span className="hint">This doesn't give the connection slot back.</span>}
              </>
            ) : (
              <button className="danger" disabled={busy} onClick={() => setConfirmRemove(item.itemId)}>Disconnect</button>
            )}
          </div>
        </section>
      ))}
    </>
  );
}

/** Available is what can be spent now (pending charges already out); current is what has posted. */
function Balance({ account: a }: { account: PlaidAccount }) {
  if (a.currentCents === null && a.availableCents === null) return <span className="faint">–</span>;
  const main = a.type === 'credit' ? a.currentCents : a.availableCents ?? a.currentCents;
  const label = a.type === 'credit' ? 'owed' : a.availableCents !== null ? 'available' : 'current';
  return (
    <>
      {main !== null && money(main)} <span className="faint small">{label}</span>
      {a.type !== 'credit' && a.availableCents !== null && a.currentCents !== null && a.currentCents !== a.availableCents && (
        <div className="faint small">{money(a.currentCents)} posted</div>
      )}
    </>
  );
}

/** The bank's own list, newest first: a check that sync is working, before matching exists. */
function RecentActivity({ account }: { account: PlaidAccount }) {
  const [open, setOpen] = useState(false);
  const txns = useLoad(() => (open ? api.bankTransactions(account.accountId) : Promise.resolve(null)), [open]);
  return (
    <div className="small">
      <button className="link small" onClick={() => setOpen(!open)}>
        {open ? 'Hide' : 'Show'} recent activity ({account.transactionCount})
      </button>
      {open && (
        <>
          <ErrorNote error={txns.error} />
          {txns.data && (
            <table className="small" style={{ marginTop: 6 }}>
              <tbody>
                {txns.data.map((t) => (
                  <tr key={t.transactionId}>
                    <td>{shortDate(t.date)}</td>
                    <td>{t.merchantName || t.name}{t.pending && <span className="chip" style={{ marginLeft: 6 }}>Pending</span>}</td>
                    {/* Plaid's sign is the bank's view: positive leaves the account. Shown the ledger's way. */}
                    <td className="num">{money(-t.amountCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </div>
  );
}

/** The card's latest statement, and what it did to the forecast. */
function CardStatement({ account: a, billName }: { account: PlaidAccount; billName: (code: string) => string }) {
  const s = a.statement;
  const use = a.statementUse;
  if (!s || s.balanceCents === null) {
    return <div className="faint small">No statement from the bank yet.</div>;
  }
  return (
    <div className="small" style={{ marginTop: 4 }}>
      <div>
        Statement{s.date && <> {shortDate(s.date)}</>}: <strong>{money(s.balanceCents)}</strong>
        {s.dueDate && <> · due <strong>{shortDate(s.dueDate)}</strong></>}
        {s.minDueCents !== null && <> · minimum {money(s.minDueCents)}</>}
        {s.overdue && <span className="status-label critical"> · Overdue</span>}
      </div>
      {s.lastPaymentCents !== null && s.lastPaymentDate && (
        <div className="faint">Last payment {money(s.lastPaymentCents)} on {shortDate(s.lastPaymentDate)}</div>
      )}
      <div className="muted">
        {!a.billCode && "Pick this card's payment from your Bills & income page (e.g. 'Chase card') to use its statement in the forecast."}
        {a.billCode && use && use.problem !== null && use.problem}
        {a.billCode && use && use.problem === null && (use.keptManual
          ? `You typed in an amount for the ${shortDate(use.occurrenceDate)} ${billName(use.billCode)} payment, so it's left as is.`
          : `Known amount ${money(use.amountCents)} on the ${shortDate(use.occurrenceDate)} ${billName(use.billCode)} payment.`)}
      </div>
    </div>
  );
}
