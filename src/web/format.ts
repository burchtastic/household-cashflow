import { diffDays, todayIn } from '../engine/dates.ts';

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const usd0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

export const money = (cents: number) => usd.format(cents / 100);
export const money0 = (cents: number) => usd0.format(cents / 100);

/** "1,234.56" / "$1234.5" / "-20" → cents, or null if not a valid amount. */
export function parseDollars(s: string, allowNegative = false): number | null {
  const cleaned = s.replace(/[$,\s]/g, '');
  if (!/^-?\d+(\.\d{0,2})?$/.test(cleaned)) return null;
  const neg = cleaned.startsWith('-');
  if (neg && !allowNegative) return null;
  const [whole, frac = ''] = cleaned.replace('-', '').split('.');
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  return neg ? -cents : cents;
}

export const centsToInput = (cents: number) => (cents / 100).toFixed(2);

const UTC = { timeZone: 'UTC' } as const;
const asDate = (iso: string) => new Date(`${iso}T00:00:00Z`);

/** "Tue, Nov 24" */
export const shortDate = (iso: string) =>
  asDate(iso).toLocaleDateString('en-US', { ...UTC, weekday: 'short', month: 'short', day: 'numeric' });
/** "Nov 24" */
export const dayMonth = (iso: string) => asDate(iso).toLocaleDateString('en-US', { ...UTC, month: 'short', day: 'numeric' });
/** "Nov 24, 2026" */
export const longDate = (iso: string) =>
  asDate(iso).toLocaleDateString('en-US', { ...UTC, month: 'short', day: 'numeric', year: 'numeric' });

export const localToday = () => todayIn(Intl.DateTimeFormat().resolvedOptions().timeZone);

export function relativeDays(iso: string, today: string): string {
  const d = diffDays(iso, today);
  if (d === 0) return 'today';
  if (d === 1) return 'tomorrow';
  if (d === -1) return 'yesterday';
  return d > 0 ? `in ${d} days` : `${-d} days ago`;
}

/** "11-24": the date in as little room as possible, for phones. */
export const mmdd = (iso: string) => iso.slice(5);
