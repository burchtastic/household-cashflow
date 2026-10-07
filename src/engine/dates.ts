// Calendar dates are plain "YYYY-MM-DD" strings. Arithmetic goes through a
// UTC day number so time zones and DST can never shift a date.

export type ISODate = string;

const MS_PER_DAY = 86_400_000;
const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isISODate(s: unknown): s is ISODate {
  if (typeof s !== 'string' || !ISO_RE.test(s)) return false;
  return fromDayNumber(toDayNumber(s)) === s;
}

export function toDayNumber(d: ISODate): number {
  const [y, m, day] = d.split('-').map(Number);
  return Date.UTC(y, m - 1, day) / MS_PER_DAY;
}

export function fromDayNumber(n: number): ISODate {
  return new Date(n * MS_PER_DAY).toISOString().slice(0, 10);
}

export function addDays(d: ISODate, n: number): ISODate {
  return fromDayNumber(toDayNumber(d) + n);
}

/** a − b in days. */
export function diffDays(a: ISODate, b: ISODate): number {
  return toDayNumber(a) - toDayNumber(b);
}

export function daysInMonth(year: number, month1: number): number {
  return new Date(Date.UTC(year, month1, 0)).getUTCDate();
}

/** "YYYY-MM" */
export function monthKey(d: ISODate): string {
  return d.slice(0, 7);
}

/** Today's calendar date in the given IANA time zone. */
export function todayIn(timeZone: string, now = new Date()): ISODate {
  return now.toLocaleDateString('en-CA', { timeZone });
}

export const AVG_DAYS_PER_MONTH = 365.25 / 12;
