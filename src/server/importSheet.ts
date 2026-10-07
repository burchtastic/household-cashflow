// Import bills, history and balances from the import template (an .xlsx workbook).
// The template lives at src/web/public/cashflow-import-template.xlsx and is made by
// scripts/make_import_template.py. Reading is dependency-free: an .xlsx is a zip of XML.
import { inflateRawSync } from 'node:zlib';
import { CATEGORIES, addDays, isISODate, type Bill, type Direction, type Snapshot, type Transaction } from '../engine/index.ts';
import { insertSnapshot, insertTransaction, listBills, listSnapshots, listTransactions, tx, upsertBill, type DB } from './db.ts';

export const IMPORT_MAX_BYTES = 10 * 1024 * 1024;
const MAX_UNZIPPED = 60 * 1024 * 1024;

export class ImportError extends Error {}

// ── Reading the workbook ─────────────────────────────────────────────────

/** The files inside a zip archive, by name. Only what .xlsx files use: stored or deflated. */
function unzip(buf: Buffer): Map<string, Buffer> {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65_535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new ImportError("That isn't an .xlsx file. Save or download the sheet as Excel (.xlsx) and try again.");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = new Map<string, Buffer>();
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new ImportError('The file looks damaged.');
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    // Only the workbook's XML is needed; skip images and the like.
    if (!name.endsWith('.xml') && !name.endsWith('.rels')) continue;
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + size);
    let data: Buffer;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) {
      try { data = inflateRawSync(raw, { maxOutputLength: MAX_UNZIPPED - total }); } catch { throw new ImportError('The file is too big or damaged.'); }
    } else throw new ImportError('The file uses a compression this app can\'t read. Re-save it as .xlsx.');
    total += data.length;
    files.set(name, data);
  }
  return files;
}

const unescape = (s: string) => s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (_, e: string) => {
  const named: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
  if (named[e.toLowerCase()]) return named[e.toLowerCase()];
  return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
});
const attr = (tag: string, name: string) => tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];
/** All the text runs inside an element, joined (rich text splits a cell into several). */
const textOf = (xml: string) => [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => unescape(m[1])).join('');

/** Column letters to a 0-based index: "A" → 0, "AB" → 27. */
const colIndex = (ref: string) => [...ref.replace(/\d+$/, '')].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;

export type Cell = string | number | boolean | null;
export type Sheets = Map<string, Cell[][]>;

/** Every sheet in the workbook as rows of cell values, keyed by lower-cased sheet name. */
export function readWorkbook(buf: Buffer): Sheets {
  const files = unzip(buf);
  const xml = (name: string) => files.get(name)?.toString('utf8');
  const workbook = xml('xl/workbook.xml');
  if (!workbook) throw new ImportError("That isn't an Excel workbook. Save or download the sheet as .xlsx and try again.");
  const rels = new Map<string, string>();
  for (const m of (xml('xl/_rels/workbook.xml.rels') ?? '').matchAll(/<Relationship\b[^>]*>/g)) {
    const id = attr(m[0], 'Id');
    const target = attr(m[0], 'Target');
    if (id && target) rels.set(id, target.startsWith('/') ? target.slice(1) : `xl/${target}`);
  }
  const shared = [...(xml('xl/sharedStrings.xml') ?? '').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1]));

  const sheets: Sheets = new Map();
  for (const m of workbook.matchAll(/<sheet\b[^>]*>/g)) {
    const name = unescape(attr(m[0], 'name') ?? '');
    const path = rels.get(attr(m[0], 'r:id') ?? '');
    const body = path && xml(path);
    if (!body) continue;
    const rows: Cell[][] = [];
    for (const r of body.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
      const rowNum = Number(attr(r[0], 'r')) || rows.length + 1;
      const row: Cell[] = [];
      for (const c of r[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const ref = attr(`<c ${c[1]}>`, 'r');
        const type = attr(`<c ${c[1]}>`, 't');
        const inner = c[2] ?? '';
        const v = inner.match(/<v>([\s\S]*?)<\/v>/)?.[1];
        let value: Cell = null;
        if (type === 's' && v !== undefined) value = shared[Number(v)] ?? '';
        else if (type === 'inlineStr') value = textOf(inner);
        else if (type === 'str' || type === 'e') value = v === undefined ? null : unescape(v);
        else if (type === 'b') value = v === '1';
        else if (v !== undefined) value = Number(v);
        row[ref ? colIndex(ref) : row.length] = value;
      }
      rows[rowNum - 1] = Array.from(row, (x) => x ?? null);
    }
    sheets.set(name.trim().toLowerCase(), Array.from(rows, (x) => x ?? []));
  }
  return sheets;
}

