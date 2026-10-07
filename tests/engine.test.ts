import { describe, expect, it } from 'vitest';
import {
  addDays, estimateBill, forecast, nearestOccurrence, occurrences,
  type Bill, type Settings, type Transaction,
} from '../src/engine/index.ts';

const settings: Settings = {
  bufferFloorCents: 500_00,
  savingsFloorCents: 4000_00,
  horizonDays: 30,
  lookbackDays: 120,
  estimateMode: 'average',
  topUpRoundingCents: 0,
  savingsDrawCodes: ['XFER'],
};

function bill(over: Partial<Bill> & { code: string }): Bill {
  return {
    name: over.code, category: 'Utility', direction: 'out', active: true,
    schedule: { kind: 'monthly', day: 1 }, amountMode: 'fixed', amountCents: 0,
    minCents: null, notes: '', sort: 0, ...over,
  };
}

let nextId = 1;
function txn(date: string, code: string, amountCents: number, direction: 'in' | 'out' = 'out'): Transaction {
  return { id: nextId++, date, code, description: code, direction, amountCents, source: 'test', note: '', plannedId: null };
}

describe('occurrences', () => {
  it('clamps monthly due days to the end of short months', () => {
    const b = bill({ code: 'X', schedule: { kind: 'monthly', day: 31 } });
    expect(occurrences(b, '2026-01-15', '2026-04-30').map((o) => o.dueDate))
      .toEqual(['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']);
  });

  it('steps interval schedules from the anchor in both directions', () => {
    const b = bill({ code: 'PAY', schedule: { kind: 'interval', anchor: '2026-09-04', everyDays: 14 } });
    expect(occurrences(b, '2026-08-25', '2026-10-02').map((o) => o.dueDate))
      .toEqual(['2026-09-04', '2026-09-18', '2026-10-02']);
    expect(occurrences(b, '2026-08-01', '2026-08-25').map((o) => o.dueDate))
      .toEqual(['2026-08-07', '2026-08-21']);
  });

  it('crosses year boundaries', () => {
    const b = bill({ code: 'X', schedule: { kind: 'monthly', day: 5 } });
    expect(occurrences(b, '2026-12-01', '2027-01-31').map((o) => o.period)).toEqual(['2026-12', '2027-01']);
  });
});

describe('nearestOccurrence', () => {
  const card = bill({ code: 'CARD', schedule: { kind: 'monthly', day: 25 } });

  it('finds the payment a statement due date belongs to, even across a month boundary', () => {
    expect(nearestOccurrence(card, '2026-10-28')).toMatchObject({ dueDate: '2026-10-25', period: '2026-10' });
    expect(nearestOccurrence(card, '2026-11-02')).toMatchObject({ dueDate: '2026-10-25', period: '2026-10' });
  });

  it('is null when no payment is close enough', () => {
    const b = bill({ code: 'X', schedule: { kind: 'interval', anchor: '2026-01-01', everyDays: 90 } });
    expect(nearestOccurrence(b, '2026-02-15')).toBeNull();
    expect(nearestOccurrence(bill({ code: 'T', schedule: { kind: 'none' } }), '2026-10-01')).toBeNull();
  });
});

describe('estimateBill', () => {
  const b = bill({ code: 'BGE', amountMode: 'auto', amountCents: 999 });
  const history = [txn('2026-06-05', 'BGE', 300_00), txn('2026-07-05', 'BGE', 500_00), txn('2025-01-05', 'BGE', 9_000_00)];

  it('averages inside the lookback window only', () => {
    expect(estimateBill(b, history, '2026-08-01', settings).estimateCents).toBe(400_00);
  });
  it('uses the worst amount in worst mode', () => {
    expect(estimateBill(b, history, '2026-08-01', { ...settings, estimateMode: 'worst' }).estimateCents).toBe(500_00);
  });
  it('respects a minimum', () => {
    expect(estimateBill({ ...b, minCents: 450_00 }, history, '2026-08-01', settings).estimateCents).toBe(450_00);
  });
  it('falls back to the typed amount with no history', () => {
    expect(estimateBill(b, [], '2026-08-01', settings).estimateCents).toBe(999);
  });
});

