import { readFileSync } from 'node:fs';
import type {
  Bill, Override, PlannedItem, Settings, Snapshot, Transaction,
} from '../engine/index.ts';

/** Shape written by scripts/import_xlsx.py. */
export interface SeedFile {
  settings: Settings;
  bills: Bill[];
  transactions: Omit<Transaction, 'id' | 'plannedId'>[];
  overrides: Override[];
  planned: Omit<PlannedItem, 'id'>[];
  snapshots: Snapshot[];
}

export interface Dataset {
  settings: Settings;
  bills: Bill[];
  transactions: Transaction[];
  overrides: Override[];
  planned: PlannedItem[];
  snapshots: Snapshot[];
}

export function readSeed(path: string): SeedFile {
  return JSON.parse(readFileSync(path, 'utf8')) as SeedFile;
}

/** Assigns ids and records each completed one-off as a real transaction linked to it. */
export function seedToDataset(seed: SeedFile): Dataset {
  let txnId = 0;
  const transactions: Transaction[] = seed.transactions.map((t) => ({ ...t, id: ++txnId, plannedId: null }));
  const planned: PlannedItem[] = seed.planned.map((p, i) => ({ ...p, id: i + 1 }));
  for (const p of planned) {
    if (p.status !== 'done') continue;
    transactions.push({
      id: ++txnId, date: p.date, code: p.code, description: p.description, direction: p.direction,
      amountCents: p.amountCents, source: 'sheet-oneoff', note: p.note, plannedId: p.id,
    });
  }
  return {
    settings: seed.settings, bills: seed.bills, transactions, overrides: seed.overrides,
    planned, snapshots: seed.snapshots,
  };
}

export function latestSnapshot(snapshots: readonly Snapshot[], account: Snapshot['account']): Snapshot | null {
  let best: Snapshot | null = null;
  for (const s of snapshots) if (s.account === account && (!best || s.date >= best.date)) best = s;
  return best;
}
