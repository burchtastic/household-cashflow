import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Read-only Plaid access. Plain fetch against the handful of endpoints we use, so there's
 * no SDK dependency tree to trust. Only Transactions and Liabilities are ever requested:
 * never Auth or Identity (account and routing numbers), never Transfer or Payments.
 */

export type PlaidEnv = 'sandbox' | 'production';

export interface PlaidConfig {
  env: PlaidEnv;
  clientId: string;
  secret: string;
  /** 32-byte AES key for access tokens at rest. */
  tokenKey: Buffer;
  /** OAuth banks return here. Must be registered in the Plaid Dashboard. */
  redirectUri?: string;
}

/** The Trial plan's lifetime cap. Removing an Item doesn't give its slot back. */
export const TRIAL_ITEM_LIMIT = 10;

/**
 * Reads the credentials file: KEY=VALUE lines. On the server it's a root-owned file handed
 * to the service by systemd (LoadCredential); locally, data/plaid.env. Absent means Plaid is off.
 */
export function loadPlaidConfig(env: NodeJS.ProcessEnv = process.env): PlaidConfig | undefined {
  const path = env.PLAID_CREDENTIALS
    ?? (env.CREDENTIALS_DIRECTORY ? join(env.CREDENTIALS_DIRECTORY, 'plaid.env') : 'data/plaid.env');
  let text: string;
  try { text = readFileSync(path, 'utf8'); } catch { return undefined; }
  const vars = parseEnvFile(text);
  const plaidEnv = vars.PLAID_ENV;
  if (plaidEnv !== 'sandbox' && plaidEnv !== 'production') throw new Error(`${path}: PLAID_ENV must be sandbox or production`);
  for (const k of ['PLAID_CLIENT_ID', 'PLAID_SECRET', 'PLAID_TOKEN_KEY']) {
    if (!vars[k]) throw new Error(`${path}: ${k} is missing`);
  }
  const tokenKey = Buffer.from(vars.PLAID_TOKEN_KEY, 'base64');
  if (tokenKey.length !== 32) throw new Error(`${path}: PLAID_TOKEN_KEY must be 32 bytes, base64 (openssl rand -base64 32)`);
  return {
    env: plaidEnv,
    clientId: vars.PLAID_CLIENT_ID,
    secret: vars.PLAID_SECRET,
    tokenKey,
    redirectUri: vars.PLAID_REDIRECT_URI || undefined,
  };
}

export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i <= 0) continue;
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

// ── Access tokens at rest ────────────────────────────────────────────────

/**
 * AES-256-GCM, bound to the Item id so a token can't be swapped onto another row.
 * Format: v1.<iv>.<tag>.<ciphertext>, base64url.
 */
export function sealToken(key: Buffer, itemId: string, token: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(itemId));
  const ct = Buffer.concat([c.update(token, 'utf8'), c.final()]);
  return ['v1', iv, c.getAuthTag(), ct].map((p) => (typeof p === 'string' ? p : p.toString('base64url'))).join('.');
}

export function openToken(key: Buffer, itemId: string, sealed: string): string {
  const [v, iv, tag, ct] = sealed.split('.');
  if (v !== 'v1' || !iv || !tag || ct === undefined) throw new Error('Unreadable access token');
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  d.setAAD(Buffer.from(itemId));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
}

// ── API ──────────────────────────────────────────────────────────────────

export class PlaidError extends Error {
  readonly code: string;
  readonly type: string;
  readonly status: number;
  constructor(status: number, body: { error_type?: string; error_code?: string; error_message?: string; display_message?: string | null }) {
    super(body.display_message || body.error_message || `Plaid request failed (${status})`);
    this.status = status;
    this.type = body.error_type ?? 'UNKNOWN';
    this.code = body.error_code ?? 'UNKNOWN';
  }
}

export interface PlaidAccount {
  account_id: string;
  name: string;
  official_name: string | null;
  mask: string | null;
  type: string;
  subtype: string | null;
  /** Dollars as floats, as Plaid sends them. Cached by Plaid, refreshed when it polls the bank. */
  balances: { available: number | null; current: number | null; iso_currency_code: string | null };
}

export interface PlaidTransaction {
  transaction_id: string;
  account_id: string;
  /** Dollars. Plaid's sign: positive is money leaving the account. */
  amount: number;
  iso_currency_code: string | null;
  date: string;
  authorized_date: string | null;
  name: string;
  merchant_name: string | null;
  pending: boolean;
  pending_transaction_id: string | null;
  personal_finance_category: { primary: string; detailed: string } | null;
}

