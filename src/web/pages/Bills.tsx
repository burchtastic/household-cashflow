import { useState } from 'react';
import type { Bill, Schedule } from '../../engine/index.ts';
import { api, type BillWithStats } from '../api.ts';
import { BillHistory } from '../components/BillHistory.tsx';
import { AsyncForm, ErrorNote, Modal, MoneyInput, PencilIcon, useLoad } from '../components/ui.tsx';
import { localToday, longDate, money } from '../format.ts';

const ordinal = (n: number) => `${n}${['th', 'st', 'nd', 'rd'][n % 100 > 10 && n % 100 < 14 ? 0 : n % 10 < 4 ? n % 10 : 0]}`;

export function describeSchedule(s: Schedule): string {
  if (s.kind === 'monthly') return `Monthly on the ${ordinal(s.day)}`;
  if (s.kind === 'interval') return s.everyDays === 14 ? `Every 2 weeks from ${longDate(s.anchor)}` : `Every ${s.everyDays} days from ${longDate(s.anchor)}`;
  return 'Tag only (not scheduled)';
}

export function Bills() {
  const { data, error, reload } = useLoad(api.bills);
  // One dialog for both: Edit from a bill's history goes back to the history on Cancel.
  const [viewing, setViewing] = useState<BillWithStats | null>(null);
  const [editing, setEditing] = useState<Bill | 'new' | null>(null);
  const [showInactive, setShowInactive] = useState(false);
  const close = () => { setEditing(null); setViewing(null); };

  if (error) return <ErrorNote error={error} />;
  if (!data) return <p className="empty">Loading…</p>;

  const visible = data.bills.filter((b) => showInactive || b.active);
  const groups: [string, BillWithStats[]][] = [
    ['Money out', visible.filter((b) => b.direction === 'out')],
    ['Money in', visible.filter((b) => b.direction === 'in')],
  ];

  return (
    <>
      <div className="page-head">
        <h1>Bills & income</h1>
        <div className="inline-form">
          <label className="small muted" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
            Show inactive ({data.bills.filter((b) => !b.active).length})
          </label>
          <button className="primary" onClick={() => setEditing('new')}>Add bill</button>
        </div>
      </div>

      {groups.map(([title, bills]) => (
        <section className="card" key={title}>
          <div className="card-head"><h2>{title}</h2></div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th className="wide-only">Code</th><th>Name</th><th className="wide-only">Schedule</th><th className="wide-only">How estimated</th>
                  <th className="num wide-only">Avg</th><th className="num wide-only">Worst</th><th className="num">Estimate</th><th />
                </tr>
              </thead>
              <tbody>
                {/* On phones only name, estimate and History fit; the schedule tucks under the name, and Edit is in the history. */}
                {bills.map((b) => (
                  <tr key={b.code} className={b.active ? '' : 'inactive'}>
                    <td className="wide-only"><code>{b.code}</code></td>
                    <td>
                      {b.name}
                      <div className="faint small">{b.category}{!b.active && ' · inactive'}</div>
                      <div className="faint small phone-only">{describeSchedule(b.schedule)}</div>
                    </td>
                    <td className="small wide-only">{describeSchedule(b.schedule)}</td>
                    <td className="small wide-only">
                      {b.amountMode === 'fixed' ? 'Fixed amount' : 'From history'}
                      {b.minCents !== null && <div className="faint">min {money(b.minCents)}</div>}
                    </td>
                    <td className="num wide-only">{b.stats.averageCents === null ? '—' : money(b.stats.averageCents)}<div className="faint small">n={b.stats.sampleSize}</div></td>
                    <td className="num wide-only">{b.stats.worstCents === null ? '—' : money(b.stats.worstCents)}</td>
                    <td className="num"><strong>{money(b.stats.estimateCents)}</strong></td>
                    <td>
                      <div className="row-actions">
                        <button className="small" title={`What ${b.name} has been, month by month`} onClick={() => setViewing(b)}>History</button>
                        <button className="small icon wide-only" title="Edit" aria-label={`Edit ${b.name}`} onClick={() => setEditing(b)}>
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
      ))}

      <p className="hint">
        Averages and worst cases look back over the window set in Settings. "Estimate" is what the forecast uses when a
        payment hasn't been confirmed and no known amount is set.
      </p>

      <Modal
        title={editing === 'new' ? 'Add bill' : editing ? `Edit ${editing.name}` : viewing?.name ?? ''}
        open={editing !== null || viewing !== null}
        onClose={close}
      >
        {editing !== null ? (
          <BillForm
            bill={editing === 'new' ? null : editing}
            categories={data.categories}
            nextSort={Math.max(0, ...data.bills.map((b) => b.sort)) + 1}
            onCancel={() => setEditing(null)}
            onDone={() => { close(); reload(); }}
          />
        ) : viewing && (
          <>
            <p className="faint small bill-history-sub">{viewing.category} · {describeSchedule(viewing.schedule)}</p>
            <BillHistory bill={viewing} today={localToday()} onEdit={() => setEditing(viewing)} onClose={close} />
          </>
        )}
      </Modal>
    </>
  );
}

function BillForm({ bill, categories, nextSort, onDone, onCancel }: {
  bill: Bill | null; categories: string[]; nextSort: number; onDone: () => void; onCancel: () => void;
}) {
  const [b, setB] = useState<Bill>(bill ?? {
    code: '', name: '', category: 'Utility', direction: 'out', active: true,
    schedule: { kind: 'monthly', day: 1 }, amountMode: 'auto', amountCents: 0, minCents: null, notes: '', sort: nextSort,
  });
  const set = (patch: Partial<Bill>) => setB({ ...b, ...patch });
  const s = b.schedule;

  return (
    <AsyncForm
      onCancel={onCancel}
      onSubmit={async () => {
        await (bill ? api.updateBill(b) : api.createBill(b));
        onDone();
      }}
    >
      <div className="form-grid">
        <label className="field">
          <span>Code</span>
          <input
            value={b.code} required disabled={bill !== null} maxLength={12} pattern="[A-Z0-9_]{1,12}"
            onChange={(e) => set({ code: e.target.value.toUpperCase() })}
          />
          <span className="hint">{bill ? 'Permanent; history is matched on it.' : 'Short and permanent, e.g. BGE.'}</span>
        </label>
        <label className="field"><span>Name</span><input value={b.name} required maxLength={80} onChange={(e) => set({ name: e.target.value })} /></label>
        <label className="field">
          <span>Category</span>
          <select value={b.category} onChange={(e) => set({ category: e.target.value })}>
            {categories.map((c) => <option key={c}>{c}</option>)}
          </select>
        </label>
        <label className="field">
          <span>Direction</span>
          <select value={b.direction} onChange={(e) => set({ direction: e.target.value as Bill['direction'] })}>
            <option value="out">Money out</option>
            <option value="in">Money in</option>
          </select>
        </label>
        <label className="field">
          <span>Schedule</span>
          <select
            value={s.kind}
            onChange={(e) => {
              const kind = e.target.value as Schedule['kind'];
              set({
                schedule: kind === 'monthly' ? { kind, day: 1 }
                  : kind === 'interval' ? { kind, anchor: new Date().toISOString().slice(0, 10), everyDays: 14 }
                  : { kind },
              });
            }}
          >
            <option value="monthly">Monthly</option>
            <option value="interval">Every N days</option>
            <option value="none">Not scheduled (tag only)</option>
          </select>
        </label>
        {s.kind === 'monthly' && (
          <label className="field">
            <span>Due day</span>
            <input type="number" min={1} max={31} value={s.day} required onChange={(e) => set({ schedule: { kind: 'monthly', day: Number(e.target.value) } })} />
          </label>
        )}
        {s.kind === 'interval' && (
          <>
            <label className="field"><span>Any one real date</span><input type="date" value={s.anchor} required onChange={(e) => set({ schedule: { ...s, anchor: e.target.value } })} /></label>
            <label className="field"><span>Every (days)</span><input type="number" min={1} max={366} value={s.everyDays} required onChange={(e) => set({ schedule: { ...s, everyDays: Number(e.target.value) } })} /></label>
          </>
        )}
        <label className="field">
          <span>Estimate from</span>
          <select value={b.amountMode} onChange={(e) => set({ amountMode: e.target.value as Bill['amountMode'] })}>
            <option value="auto">History (average / worst)</option>
            <option value="fixed">Fixed amount</option>
          </select>
        </label>
        <MoneyInput
          label={b.amountMode === 'fixed' ? 'Amount' : 'Fallback amount (no history yet)'}
          cents={b.amountCents}
          onChange={(c) => set({ amountCents: c ?? 0 })}
        />
        {b.amountMode === 'auto' && (
          <MoneyInput label="Never estimate below (optional)" cents={b.minCents} required={false} onChange={(c) => set({ minCents: c })} />
        )}
        <label className="field" style={{ alignSelf: 'center' }}>
          <span>Active</span>
          <input type="checkbox" checked={b.active} onChange={(e) => set({ active: e.target.checked })} />
        </label>
      </div>
      <label className="field" style={{ marginTop: 12 }}>
        <span>Notes</span>
        <textarea rows={2} maxLength={500} value={b.notes} onChange={(e) => set({ notes: e.target.value })} />
      </label>
    </AsyncForm>
  );
}
