// Reproduces the spreadsheet's Ledger tab from the imported data.
// Expected balances are kept in data/sheet-ledger.json (gitignored, real figures),
// so this test only runs on a machine that has run the importer.
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { forecast } from '../src/engine/index.ts';
import { latestSnapshot, readSeed, seedToDataset } from '../src/server/seedData.ts';

const SEED = 'data/seed.json';
const EXPECTED = 'data/sheet-ledger.json';
const ready = existsSync(SEED) && existsSync(EXPECTED);

interface SheetLedger {
  windowStart: string;
  windowEnd: string;
  balanceToday: { date: string; balanceCents: number };
  /** End-of-day balance for every date that has a Ledger row. */
  endOfDay: Record<string, number>;
}

describe.skipIf(!ready)('parity with the spreadsheet Ledger', () => {
  const data = ready ? seedToDataset(readSeed(SEED)) : null!;
  const expected: SheetLedger = ready ? JSON.parse(readFileSync(EXPECTED, 'utf8')) : null!;
  const run = (today: string) =>
    forecast({
      today,
      settings: data.settings,
      bills: data.bills,
      transactions: data.transactions,
      overrides: data.overrides,
      planned: data.planned,
      checking: latestSnapshot(data.snapshots, 'checking')!,
      savings: null,
      horizonEnd: expected.windowEnd,
    });

  it('matches every end-of-day balance in the window', () => {
    const f = run(expected.windowStart);
    const daily = Object.fromEntries(f.daily.map((d) => [d.date, d.balanceCents]));
    const actual = Object.fromEntries(Object.keys(expected.endOfDay).map((d) => [d, daily[d]]));
    expect(actual).toEqual(expected.endOfDay);
  });

  it('matches the sheet\'s "Balance today"', () => {
    const f = run(expected.balanceToday.date);
    expect(f.todayBalanceCents).toBe(expected.balanceToday.balanceCents);
  });
});