/** A card's latest statement, from the Liabilities product. Dollars, as Plaid sends them. */
export interface PlaidCardLiability {
  account_id: string | null;
  last_statement_issue_date: string | null;
  last_statement_balance: number | null;
  minimum_payment_amount: number | null;
  next_payment_due_date: string | null;
  last_payment_amount: number | null;
  last_payment_date: string | null;
  is_overdue: boolean | null;
}

/** NOT_READY until Plaid's first pull from the bank finishes; HISTORICAL_UPDATE_COMPLETE once all history is in. */
export type UpdateStatus = 'NOT_READY' | 'INITIAL_UPDATE_COMPLETE' | 'HISTORICAL_UPDATE_COMPLETE';

export interface SyncPage {
  added: PlaidTransaction[];
  modified: PlaidTransaction[];
  removed: { transaction_id: string }[];
  nextCursor: string;
  hasMore: boolean;
  updateStatus: UpdateStatus;
}

/** What the server needs from Plaid. Tests swap in a fake. */
export interface PlaidApi {
  createLinkToken(o: { accessToken?: string }): Promise<string>;
  exchangePublicToken(publicToken: string): Promise<{ accessToken: string; itemId: string }>;
  getAccounts(accessToken: string): Promise<PlaidAccount[]>;
  removeItem(accessToken: string): Promise<void>;
  /** One page of changes since `cursor` ('' for everything). */
  syncTransactions(accessToken: string, cursor: string): Promise<SyncPage>;
  /** Credit card statements. */
  getCardLiabilities(accessToken: string): Promise<PlaidCardLiability[]>;
}

const HOSTS: Record<PlaidEnv, string> = {
  sandbox: 'https://sandbox.plaid.com',
  production: 'https://production.plaid.com',
};

export class PlaidClient implements PlaidApi {
  private readonly cfg: PlaidConfig;
  constructor(cfg: PlaidConfig) { this.cfg = cfg; }

  private async call<T>(path: string, body: object): Promise<T> {
    const res = await fetch(HOSTS[this.cfg.env] + path, {
      method: 'POST',
      // Credentials in headers, so they never sit in a body that might get logged.
      headers: {
        'content-type': 'application/json',
        'PLAID-CLIENT-ID': this.cfg.clientId,
        'PLAID-SECRET': this.cfg.secret,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const data = await res.json().catch(() => ({})) as T & object;
    if (!res.ok) throw new PlaidError(res.status, data);
    return data;
  }

  async createLinkToken({ accessToken }: { accessToken?: string }): Promise<string> {
    const body: Record<string, unknown> = {
      client_name: 'Cashflow',
      language: 'en',
      country_codes: ['US'],
      // One household, one Plaid user.
      user: { client_user_id: 'household' },
      ...(this.cfg.redirectUri && { redirect_uri: this.cfg.redirectUri }),
    };
    if (accessToken) {
      // Update mode: repairs a broken login without using another Item.
      body.access_token = accessToken;
    } else {
      body.products = ['transactions'];
      // Card statements where the bank supports them, without hiding banks that don't.
      body.required_if_supported_products = ['liabilities'];
      // History can only be set when linking, so ask for the most Plaid allows.
      body.transactions = { days_requested: 730 };
    }
    return (await this.call<{ link_token: string }>('/link/token/create', body)).link_token;
  }

  async exchangePublicToken(publicToken: string) {
    const r = await this.call<{ access_token: string; item_id: string }>('/item/public_token/exchange', { public_token: publicToken });
    return { accessToken: r.access_token, itemId: r.item_id };
  }

  async getAccounts(accessToken: string) {
    return (await this.call<{ accounts: PlaidAccount[] }>('/accounts/get', { access_token: accessToken })).accounts;
  }

  async removeItem(accessToken: string) {
    await this.call('/item/remove', { access_token: accessToken });
  }

  async getCardLiabilities(accessToken: string): Promise<PlaidCardLiability[]> {
    const r = await this.call<{ liabilities: { credit: PlaidCardLiability[] | null } }>('/liabilities/get', { access_token: accessToken });
    return r.liabilities.credit ?? [];
  }

  async syncTransactions(accessToken: string, cursor: string): Promise<SyncPage> {
    const r = await this.call<{
      added: PlaidTransaction[]; modified: PlaidTransaction[]; removed: { transaction_id: string }[];
      next_cursor: string; has_more: boolean; transactions_update_status: UpdateStatus;
    }>('/transactions/sync', { access_token: accessToken, count: 500, ...(cursor && { cursor }) });
    return {
      added: r.added, modified: r.modified, removed: r.removed,
      nextCursor: r.next_cursor, hasMore: r.has_more, updateStatus: r.transactions_update_status,
    };
  }
}