describe('card floors', () => {
  const card = bill({ code: 'CARD', category: 'Credit Card', amountMode: 'fixed', amountCents: 3000_00, schedule: { kind: 'monthly', day: 25 } });
  const run = (o: Partial<Parameters<typeof forecast>[0]> = {}) => forecast({
    today: '2026-10-07', settings: { ...settings, horizonDays: 60 }, bills: [card], transactions: [], overrides: [], planned: [],
    checking: { account: 'checking', date: '2026-10-07', amountCents: 10000_00 }, savings: null, ...o,
  }).events.filter((e) => e.code === 'CARD').map((e) => [e.period, e.amountCents, e.raisedFromCents ?? null]);

  it("raises only the next payment to what's already on the card", () => {
    expect(run({ cardFloors: [{ code: 'CARD', amountCents: 4000_00 }] }))
      .toEqual([['2026-10', 4000_00, 3000_00], ['2026-11', 3000_00, null]]);
  });

  it('never lowers an estimate', () => {
    expect(run({ cardFloors: [{ code: 'CARD', amountCents: 1000_00 }] }))
      .toEqual([['2026-10', 3000_00, null], ['2026-11', 3000_00, null]]);
  });

  it('skips a payment with a known amount (the statement) and paid ones', () => {
    expect(run({
      cardFloors: [{ code: 'CARD', amountCents: 4000_00 }],
      overrides: [{ code: 'CARD', period: '2026-10', amountCents: 2500_00 }],
    })).toEqual([['2026-10', 2500_00, null], ['2026-11', 4000_00, 3000_00]]);
    expect(run({
      cardFloors: [{ code: 'CARD', amountCents: 4000_00 }],
      transactions: [txn('2026-10-24', 'CARD', 2900_00)],
      checking: { account: 'checking', date: '2026-10-01', amountCents: 10000_00 },
    })).toEqual([['2026-10', 2900_00, null], ['2026-11', 4000_00, 3000_00]]);
  });
});

