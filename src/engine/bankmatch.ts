import { diffDays, type ISODate } from './dates.ts';
import type { Cents, Direction } from './types.ts';

/**
 * Matching the bank's checking activity to what the ledger expects, by amount rather than
 * name: bank descriptions rarely look like bill names. A payment matches when it's within
 * the expected item's date window, never more than expected, and at most `tolerance` less
 * (a card payment can be a little under the statement after a return).
 */

export interface BankItem {
  id: string;
  date: ISODate;
  direction: Direction;
  amountCents: Cents;
}

export interface Expected {
  key: string;
  date: ISODate;
  direction: Direction;
  amountCents: Cents;
  slackDays: number;
}

export const DEFAULT_TOLERANCE = 0.1;

/** True when `bank` could be `exp`. */
export function amountFits(bank: Cents, expected: Cents, tolerance = DEFAULT_TOLERANCE): boolean {
  return expected > 0 && bank <= expected && bank >= Math.round(expected * (1 - tolerance));
}

/**
 * Pairs bank items with expected items, each used at most once. The closest amount wins,
 * then the closest date, so a $1,200 payment goes to the $1,200 bill, not the $1,250 one.
 * Returns bank id → expected key.
 */
export function matchByAmount(bank: BankItem[], expected: Expected[], tolerance = DEFAULT_TOLERANCE): Map<string, string> {
  const pairs: { b: BankItem; e: Expected; gap: number; days: number }[] = [];
  for (const b of bank) {
    for (const e of expected) {
      if (b.direction !== e.direction) continue;
      const days = Math.abs(diffDays(b.date, e.date));
      if (days > e.slackDays || !amountFits(b.amountCents, e.amountCents, tolerance)) continue;
      pairs.push({ b, e, gap: (e.amountCents - b.amountCents) / e.amountCents, days });
    }
  }
  pairs.sort((x, y) => x.gap - y.gap || x.days - y.days || x.b.id.localeCompare(y.b.id) || x.e.key.localeCompare(y.e.key));
  const out = new Map<string, string>();
  const used = new Set<string>();
  for (const { b, e } of pairs) {
    if (out.has(b.id) || used.has(e.key)) continue;
    out.set(b.id, e.key);
    used.add(e.key);
  }
  return out;
}
