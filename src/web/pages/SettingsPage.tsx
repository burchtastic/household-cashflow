import { useState } from 'react';
import type { Settings } from '../../engine/index.ts';
import { api, auth } from '../api.ts';
import { AppUpdates } from '../components/AppUpdates.tsx';
import { ImportSheet } from '../components/ImportSheet.tsx';
import { RestoreBackup } from '../components/RestoreBackup.tsx';
import { Security } from '../components/Security.tsx';
import { AsyncForm, ErrorNote, MoneyInput, useLoad } from '../components/ui.tsx';
import { longDate, money } from '../format.ts';

export function SettingsPage() {
  const settings = useLoad(api.settings);
  const snapshots = useLoad(api.snapshots);
  const status = useLoad(auth.status);
  const demo = status.data?.demo ?? false;

  if (settings.error) return <ErrorNote error={settings.error} />;
  if (!settings.data) return <p className="empty">Loading…</p>;

  return (
    <>
      <div className="page-head"><h1>Settings</h1></div>
      <section className="card">
        <div className="card-head"><h2>Forecast</h2></div>
        <SettingsForm initial={settings.data} onSaved={settings.reload} />
      </section>

      <section className="card">
        <div className="card-head"><h2>Bank connections</h2></div>
        <p className="hint">Read-only links to the bank through Plaid, for balances, transactions and card statements.</p>
        <div className="form-actions" style={{ justifyContent: 'flex-start' }}>
          {/* A full page load: only that page's security policy lets Plaid in. */}
          <a className="btn" href="/connect">Manage bank connections</a>
        </div>
      </section>

      <section className="card">
        <div className="card-head"><h2>Demo mode</h2></div>
        <p className="hint">
          For showing the app off. Every amount is disguised: paychecks at about 70%, card bills 50%, the mortgage 75%,
          everything else 60%, each nudged a little so the real figures can't be worked out. Bank activity shows categories
          instead of merchants, and account numbers are hidden. It's for this browser only (your phone keeps the real
          numbers), and nothing can be changed while it's on.
        </p>
        <div className="form-actions" style={{ justifyContent: 'flex-start' }}>
          <button className="primary" onClick={() => api.setDemo(!demo).then(() => location.reload())}>
            {demo ? 'Turn off demo mode' : 'Turn on demo mode'}
          </button>
        </div>
      </section>

      <ImportSheet />

      <Security />

      <AppUpdates />

      <RestoreBackup />

      <section className="card">
        <div className="card-head"><h2>Balance history</h2><span className="muted small">Add new balances from the dashboard.</span></div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Account</th><th>As of</th><th className="num">Balance</th></tr></thead>
            <tbody>
              {snapshots.data?.slice().reverse().map((s) => (
                <tr key={s.id}><td>{s.account}</td><td>{longDate(s.date)}</td><td className="num">{money(s.amountCents)}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

function SettingsForm({ initial, onSaved }: { initial: Settings; onSaved: () => void }) {
  const [s, setS] = useState(initial);
  const [saved, setSaved] = useState(false);
  const set = (patch: Partial<Settings>) => { setS({ ...s, ...patch }); setSaved(false); };
  return (
    <AsyncForm
      onSubmit={async () => {
        await api.saveSettings(s);
        setSaved(true);
        onSaved();
      }}
    >
      <div className="form-grid">
        <MoneyInput label="Checking floor" cents={s.bufferFloorCents} onChange={(c) => c !== null && set({ bufferFloorCents: c })} />
        <MoneyInput label="Savings floor" cents={s.savingsFloorCents} onChange={(c) => c !== null && set({ savingsFloorCents: c })} />
        <label className="field">
          <span>Look ahead (days)</span>
          <input type="number" min={7} max={366} value={s.horizonDays} onChange={(e) => set({ horizonDays: Number(e.target.value) })} />
        </label>
        <label className="field">
          <span>Estimate lookback (days)</span>
          <input type="number" min={30} max={1100} value={s.lookbackDays} onChange={(e) => set({ lookbackDays: Number(e.target.value) })} />
        </label>
        <label className="field">
          <span>Estimate mode</span>
          <select value={s.estimateMode} onChange={(e) => set({ estimateMode: e.target.value as Settings['estimateMode'] })}>
            <option value="average">Average</option>
            <option value="worst">Worst case</option>
          </select>
        </label>
        <MoneyInput label="Round transfers up to" cents={s.topUpRoundingCents} onChange={(c) => c !== null && set({ topUpRoundingCents: c })} />
        <MoneyInput label="Ignore bank differences under" cents={s.bankCheckThresholdCents} onChange={(c) => c !== null && set({ bankCheckThresholdCents: c })} />
      </div>
      <p className="hint">
        Checking floor: the balance you never want to drop below. Savings floor: the savings balance you never want to
        draw below. Worst case uses the highest amount each bill hit in the lookback window.
      </p>
      <p className="hint">
        Ignore bank differences under: the dashboard only flags a gap between the bank's balance and the ledger's this
        big or bigger, unless the bank has less and that would take the account below its floor. $0 flags every gap.
      </p>
      {saved && <p className="small" style={{ color: 'var(--good-ink)' }}>Saved.</p>}
    </AsyncForm>
  );
}