describe('forecast', () => {
  const pay = bill({
    code: 'PAY', direction: 'in', category: 'Income', amountCents: 2000_00,
    schedule: { kind: 'interval', anchor: '2026-10-09', everyDays: 14 },
  });
  const rent = bill({ code: 'RENT', amountCents: 1500_00, schedule: { kind: 'monthly', day: 15 } });
  const base = {
    settings, bills: [pay, rent], overrides: [], planned: [], savings: null,
    transactions: [] as Transaction[],
  };

  it('looks forward from today, not from the snapshot', () => {
    // Snapshot on Oct 1; a dip on Oct 3 is in the past by Oct 6.
    const f = forecast({
      ...base,
      today: '2026-10-06',
      checking: { account: 'checking', date: '2026-10-01', amountCents: 2000_00 },
      transactions: [txn('2026-10-03', 'MISC', 1900_00)],
    });
    expect(f.todayBalanceCents).toBe(100_00);
    // Oct 9 +2000 → 2100, Oct 15 −1500 → 600, Oct 23 +2000 → 2600, Nov 5 horizon.
    expect(f.lowest).toEqual({ date: '2026-10-06', balanceCents: 100_00 });
    expect(f.topUps).toEqual([{ by: '2026-10-06', amountCents: 400_00 }]);
    expect(f.safeToSweepCents).toBe(0);
  });

  it('sizes each top-up to cover the next two weeks', () => {
    const f = forecast({
      ...base,
      today: '2026-10-01',
      checking: { account: 'checking', date: '2026-10-01', amountCents: 600_00 },
      bills: [rent, bill({ code: 'CARD', amountCents: 700_00, schedule: { kind: 'monthly', day: 20 } })],
    });
    // Oct 15: 600 − 1500 = −900; low point through Oct 28 is −1600 (card on the 20th) → one 2100 transfer,
    // not 1400 now and 700 five days later.
    expect(f.topUps).toEqual([{ by: '2026-10-15', amountCents: 2100_00 }]);
  });

  it('replaces an estimate with the matched payment, even when paid early', () => {
    const f = forecast({
      ...base,
      today: '2026-10-20',
      checking: { account: 'checking', date: '2026-10-01', amountCents: 5000_00 },
      transactions: [txn('2026-10-12', 'RENT', 1450_00)],
    });
    const rentEvents = f.events.filter((e) => e.code === 'RENT');
    expect(rentEvents[0]).toMatchObject({ date: '2026-10-12', amountCents: 1450_00, status: 'posted', period: '2026-10' });
    expect(rentEvents).toHaveLength(2); // Oct (posted) + Nov (estimated), never a duplicate October
  });

  it('assumes events on or before the snapshot are already in the balance', () => {
    const f = forecast({
      ...base,
      today: '2026-10-20',
      checking: { account: 'checking', date: '2026-10-15', amountCents: 1000_00 },
    });
    expect(f.events.find((e) => e.code === 'RENT' && e.period === '2026-10')).toBeUndefined();
  });

  it('flags unconfirmed past events and uses a known amount over the estimate', () => {
    const f = forecast({
      ...base,
      today: '2026-10-20',
      checking: { account: 'checking', date: '2026-10-01', amountCents: 5000_00 },
      overrides: [{ code: 'RENT', period: '2026-10', amountCents: 1234_00 }],
    });
    expect(f.unconfirmed.map((e) => [e.code, e.status, e.amountCents])).toEqual([
      ['PAY', 'scheduled', 2000_00],
      ['RENT', 'known', 1234_00],
    ]);
  });

  it('calls fixed amounts scheduled and history-based amounts estimated', () => {
    const f = forecast({
      ...base,
      today: '2026-10-01',
      checking: { account: 'checking', date: '2026-10-01', amountCents: 5000_00 },
      bills: [rent, bill({ code: 'BGE', amountMode: 'auto', amountCents: 150_00, schedule: { kind: 'monthly', day: 20 } })],
    });
    const status = (code: string) => f.events.find((e) => e.code === code)!.status;
    expect(status('RENT')).toBe('scheduled');
    expect(status('BGE')).toBe('estimated');
    expect(f.estimatedOutflowCents).toBe(150_00); // only the guess, not the rent
  });

  it('works out how much smaller the next planned savings draw could be', () => {
    const plan = (amountCents: number) => forecast({
      ...base,
      today: '2026-10-01',
      checking: { account: 'checking', date: '2026-10-01', amountCents: 600_00 },
      bills: [rent],
      planned: [{ id: 7, date: '2026-10-10', code: 'XFER', description: 'Transfer', direction: 'in', amountCents, note: '', status: 'planned' }],
    });
    // 600 + draw − 1500 on Oct 15 must stay ≥ 500, so the draw needs 1400 and the rest is slack.
    expect(plan(2000_00).nextDraw).toEqual({ plannedId: 7, code: 'XFER', date: '2026-10-10', amountCents: 2000_00, canTrimCents: 600_00 });
    expect(plan(1400_00).nextDraw!.canTrimCents).toBe(0);
    // Slack never exceeds the draw itself.
    expect(forecast({
      ...base, today: '2026-10-01', bills: [],
      checking: { account: 'checking', date: '2026-10-01', amountCents: 9000_00 },
      planned: [{ id: 1, date: '2026-10-10', code: 'XFER', description: 'T', direction: 'in', amountCents: 300_00, note: '', status: 'planned' }],
    }).nextDraw!.canTrimCents).toBe(300_00);
  });

  it('computes savings runway from the forward shortfall, net of draws since the snapshot', () => {
    const f = forecast({
      ...base,
      today: '2026-10-01',
      horizonEnd: addDays('2026-10-01', 61),
      checking: { account: 'checking', date: '2026-10-01', amountCents: 0 },
      savings: { account: 'savings', date: '2026-09-01', amountCents: 10_000_00 },
      bills: [rent],
      transactions: [txn('2026-09-20', 'XFER', 2000_00, 'in')],
    });
    const s = f.savings!;
    expect(s.balanceTodayCents).toBe(8000_00);
    expect(s.trailing90DrawsCents).toBe(2000_00);
    // Two rents in 61 days ≈ 1497/month shortfall; cushion 4000.
    expect(s.monthlyShortfallCents).toBe(Math.round((3000_00 * 365.25) / 12 / 61));
    expect(s.runwayMonths).toBeCloseTo(4000_00 / s.monthlyShortfallCents, 6);
  });
});
