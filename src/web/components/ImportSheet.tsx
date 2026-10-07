import { useState } from 'react';
import type { Schedule } from '../../engine/index.ts';
import { api, type ImportSummary } from '../api.ts';
import { longDate, money } from '../format.ts';
import { ErrorNote } from './ui.tsx';

const TEMPLATE = '/cashflow-import-template.xlsx';

const when = (s: Schedule) =>
  s.kind === 'monthly' ? `monthly on day ${s.day}` : s.kind === 'interval' ? `every ${s.everyDays / 7 === 1 ? 'week' : `${s.everyDays / 7} weeks`}` : 'one-off type';

/** Settings → Import: fill in the template, check what it would add, then add it. */
export function ImportSheet() {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ImportSummary | null>(null);
  const [done, setDone] = useState<ImportSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try { await fn(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const choose = (f: File | null) => {
    setFile(f);
    setPreview(null);
    setDone(null);
    if (f) run(async () => setPreview(await api.importPreview(f)));
  };
  const nothing = preview && !preview.newBills.length && !preview.newTypes.length && !preview.transactions && !preview.snapshots.length;

  return (
    <section className="card">
      <div className="card-head"><h2>Import from a spreadsheet</h2></div>
      <p className="hint">
        Bring in bills, past payments and balances in one go. <a href={TEMPLATE} download>Download the template</a>, fill
        it in (Excel or Google Sheets, then download as .xlsx), and choose it here. You'll see what it adds before anything
        is saved, and importing the same file again adds nothing twice.
      </p>
      <div className="inline-form">
        <label className="field">
          <span>Spreadsheet (.xlsx)</span>
          <input
            type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" disabled={busy}
            onChange={(e) => choose(e.target.files?.[0] ?? null)}
            // Choosing the same file again (after fixing it) still reads it afresh.
            onClick={(e) => { e.currentTarget.value = ''; }}
          />
        </label>
      </div>
      <ErrorNote error={error} />
      {busy && <p className="muted small">Reading…</p>}

      {done && (
        <div className="update-banner" role="status">
          <span>
            Imported {done.newBills.length + done.newTypes.length} bills and types, {done.transactions} past payments
            and {done.snapshots.length} balances.
          </span>
          <a className="btn" href="/#/">Open the dashboard</a>
        </div>
      )}

      {preview && !done && (
        <div className="import-preview">
          {preview.errorCount > 0 && (
            <>
              <h3 className="error">Fix {preview.errorCount === 1 ? 'this' : `these ${preview.errorCount}`} in the file, then choose it again</h3>
              <ul className="small">
                {preview.errors.map((p, i) => <li key={i}><strong>{p.sheet}, row {p.row}:</strong> {p.message}</li>)}
              </ul>
            </>
          )}
          <h3>It would add</h3>
          <ul className="small">
            {preview.newBills.length > 0 && (
              <li>
                {preview.newBills.length} bills:{' '}
                {preview.newBills.map((b) => `${b.name} (${b.direction === 'in' ? '+' : '−'}${money(b.amountCents)}${b.amountMode === 'auto' ? ' est.' : ''}, ${when(b.schedule)})`).join('; ')}
              </li>
            )}
            {preview.newTypes.length > 0 && (
              <li>{preview.newTypes.length} new one-off types from History: {preview.newTypes.map((b) => b.name).join(', ')}</li>
            )}
            {preview.transactions > 0 && (
              <li>
                {preview.transactions} past payments and deposits
                {preview.firstDate && `, ${longDate(preview.firstDate)} to ${longDate(preview.lastDate!)}`}
              </li>
            )}
            {preview.snapshots.map((s, i) => <li key={i}>{s.account === 'checking' ? 'Checking' : 'Savings'} balance {money(s.amountCents)} on {longDate(s.date)}</li>)}
            {nothing && <li>Nothing new.</li>}
          </ul>
          {(preview.existingBills > 0 || preview.duplicateTransactions > 0 || preview.duplicateSnapshots > 0) && (
            <p className="hint">
              Already here, so skipped: {[
                preview.existingBills && `${preview.existingBills} bills`,
                preview.duplicateTransactions && `${preview.duplicateTransactions} payments`,
                preview.duplicateSnapshots && `${preview.duplicateSnapshots} balances`,
              ].filter(Boolean).join(', ')}.
            </p>
          )}
          {preview.warnings.length > 0 && (
            <ul className="small faint">{preview.warnings.map((p, i) => <li key={i}>{p.sheet}, row {p.row}: {p.message}</li>)}</ul>
          )}
          <div className="form-actions" style={{ justifyContent: 'flex-start' }}>
            <button
              className="primary" disabled={busy || preview.errorCount > 0 || Boolean(nothing)}
              onClick={() => file && run(async () => setDone(await api.importFile(file)))}
            >
              Import
            </button>
            <button disabled={busy} onClick={() => choose(null)}>Cancel</button>
          </div>
        </div>
      )}
    </section>
  );
}
