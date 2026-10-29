import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import type {
  Bill, EstimateStats, Forecast, PlannedItem, Settings, Snapshot, Transaction,
} from '../engine/index.ts';
import type { DeployStatus, Version } from '../server/deploy.ts';
import type { AccountRole, BankTransaction, PlaidAccountRow, PlaidItemRow } from '../server/db.ts';
import type { ItemSyncResult } from '../server/sync.ts';
import type { StatementPlan } from '../server/statements.ts';
import type { BankBalance, ImportSummary } from '../server/app.ts';
import type { BackupFile, BackupSummary, LastRestore } from '../server/restore.ts';

export type { DeployStatus, Version, AccountRole, BankTransaction, ItemSyncResult, BankBalance, ImportSummary };
export type { BackupFile, BackupSummary, LastRestore };
export type ReviewItem = BankTransaction & { direction: 'in' | 'out'; undone: boolean };
export type BankBalances = { enabled: false } | { enabled: true; checking: BankBalance | null; savings: BankBalance | null };
export type StatementUse =
  | (StatementPlan & { problem: null })
  | { problem: string };
export type PlaidAccount = PlaidAccountRow & { transactionCount: number; statementUse: StatementUse | null };
export type PlaidItem = Omit<PlaidItemRow, 'accessTokenEnc' | 'cursor'> & { accounts: PlaidAccount[] };
export type PlaidInfo =
  | { enabled: false }
  | {
    enabled: true; env: 'sandbox' | 'production'; slots: { used: number; limit: number };
    syncEveryMs: number | null; items: PlaidItem[];
  };
export interface DeployInfo { enabled: boolean; running: Version | null; status: DeployStatus | null; queued: boolean }

export const SIGNED_OUT_EVENT = 'cashflow:signed-out';

export interface Passkey { id: string; name: string; backedUp: boolean; createdAt: number; lastUsedAt: number | null }

/** Turn WebAuthn's DOMExceptions into something a person can act on. */
function ceremonyError(e: unknown): Error {
  const name = (e as { name?: string })?.name;
  if (name === 'NotAllowedError') return new Error('Cancelled, or the passkey prompt timed out.');
  if (name === 'InvalidStateError') return new Error('This device already has a passkey for Cashflow.');
  if (name === 'SecurityError') return new Error('Passkeys need https or localhost. Open the app at its proper address.');
  return e instanceof Error ? e : new Error(String(e));
}

export const auth = {
  status: () => request<{ authenticated: boolean; hasPasskeys: boolean; demo: boolean }>('GET', '/api/auth/status'),
  async signIn() {
    const optionsJSON = await request<Parameters<typeof startAuthentication>[0]['optionsJSON']>('POST', '/api/auth/login/options', {});
    let response;
    try { response = await startAuthentication({ optionsJSON }); } catch (e) { throw ceremonyError(e); }
    await request('POST', '/api/auth/login/verify', { response });
  },
  async register(name: string, setupToken?: string) {
    const optionsJSON = await request<Parameters<typeof startRegistration>[0]['optionsJSON']>(
      'POST', '/api/auth/register/options', { name, ...(setupToken && { setupToken }) },
    );
    let response;
    try { response = await startRegistration({ optionsJSON }); } catch (e) { throw ceremonyError(e); }
    return request<{ passkey: Passkey }>('POST', '/api/auth/register/verify', { response });
  },
  signOut: () => request('POST', '/api/auth/logout', {}),
  signOutEverywhere: () => request('POST', '/api/auth/logout-all', {}),
  passkeys: () => request<Passkey[]>('GET', '/api/auth/passkeys'),
  removePasskey: (id: string) => request('DELETE', `/api/auth/passkeys/${encodeURIComponent(id)}`),
};

export type BillWithStats = Bill & { stats: EstimateStats };
export type TxnWithCategory = Transaction & { category: string };

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  // A lapsed session anywhere sends the app back to the sign-in screen.
  if (res.status === 401 && !url.startsWith('/api/auth/')) dispatchEvent(new Event(SIGNED_OUT_EVENT));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `Request failed (${res.status})`);
  return data as T;
}

const get = <T>(url: string) => request<T>('GET', url);

/** Sends a file's raw bytes (the spreadsheet import). */
async function upload<T>(url: string, file: File): Promise<T> {
  const res = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: file, credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) dispatchEvent(new Event(SIGNED_OUT_EVENT));
  if (res.status === 413) throw new Error('That file is too big (10 MB at most).');
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `Request failed (${res.status})`);
  return data as T;
}

/** Just the bill's own fields: the Bills page's rows also carry history stats, which the server rejects. */
const billBody = (b: Bill): Bill => ({
  code: b.code, name: b.name, category: b.category, direction: b.direction, active: b.active, schedule: b.schedule,
  amountMode: b.amountMode, amountCents: b.amountCents, minCents: b.minCents, notes: b.notes, sort: b.sort,
});

