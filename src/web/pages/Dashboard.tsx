import { useState, type ReactNode } from 'react';
import { diffDays } from '../../engine/dates.ts';
import type { Forecast, LedgerEvent, Settings } from '../../engine/index.ts';
import { api, type BankBalance, type BillWithStats, type ReviewItem } from '../api.ts';
import { BalanceChart } from '../components/BalanceChart.tsx';
import { EditTransactionForm } from '../components/EditTransaction.tsx';
import { AsyncForm, DateText, ErrorNote, Modal, MoneyInput, PencilIcon, StatusChip, useLoad } from '../components/ui.tsx';
import { OneOffForm } from './OneOffs.tsx';
import { localToday, longDate, money, money0, relativeDays, shortDate } from '../format.ts';

/** Paid/Received is offered for anything already due, and for the next one of each item up to this far ahead. */
const CONFIRM_AHEAD_DAYS = 14;

type Action =
  | { kind: 'confirm'; event: LedgerEvent }
  | { kind: 'known'; event: LedgerEvent }
  | { kind: 'edit'; event: LedgerEvent }
  | { kind: 'balance'; account: 'checking' | 'savings' }
  | { kind: 'planned'; event: LedgerEvent }
  | null;

export function Dashboard() {
  const { data, error, reload } = useLoad(api.forecast);
  const bank = useLoad(api.bankBalances);
  const [action, setAction] = useState<Action>(null);
  const close = () => setAction(null);
  const done = () => { close(); reload(); };

  // A fresh install has no balance yet, so there's nothing to forecast from.
  if (error === 'Enter a checking balance first') {
    return (
      <section className="card" style={{ marginTop: 20 }}>
        <div className="card-head"><h2>Get started</h2></div>
        <p>
          The forecast needs your bills and a checking balance. The quickest way: fill in the import template and load it
          in <a href="/#/settings">Settings → Import from a spreadsheet</a>.
        </p>
        <p className="muted small">
          Or add bills on the <a href="/#/bills">Bills</a> page, then enter today's checking balance here.
        </p>
        <div className="form-actions" style={{ justifyContent: 'flex-start' }}>
          <button className="primary" onClick={() => setAction({ kind: 'balance', account: 'checking' })}>Enter checking balance</button>
        </div>
        <Modal title={modalTitle(action)} open={action?.kind === 'balance'} onClose={close}>
          {action?.kind === 'balance' && <BalanceForm account="checking" today={localToday()} onDone={done} onCancel={close} />}
        </Modal>
      </section>
    );
  }
  if (error) return <ErrorNote error={error} />;
  if (!data) return <p className="empty">Loading…</p>;
  const { forecast: f, settings } = data;
  const staleDays = diffDays(f.today, f.start.date);

  return (
    <>
      <OverdraftAlert f={f} />
      {bank.data?.enabled && bank.data.checking && (
        <BankCheck key={`c${bank.data.checking.amountCents}:${f.todayBalanceCents}`} account="checking" bank={bank.data.checking} ledgerCents={f.todayBalanceCents} f={f} onUsed={reload} />
      )}
      {bank.data?.enabled && bank.data.savings && f.savings && (
        <BankCheck key={`s${bank.data.savings.amountCents}:${f.savings.balanceTodayCents}`} account="savings" bank={bank.data.savings} ledgerCents={f.savings.balanceTodayCents} f={f} onUsed={reload} />
      )}
      {staleDays > 7 && (
        <div className="banner warn">
          <span>
            Checking balance was last entered <strong>{longDate(f.start.date)}</strong> ({staleDays} days ago).
            Everything since is projected. Update it to clear the items below.
          </span>
          <button className="primary small" onClick={() => setAction({ kind: 'balance', account: 'checking' })}>
            Update balance
          </button>
        </div>
      )}

      <section className="hero">
        <div className="card">
          <div className="tile-label muted small">Checking today</div>
          <div className={`hero-figure${f.todayBalanceCents < 0 ? ' negative' : ''}`}>{money(f.todayBalanceCents)}</div>
          <div className="muted small">
            {staleDays === 0 ? 'Entered today' : `Projected from ${money(f.start.balanceCents)} on ${shortDate(f.start.date)}`}
            {' · '}
            <button className="link small" onClick={() => setAction({ kind: 'balance', account: 'checking' })}>update</button>
          </div>
        </div>
        <Decision f={f} settings={settings} onChanged={reload} />
      </section>

      <section className="card">
        <div className="card-head">
          <h2>Projected checking balance</h2>
          <span className="muted small">through {longDate(f.horizonEnd)}</span>
        </div>
        <BalanceChart
          daily={f.daily}
          events={f.events}
          today={f.today}
          floorCents={settings.bufferFloorCents}
          lowest={f.lowest}
          drawCodes={settings.savingsDrawCodes}
        />
      </section>

      <section className="tiles" style={{ marginTop: 16 }}>
        <div className={`tile${f.lowest.balanceCents < 0 ? ' negative' : ''}`}>
          <div className="label">Lowest point</div>
          <div className="value">{money(f.lowest.balanceCents)}</div>
          <div className="sub">{shortDate(f.lowest.date)} · {relativeDays(f.lowest.date, f.today)}</div>
        </div>
        <div className="tile">
          <div className="label">Next paycheck</div>
          <div className="value">{f.nextPaycheck ? money(f.nextPaycheck.amountCents) : '—'}</div>
          <div className="sub">{f.nextPaycheck ? `${shortDate(f.nextPaycheck.date)} · ${relativeDays(f.nextPaycheck.date, f.today)}` : 'None scheduled'}</div>
        </div>
        <div className="tile">
          <div className="label">Still estimated</div>
          <div className="value">{money0(f.estimatedOutflowCents)}</div>
          <div className="sub">of upcoming bills are guesses</div>
        </div>
        <SavingsTile f={f} onUpdate={() => setAction({ kind: 'balance', account: 'savings' })} />
      </section>

      <ToReview onChanged={reload} />

      {f.unconfirmed.length > 0 && (
        <section className="card" style={{ marginTop: 16 }}>
          <div className="card-head">
            <h2>Needs confirming</h2>
            <span className="muted small">Since your last balance. Confirm each, or just update the balance.</span>
          </div>
          <EventTable events={f.unconfirmed} today={f.today} floor={settings.bufferFloorCents} onAction={setAction} onChanged={reload} />
        </section>
      )}

      <section className="card" style={{ marginTop: 16 }}>
        <div className="card-head">
          <h2>Upcoming</h2>
          <span className="muted small">{f.events.filter((e) => e.date > f.today).length} items</span>
        </div>
        <EventTable
          events={f.events.filter((e) => e.date > f.today)}
          today={f.today}
          floor={settings.bufferFloorCents}
          onAction={setAction}
          onChanged={reload}
        />
      </section>

      <Modal title={modalTitle(action)} open={action !== null} onClose={close}>
        {action?.kind === 'confirm' && <ConfirmForm event={action.event} today={f.today} onDone={done} onCancel={close} />}
        {action?.kind === 'known' && <KnownForm event={action.event} onDone={done} onCancel={close} />}
        {action?.kind === 'edit' && (
          <EditTransactionForm
            txn={{
              id: action.event.transactionId!, name: action.event.name, date: action.event.date,
              amountCents: action.event.amountCents, note: action.event.note, direction: action.event.direction,
            }}
            today={f.today}
            onDone={done}
            onCancel={close}
          />
        )}
        {action?.kind === 'balance' && <BalanceForm account={action.account} today={f.today} onDone={done} onCancel={close} />}
        {action?.kind === 'planned' && <EditPlanned plannedId={action.event.plannedId!} today={f.today} onDone={done} onCancel={close} />}
      </Modal>
    </>
  );
}

