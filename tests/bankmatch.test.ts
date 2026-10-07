import { describe, expect, it } from 'vitest';
import { amountFits, matchByAmount, type BankItem, type Expected } from '../src/engine/index.ts';

const out = (id: string, date: string, amountCents: number): BankItem => ({ id, date, direction: 'out', amountCents });
const exp = (key: string, date: string, amountCents: number, slackDays = 15): Expected =>
  ({ key, date, direction: 'out', amountCents, slackDays });

describe('amountFits', () => {
  it('takes the exact amount or up to 10% less, never more', () => {
    expect(amountFits(1200_00, 1200_00)).toBe(true);
    expect(amountFits(1080_00, 1200_00)).toBe(true);
    expect(amountFits(1079_99, 1200_00)).toBe(false);
    expect(amountFits(1200_01, 1200_00)).toBe(false);
    expect(amountFits(0, 0)).toBe(false);
  });
});

describe('matchByAmount', () => {
  it('matches by amount within the date window', () => {
    const m = matchByAmount([out('b1', '2026-10-26', 1150_00)], [exp('CARD', '2026-10-25', 1200_00)]);
    expect([...m]).toEqual([['b1', 'CARD']]);
  });

  it('ignores the wrong direction, a date too far away, and an amount out of range', () => {
    const m = matchByAmount(
      [{ ...out('in', '2026-10-25', 1200_00), direction: 'in' }, out('far', '2026-11-20', 1200_00), out('big', '2026-10-25', 1300_00)],
      [exp('CARD', '2026-10-25', 1200_00)],
    );
    expect(m.size).toBe(0);
  });

  it('gives each side one partner, closest amount first', () => {
    const m = matchByAmount(
      [out('a', '2026-10-25', 1190_00), out('b', '2026-10-25', 1240_00)],
      [exp('BIG', '2026-10-25', 1250_00), exp('SMALL', '2026-10-25', 1200_00)],
    );
    expect(Object.fromEntries(m)).toEqual({ a: 'SMALL', b: 'BIG' });
  });

  it('prefers the nearer date when amounts tie', () => {
    const m = matchByAmount([out('b', '2026-10-01', 500_00)], [exp('SEP', '2026-09-20', 500_00), exp('OCT', '2026-10-03', 500_00)]);
    expect([...m]).toEqual([['b', 'OCT']]);
  });
});
