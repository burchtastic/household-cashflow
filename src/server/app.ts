import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import {
  CATEGORIES, estimateBill, forecast, isISODate, todayIn,
  type Bill, type PlannedItem, type Settings,
} from '../engine/index.ts';
import {
  deletePlanned, deleteTransaction, getBill, getPlanned, getSettings, insertPlanned, insertSnapshot,
  insertTransaction, listBills, listOccurrenceNotes, listOverrides, listPlanned, listSnapshots, listTransactions,
  putSettings, setOccurrenceNote, setOverride, tx, updatePlanned, updateTransaction, upsertBill, type DB,
  getPlaidItem, insertPlaidItem, listPlaidAccounts, listPlaidItems, markPlaidItemRemoved, setPlaidAccountRole,
  setPlaidItemStatus, upsertPlaidAccounts, type AccountRole, type PlaidItemRow,
  countBankTransactions, listBankTransactions, setPlaidAccountBill, linkBank, setBankHold, listBankHolds,
} from './db.ts';
import { defaultRole, Syncer, toAccountRow } from './sync.ts';
import { applyCardStatements, cardFloors, planCardStatements } from './statements.ts';
import { reconcile, reviewList } from './reconcile.ts';
import { DEMO_COOKIE, demoAccount, demoBankTransaction, demoReader, type Reader } from './demo.ts';
import {
  openToken, PlaidError, sealToken, TRIAL_ITEM_LIMIT, type PlaidAccount, type PlaidApi, type PlaidConfig,
} from './plaid.ts';
import { latestSnapshot } from './seedData.ts';
import {
  Auth, FLOW_COOKIE, RateLimiter, SESSION_COOKIE,
  type AuthConfig, type Verifiers,
} from './auth.ts';
import { deployState, readVersion, requestDeploy, type DeployConfig } from './deploy.ts';
import { applyImport, IMPORT_MAX_BYTES, ImportError, previewImport, type ImportPlan } from './importSheet.ts';
import { RestoreError, type Restorer } from './restore.ts';

export interface AppOptions {
  timeZone: string;
  auth: AuthConfig;
  staticDir?: string;
  /** Updating from the app; off when absent (see src/server/deploy.ts). */
  deploy?: DeployConfig;
  /** Read-only bank connections; off when absent (see src/server/plaid.ts). */
  plaid?: { config: PlaidConfig; api: PlaidApi };
  /** Pull from Plaid on this interval (off when absent, as in tests). "Sync now" works either way. */
  plaidSyncEveryMs?: number;
  /** Restoring from the off-site backups (src/server/restore.ts); `restart` ends this process so systemd starts it on the restored data. */
  restore?: { restorer: Restorer; restart: () => void };
  logger?: boolean;
  /** Tests only: stand-in authenticator checks and clock. */
  verifiers?: Verifiers;
  now?: () => number;
}

function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

