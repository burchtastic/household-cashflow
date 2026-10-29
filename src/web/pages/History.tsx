import { useState } from 'react';
import { api, type TxnWithCategory } from '../api.ts';
import { DateRangePicker, presetRange } from '../components/DateRangePicker.tsx';
import { EditTransactionForm } from '../components/EditTransaction.tsx';
import { ConfirmButton, ErrorNote, Modal, PencilIcon, useLoad } from '../components/ui.tsx';
import { addDays } from '../../engine/dates.ts';
import { localToday, money, shortDate } from '../format.ts';

export function History() {
  const today = localToday();
  const [range, setRange] = useState(() => presetRange('last90', today));
  const { from, to } = range;
  const [category, setCategory] = useState('');
  const report = useLoad(() => api.report(from, to), [from, to]);
  const txns = useLoad(() => api.transactions({ from, to, ...(category ? { category } : {}) }), [from, to, category]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<TxnWithCategory | null>(null);
  // Transfers set up with the bank for a later date: outside any past range, but still editable here.
  const later = useLoad(() => api.transactions({ from: addDays(today, 1) }), []);
  const reloadAll = () => { txns.reload(); report.reload(); later.reload(); };

  const totalOut = report.data?.categories.reduce((s, c) => s + c.outCents, 0) ?? 0;
  const totalIn = report.data?.categories.reduce((s, c) => s + c.inCents, 0) ?? 0;

  return (
    <>
      <div className="page-head">
        <h1>History & reports</h1>
        <DateRangePicker value={range} today={today} onChange={setRange} />
      </div>
      <ErrorNote error={report.error ?? txns.error ?? later.error ?? error} />

      {later.data && later.data.length > 0 && (
        <section className="card">
          <div className="card-head">
            <h2>Set up for later</h2>
            <span className="muted small">Already arranged with the bank; the forecast counts each on its date.</span>
          </div>
          <div className="table-wrap">
            <table className="stacked">
              <thead><tr><th>Date</th><th>Item</th><th>Category</th><th className="num">Amount</th><th /></tr></thead>
              <tbody>
                {later.data.map((t) => (
                  <tr key={t.id} className={t.direction === 'in' ? 'inflow' : ''}>
                    <td className="date">{shortDate(t.date)}</td>
                    <td className="what">{t.description}{t.note && <div className="note small">{t.note}</div>}</td>
                    <td className="meta small">{t.category}</td>
                    <td className="num amount">{t.direction === 'in' ? '+' : '−'}{money(t.amountCents)}</td>
                    <td className="actions">
                      <div className="row-actions">
                        <button
                          className="small icon" title="Edit date, amount or note" aria-label={`Edit ${t.description}`}
                          onClick={() => setEditing(t)}
                        >
                          <PencilIcon />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="card">
        <div className="card-head">
          <h2>By category</h2>
          <span className="muted small">Out {money(totalOut)} · In {money(totalIn)}</span>
        </div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Category</th><th className="num">Out</th><th className="num">In</th><th className="num">Count</th></tr></thead>
            <tbody>
              {report.data?.categories.map((c) => (
                <tr key={c.category} style={{ cursor: 'pointer' }} onClick={() => setCategory(category === c.category ? '' : c.category)}>
                  <td>{category === c.category ? <strong>{c.category} ✓</strong> : c.category}</td>
                  <td className="num">{c.outCents ? money(c.outCents) : '—'}</td>
                  <td className="num">{c.inCents ? money(c.inCents) : '—'}</td>
                  <td className="num">{c.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="hint">Click a category to filter the transactions below.</p>
      </section>

      <section className="card">
        <div className="card-head">
          <h2>Transactions{category && ` · ${category}`}</h2>
          {category && <button className="small" onClick={() => setCategory('')}>Clear filter</button>}
        </div>
        <div className="table-wrap">
          <table className="stacked">
            <thead><tr><th>Date</th><th>Item</th><th>Category</th><th className="wide-only">Source</th><th className="num">Amount</th><th /></tr></thead>
            <tbody>
              {txns.data?.slice().reverse().map((t) => (
                <tr key={t.id} className={t.direction === 'in' ? 'inflow' : ''}>
                  <td className="date">{shortDate(t.date)}</td>
                  <td className="what">
                    {t.description}
                    <NoteCell note={t.note} onSave={async (note) => { await api.setTransactionNote(t.id, note); txns.reload(); }} />
                  </td>
                  <td className="meta small">{t.category}</td>
                  <td className="small faint wide-only">{t.source}</td>
                  <td className="num amount">{t.direction === 'in' ? '+' : '−'}{money(t.amountCents)}</td>
                  <td className="actions">
                    <div className="row-actions">
                      <button
                        className="small icon" title="Edit date, amount or note" aria-label={`Edit ${t.description}`}
                        onClick={() => setEditing(t)}
                      >
                        <PencilIcon />
                      </button>
                      <ConfirmButton label="Delete" onConfirm={async () => {
                        setError(null);
                        // A one-off goes with its transaction; otherwise it would reappear as planned.
                        try {
                          await (t.plannedId !== null ? api.deletePlanned(t.plannedId) : api.deleteTransaction(t.id));
                          reloadAll();
                        } catch (e) { setError((e as Error).message); }
                      }} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {txns.data?.length === 0 && <p className="empty">No transactions in this range.</p>}
        </div>
      </section>

      <Modal title={editing ? `Edit ${editing.description}` : ''} open={editing !== null} onClose={() => setEditing(null)}>
        {editing && (
          <EditTransactionForm
            txn={{ ...editing, name: editing.description }}
            today={today}
            onDone={() => { setEditing(null); reloadAll(); }}
            onCancel={() => setEditing(null)}
          />
        )}
      </Modal>
    </>
  );
}

function NoteCell({ note, onSave }: { note: string; onSave: (note: string) => Promise<void> }) {
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    if (draft === null) return;
    setError(null);
    try { await onSave(draft.trim()); setDraft(null); } catch (e) { setError((e as Error).message); }
  };
  if (draft !== null) {
    return (
      <form className="note-edit" onSubmit={(e) => { e.preventDefault(); save(); }}>
        <input
          autoFocus value={draft} maxLength={200} placeholder="e.g. plumbing repair" aria-label="Note"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Escape') setDraft(null); }}
        />
        <button type="submit" className="small">Save</button>
        <button type="button" className="small link" onClick={() => setDraft(null)}>Cancel</button>
        <ErrorNote error={error} />
      </form>
    );
  }
  return note ? (
    <button type="button" className="note small note-button" title="Edit note" onClick={() => setDraft(note)}>
      <span>{note}</span> <PencilIcon />
    </button>
  ) : (
    <button type="button" className="link small add-note" onClick={() => setDraft('')}>+ Add note</button>
  );
}