function modalTitle(a: Action): string {
  if (a === null) return '';
  if (a.kind === 'balance') return `Update ${a.account} balance`;
  if (a.kind === 'confirm') return a.event.direction === 'in' ? 'Mark as received' : 'Mark as paid';
  if (a.kind === 'edit') return `Edit ${a.event.name}`;
  if (a.kind === 'planned') return `Edit planned ${a.event.direction === 'in' ? 'income' : 'expense'}`;
  return a.event.status === 'estimated' ? `Set amount: ${a.event.name}` : `Edit ${a.event.name}`;
}

/** Overdrawing checking is the one outcome this app exists to prevent, so it gets the loudest warning on the page. */
/**
 * Checking activity that matched nothing (src/server/reconcile.ts). Filing it records it
 * under a code; dismissing leaves it out for good.
 */
function ToReview({ onChanged }: { onChanged: () => void }) {
  const items = useLoad(api.bankReview);
  const bills = useLoad(api.bills);
  if (!items.data?.length || !bills.data) return null;
  const done = () => { items.reload(); onChanged(); };
  return (
    <section className="card" style={{ marginTop: 16 }}>
      <div className="card-head">
        <h2>To review</h2>
        <span className="muted small">Checking activity that didn't match anything. File it, or dismiss it.</span>
      </div>
      <ErrorNote error={items.error} />
      <div className="table-wrap">
        <table>
          <thead><tr><th>Date</th><th>At the bank</th><th className="num">Amount</th><th>File as</th></tr></thead>
          <tbody>
            {items.data.map((t) => <ReviewRow key={t.transactionId} item={t} bills={bills.data!.bills} onDone={done} />)}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ReviewRow({ item: t, bills, onDone }: { item: ReviewItem; bills: BillWithStats[]; onDone: () => void }) {
  const choices = bills.filter((b) => b.direction === t.direction);
  const [code, setCode] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try { await fn(); onDone(); } catch (e) { setError((e as Error).message); setBusy(false); }
  };
  return (
    <tr>
      <td className="small">{shortDate(t.date)}</td>
      <td>
        {t.merchantName || t.name}
        {t.pending && <span className="chip" style={{ marginLeft: 6 }}>Pending</span>}
        {t.undone && <div className="faint small">You undid its match.</div>}
        <ErrorNote error={error} />
      </td>
      <td className="num">{money(t.direction === 'in' ? t.amountCents : -t.amountCents)}</td>
      <td>
        <div className="row-actions">
          <select value={code} disabled={busy} aria-label="File as" onChange={(e) => setCode(e.target.value)}>
            <option value="">Choose…</option>
            {choices.map((b) => <option key={b.code} value={b.code}>{b.name}</option>)}
          </select>
          <input placeholder="Note" value={note} maxLength={200} disabled={busy} onChange={(e) => setNote(e.target.value)} style={{ width: 120 }} />
          <button className="small primary" disabled={busy || !code} onClick={() => run(() => api.fileBankItem(t.transactionId, code, note))}>File</button>
          <button className="small" disabled={busy} onClick={() => run(() => api.dismissBankItem(t.transactionId))}>Dismiss</button>
        </div>
      </td>
    </tr>
  );
}

const DISMISSED = 'cashflow:bank-check-dismissed';

/**
 * The bank's balance next to the ledger's. Shown only when they differ; the bank's figure
 * replaces the ledger's only when asked.
 */
function BankCheck({ account, bank, ledgerCents, f, onUsed }: {
  account: 'checking' | 'savings'; bank: BankBalance; ledgerCents: number; f: Forecast; onUsed: () => void;
}) {
  // Dismissing hides this account's notice until the bank's balance or the ledger's changes.
  const key = `${account}:${bank.amountCents}:${ledgerCents}`;
  const [dismissed, setDismissed] = useState(() => {
    try { return localStorage.getItem(`${DISMISSED}:${account}`) === key; } catch { return false; }
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const diff = bank.amountCents - ledgerCents;
  if (diff === 0 || dismissed) return null;

  const bankName = [...new Set(bank.accounts.map((a) => a.institution))].join(' + ');
  const fetched = new Date(bank.fetchedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  // Checking only: things the ledger expects by today but nobody has marked done. The bank
  // may not have them yet, and using its balance treats them as done.
  const waiting = account === 'checking'
    ? f.events.filter((e) => e.date <= f.today && e.status !== 'posted')
    : [];

  const use = async () => {
    setBusy(true);
    setError(null);
    try { await api.useBankBalance(account); onUsed(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const dismiss = () => {
    try { localStorage.setItem(`${DISMISSED}:${account}`, key); } catch { /* shows again next load */ }
    setDismissed(true);
  };

  return (
    <div className="banner warn" role="status">
      <div>
        <div>
          {bankName} says {account} has <strong>{money(bank.amountCents)}</strong>
          {account === 'checking' && ' available'}; the ledger has <strong>{money(ledgerCents)}</strong> for today.
          {' '}That's <strong>{money(Math.abs(diff))} {diff > 0 ? 'more' : 'less'}</strong> at the bank.
        </div>
        <div className="muted small">
          Bank balance as of {fetched}.
          {waiting.length > 0 && (
            <> Not marked done yet, and maybe not at the bank: {waiting.map((e) => `${e.name} ${money(e.amountCents)}`).join(', ')}.
              Using the bank's balance treats these as done.</>
          )}
        </div>
        <ErrorNote error={error} />
      </div>
      <div className="row-actions">
        <button className="primary small" disabled={busy} onClick={use}>Use {bankName}'s balance</button>
        <button className="small" disabled={busy} onClick={dismiss}>Dismiss</button>
      </div>
    </div>
  );
}

function OverdraftAlert({ f }: { f: Forecast }) {
  const ahead = f.daily.filter((p) => p.date >= f.today);
  const first = ahead.find((p) => p.balanceCents < 0);
  if (!first) return null;
  const worst = ahead.reduce((lo, p) => (p.balanceCents < lo.balanceCents ? p : lo), first);
  const now = first.date <= f.today;
  const plan = f.topUps.find((t) => t.by <= first.date);
  return (
    <div className="overdraft" role="alert">
      <div className="overdraft-icon" aria-hidden="true">!</div>
      <div>
        <div className="overdraft-head">
          {now ? `Checking is overdrawn: ${money(first.balanceCents)}` : `Checking goes below $0 on ${shortDate(first.date)}`}
        </div>
        <div>
          {!now && `That's ${relativeDays(first.date, f.today)}: it drops to ${money(first.balanceCents)}. `}
          {worst.date !== first.date && `It reaches ${money(worst.balanceCents)} on ${shortDate(worst.date)}. `}
          Move at least <strong>{money0(-worst.balanceCents)}</strong> from savings before {shortDate(first.date)}
          {plan && plan.amountCents > -worst.balanceCents && <> ({money0(plan.amountCents)} also keeps you above your floor)</>},
          then add it under One-offs so this clears.
        </div>
      </div>
    </div>
  );
}

function Decision({ f, settings, onChanged }: { f: Forecast; settings: Settings; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (f.topUps.length > 0) {
    const [first, ...rest] = f.topUps;
    return (
      <div className="card decision critical">
        <span className="status-label critical">▲ Transfer needed</span>
        <div className="headline">
          Move {money0(first.amountCents)} from savings by {shortDate(first.by)}
        </div>
        <Details>
          Keeps checking at or above your {money0(settings.bufferFloorCents)} floor through {shortDate(rest[0]?.by ?? f.horizonEnd)}.
          {' '}It's {relativeDays(first.by, f.today)}.
        </Details>
        {rest.length > 0 && (
          <ul className="topup-list small">
            {rest.map((t) => (
              <li key={t.by}><span>Then by {shortDate(t.by)}</span><span className="num">{money0(t.amountCents)}</span></li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  const floor = money0(settings.bufferFloorCents);
  const through = `Checking stays above your ${floor} floor through ${shortDate(f.horizonEnd)}`;
  const lowNote = `Lowest point: ${money0(f.lowest.balanceCents)} on ${shortDate(f.lowest.date)}.`;
  const draw = f.nextDraw;

  // While savings is covering a shortfall, the useful question is "can I pull less?", not "can I save more?".
  if (draw && draw.canTrimCents >= Math.max(settings.topUpRoundingCents, 100_00)) {
    const lower = draw.amountCents - draw.canTrimCents;
    const apply = async () => {
      setBusy(true);
      setError(null);
      try {
        await api.updatePlanned(draw.plannedId, {
          date: draw.date, code: draw.code, amountCents: lower > 0 ? lower : draw.amountCents,
          ...(lower > 0 ? {} : { status: 'skipped' as const }),
        });
        onChanged();
      } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
    };
    return (
      <div className="card decision good">
        <span className="status-label good">● On track</span>
        <div className="headline">
          {lower > 0
            ? `Your ${shortDate(draw.date)} savings transfer can be ${money0(lower)}`
            : `You can skip the ${shortDate(draw.date)} savings transfer`}
        </div>
        <Details>
          It's planned at {money0(draw.amountCents)}. Taking {money0(draw.canTrimCents)} less still keeps checking above
          your {floor} floor through {shortDate(f.horizonEnd)}, and that money stays in savings.
        </Details>
        <ErrorNote error={error} />
        <div style={{ marginTop: 10 }}>
          <button className="small" disabled={busy} onClick={apply}>
            {lower > 0 ? `Change plan to ${money0(lower)}` : 'Skip it'}
          </button>
        </div>
      </div>
    );
  }

  const drawing = draw !== null || (f.savings?.monthlyShortfallCents ?? 0) > 0;
  if (drawing || f.safeToSweepCents <= 0) {
    return (
      <div className="card decision good">
        <span className="status-label good">● On track</span>
        <div className="headline">{draw ? 'No extra transfers needed' : 'No transfers needed'}</div>
        <Details>
          {draw && <>Counting your {money0(draw.amountCents)} transfer from savings on {shortDate(draw.date)}. </>}
          {through}. {lowNote}
        </Details>
      </div>
    );
  }

  return (
    <div className="card decision good">
      <span className="status-label good">● On track</span>
      <div className="headline">You can sweep {money0(f.safeToSweepCents)} to savings</div>
      <Details>{through}, even after moving that much now. {lowNote}</Details>
    </div>
  );
}

/** The fine print under a decision: always shown on wide screens, behind "View details" on phones. */
function Details({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className={`muted small decision-detail${open ? ' open' : ''}`}>{children}</div>
      <button className="link small phone-only details-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? 'Hide details' : 'View details'}
      </button>
    </>
  );
}

function SavingsTile({ f, onUpdate }: { f: Forecast; onUpdate: () => void }) {
  const s = f.savings;
  if (!s) {
    return (
      <div className="tile">
        <div className="label">Savings runway</div>
        <div className="value">—</div>
        <div className="sub"><button className="link small" onClick={onUpdate}>Enter savings balance</button></div>
      </div>
    );
  }
  const months = s.runwayMonths;
  const tight = months !== null && months < 3;
  return (
    <div className="tile">
      <div className="label">Savings runway</div>
      <div className="value">
        {months === null ? 'Not drawing' : `${months.toFixed(1)} mo`}
      </div>
      <div className="sub">
        {months !== null && (
          <span className={`status-label ${tight ? 'critical' : 'good'}`} style={{ textTransform: 'none', letterSpacing: 0 }}>
            {tight ? '▲' : '●'} {money0(s.floorCents)} floor ~{shortDate(s.floorDate!)}
          </span>
        )}
        <div>
          {money0(s.balanceTodayCents)} saved · short {money0(s.monthlyShortfallCents)}/mo ·{' '}
          <button className="link small" onClick={onUpdate}>update</button>
        </div>
      </div>
    </div>
  );
}

function EventTable({ events, today, floor, onAction, onChanged }: {
  events: LedgerEvent[]; today: string; floor: number; onAction: (a: Action) => void; onChanged: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  if (events.length === 0) return <p className="empty">Nothing here.</p>;

  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try { await fn(); onChanged(); } catch (e) { setError((e as Error).message); }
  };

  // Only the next unpaid occurrence of each item can be marked ahead of time; nobody pays months early.
  const nextOpen = new Map<string, string>();
  for (const e of events) {
    if (e.date > today && e.status !== 'posted' && !nextOpen.has(e.code)) nextOpen.set(e.code, e.key);
  }
  const dueSoon = (e: LedgerEvent) =>
    e.date <= today || (diffDays(e.date, today) <= CONFIRM_AHEAD_DAYS && nextOpen.get(e.code) === e.key);

  return (
    <div className="table-wrap">
      <ErrorNote error={error} />
      <table>
        <thead>
          <tr>
            <th>Date</th><th>Item</th><th className="wide-only">Status</th>
            <th className="num"><span className="wide-only">Amount</span><span className="phone-only">Amount / bal.</span></th>
            <th className="num wide-only">Balance</th><th />
          </tr>
        </thead>
        <tbody>
          {events.map((e) => {
            const balance = <>{e.balanceCents < 0 ? '⚠ ' : e.balanceCents < floor && '▼ '}{money(e.balanceCents)}</>;
            return (
            <tr
              key={e.key}
              className={[
                e.direction === 'in' ? 'inflow' : '', e.balanceCents < floor ? 'below-floor' : '',
                e.balanceCents < 0 ? 'negative' : '',
                e.date <= today ? 'past' : '', e.status === 'estimated' ? 'guess' : '',
              ].join(' ')}
            >
              <td className="num" style={{ textAlign: 'left' }}><DateText iso={e.date} /></td>
              <td>
                {e.name}
                <span className="phone-only status-under"><StatusChip status={e.status} direction={e.direction} future={e.date > today} /></span>
                {e.note && <div className="note small">{e.note}</div>}
                {e.status === 'posted' && e.estimateCents !== null && e.estimateCents !== e.amountCents && (
                  <div className="faint small">est. {money(e.estimateCents)}</div>
                )}
                {e.raisedFromCents != null && (
                  <div className="raised small">est. {money(e.raisedFromCents)} · raised: {money(e.amountCents)} already on the card</div>
                )}
              </td>
              <td className="wide-only"><StatusChip status={e.status} direction={e.direction} future={e.date > today} /></td>
              <td className="num amount">
                {e.direction === 'in' ? '+' : '−'}{money(e.amountCents)}
                <div className="phone-only balance">{balance}</div>
              </td>
              <td className="num balance wide-only">{balance}</td>
              <td>
                <div className="row-actions">
                  {e.period !== null && e.status !== 'posted' && (
                    <>
                      {dueSoon(e) && (
                        <button className="small" onClick={() => onAction({ kind: 'confirm', event: e })}>
                          {e.direction === 'in' ? 'Received…' : e.date > today ? 'Paid / set up…' : 'Paid…'}
                        </button>
                      )}
                      {e.status === 'estimated' ? (
                        <button className="small" onClick={() => onAction({ kind: 'known', event: e })}>Set amount</button>
                      ) : (
                        <button
                          className="small icon" title="Edit this amount" aria-label={`Edit ${e.name} amount`}
                          onClick={() => onAction({ kind: 'known', event: e })}
                        >
                          <PencilIcon />
                        </button>
                      )}
                    </>
                  )}
                  {e.plannedId !== null && e.status === 'planned' && dueSoon(e) && (
                    <button className="small" onClick={() => run(() => api.completePlanned(e.plannedId!, e.date, e.amountCents))}>
                      Done
                    </button>
                  )}
                  {e.plannedId !== null && e.status === 'planned' && (
                    <button
                      className="small icon" title="Edit this one-off" aria-label={`Edit ${e.name}`}
                      onClick={() => onAction({ kind: 'planned', event: e })}
                    >
                      <PencilIcon />
                    </button>
                  )}
                  {e.status === 'posted' && e.transactionId !== null && (
                    <button
                      className="small icon" title="Edit date, amount or note" aria-label={`Edit ${e.name}`}
                      onClick={() => onAction({ kind: 'edit', event: e })}
                    >
                      <PencilIcon />
                    </button>
                  )}
                  {e.status === 'posted' && e.transactionId !== null && (
                    <button className="small link" title="Remove this confirmation" onClick={() => run(() => api.deleteTransaction(e.transactionId!))}>
                      Undo
                    </button>
                  )}
                </div>
              </td>
            </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ConfirmForm({ event, today, onDone, onCancel }: { event: LedgerEvent; today: string; onDone: () => void; onCancel: () => void }) {
  // A payment can be set up with the bank ahead of time, for any day up to its due date.
  // Money coming in only counts once it has.
  const due = event.dueDate ?? event.date;
  const latest = event.direction === 'out' && due > today ? due : today;
  const [date, setDate] = useState(event.date <= latest ? event.date : today);
  const [cents, setCents] = useState<number | null>(event.amountCents);
  const [note, setNote] = useState(event.note);
  const ahead = date > today;
  return (
    <AsyncForm
      submitLabel={event.direction === 'in' ? 'Mark received' : ahead ? 'Mark set up' : 'Mark paid'}
      onCancel={onCancel}
      onSubmit={async () => {
        if (cents === null) throw new Error('Enter the amount');
        await api.confirm(event.code, date, cents, note.trim());
        onDone();
      }}
    >
      <p className="muted small">{event.name}, due {shortDate(event.dueDate ?? event.date)}</p>
      <div className="form-grid">
        <label className="field">
          <span>{event.direction === 'in' ? 'Date received' : latest > today ? 'Date paid (or scheduled)' : 'Date paid'}</span>
          <input type="date" value={date} max={latest} required onChange={(e) => setDate(e.target.value)} />
        </label>
        <MoneyInput label="Amount" cents={cents} onChange={setCents} />
      </div>
      {ahead && (
        <p className="hint">
          Set up with the bank for {shortDate(date)}: it shows as ✓ Set up until then, and when the payment shows up at
          the bank the sync links it to this.
        </p>
      )}
      <NoteField value={note} onChange={setNote} />
    </AsyncForm>
  );
}

function NoteField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <label className="field" style={{ marginTop: 12 }}>
      <span>Note</span>
      <input value={value} maxLength={200} placeholder="e.g. plumbing repair" onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

function KnownForm({ event, onDone, onCancel }: { event: LedgerEvent; onDone: () => void; onCancel: () => void }) {
  const [cents, setCents] = useState<number | null>(event.status === 'estimated' ? null : event.amountCents);
  const [note, setNote] = useState(event.note);
  const usual = money(event.estimateCents ?? event.amountCents);
  return (
    <AsyncForm
      onCancel={onCancel}
      onSubmit={async () => {
        // Leaving a fixed amount as it was shouldn't turn it into a "known" override.
        const unchanged = event.status === 'scheduled' && cents === event.amountCents;
        if (!unchanged) await api.setOverride(event.code, event.period!, cents);
        if (note.trim() !== event.note) await api.setOccurrenceNote(event.code, event.period!, note.trim());
        onDone();
      }}
    >
      {event.status === 'estimated' ? (
        <p className="muted small">
          {event.name}, due {shortDate(event.dueDate ?? event.date)}. Use this when you know the amount (e.g. the statement
          posted) but it hasn't been paid yet. Current estimate: {usual}.
        </p>
      ) : (
        <p className="muted small">
          Changes {event.name} on {shortDate(event.dueDate ?? event.date)} only. To change every one, edit it on the Bills
          page. Normally: {usual}.
        </p>
      )}
      <MoneyInput label="Amount (leave blank to go back to normal)" cents={cents} onChange={setCents} required={false} autoFocus />
      <NoteField value={note} onChange={setNote} />
      <p className="hint">The note carries over when you mark it paid, and shows in History.</p>
    </AsyncForm>
  );
}

function BalanceForm({ account, today, onDone, onCancel }: { account: 'checking' | 'savings'; today: string; onDone: () => void; onCancel: () => void }) {
  const [date, setDate] = useState(today);
  const [cents, setCents] = useState<number | null>(null);
  return (
    <AsyncForm
      onCancel={onCancel}
      onSubmit={async () => {
        if (cents === null) throw new Error('Enter the balance');
        await api.addSnapshot({ account, date, amountCents: cents });
        onDone();
      }}
    >
      <p className="muted small">
        {account === 'checking'
          ? 'The real balance from your bank. Anything dated on or before this day is assumed to be in it.'
          : 'Your real savings balance. Savings draws recorded after this date are subtracted automatically.'}
      </p>
      <div className="form-grid">
        <label className="field"><span>As of</span><input type="date" value={date} max={today} required onChange={(e) => setDate(e.target.value)} /></label>
        <MoneyInput label="Balance" cents={cents} onChange={setCents} allowNegative={account === 'checking'} />
      </div>
    </AsyncForm>
  );
}

/** Edit a planned one-off without leaving the Dashboard: the One-offs form, plus Delete. */
function EditPlanned({ plannedId, today, onDone, onCancel }: { plannedId: number; today: string; onDone: () => void; onCancel: () => void }) {
  const planned = useLoad(api.planned);
  const bills = useLoad(api.bills);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (planned.error || bills.error) return <ErrorNote error={planned.error ?? bills.error} />;
  if (!planned.data || !bills.data) return <p className="empty">Loading…</p>;
  const item = planned.data.find((p) => p.id === plannedId);
  if (!item) return <ErrorNote error="This one-off no longer exists." />;
  return (
    <>
      <OneOffForm
        item={item} direction={item.direction} bills={bills.data.bills} history={planned.data} today={today}
        balance={null} onTypeAdded={bills.reload} onDone={onDone} onCancel={onCancel}
      />
      <div className="form-actions" style={{ justifyContent: 'flex-start' }}>
        {confirmDelete ? (
          <>
            <button
              type="button" className="small danger"
              onClick={() => api.deletePlanned(item.id).then(onDone, (e: Error) => setError(e.message))}
            >
              Yes, delete it
            </button>
            <button type="button" className="small" onClick={() => setConfirmDelete(false)}>Keep it</button>
          </>
        ) : (
          <button type="button" className="small link danger" onClick={() => setConfirmDelete(true)}>Delete this one-off</button>
        )}
      </div>
      <ErrorNote error={error} />
    </>
  );
}
