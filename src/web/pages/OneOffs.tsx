import { useState } from 'react';
import { addDays } from '../../engine/dates.ts';
import type { Direction, PlannedItem, Snapshot } from '../../engine/index.ts';
import { api, type BillWithStats } from '../api.ts';
import { EditTransactionForm } from '../components/EditTransaction.tsx';
import { AsyncForm, ConfirmButton, ErrorNote, Modal, MoneyInput, PencilIcon, useLoad } from '../components/ui.tsx';
import { localToday, money, shortDate } from '../format.ts';

type Editing = { item: PlannedItem } | { direction: Direction } | { done: PlannedItem } | null;

export function OneOffs() {
  const planned = useLoad(api.planned);
  const bills = useLoad(api.bills);
  const snapshots = useLoad(api.snapshots);
  const [editing, setEditing] = useState<Editing>(null);
  const [error, setError] = useState<string | null>(null);
  const today = localToday();

  if (planned.error || bills.error) return <ErrorNote error={planned.error ?? bills.error} />;
  if (!planned.data || !bills.data) return <p className="empty">Loading…</p>;

  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try { await fn(); planned.reload(); } catch (e) { setError((e as Error).message); }
  };
  const upcoming = planned.data.filter((p) => p.status === 'planned');
  const past = planned.data.filter((p) => p.status !== 'planned').reverse();

  return (
    <>
      <div className="page-head">
        <h1>One-offs</h1>
        <div className="inline-form">
          <button className="primary" onClick={() => setEditing({ direction: 'out' })}>− Add expense</button>
          <button className="primary" onClick={() => setEditing({ direction: 'in' })}>+ Add income</button>
        </div>
      </div>
      <p className="muted small" style={{ marginTop: -8 }}>
        Anything off-schedule: a transfer from savings, a Venmo, a prescription, a reimbursement. Log it after it
        happens, or plan it ahead so the forecast counts it.
      </p>
      <ErrorNote error={error} />

      <section className="card">
        <div className="card-head"><h2>Planned</h2></div>
        {upcoming.length === 0 ? <p className="empty">Nothing planned.</p> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Date</th><th>Item</th><th className="num">Amount</th><th /></tr></thead>
              <tbody>
                {upcoming.map((p) => (
                  <tr key={p.id} className={p.direction === 'in' ? 'inflow' : ''}>
                    <td>{shortDate(p.date)}{p.date < today && <div className="error small">overdue</div>}</td>
                    <td>{p.note || p.description}{p.note && <div className="faint small">{p.description}</div>}</td>
                    <td className="num amount">{p.direction === 'in' ? '+' : '−'}{money(p.amountCents)}</td>
                    <td>
                      <div className="row-actions">
                        <button className="small" onClick={() => run(() => api.completePlanned(p.id, p.date, p.amountCents))}>Done</button>
                        <button className="small" onClick={() => setEditing({ item: p })}>Edit</button>
                        <ConfirmButton label="Delete" className="small danger" onConfirm={() => run(() => api.deletePlanned(p.id))} />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card">
        <div className="card-head"><h2>Done</h2></div>
        {past.length === 0 ? <p className="empty">Nothing yet.</p> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Date</th><th>Item</th><th>Status</th><th className="num">Amount</th><th /></tr></thead>
              <tbody>
                {past.map((p) => (
                  <tr key={p.id} className="past">
                    <td>{shortDate(p.date)}</td>
                    <td>{p.note || p.description}{p.note && <div className="faint small">{p.description}</div>}</td>
                    <td className="small">{p.status === 'done' && p.date > today ? 'set up' : p.status}</td>
                    <td className="num">{p.direction === 'in' ? '+' : '−'}{money(p.amountCents)}</td>
                    <td>
                      <div className="row-actions">
                        {p.status === 'done' && (
                          <button
                            className="small icon" title="Edit date, amount or note" aria-label={`Edit ${p.note || p.description}`}
                            onClick={() => setEditing({ done: p })}
                          >
                            <PencilIcon />
                          </button>
                        )}
                        <ConfirmButton label="Delete" title="Delete this and its transaction" onConfirm={() => run(() => api.deletePlanned(p.id))} />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <Modal title={modalTitle(editing)} open={editing !== null} onClose={() => setEditing(null)}>
        {editing !== null && 'done' in editing && (
          <EditTransactionForm
            txn={{ ...editing.done, name: editing.done.description }}
            today={today}
            save={(v) => api.updatePlanned(editing.done.id, { ...v, code: editing.done.code })}
            onCancel={() => setEditing(null)}
            onDone={() => { setEditing(null); planned.reload(); }}
          />
        )}
        {editing !== null && !('done' in editing) && (
          <OneOffForm
            item={'item' in editing ? editing.item : null}
            direction={'item' in editing ? editing.item.direction : editing.direction}
            bills={bills.data.bills}
            history={planned.data}
            today={today}
            onTypeAdded={bills.reload}
            balance={latestChecking(snapshots.data ?? [])}
            onCancel={() => setEditing(null)}
            onDone={() => { setEditing(null); planned.reload(); }}
          />
        )}
      </Modal>
    </>
  );
}

function latestChecking(snaps: Snapshot[]): Snapshot | null {
  let best: Snapshot | null = null;
  for (const s of snaps) if (s.account === 'checking' && (!best || s.date >= best.date)) best = s;
  return best;
}

function modalTitle(e: Editing): string {
  if (e === null) return '';
  if ('item' in e) return e.item.direction === 'in' ? 'Edit income' : 'Edit expense';
  if ('done' in e) return `Edit ${e.done.note || e.done.description}`;
  return e.direction === 'in' ? 'Add income' : 'Add expense';
}

/** A short unique code for a new type, e.g. "Medical" → "MEDICAL", then "MEDICAL2". */
function newCode(name: string, taken: Set<string>): string {
  const stem = name.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 9) || 'TYPE';
  if (!taken.has(stem)) return stem;
  for (let i = 2; ; i++) if (!taken.has(`${stem}${i}`)) return `${stem}${i}`;
}

export function OneOffForm({ item, direction, bills, history, today, balance, onDone, onCancel, onTypeAdded }: {
  item: PlannedItem | null; direction: Direction; bills: BillWithStats[]; history: PlannedItem[]; today: string;
  balance: Snapshot | null; onDone: () => void; onCancel: () => void; onTypeAdded: () => void;
}) {
  // Off-schedule types are tags, so "active" (which only controls scheduling) doesn't apply to them.
  const sameWay = bills.filter((b) => b.direction === direction && (b.active || b.schedule.kind === 'none'));
  // Off-schedule types are the quick picks, most used first; recurring bills stay available but out of the way.
  const uses = new Map<string, number>();
  for (const p of history) uses.set(p.code, (uses.get(p.code) ?? 0) + 1);
  const quick = sameWay
    .filter((b) => b.schedule.kind === 'none')
    .sort((a, b) => (uses.get(b.code) ?? 0) - (uses.get(a.code) ?? 0) || a.sort - b.sort);
  const recurring = sameWay.filter((b) => b.schedule.kind !== 'none');

  const [code, setCode] = useState(item?.code ?? quick[0]?.code ?? sameWay[0]?.code ?? '');
  const [cents, setCents] = useState<number | null>(item?.amountCents ?? null);
  const [note, setNote] = useState(item?.note ?? '');
  // Remounts the amount box when a suggestion fills it in (it keeps its own text while you type).
  const [amountKey, setAmountKey] = useState(0);
  const [filledFrom, setFilledFrom] = useState<{ date: string; amount: boolean } | null>(null);

  // Past notes for this direction, newest first, each remembering the type and amount it last had.
  const past = new Map<string, PlannedItem>();
  for (const p of [...history].sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id)) {
    const k = p.note.trim().toLowerCase();
    if (p.direction === direction && k && !past.has(k)) past.set(k, p);
  }
  const typeNote = (v: string) => {
    setNote(v);
    const hit = past.get(v.trim().toLowerCase());
    if (!hit || item !== null) { setFilledFrom(null); return; }
    setCode(hit.code);
    if (cents === null) { setCents(hit.amountCents); setAmountKey((k) => k + 1); }
    setFilledFrom({ date: hit.date, amount: cents === null });
  };
  const [date, setDate] = useState(item?.date ?? today);
  const [happened, setHappened] = useState(true);
  const [setUp, setSetUp] = useState(false);
  const logNow = item === null && happened && date <= today;
  // A future item can already be committed, e.g. a transfer scheduled with the bank.
  const markDone = logNow || (item === null && date > today && setUp);
  // The forecast treats anything dated on or before the checking balance as already in it.
  const coveredByBalance = logNow && balance !== null && date <= balance.date;
  const [inBalance, setInBalance] = useState<boolean | null>(null);
  const alreadyIn = inBalance ?? (balance !== null && date < balance.date);
  const noun = direction === 'in' ? 'income' : 'expense';
  const yesterday = addDays(today, -1);
  const [newType, setNewType] = useState<string | null>(null);
  const [typeError, setTypeError] = useState<string | null>(null);

  const addType = async () => {
    const name = (newType ?? '').trim();
    if (!name) return;
    setTypeError(null);
    const c = newCode(name, new Set(bills.map((b) => b.code)));
    try {
      await api.createBill({
        code: c, name, category: direction === 'in' ? 'Transfer' : 'Uncategorized', direction, active: false,
        schedule: { kind: 'none' }, amountMode: 'fixed', amountCents: 0, minCents: null, notes: '',
        sort: Math.min(10_000, Math.max(0, ...bills.map((b) => b.sort)) + 1),
      });
      setCode(c);
      setNewType(null);
      onTypeAdded();
    } catch (e) { setTypeError((e as Error).message); }
  };

  return (
    <AsyncForm
      onCancel={onCancel}
      submitLabel={item ? 'Save' : logNow ? `Log ${noun}` : markDone ? 'Save as set up' : `Plan ${noun}`}
      onSubmit={async () => {
        if (cents === null) throw new Error('Enter the amount');
        if (!code) throw new Error('Pick a type');
        const body = { date, code, amountCents: cents, note: note.trim() };
        await (item
          ? api.updatePlanned(item.id, body)
          : api.addPlanned({ ...body, status: markDone ? 'done' : 'planned', ...(coveredByBalance && !alreadyIn && { adjustBalance: true }) }));
        onDone();
      }}
    >
      <div className="form-grid">
        <MoneyInput key={amountKey} label="Amount" cents={cents} onChange={setCents} autoFocus={amountKey === 0} className="big-money" />
        <label className="field">
          <span>What was it?</span>
          <input
            value={note} maxLength={200} onChange={(e) => typeNote(e.target.value)} list={`past-notes-${direction}`} autoComplete="off"
            placeholder={direction === 'in' ? 'e.g. FSA reimbursement' : 'e.g. Rx, hotel deposit'}
          />
        </label>
        <datalist id={`past-notes-${direction}`}>
          {[...past.values()].map((p) => <option key={p.id} value={p.note.trim()} />)}
        </datalist>
      </div>

      {filledFrom && <p className="hint" style={{ margin: '6px 0 0' }}>{filledFrom.amount ? 'Type and amount' : 'Type'} filled in from {shortDate(filledFrom.date)}. Change anything that's different.</p>}

      <div className="field" style={{ marginTop: 14 }}>
        <span className="field-label">Type</span>
        <div className="choice-row" role="radiogroup" aria-label="Type">
          {quick.map((b) => (
            <button type="button" key={b.code} role="radio" aria-checked={code === b.code} className="choice" onClick={() => setCode(b.code)}>
              {b.name}
            </button>
          ))}
          {newType === null ? (
            <button type="button" className="choice add" onClick={() => setNewType('')}>+ New type</button>
          ) : (
            <span className="choice-new">
              <input
                autoFocus value={newType} maxLength={40} placeholder="e.g. Medical" aria-label="New type name"
                onChange={(e) => setNewType(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); addType(); }
                  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setNewType(null); }
                }}
              />
              <button type="button" className="small" onClick={addType}>Add</button>
              <button type="button" className="small link" onClick={() => setNewType(null)}>Cancel</button>
            </span>
          )}
          {recurring.length > 0 && (
            <select
              aria-label="Or part of a regular bill"
              className={recurring.some((b) => b.code === code) ? 'choice-select active' : 'choice-select'}
              value={recurring.some((b) => b.code === code) ? code : ''}
              onChange={(e) => e.target.value && setCode(e.target.value)}
            >
              <option value="">{direction === 'in' ? 'Part of regular income…' : 'Part of a regular bill…'}</option>
              {recurring.map((b) => <option key={b.code} value={b.code}>{b.name}</option>)}
            </select>
          )}
        </div>
        <ErrorNote error={typeError} />
      </div>

      <div className="field" style={{ marginTop: 14 }}>
        <span className="field-label">When</span>
        <div className="choice-row">
          <button type="button" className="choice" aria-pressed={date === today} onClick={() => setDate(today)}>Today</button>
          <button type="button" className="choice" aria-pressed={date === yesterday} onClick={() => setDate(yesterday)}>Yesterday</button>
          <input type="date" aria-label="Date" value={date} required onChange={(e) => setDate(e.target.value)} />
        </div>
      </div>

      {item === null && (
        date <= today ? (
          <>
            <label className="check" style={{ marginTop: 14 }}>
              <input type="checkbox" checked={happened} onChange={(e) => setHappened(e.target.checked)} />
              Already happened (counts as done, not planned)
            </label>
            {coveredByBalance && (
              <fieldset className="balance-q">
                <legend>
                  Your checking balance of {money(balance.amountCents)} was entered {shortDate(balance.date)}. Is this {noun} already in it?
                </legend>
                <label className="check">
                  <input type="radio" name="inBalance" checked={alreadyIn} onChange={() => setInBalance(true)} />
                  Yes, the bank already shows it
                </label>
                <label className="check">
                  <input type="radio" name="inBalance" checked={!alreadyIn} onChange={() => setInBalance(false)} />
                  No, {direction === 'in' ? 'add' : 'take'} {cents !== null ? money(cents) : 'it'} {direction === 'in' ? 'to' : 'off'} that balance
                </label>
              </fieldset>
            )}
          </>
        ) : (
          <label className="check" style={{ marginTop: 14 }}>
            <input type="checkbox" checked={setUp} onChange={(e) => setSetUp(e.target.checked)} />
            Already set up with the bank (otherwise it's planned). The forecast counts it on {shortDate(date)} either way.
          </label>
        )
      )}
    </AsyncForm>
  );
}