/** __Host- cookies: Secure, Path=/, no Domain, so only this exact origin over HTTPS (or localhost) gets them. */
function cookie(name: string, value: string, maxAgeSeconds: number): string {
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeSeconds}`;
}

// ── JSON schemas ─────────────────────────────────────────────────────────

const date = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } as const;
const cents = { type: 'integer', minimum: 0, maximum: 100_000_000_00 } as const;
const code = { type: 'string', pattern: '^[A-Z0-9_]{1,12}$' } as const;
const text = (max: number) => ({ type: 'string', maxLength: max }) as const;
const direction = { type: 'string', enum: ['in', 'out'] } as const;

const scheduleSchema = {
  oneOf: [
    {
      type: 'object', additionalProperties: false, required: ['kind', 'day'],
      properties: { kind: { const: 'monthly' }, day: { type: 'integer', minimum: 1, maximum: 31 } },
    },
    {
      type: 'object', additionalProperties: false, required: ['kind', 'anchor', 'everyDays'],
      properties: { kind: { const: 'interval' }, anchor: date, everyDays: { type: 'integer', minimum: 1, maximum: 366 } },
    },
    { type: 'object', additionalProperties: false, required: ['kind'], properties: { kind: { const: 'none' } } },
  ],
} as const;

const billSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['code', 'name', 'category', 'direction', 'active', 'schedule', 'amountMode', 'amountCents', 'minCents', 'notes', 'sort'],
  properties: {
    code,
    name: { type: 'string', minLength: 1, maxLength: 80 },
    category: { type: 'string', enum: [...CATEGORIES] },
    direction,
    active: { type: 'boolean' },
    schedule: scheduleSchema,
    amountMode: { type: 'string', enum: ['fixed', 'auto'] },
    amountCents: cents,
    minCents: { anyOf: [cents, { type: 'null' }] },
    notes: text(500),
    sort: { type: 'integer', minimum: 0, maximum: 10_000 },
  },
} as const;

const plannedBody = {
  type: 'object',
  additionalProperties: false,
  required: ['date', 'code', 'amountCents'],
  properties: {
    date, code, amountCents: cents, note: text(200),
    status: { type: 'string', enum: ['planned', 'done', 'skipped'] },
    // New and done only: also take it out of (or add it to) the latest checking balance, which predates it.
    adjustBalance: { type: 'boolean' },
  },
} as const;
const period = { type: 'string', pattern: '^\\d{4}-\\d{2}(-\\d{2})?$' } as const;

const settingsSchema = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: {
    bufferFloorCents: cents,
    savingsFloorCents: cents,
    horizonDays: { type: 'integer', minimum: 7, maximum: 366 },
    lookbackDays: { type: 'integer', minimum: 30, maximum: 1100 },
    estimateMode: { type: 'string', enum: ['average', 'worst'] },
    topUpRoundingCents: { type: 'integer', minimum: 0, maximum: 1000_00 },
    savingsDrawCodes: { type: 'array', items: code, maxItems: 10 },
    bankCheckThresholdCents: cents,
  },
} as const;

const idParam = {
  type: 'object', required: ['id'], properties: { id: { type: 'integer', minimum: 1 } },
} as const;

export interface BankBalance {
  amountCents: number;
  /** The oldest of the accounts' fetch times. */
  fetchedAt: number;
  accounts: { name: string; mask: string; institution: string }[];
}

/** Real paths (not #routes) because Plaid's OAuth redirect URI can't contain a fragment. */
export const PLAID_PAGES = ['/connect', '/plaid-oauth'];
const PLAID_LINK_SCRIPT = 'https://cdn.plaid.com/link/v2/stable/link-initialize.js';

class HttpError extends Error {
  readonly statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

/** What the import screen shows: counts and the new items, not every transaction. */
function importSummary(p: ImportPlan) {
  const bill = (b: Bill) => ({ code: b.code, name: b.name, direction: b.direction, category: b.category, schedule: b.schedule, amountCents: b.amountCents, amountMode: b.amountMode });
  return {
    newBills: p.newBills.map(bill),
    newTypes: p.newTypes.map(bill),
    existingBills: p.existingBills,
    transactions: p.transactions.length,
    duplicateTransactions: p.duplicateTransactions,
    snapshots: p.snapshots,
    duplicateSnapshots: p.duplicateSnapshots,
    firstDate: p.firstDate,
    lastDate: p.lastDate,
    errors: p.errors.slice(0, 100),
    errorCount: p.errors.length,
    warnings: p.warnings.slice(0, 100),
  };
}
export type ImportSummary = ReturnType<typeof importSummary>;

// ── App ──────────────────────────────────────────────────────────────────

export function buildApp(db: DB, opts: AppOptions): FastifyInstance {
  const auth = new Auth(db, opts.auth, opts.verifiers, opts.now);
  const authLimiter = new RateLimiter(30, 60_000, opts.now);
  const app = Fastify({
    logger: opts.logger ? { level: 'info', redact: ['req.headers.cookie', 'req.headers.authorization'] } : false,
    bodyLimit: 64 * 1024,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: 'array', allErrors: false } },
  });

  const today = (q?: unknown) => {
    const t = (q as { today?: string } | undefined)?.today;
    if (t !== undefined) {
      if (!isISODate(t)) throw new HttpError(400, 'today must be YYYY-MM-DD');
      return t;
    }
    return todayIn(opts.timeZone);
  };

  /** The style nonce each bank-connection page was sent with (see the end of this function). */
  const styleNonces = new WeakMap<object, string>();

  // Security headers on every response.
  app.addHook('onSend', async (req, reply, payload) => {
    // Only the bank-connection pages may load Plaid Link (its script and its frame).
    const plaidPage = Boolean(opts.plaid) && PLAID_PAGES.includes(req.url.split('?')[0]);
    const nonce = styleNonces.get(req);
    reply.header('Content-Security-Policy', plaidPage
      ? `default-src 'self'; script-src 'self' ${PLAID_LINK_SCRIPT}; style-src 'self'${nonce ? ` 'nonce-${nonce}'` : ''}; img-src 'self' data:; ` +
        "frame-src https://cdn.plaid.com/; connect-src 'self' https://production.plaid.com/ https://sandbox.plaid.com/; " +
        "frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'"
      : "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
        "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'");
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'DENY');
    // Link opens bank sign-in pages in a pop-up and needs to keep its handle on them.
    reply.header('Cross-Origin-Opener-Policy', plaidPage ? 'same-origin-allow-popups' : 'same-origin');
    reply.header('Cross-Origin-Resource-Policy', 'same-origin');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    if (req.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
    return payload;
  });

  // Writes must be same-origin JSON. Browsers always send Origin on cross-site
  // POST/PUT/DELETE, so this blocks cross-site request forgery outright.
  app.addHook('onRequest', async (req) => {
    if (req.method === 'GET' || req.method === 'HEAD') return;
    const origin = req.headers.origin;
    if (origin !== undefined) {
      let host: string | null = null;
      try { host = new URL(origin).host; } catch { /* malformed */ }
      // Same host, or one of the configured origins (a proxy such as Tailscale Serve may rewrite Host).
      if (host !== req.headers.host && !opts.auth.origins.includes(origin)) {
        throw new HttpError(403, 'Cross-origin request refused');
      }
    }
    if (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(String(req.headers['sec-fetch-site']))) {
      throw new HttpError(403, 'Cross-site request refused');
    }
  });

  // Demo mode is read-only: disguised numbers must never be saved over real ones.
  app.addHook('onRequest', async (req) => {
    if (req.method === 'GET' || req.method === 'HEAD' || !isDemo(req)) return;
    const path = req.url.split('?')[0];
    if (path === '/api/demo' || path.startsWith('/api/auth/')) return;
    throw new HttpError(409, 'Demo mode is on, so nothing can be changed. Turn it off in Settings to make changes.');
  });

  // Everything under /api requires a session except sign-in itself and the health check.
  app.addHook('onRequest', async (req) => {
    const path = req.url.split('?')[0];
    if (!path.startsWith('/api/') || path === '/api/health') return;
    if (path.startsWith('/api/auth/')) {
      if (req.method !== 'GET' && !authLimiter.take()) throw new HttpError(429, 'Too many attempts. Wait a minute.');
      return;
    }
    if (!auth.checkSession(readCookie(req.headers.cookie, SESSION_COOKIE))) {
      throw new HttpError(401, 'Sign in required');
    }
  });

  app.setErrorHandler((err: Error & { statusCode?: number; validation?: unknown }, req, reply) => {
    const status = err.statusCode ?? 500;
    if (status >= 500) req.log.error(err);
    reply.status(status).send({
      // Our own errors (e.g. a bank connection failing) are written for the user; anything else stays vague.
      error: status >= 500 && !(err instanceof HttpError) ? 'Internal error' : err.message,
    });
  });

  const requireBill = (c: string): Bill => {
    const b = getBill(db, c);
    if (!b) throw new HttpError(400, `Unknown code ${c}`);
    return b;
  };

  // What the screens read: the database, or in demo mode (per browser) a disguised copy.
  const realReader: Reader = {
    settings: () => getSettings(db),
    bills: () => listBills(db),
    transactions: (from, to) => listTransactions(db, from, to),
    overrides: () => listOverrides(db),
    notes: () => listOccurrenceNotes(db),
    planned: () => listPlanned(db),
    snapshots: () => listSnapshots(db),
    cardFloors: () => (opts.plaid ? cardFloors(db, opts.plaid.config.env) : []),
  };
  const isDemo = (req: { headers: { cookie?: string } }) => readCookie(req.headers.cookie, DEMO_COOKIE) === '1';
  const reader = (req: { headers: { cookie?: string } }): Reader => (isDemo(req) ? demoReader(realReader) : realReader);

  const runForecast = (t: string, r: Reader) => {
    const snapshots = r.snapshots();
    const checking = latestSnapshot(snapshots, 'checking');
    if (!checking) throw new HttpError(409, 'Enter a checking balance first');
    return forecast({
      today: t,
      settings: r.settings(),
      bills: r.bills(),
      transactions: r.transactions(),
      overrides: r.overrides(),
      notes: r.notes(),
      planned: r.planned(),
      checking,
      savings: latestSnapshot(snapshots, 'savings'),
      cardFloors: r.cardFloors(),
    });
  };

  // ── Auth ───────────────────────────────────────────────────────────────

  const sessionOf = (req: { headers: { cookie?: string } }) => readCookie(req.headers.cookie, SESSION_COOKIE);
  const isSignedIn = (req: { headers: { cookie?: string } }) => auth.checkSession(sessionOf(req));
  const requireSignedIn = (req: { headers: { cookie?: string } }) => {
    if (!isSignedIn(req)) throw new HttpError(401, 'Sign in required');
  };
  const startSession = (reply: { header: (k: string, v: string[]) => unknown }) => {
    reply.header('set-cookie', [
      cookie(SESSION_COOKIE, auth.createSession(), Math.floor(opts.auth.sessionMaxMs / 1000)),
      cookie(FLOW_COOKIE, '', 0),
    ]);
  };
  const credentialBody = {
    type: 'object', required: ['response'], additionalProperties: false,
    properties: {
      response: {
        type: 'object', required: ['id', 'rawId', 'response', 'type'],
        properties: { id: { type: 'string', maxLength: 1024 }, type: { const: 'public-key' } },
      },
    },
  } as const;

  app.get('/api/auth/status', async (req) => ({
    authenticated: isSignedIn(req),
    hasPasskeys: auth.hasPasskeys(),
    demo: isDemo(req),
  }));

  // Demo mode, for this browser only. A cookie, so another device keeps the real numbers.
  app.post('/api/demo', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['on'], properties: { on: { type: 'boolean' } } } },
  }, async (req, reply) => {
    const { on } = req.body as { on: boolean };
    reply.header('set-cookie', cookie(DEMO_COOKIE, on ? '1' : '', on ? 30 * 24 * 3600 : 0));
    return { demo: on };
  });

  app.post('/api/auth/register/options', {
    schema: {
      body: {
        type: 'object', additionalProperties: false, required: ['name'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 60 },
          setupToken: { type: 'string', pattern: '^[A-Za-z0-9_-]{20,100}$' },
        },
      },
    },
  }, async (req, reply) => {
    const body = req.body as { name: string; setupToken?: string };
    const { options, flowId } = await auth.registrationOptions({
      authenticated: isSignedIn(req), setupToken: body.setupToken, name: body.name,
    });
    reply.header('set-cookie', cookie(FLOW_COOKIE, flowId, 300));
    return options;
  });

  app.post('/api/auth/register/verify', { schema: { body: credentialBody } }, async (req, reply) => {
    const { response } = req.body as { response: Parameters<Auth['finishRegistration']>[1] };
    const signedIn = isSignedIn(req);
    const passkey = await auth.finishRegistration(readCookie(req.headers.cookie, FLOW_COOKIE), response);
    if (signedIn) reply.header('set-cookie', cookie(FLOW_COOKIE, '', 0));
    else startSession(reply);
    return { passkey };
  });

  app.post('/api/auth/login/options', async (_req, reply) => {
    const { options, flowId } = await auth.loginOptions();
    reply.header('set-cookie', cookie(FLOW_COOKIE, flowId, 300));
    return options;
  });

  app.post('/api/auth/login/verify', { schema: { body: credentialBody } }, async (req, reply) => {
    const { response } = req.body as { response: Parameters<Auth['finishLogin']>[1] };
    await auth.finishLogin(readCookie(req.headers.cookie, FLOW_COOKIE), response);
    startSession(reply);
    return { ok: true };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    auth.endSession(sessionOf(req));
    reply.header('set-cookie', cookie(SESSION_COOKIE, '', 0));
    return { ok: true };
  });

  app.post('/api/auth/logout-all', async (req, reply) => {
    requireSignedIn(req);
    auth.endAllSessions();
    reply.header('set-cookie', cookie(SESSION_COOKIE, '', 0));
    return { ok: true };
  });

  app.get('/api/auth/passkeys', async (req) => {
    requireSignedIn(req);
    return auth.listPasskeys();
  });

  app.delete('/api/auth/passkeys/:id', {
    schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', maxLength: 1024 } } } },
  }, async (req) => {
    requireSignedIn(req);
    const result = auth.deletePasskey((req.params as { id: string }).id);
    if (result === 'not-found') throw new HttpError(404, 'Not found');
    if (result === 'last') throw new HttpError(409, "You can't remove your only passkey");
    return { ok: true };
  });

  // ── Forecast ───────────────────────────────────────────────────────────

  app.get('/api/forecast', async (req) => {
    const t = today(req.query);
    const r = reader(req);
    return { forecast: runForecast(t, r), settings: r.settings() };
  });

  // ── Bills ──────────────────────────────────────────────────────────────

  app.get('/api/bills', async (req) => {
    const t = today(req.query);
    const r = reader(req);
    const settings = r.settings();
    const txns = r.transactions();
    return {
      categories: CATEGORIES,
      bills: r.bills().map((b) => ({ ...b, stats: estimateBill(b, txns, t, settings) })),
    };
  });

  app.post('/api/bills', { schema: { body: billSchema } }, async (req, reply) => {
    const b = req.body as Bill;
    if (getBill(db, b.code)) throw new HttpError(409, `Code ${b.code} already exists`);
    upsertBill(db, b);
    reply.status(201);
    return b;
  });

  app.put('/api/bills/:code', {
    schema: { params: { type: 'object', properties: { code } }, body: billSchema },
  }, async (req) => {
    const { code: c } = req.params as { code: string };
    const b = req.body as Bill;
    if (b.code !== c) throw new HttpError(400, 'A bill code cannot change; create a new bill instead');
    requireBill(c);
    upsertBill(db, b);
    return b;
  });

  // ── Confirming recurring occurrences ───────────────────────────────────

  app.post('/api/occurrences/confirm', {
    schema: {
      body: {
        type: 'object', additionalProperties: false, required: ['code', 'date', 'amountCents'],
        properties: { code, date, amountCents: cents, note: text(200) },
      },
    },
  }, async (req, reply) => {
    const body = req.body as { code: string; date: string; amountCents: number; note?: string };
    if (!isISODate(body.date)) throw new HttpError(400, 'Invalid date');
    const b = requireBill(body.code);
    const id = insertTransaction(db, {
      date: body.date, code: b.code, description: b.name, direction: b.direction,
      amountCents: body.amountCents, source: 'manual', note: body.note ?? '', plannedId: null,
    });
    reply.status(201);
    return { id };
  });

  app.put('/api/occurrences/note', {
    schema: {
      body: {
        type: 'object', additionalProperties: false, required: ['code', 'period', 'note'],
        properties: { code, period, note: text(200) },
      },
    },
  }, async (req) => {
    const body = req.body as { code: string; period: string; note: string };
    requireBill(body.code);
    setOccurrenceNote(db, { ...body, note: body.note.trim() });
    return { ok: true };
  });

  app.put('/api/overrides', {
    schema: {
      body: {
        type: 'object', additionalProperties: false, required: ['code', 'period', 'amountCents'],
        properties: {
          code,
          period: { type: 'string', pattern: '^\\d{4}-\\d{2}(-\\d{2})?$' },
          amountCents: { anyOf: [cents, { type: 'null' }] },
        },
      },
    },
  }, async (req) => {
    const body = req.body as { code: string; period: string; amountCents: number | null };
    requireBill(body.code);
    setOverride(db, body);
    return { ok: true };
  });

  // ── Transactions ───────────────────────────────────────────────────────

  app.get('/api/transactions', {
    schema: {
      querystring: {
        type: 'object', additionalProperties: false,
        properties: { from: date, to: date, code, category: text(40) },
      },
    },
  }, async (req) => {
    const q = req.query as { from?: string; to?: string; code?: string; category?: string };
    const r = reader(req);
    const bills = new Map(r.bills().map((b) => [b.code, b]));
    return r.transactions(q.from, q.to)
      .map((t) => ({ ...t, category: bills.get(t.code)?.category ?? 'Uncategorized' }))
      .filter((t) => (!q.code || t.code === q.code) && (!q.category || t.category === q.category));
  });

  app.post('/api/transactions', {
    schema: {
      body: {
        type: 'object', additionalProperties: false, required: ['date', 'code', 'amountCents'],
        properties: { date, code, amountCents: cents, note: text(200), direction },
      },
    },
  }, async (req, reply) => {
    const body = req.body as { date: string; code: string; amountCents: number; note?: string; direction?: 'in' | 'out' };
    if (!isISODate(body.date)) throw new HttpError(400, 'Invalid date');
    const b = requireBill(body.code);
    const id = insertTransaction(db, {
      date: body.date, code: b.code, description: b.name, direction: body.direction ?? b.direction,
      amountCents: body.amountCents, source: 'manual', note: body.note ?? '', plannedId: null,
    });
    reply.status(201);
    return { id };
  });

  app.patch('/api/transactions/:id', {
    schema: {
      params: idParam,
      body: {
        type: 'object', additionalProperties: false, minProperties: 1,
        properties: { date, amountCents: cents, note: text(200) },
      },
    },
  }, async (req) => {
    const { id } = req.params as { id: number };
    const body = req.body as { date?: string; amountCents?: number; note?: string };
    if (body.date !== undefined && !isISODate(body.date)) throw new HttpError(400, 'Invalid date');
    const patch = { ...body, ...(body.note !== undefined && { note: body.note.trim() }) };
    if (!updateTransaction(db, id, patch)) throw new HttpError(404, 'Not found');
    return { ok: true };
  });

  app.delete('/api/transactions/:id', { schema: { params: idParam } }, async (req) => {
    const { id } = req.params as { id: number };
    if (!deleteTransaction(db, id)) throw new HttpError(404, 'Not found');
    return { ok: true };
  });

  // ── One-off planned items ──────────────────────────────────────────────

  app.get('/api/planned', async (req) => reader(req).planned());

  app.post('/api/planned', { schema: { body: plannedBody } }, async (req, reply) => {
    const body = req.body as {
      date: string; code: string; amountCents: number; note?: string; status?: PlannedItem['status']; adjustBalance?: boolean;
    };
    if (!isISODate(body.date)) throw new HttpError(400, 'Invalid date');
    if (body.status === 'skipped') throw new HttpError(400, 'New one-offs are planned or done');
    const checking = body.adjustBalance ? latestSnapshot(listSnapshots(db), 'checking') : null;
    if (body.adjustBalance && (body.status !== 'done' || !checking || body.date > checking.date)) {
      throw new HttpError(400, 'Only a done item dated on or before the latest checking balance can adjust it');
    }
    const b = requireBill(body.code);
    const item = {
      date: body.date, code: b.code, description: b.name, direction: b.direction,
      amountCents: body.amountCents, note: body.note ?? '',
    };
    // Logging something that already happened records its transaction in the same step.
    const id = tx(db, () => {
      const pid = insertPlanned(db, { ...item, status: body.status ?? 'planned' });
      if (body.status === 'done') insertTransaction(db, { ...item, source: 'manual', plannedId: pid });
      // The balance was entered before this was spent (or received), so it isn't in it yet.
      if (checking) {
        const delta = item.direction === 'in' ? item.amountCents : -item.amountCents;
        insertSnapshot(db, { account: 'checking', date: checking.date, amountCents: checking.amountCents + delta });
      }
      return pid;
    });
    reply.status(201);
    return { id };
  });

  app.put('/api/planned/:id', { schema: { params: idParam, body: plannedBody } }, async (req) => {
    const { id } = req.params as { id: number };
    const body = req.body as { date: string; code: string; amountCents: number; note?: string; status?: PlannedItem['status'] };
    if (!isISODate(body.date)) throw new HttpError(400, 'Invalid date');
    const existing = getPlanned(db, id);
    if (!existing) throw new HttpError(404, 'Not found');
    if (body.status === 'done' && existing.status !== 'done') {
      throw new HttpError(400, 'Use /complete to mark a one-off as done');
    }
    if (existing.status === 'done' && body.status !== undefined && body.status !== 'done') {
      throw new HttpError(400, 'Undo the transaction to put a done one-off back on the plan');
    }
    const b = requireBill(body.code);
    updatePlanned(db, {
      ...existing, date: body.date, code: b.code, description: b.name, direction: b.direction,
      amountCents: body.amountCents, note: body.note ?? existing.note, status: body.status ?? existing.status,
    });
    return { ok: true };
  });

  app.post('/api/planned/:id/complete', {
    schema: {
      params: idParam,
      body: {
        type: 'object', additionalProperties: false, required: ['date', 'amountCents'],
        properties: { date, amountCents: cents },
      },
    },
  }, async (req) => {
    const { id } = req.params as { id: number };
    const body = req.body as { date: string; amountCents: number };
    if (!isISODate(body.date)) throw new HttpError(400, 'Invalid date');
    const p = getPlanned(db, id);
    if (!p) throw new HttpError(404, 'Not found');
    if (p.status === 'done') throw new HttpError(409, 'Already done');
    tx(db, () => {
      insertTransaction(db, {
        date: body.date, code: p.code, description: p.description, direction: p.direction,
        amountCents: body.amountCents, source: 'manual', note: p.note, plannedId: p.id,
      });
      // The planned item takes the real date and amount, matching its transaction.
      updatePlanned(db, { ...p, date: body.date, amountCents: body.amountCents, status: 'done' });
    });
    return { ok: true };
  });

  app.delete('/api/planned/:id', { schema: { params: idParam } }, async (req) => {
    const { id } = req.params as { id: number };
    const p = getPlanned(db, id);
    if (!p) throw new HttpError(404, 'Not found');
    deletePlanned(db, id);
    return { ok: true };
  });

  // ── Balances & settings ────────────────────────────────────────────────

  app.get('/api/snapshots', async (req) => reader(req).snapshots());

  app.post('/api/snapshots', {
    schema: {
      body: {
        type: 'object', additionalProperties: false, required: ['account', 'date', 'amountCents'],
        properties: {
          account: { type: 'string', enum: ['checking', 'savings'] },
          date,
          // Checking can be overdrawn.
          amountCents: { type: 'integer', minimum: -100_000_000_00, maximum: 100_000_000_00 },
        },
      },
    },
  }, async (req, reply) => {
    const body = req.body as { account: 'checking' | 'savings'; date: string; amountCents: number };
    if (!isISODate(body.date)) throw new HttpError(400, 'Invalid date');
    if (body.date > todayIn(opts.timeZone)) throw new HttpError(400, 'A balance cannot be in the future');
    const id = insertSnapshot(db, body);
    reply.status(201);
    return { id };
  });

  app.get('/api/settings', async (req) => reader(req).settings());

  app.put('/api/settings', { schema: { body: settingsSchema } }, async (req) => {
    putSettings(db, req.body as Partial<Settings>);
    return getSettings(db);
  });

  // ── Reports ────────────────────────────────────────────────────────────

  app.get('/api/reports', {
    schema: {
      querystring: {
        type: 'object', additionalProperties: false, required: ['from', 'to'],
        properties: { from: date, to: date },
      },
    },
  }, async (req) => {
    const { from, to } = req.query as { from: string; to: string };
    const r = reader(req);
    const bills = new Map(r.bills().map((b) => [b.code, b]));
    const totals = new Map<string, { category: string; inCents: number; outCents: number; count: number }>();
    for (const t of r.transactions(from, to)) {
      const category = bills.get(t.code)?.category ?? 'Uncategorized';
      const row = totals.get(category) ?? { category, inCents: 0, outCents: 0, count: 0 };
      if (t.direction === 'in') row.inCents += t.amountCents;
      else row.outCents += t.amountCents;
      row.count++;
      totals.set(category, row);
    }
    return { from, to, categories: [...totals.values()].sort((a, b) => b.outCents - a.outCents) };
  });

  app.get('/api/health', async () => ({ ok: true }));

  // ── Import from the spreadsheet template ───────────────────────────────

  // The workbook arrives as raw bytes; only these two routes accept that, with a bigger limit.
  app.register(async (scope) => {
    scope.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: IMPORT_MAX_BYTES }, (_req, body, done) => done(null, body));
    const withFile = (fn: (file: Buffer) => ImportPlan) => async (req: { body: unknown }) => {
      if (!Buffer.isBuffer(req.body)) throw new HttpError(400, 'Send the .xlsx file');
      try { return importSummary(fn(req.body)); } catch (e) {
        if (e instanceof ImportError) throw new HttpError(400, e.message);
        throw e;
      }
    };
    scope.post('/api/import/preview', { bodyLimit: IMPORT_MAX_BYTES }, withFile((f) => previewImport(db, f)));
    scope.post('/api/import', { bodyLimit: IMPORT_MAX_BYTES }, withFile((f) => applyImport(db, f)));
  });

  // ── App updates ────────────────────────────────────────────────────────

  // What this process is running, fixed at startup.
  const running = opts.deploy ? readVersion(opts.deploy.versionFile) : null;
  const clock = opts.now ?? Date.now;

  app.get('/api/admin/deploy', async () => ({ running, ...deployState(opts.deploy, clock()) }));

  app.post('/api/admin/deploy', {
    schema: {
      body: {
        type: 'object', additionalProperties: false, required: ['action'],
        properties: { action: { type: 'string', enum: ['check', 'deploy'] } },
      },
    },
  }, async (req, reply) => {
    if (!opts.deploy || !deployState(opts.deploy, clock()).enabled) {
      throw new HttpError(404, 'Updating from the app is not set up on this server');
    }
    const { action } = req.body as { action: 'check' | 'deploy' };
    if (!requestDeploy(opts.deploy, action, clock())) throw new HttpError(409, 'An update is already running');
    reply.status(202);
    return { queued: action };
  });

  // ── Restore from the off-site backups ──────────────────────────────────

  const restore = opts.restore;
  // Each try at the key downloads a backup; a few a minute is plenty for a person.
  const keyLimiter = new RateLimiter(10, 60_000, opts.now);
  const backupName = { type: 'string', pattern: '^cashflow-[0-9a-z-]{1,60}\\.db$' } as const;
  const requireRestore = () => {
    if (!restore?.restorer.enabled()) throw new HttpError(404, 'Off-site backups are not set up on this server');
    return restore;
  };
  const restoring = async <T>(fn: () => T | Promise<T>): Promise<T> => {
    try { return await fn(); } catch (e) {
      if (e instanceof RestoreError) throw new HttpError(e.statusCode, e.message);
      throw e;
    }
  };
  let restartAfter: string | null = null;

  app.get('/api/admin/restore', async () => ({
    enabled: Boolean(restore?.restorer.enabled()),
    last: restore?.restorer.last() ?? null,
  }));

  app.get('/api/admin/restore/backups', async () => restoring(() => requireRestore().restorer.list()));

  app.post('/api/admin/restore/check', {
    schema: {
      body: {
        type: 'object', additionalProperties: false, required: ['name', 'key'],
        properties: { name: backupName, key: { type: 'string', minLength: 1, maxLength: 1024 } },
      },
    },
  }, async (req) => {
    const { restorer } = requireRestore();
    if (!keyLimiter.take()) throw new HttpError(429, 'Too many tries. Wait a minute.');
    const { name, key } = req.body as { name: string; key: string };
    return restoring(() => restorer.check(name, key));
  });

  app.post('/api/admin/restore/apply', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['name'], properties: { name: backupName } } },
    // Restart only once the reply has gone out.
    onResponse: async (req) => {
      if (restore && restartAfter === req.id) {
        restartAfter = null;
        restore.restart();
      }
    },
  }, async (req, reply) => {
    const { restorer } = requireRestore();
    const { name } = req.body as { name: string };
    const staged = await restoring(() => restorer.stage(db, name));
    restartAfter = req.id;
    reply.status(202);
    return { restarting: true, ...staged };
  });

  // ── Bank connections (Plaid, read-only) ────────────────────────────────

  const plaid = opts.plaid;
  const plaidId = { type: 'string', pattern: '^[A-Za-z0-9_-]{1,100}$' } as const;
  const itemParams = { type: 'object', required: ['itemId'], properties: { itemId: plaidId } } as const;
  const requirePlaid = () => {
    if (!plaid) throw new HttpError(404, 'Bank connections are not set up on this server');
    return plaid;
  };
  const liveItem = (itemId: string): PlaidItemRow => {
    const p = requirePlaid();
    const item = getPlaidItem(db, itemId);
    if (!item || item.status === 'removed') throw new HttpError(404, 'Not found');
    if (item.env !== p.config.env) throw new HttpError(409, `This connection was made in ${item.env}, not ${p.config.env}`);
    return item;
  };
  const tokenOf = (item: PlaidItemRow) => openToken(requirePlaid().config.tokenKey, item.itemId, item.accessTokenEnc);
  // Removed Items still count: the Trial never gives a slot back.
  const slotsUsed = () => listPlaidItems(db).filter((i) => i.env === 'production').length;

  /** Plaid's failures, recorded on the Item when they're about it. */
  const plaidFailure = (err: unknown, itemId?: string): never => {
    if (!(err instanceof PlaidError)) throw err;
    if (itemId && err.type === 'ITEM_ERROR') {
      setPlaidItemStatus(db, itemId, err.code === 'ITEM_LOGIN_REQUIRED' ? 'login_required' : 'error', err.message);
    }
    throw new HttpError(502, `${err.message} (${err.code})`);
  };
  const saveAccounts = (itemId: string, accounts: PlaidAccount[]) =>
    upsertPlaidAccounts(db, accounts.map((a) => toAccountRow(itemId, a, clock())), defaultRole);

  const syncer = plaid && new Syncer(db, plaid.config, plaid.api, opts.timeZone, clock);
  if (syncer && opts.plaidSyncEveryMs) {
    const every = opts.plaidSyncEveryMs;
    const runSync = () => {
      syncer.syncAll().then(
        (results) => {
          for (const r of results) {
            if (r.ok) app.log.info({ bank: r.institutionName, saved: r.saved, removed: r.removed }, 'bank sync');
            else app.log.warn({ bank: r.institutionName, error: r.error }, 'bank sync failed');
          }
        },
        (err: Error) => app.log.error(err, 'bank sync crashed'),
      );
    };
    // Soon after startup, then on the interval. unref: a pending sync never holds the process open.
    const first = setTimeout(runSync, 60_000);
    const timer = setInterval(runSync, every);
    first.unref();
    timer.unref();
    app.addHook('onClose', async () => { clearTimeout(first); clearInterval(timer); });
  }

  app.get('/api/plaid', async (req) => {
    if (!plaid) return { enabled: false };
    const demo = isDemo(req);
    const accounts = listPlaidAccounts(db);
    const counts = countBankTransactions(db);
    const { plans, problems } = planCardStatements(db, plaid.config.env);
    // What each card's statement did to the forecast.
    const statementFor = (accountId: string) => {
      const plan = plans.find((p) => p.accountIds.includes(accountId));
      const problem = problems.find((p) => p.accountId === accountId);
      return plan ? { ...plan, problem: null } : problem ? { problem: problem.message } : null;
    };
    return {
      enabled: true,
      env: plaid.config.env,
      slots: { used: slotsUsed(), limit: TRIAL_ITEM_LIMIT },
      syncEveryMs: opts.plaidSyncEveryMs ?? null,
      items: listPlaidItems(db)
        .filter((i) => i.status !== 'removed' && i.env === plaid.config.env)
        .map(({ accessTokenEnc: _, cursor: __, ...i }) => ({
          ...i,
          accounts: accounts
            .filter((a) => a.itemId === i.itemId)
            .map((a) => {
              const use = statementFor(a.accountId);
              const row = { ...a, transactionCount: counts.get(a.accountId) ?? 0, statementUse: use };
              if (!demo) return row;
              const shown = demoAccount(row);
              return use && use.problem === null ? { ...shown, statementUse: { ...use, amountCents: shown.statement?.balanceCents ?? 0 } } : shown;
            }),
        })),
    };
  });

  app.post('/api/plaid/sync', async () => {
    requirePlaid();
    return { results: await syncer!.syncAll() };
  });

  /** What the bank says checking and savings hold: the accounts given those roles, added up. */
  const bankBalances = () => {
    const p = requirePlaid();
    const items = new Map(listPlaidItems(db)
      .filter((i) => i.status !== 'removed' && i.env === p.config.env)
      .map((i) => [i.itemId, i]));
    const forRole = (role: 'checking' | 'savings'): BankBalance | null => {
      const accounts = listPlaidAccounts(db).filter((a) => a.role === role && items.has(a.itemId));
      // Available already has pending charges taken out (docs/PLAN.md: pending counts).
      const amounts = accounts.map((a) => a.availableCents ?? a.currentCents);
      if (!accounts.length || amounts.some((c) => c === null)) return null;
      return {
        amountCents: amounts.reduce((s: number, c) => s + c!, 0),
        fetchedAt: Math.min(...accounts.map((a) => a.balanceAt ?? 0)),
        accounts: accounts.map((a) => ({
          name: a.name, mask: a.mask, institution: items.get(a.itemId)!.institutionName,
        })),
      };
    };
    return { checking: forRole('checking'), savings: forRole('savings') };
  };

  // Demo shows no balance check: it would compare a disguised bank with a disguised ledger.
  app.get('/api/plaid/balances', async (req) => (
    !plaid ? { enabled: false } : isDemo(req) ? { enabled: true, checking: null, savings: null } : { enabled: true, ...bankBalances() }
  ));

  // Takes the bank's figure as today's balance: the same as typing it in, so anything dated
  // today or earlier is assumed to be in it.
  app.post('/api/plaid/use-balance', {
    schema: {
      body: {
        type: 'object', additionalProperties: false, required: ['account'],
        properties: { account: { type: 'string', enum: ['checking', 'savings'] } },
      },
    },
  }, async (req, reply) => {
    const { account } = req.body as { account: 'checking' | 'savings' };
    const bank = bankBalances()[account];
    if (!bank) throw new HttpError(409, `No bank account is set as ${account}`);
    const id = insertSnapshot(db, { account, date: today(req.query), amountCents: bank.amountCents });
    reply.status(201);
    return { id, amountCents: bank.amountCents };
  });

  // ── Checking activity that matched nothing ──────────────────────────────

  const reviewable = (id: string) => {
    const p = requirePlaid();
    const t = reviewList(db, p.config.env, opts.timeZone).find((r) => r.transactionId === id);
    if (!t) throw new HttpError(404, 'Not waiting for review');
    return t;
  };
  const reviewParams = { type: 'object', required: ['id'], properties: { id: plaidId } } as const;

  app.get('/api/bank-review', async (req) => {
    if (!plaid) return [];
    const holds = listBankHolds(db);
    const shown = isDemo(req) ? demoBankTransaction : <T>(t: T) => t;
    return reviewList(db, plaid.config.env, opts.timeZone).map(shown).map((t) => ({
      ...t,
      direction: t.amountCents > 0 ? 'out' : 'in',
      amountCents: Math.abs(t.amountCents),
      // A match was undone: say so, since it may look like it should have matched.
      undone: holds.get(t.transactionId) === 'review',
    }));
  });

  // Files it under a code: a bill payment, a savings transfer, or any other type. Off-schedule
  // types are one-offs, so those land on the One-offs page as done, like one logged there.
  app.post('/api/bank-review/:id/assign', {
    schema: {
      params: reviewParams,
      body: { type: 'object', additionalProperties: false, required: ['code'], properties: { code, note: text(200) } },
    },
  }, async (req, reply) => {
    const t = reviewable((req.params as { id: string }).id);
    const body = req.body as { code: string; note?: string };
    const b = requireBill(body.code);
    const id = tx(db, () => {
      const item = {
        date: t.date, code: b.code, description: b.name, direction: t.amountCents > 0 ? 'out' : 'in',
        amountCents: Math.abs(t.amountCents), note: body.note?.trim() ?? '',
      } as const;
      const plannedId = b.schedule.kind === 'none' ? insertPlanned(db, { ...item, status: 'done' }) : null;
      const ledgerId = insertTransaction(db, { ...item, source: 'plaid', plannedId });
      linkBank(db, ledgerId, t.transactionId);
      setBankHold(db, t.transactionId, null);
      return ledgerId;
    });
    reply.status(201);
    return { id };
  });

  app.post('/api/bank-review/:id/dismiss', { schema: { params: reviewParams } }, async (req) => {
    const t = reviewable((req.params as { id: string }).id);
    setBankHold(db, t.transactionId, 'dismissed');
    return { ok: true };
  });

  app.get('/api/plaid/accounts/:accountId/transactions', {
    schema: {
      params: { type: 'object', required: ['accountId'], properties: { accountId: plaidId } },
      querystring: {
        type: 'object', additionalProperties: false,
        properties: { limit: { type: 'integer', minimum: 1, maximum: 500 } },
      },
    },
  }, async (req) => {
    requirePlaid();
    const { accountId } = req.params as { accountId: string };
    if (!listPlaidAccounts(db).some((a) => a.accountId === accountId)) throw new HttpError(404, 'Not found');
    const txns = listBankTransactions(db, accountId, (req.query as { limit?: number }).limit ?? 25);
    return isDemo(req) ? txns.map(demoBankTransaction) : txns;
  });

  app.post('/api/plaid/link-token', {
    schema: { body: { type: 'object', additionalProperties: false, properties: { itemId: plaidId } } },
  }, async (req) => {
    const p = requirePlaid();
    const { itemId } = req.body as { itemId?: string };
    if (itemId) {
      // Update mode: repairs the login without using another slot.
      const item = liveItem(itemId);
      try { return { linkToken: await p.api.createLinkToken({ accessToken: tokenOf(item) }) }; } catch (e) { return plaidFailure(e, itemId); }
    }
    if (p.config.env === 'production' && slotsUsed() >= TRIAL_ITEM_LIMIT) {
      throw new HttpError(409, `All ${TRIAL_ITEM_LIMIT} Trial connections are used`);
    }
    try { return { linkToken: await p.api.createLinkToken({}) }; } catch (e) { return plaidFailure(e); }
  });

  app.post('/api/plaid/exchange', {
    schema: {
      body: {
        type: 'object', additionalProperties: false, required: ['publicToken', 'institution'],
        properties: {
          publicToken: { type: 'string', pattern: '^public-(sandbox|production)-[A-Za-z0-9-]{1,100}$' },
          institution: {
            type: 'object', additionalProperties: false, required: ['id', 'name'],
            properties: { id: { type: 'string', maxLength: 50 }, name: { type: 'string', minLength: 1, maxLength: 100 } },
          },
        },
      },
    },
  }, async (req, reply) => {
    const p = requirePlaid();
    const body = req.body as { publicToken: string; institution: { id: string; name: string } };
    let exchanged: { accessToken: string; itemId: string };
    try { exchanged = await p.api.exchangePublicToken(body.publicToken); } catch (e) { return plaidFailure(e); }
    if (getPlaidItem(db, exchanged.itemId)) throw new HttpError(409, 'That connection is already saved');
    insertPlaidItem(db, {
      itemId: exchanged.itemId, env: p.config.env, institutionId: body.institution.id,
      institutionName: body.institution.name,
      accessTokenEnc: sealToken(p.config.tokenKey, exchanged.itemId, exchanged.accessToken),
      createdAt: clock(),
    });
    // The connection is kept even if this fails; Refresh retries it.
    try {
      saveAccounts(exchanged.itemId, await p.api.getAccounts(exchanged.accessToken));
    } catch (e) {
      try { plaidFailure(e, exchanged.itemId); } catch { /* recorded on the Item */ }
    }
    reply.status(201);
    return { itemId: exchanged.itemId };
  });

  // After Link's update mode (or any time): check the login works and pick up new accounts.
  app.post('/api/plaid/items/:itemId/refresh', { schema: { params: itemParams } }, async (req) => {
    const p = requirePlaid();
    const item = liveItem((req.params as { itemId: string }).itemId);
    try { saveAccounts(item.itemId, await p.api.getAccounts(tokenOf(item))); } catch (e) { return plaidFailure(e, item.itemId); }
    setPlaidItemStatus(db, item.itemId, 'ok');
    return { ok: true };
  });

  app.put('/api/plaid/accounts/:accountId', {
    schema: {
      params: { type: 'object', required: ['accountId'], properties: { accountId: plaidId } },
      body: {
        type: 'object', additionalProperties: false, minProperties: 1,
        properties: {
          role: { type: 'string', enum: ['checking', 'savings', 'card', 'ignore'] },
          // The bill that pays this card; its statement becomes that bill's known amount.
          billCode: { anyOf: [code, { type: 'null' }] },
        },
      },
    },
  }, async (req) => {
    const p = requirePlaid();
    const { accountId } = req.params as { accountId: string };
    const body = req.body as { role?: AccountRole; billCode?: string | null };
    if (!listPlaidAccounts(db).some((a) => a.accountId === accountId)) throw new HttpError(404, 'Not found');
    if (body.billCode && requireBill(body.billCode).direction !== 'out') throw new HttpError(400, 'A card is paid by an outgoing bill');
    const before = planCardStatements(db, p.config.env).plans;
    tx(db, () => {
      if (body.role !== undefined) setPlaidAccountRole(db, accountId, body.role);
      if (body.billCode !== undefined) setPlaidAccountBill(db, accountId, body.billCode);
      applyCardStatements(db, p.config.env, before);
    });
    return { ok: true };
  });

  app.delete('/api/plaid/items/:itemId', { schema: { params: itemParams } }, async (req) => {
    const p = requirePlaid();
    const item = liveItem((req.params as { itemId: string }).itemId);
    try {
      await p.api.removeItem(tokenOf(item));
    } catch (e) {
      // Already gone at Plaid's end: just forget it here.
      if (!(e instanceof PlaidError && ['ITEM_NOT_FOUND', 'INVALID_ACCESS_TOKEN'].includes(e.code))) return plaidFailure(e, item.itemId);
    }
    markPlaidItemRemoved(db, item.itemId, clock());
    return { ok: true };
  });

  // ── Built front end ────────────────────────────────────────────────────

  if (opts.staticDir && existsSync(opts.staticDir)) {
    // Files are looked up per request, so a rebuild never needs a restart.
    const root = resolve(opts.staticDir);
    app.register(fastifyStatic, { root, dotfiles: 'deny' });
    // On phones, Link positions its frame with a <style> it adds to the page, which the CSP
    // only lets in by nonce. Each load gets a fresh one, for src/web/plaidLink.ts to hand on.
    if (opts.plaid) {
      for (const path of PLAID_PAGES) {
        app.get(path, (req, reply) => {
          const nonce = randomBytes(16).toString('base64');
          styleNonces.set(req, nonce);
          const html = readFileSync(join(root, 'index.html'), 'utf8')
            .replace('<head>', `<head>\n    <meta property="csp-nonce" nonce="${nonce}" />`);
          return reply.header('Cache-Control', 'no-store').type('text/html; charset=utf-8').send(html);
        });
      }
    }
    app.setNotFoundHandler((req, reply) => {
      const path = req.url.split('?')[0];
      // Page routes get the app shell; a missing asset must 404, never become HTML.
      if (req.method === 'GET' && !path.startsWith('/api/') && !/\.[a-z0-9]+$/i.test(path)) {
        return reply.sendFile('index.html');
      }
      reply.status(404).send({ error: 'Not found' });
    });
  }

  return app;
}
