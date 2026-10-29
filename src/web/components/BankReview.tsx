import { useState } from 'react';
import { api, type BillWithStats, type ReviewItem } from '../api.ts';
import { ErrorNote, useLoad } from './ui.tsx';
import { money, shortDate } from '../format.ts';

/**
 * Checking activity that matched nothing (src/server/reconcile.ts). Filing it records it
 * under a code; dismissing leaves it out for good. Shown on the Dashboard and on One-offs.
 */
export function ToReview({ onChanged }: { onChanged: () => void }) {
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
        <table className="stacked review">
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
  // Off-schedule types file as one-offs (they show on the One-offs page); the rest pay a regular bill.
  const groups: [string, BillWithStats[]][] = [
    ['One-offs', choices.filter((b) => b.schedule.kind === 'none')],
    [t.direction === 'in' ? 'Regular income' : 'Regular bills', choices.filter((b) => b.schedule.kind !== 'none')],
  ];
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
      <td className="date small">{shortDate(t.date)}</td>
      <td className="what">
        {t.merchantName || t.name}
        {t.pending && <span className="chip" style={{ marginLeft: 6 }}>Pending</span>}
        {t.undone && <div className="faint small">You undid its match.</div>}
        <ErrorNote error={error} />
      </td>
      <td className="num amount">{money(t.direction === 'in' ? t.amountCents : -t.amountCents)}</td>
      <td className="file">
        <div className="row-actions">
          <select value={code} disabled={busy} aria-label="File as" onChange={(e) => setCode(e.target.value)}>
            <option value="">Choose…</option>
            {groups.filter(([, bs]) => bs.length).map(([label, bs]) => (
              <optgroup key={label} label={label}>
                {bs.map((b) => <option key={b.code} value={b.code}>{b.name}</option>)}
              </optgroup>
            ))}
          </select>
          <input placeholder="Note" aria-label="Note" value={note} maxLength={200} disabled={busy} onChange={(e) => setNote(e.target.value)} />
          <button className="small primary" disabled={busy || !code} onClick={() => run(() => api.fileBankItem(t.transactionId, code, note))}>File</button>
          <button className="small" disabled={busy} onClick={() => run(() => api.dismissBankItem(t.transactionId))}>Dismiss</button>
        </div>
      </td>
    </tr>
  );
}