export const api = {
  forecast: () => get<{ forecast: Forecast; settings: Settings }>('/api/forecast'),
  bills: () => get<{ categories: string[]; bills: BillWithStats[] }>('/api/bills'),
  createBill: (b: Bill) => request('POST', '/api/bills', billBody(b)),
  updateBill: (b: Bill) => request('PUT', `/api/bills/${encodeURIComponent(b.code)}`, billBody(b)),
  confirm: (code: string, date: string, amountCents: number, note: string) =>
    request('POST', '/api/occurrences/confirm', { code, date, amountCents, note }),
  setOccurrenceNote: (code: string, period: string, note: string) =>
    request('PUT', '/api/occurrences/note', { code, period, note }),
  setTransactionNote: (id: number, note: string) => request('PATCH', `/api/transactions/${id}`, { note }),
  updateTransaction: (id: number, t: { date: string; amountCents: number; note: string }) =>
    request('PATCH', `/api/transactions/${id}`, t),
  setOverride: (code: string, period: string, amountCents: number | null) =>
    request('PUT', '/api/overrides', { code, period, amountCents }),
  transactions: (q: { from?: string; to?: string; code?: string; category?: string }) =>
    get<TxnWithCategory[]>(`/api/transactions?${new URLSearchParams(q as Record<string, string>)}`),
  addTransaction: (t: { date: string; code: string; amountCents: number; note?: string }) =>
    request('POST', '/api/transactions', t),
  deleteTransaction: (id: number) => request('DELETE', `/api/transactions/${id}`),
  planned: () => get<PlannedItem[]>('/api/planned'),
  addPlanned: (p: { date: string; code: string; amountCents: number; note?: string; status?: 'planned' | 'done'; adjustBalance?: boolean }) =>
    request('POST', '/api/planned', p),
  updatePlanned: (id: number, p: { date: string; code: string; amountCents: number; note?: string; status?: PlannedItem['status'] }) =>
    request('PUT', `/api/planned/${id}`, p),
  completePlanned: (id: number, date: string, amountCents: number) =>
    request('POST', `/api/planned/${id}/complete`, { date, amountCents }),
  deletePlanned: (id: number) => request('DELETE', `/api/planned/${id}`),
  snapshots: () => get<(Snapshot & { id: number })[]>('/api/snapshots'),
  addSnapshot: (s: Snapshot) => request('POST', '/api/snapshots', s),
  settings: () => get<Settings>('/api/settings'),
  saveSettings: (s: Partial<Settings>) => request<Settings>('PUT', '/api/settings', s),
  deployInfo: () => get<DeployInfo>('/api/admin/deploy'),
  requestDeploy: (action: 'check' | 'deploy') => request('POST', '/api/admin/deploy', { action }),
  restoreInfo: () => get<{ enabled: boolean; last: LastRestore | null }>('/api/admin/restore'),
  backups: () => get<BackupFile[]>('/api/admin/restore/backups'),
  checkBackup: (name: string, key: string) => request<BackupSummary>('POST', '/api/admin/restore/check', { name, key }),
  restoreBackup: (name: string) => request<{ restarting: true; savedAs: string }>('POST', '/api/admin/restore/apply', { name }),
  plaid: () => get<PlaidInfo>('/api/plaid'),
  plaidLinkToken: (itemId?: string) => request<{ linkToken: string }>('POST', '/api/plaid/link-token', itemId ? { itemId } : {}),
  plaidExchange: (publicToken: string, institution: { id: string; name: string }) =>
    request<{ itemId: string }>('POST', '/api/plaid/exchange', { publicToken, institution }),
  plaidRefresh: (itemId: string) => request('POST', `/api/plaid/items/${encodeURIComponent(itemId)}/refresh`, {}),
  importPreview: (file: File) => upload<ImportSummary>('/api/import/preview', file),
  importFile: (file: File) => upload<ImportSummary>('/api/import', file),
  setDemo: (on: boolean) => request<{ demo: boolean }>('POST', '/api/demo', { on }),
  bankBalances: () => get<BankBalances>('/api/plaid/balances'),
  bankReview: () => get<ReviewItem[]>('/api/bank-review'),
  fileBankItem: (id: string, code: string, note: string) =>
    request('POST', `/api/bank-review/${encodeURIComponent(id)}/assign`, { code, note }),
  dismissBankItem: (id: string) => request('POST', `/api/bank-review/${encodeURIComponent(id)}/dismiss`, {}),
  useBankBalance: (account: 'checking' | 'savings') => request('POST', '/api/plaid/use-balance', { account }),
  plaidSync: () => request<{ results: ItemSyncResult[] }>('POST', '/api/plaid/sync', {}),
  bankTransactions: (accountId: string) =>
    get<BankTransaction[]>(`/api/plaid/accounts/${encodeURIComponent(accountId)}/transactions?limit=25`),
  plaidRemove: (itemId: string) => request('DELETE', `/api/plaid/items/${encodeURIComponent(itemId)}`),
  plaidSetRole: (accountId: string, role: AccountRole) =>
    request('PUT', `/api/plaid/accounts/${encodeURIComponent(accountId)}`, { role }),
  plaidSetCardBill: (accountId: string, billCode: string | null) =>
    request('PUT', `/api/plaid/accounts/${encodeURIComponent(accountId)}`, { billCode }),
  report: (from: string, to: string) =>
    get<{ categories: { category: string; inCents: number; outCents: number; count: number }[] }>(
      `/api/reports?from=${from}&to=${to}`,
    ),
};
