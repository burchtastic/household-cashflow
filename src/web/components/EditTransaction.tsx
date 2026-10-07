import { useState } from 'react';
import { api } from '../api.ts';
import { AsyncForm, MoneyInput } from './ui.tsx';

export interface EditableTxn {
  id: number;
  name: string;
  date: string;
  amountCents: number;
  note: string;
  direction: 'in' | 'out';
}

/** Change the date, amount or note of something already recorded (paid, received, or set up with the bank). */
export function EditTransactionForm({ txn, today, onDone, onCancel, save }: {
  txn: EditableTxn; today: string; onDone: () => void; onCancel: () => void;
  /** Defaults to saving the transaction itself. */
  save?: (v: { date: string; amountCents: number; note: string }) => Promise<unknown>;
}) {
  const [date, setDate] = useState(txn.date);
  const [cents, setCents] = useState<number | null>(txn.amountCents);
  const [note, setNote] = useState(txn.note);
  const future = date > today;
  return (
    <AsyncForm
      onCancel={onCancel}
      onSubmit={async () => {
        if (cents === null) throw new Error('Enter the amount');
        const v = { date, amountCents: cents, note: note.trim() };
        await (save ? save(v) : api.updateTransaction(txn.id, v));
        onDone();
      }}
    >
      <p className="muted small">
        {txn.name}. {future
          ? 'Set up with the bank: the forecast counts it on this date.'
          : txn.direction === 'in' ? 'Already received.' : 'Already paid.'}
      </p>
      <div className="form-grid">
        <label className="field">
          <span>{future ? 'Date it goes through' : 'Date'}</span>
          <input type="date" value={date} required onChange={(e) => setDate(e.target.value)} />
        </label>
        <MoneyInput label="Amount" cents={cents} onChange={setCents} autoFocus />
      </div>
      <label className="field" style={{ marginTop: 12 }}>
        <span>Note</span>
        <input value={note} maxLength={200} placeholder="e.g. plumbing repair" onChange={(e) => setNote(e.target.value)} />
      </label>
      <p className="hint">
        Anything dated on or before your latest checking balance is treated as already in it.
      </p>
    </AsyncForm>
  );
}