// ── Making sense of the rows ─────────────────────────────────────────────

export interface ImportProblem { sheet: string; row: number; message: string }

export interface ImportPlan {
  newBills: Bill[];
  /** One-off types made up for History items that weren't on the Bills sheet or in the app. */
  newTypes: Bill[];
  existingBills: number;
  transactions: Omit<Transaction, 'id'>[];
  duplicateTransactions: number;
  snapshots: Snapshot[];
  duplicateSnapshots: number;
  errors: ImportProblem[];
  warnings: ImportProblem[];
  firstDate: string | null;
  lastDate: string | null;
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
const str = (c: Cell | undefined) => (c === null || c === undefined ? '' : String(c).trim());

/** A header row's labels → column index, matched loosely ("Money in or out?" finds "money in or out"). */
function columns(header: Cell[], wanted: Record<string, string[]>) {
  const labels = header.map((h) => norm(str(h)).replace(/[?:*()]/g, '').trim());
  const out: Record<string, number> = {};
  for (const [key, names] of Object.entries(wanted)) {
    out[key] = labels.findIndex((l) => names.some((n) => l === n || l.startsWith(`${n} `)));
  }
  return out;
}

/** The header is the first row whose cells include `first`; rows above it are instructions. */
function table(rows: Cell[][], first: string) {
  const at = rows.findIndex((r) => r.some((c) => norm(str(c)).replace(/[?:*]/g, '') === first));
  return at < 0 ? null : { header: rows[at], body: rows.slice(at + 1).map((r, i) => ({ cells: r, row: at + i + 2 })) };
}

/** Excel dates are day counts from 1899-12-30; text dates are YYYY-MM-DD or M/D/YYYY. */
export function toISODate(c: Cell): string | null {
  if (typeof c === 'number' && c > 0 && c < 2_958_466) return addDays('1899-12-30', Math.floor(c));
  const s = str(c);
  if (isISODate(s as unknown)) return s;
  const m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})$/);
  if (!m) return null;
  const year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  const iso = `${year}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  return isISODate(iso) ? iso : null;
}

/** 1234.5, "$1,234.50" or "(45.00)" → cents (the sign is dropped; direction comes from elsewhere). */
export function toCents(c: Cell): number | null {
  if (typeof c === 'number') return Number.isFinite(c) ? Math.round(Math.abs(c) * 100) : null;
  const s = str(c).replace(/[$,\s()]/g, '').replace(/^[-+]/, '');
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  return Math.round(Number(s) * 100);
}

const toDirection = (c: Cell): Direction | null => {
  const s = norm(str(c));
  if (['out', 'money out', 'expense', 'bill', 'paid'].includes(s)) return 'out';
  if (['in', 'money in', 'income', 'deposit', 'received'].includes(s)) return 'in';
  return null;
};
const yes = (c: Cell) => c === true || ['yes', 'y', 'true', 'varies'].includes(norm(str(c)));

const FREQUENCIES: Record<string, number | 'monthly' | 'none'> = {
  monthly: 'monthly', 'every month': 'monthly',
  weekly: 7, 'every week': 7,
  'every 2 weeks': 14, biweekly: 14, 'bi-weekly': 14, 'every other week': 14,
  'every 4 weeks': 28,
  'one-off': 'none', 'one-off type': 'none', 'not scheduled': 'none', none: 'none', '': 'none',
};

/** A short permanent code from a name: "Electric bill" → "ELECTRICBIL", unique among `taken`. */
export function makeCode(name: string, taken: Set<string>): string {
  const base = (name.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10) || 'ITEM');
  let code = base;
  for (let n = 2; taken.has(code); n++) code = `${base}${n}`;
  taken.add(code);
  return code;
}

const findSheet = (sheets: Sheets, ...names: string[]) => names.map((n) => sheets.get(n)).find((s) => s !== undefined);

export function planImport(sheets: Sheets, current: { bills: Bill[]; transactions: Transaction[]; snapshots: Snapshot[] }): ImportPlan {
  const errors: ImportProblem[] = [];
  const warnings: ImportProblem[] = [];
  const taken = new Set(current.bills.map((b) => b.code));
  const byKey = new Map<string, Bill>();
  for (const b of current.bills) { byKey.set(norm(b.name), b); byKey.set(norm(b.code), b); }
  const newBills: Bill[] = [];
  const newTypes: Bill[] = [];
  let existingBills = 0;
  let sort = current.bills.reduce((m, b) => Math.max(m, b.sort), 0);

  // Bills
  const billRows = findSheet(sheets, 'bills');
  const bills = billRows && table(billRows, 'name');
  if (bills) {
    const col = columns(bills.header, {
      name: ['name'], dir: ['money in or out', 'in or out'], category: ['category'], amount: ['amount', 'usual amount'],
      varies: ['amount varies', 'varies'], often: ['how often', 'frequency'], day: ['day of month', 'day'],
      next: ['next date', 'a date it happens', 'starting'], code: ['code'],
    });
    for (const { cells, row } of bills.body) {
      const name = str(cells[col.name]);
      if (!name) continue;
      const problem = (message: string) => errors.push({ sheet: 'Bills', row, message: `${name}: ${message}` });
      if (byKey.has(norm(name)) || (col.code >= 0 && str(cells[col.code]) && byKey.has(norm(str(cells[col.code]))))) {
        existingBills++;
        continue;
      }
      const direction = toDirection(cells[col.dir]);
      if (!direction) { problem('"Money in or out" must be In or Out.'); continue; }
      const amountCents = col.amount >= 0 && str(cells[col.amount]) ? toCents(cells[col.amount]) : 0;
      if (amountCents === null) { problem(`"${str(cells[col.amount])}" isn't an amount.`); continue; }
      const freq = FREQUENCIES[norm(str(cells[col.often]))];
      if (freq === undefined) { problem(`"How often" must be Monthly, Every week, Every 2 weeks, Every 4 weeks or One-off type.`); continue; }
      let schedule: Bill['schedule'];
      if (freq === 'monthly') {
        const day = Number(cells[col.day]);
        if (!Number.isInteger(day) || day < 1 || day > 31) { problem('Monthly items need a day of the month (1-31).'); continue; }
        schedule = { kind: 'monthly', day };
      } else if (freq === 'none') {
        schedule = { kind: 'none' };
      } else {
        const anchor = toISODate(cells[col.next]);
        if (!anchor) { problem(`Items every ${freq / 7 === 1 ? 'week' : `${freq / 7} weeks`} need a date it happens (any past or future one).`); continue; }
        schedule = { kind: 'interval', anchor, everyDays: freq };
      }
      const catText = str(cells[col.category]);
      let category = CATEGORIES.find((c) => norm(c) === norm(catText)) ?? (direction === 'in' && !catText ? 'Income' : null);
      if (!category) {
        category = 'Uncategorized';
        if (catText) warnings.push({ sheet: 'Bills', row, message: `${name}: category "${catText}" isn't one of the app's, so it's Uncategorized.` });
      }
      const wantCode = col.code >= 0 ? str(cells[col.code]).toUpperCase() : '';
      if (wantCode && !/^[A-Z0-9_]{1,12}$/.test(wantCode)) { problem('Code must be up to 12 letters, digits or _.'); continue; }
      const code = wantCode && !taken.has(wantCode) ? (taken.add(wantCode), wantCode) : makeCode(name, taken);
      const bill: Bill = {
        code, name: name.slice(0, 80), category, direction, active: true, schedule,
        amountMode: yes(cells[col.varies]) ? 'auto' : 'fixed', amountCents, minCents: null, notes: '', sort: ++sort,
      };
      newBills.push(bill);
      byKey.set(norm(name), bill);
      byKey.set(norm(code), bill);
    }
  }

  // History
  const existing = new Set(current.transactions.map((t) => `${t.date}|${t.code}|${t.amountCents}`));
  const transactions: Omit<Transaction, 'id'>[] = [];
  let duplicateTransactions = 0;
  const histRows = findSheet(sheets, 'history', 'transactions');
  const hist = histRows && table(histRows, 'date');
  if (hist) {
    const col = columns(hist.header, {
      date: ['date'], item: ['item', 'name', 'what'], dir: ['money in or out', 'in or out'], amount: ['amount'], note: ['note', 'notes'],
    });
    for (const { cells, row } of hist.body) {
      if (cells.every((c) => str(c) === '')) continue;
      const item = str(cells[col.item]);
      const problem = (message: string) => errors.push({ sheet: 'History', row, message });
      const date = toISODate(cells[col.date]);
      if (!date) { problem(`"${str(cells[col.date])}" isn't a date.`); continue; }
      if (!item) { problem('The Item is blank.'); continue; }
      const amountCents = toCents(cells[col.amount]);
      if (amountCents === null) { problem(`${item}: "${str(cells[col.amount])}" isn't an amount.`); continue; }
      const stated = col.dir >= 0 ? toDirection(cells[col.dir]) : null;
      let bill = byKey.get(norm(item));
      if (!bill) {
        if (!stated) { problem(`${item} isn't on the Bills sheet, so say whether it's money In or Out.`); continue; }
        bill = {
          code: makeCode(item, taken), name: item.slice(0, 80), category: stated === 'in' ? 'Income' : 'Uncategorized',
          direction: stated, active: true, schedule: { kind: 'none' }, amountMode: 'fixed', amountCents: 0,
          minCents: null, notes: '', sort: ++sort,
        };
        newTypes.push(bill);
        byKey.set(norm(item), bill);
      } else if (stated && stated !== bill.direction) {
        problem(`${item} is money ${bill.direction === 'in' ? 'In' : 'Out'} on Bills, but this row says ${stated === 'in' ? 'In' : 'Out'}.`);
        continue;
      }
      if (existing.has(`${date}|${bill.code}|${amountCents}`)) { duplicateTransactions++; continue; }
      transactions.push({
        date, code: bill.code, description: bill.name, direction: bill.direction, amountCents,
        source: 'import', note: str(cells[col.note]).slice(0, 200), plannedId: null,
      });
    }
  }

  // Balances
  const snapshots: Snapshot[] = [];
  let duplicateSnapshots = 0;
  const balRows = findSheet(sheets, 'balances', 'balance');
  const bal = balRows && table(balRows, 'account');
  if (bal) {
    const col = columns(bal.header, { account: ['account'], date: ['date', 'as of'], amount: ['balance', 'amount'] });
    const have = new Set(current.snapshots.map((s) => `${s.account}|${s.date}|${s.amountCents}`));
    for (const { cells, row } of bal.body) {
      if (cells.every((c) => str(c) === '')) continue;
      const acct = norm(str(cells[col.account]));
      const account = acct.startsWith('check') ? 'checking' : acct.startsWith('sav') ? 'savings' : null;
      const date = toISODate(cells[col.date]);
      const raw = cells[col.amount];
      const cents = toCents(raw);
      const negative = (typeof raw === 'number' && raw < 0) || /^\s*[-(]/.test(str(raw));
      if (!account) { errors.push({ sheet: 'Balances', row, message: 'Account must be Checking or Savings.' }); continue; }
      if (!date) { errors.push({ sheet: 'Balances', row, message: `"${str(cells[col.date])}" isn't a date.` }); continue; }
      if (cents === null) { errors.push({ sheet: 'Balances', row, message: `"${str(raw)}" isn't an amount.` }); continue; }
      const s: Snapshot = { account, date, amountCents: negative ? -cents : cents };
      if (have.has(`${s.account}|${s.date}|${s.amountCents}`)) { duplicateSnapshots++; continue; }
      snapshots.push(s);
    }
  }

  if (!bills && !hist && !bal) {
    throw new ImportError('No Bills, History or Balances sheet found. Start from the import template (Settings → Import).');
  }
  const dates = transactions.map((t) => t.date).sort();
  return {
    newBills, newTypes, existingBills, transactions, duplicateTransactions, snapshots, duplicateSnapshots,
    errors, warnings, firstDate: dates[0] ?? null, lastDate: dates.at(-1) ?? null,
  };
}

/** Reads the file and works out what importing it would add. Nothing is saved. */
export function previewImport(db: DB, file: Buffer): ImportPlan {
  return planImport(readWorkbook(file), {
    bills: listBills(db), transactions: listTransactions(db), snapshots: listSnapshots(db),
  });
}

/** Saves everything the file adds, all or nothing. Refuses while the file has errors. */
export function applyImport(db: DB, file: Buffer): ImportPlan {
  const plan = previewImport(db, file);
  if (plan.errors.length) throw new ImportError('Fix the problems in the file first, then import it again.');
  tx(db, () => {
    for (const b of [...plan.newBills, ...plan.newTypes]) upsertBill(db, b);
    for (const t of plan.transactions) insertTransaction(db, t);
    for (const s of plan.snapshots) insertSnapshot(db, s);
  });
  return plan;
}
