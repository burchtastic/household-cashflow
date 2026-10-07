import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/server/app.ts';
import { openDb, type DB } from '../src/server/db.ts';
import {
  Auth, DEFAULT_SESSION, FLOW_COOKIE, SESSION_COOKIE, type AuthConfig, type Verifiers,
} from '../src/server/auth.ts';

const AUTH: AuthConfig = { rpID: 'localhost', rpName: 'Cashflow', origins: ['http://localhost:8787'], ...DEFAULT_SESSION };
const HOUR = 3_600_000;

// Stand-in authenticator: a response "signs" whatever challenge it carries in
// clientDataJSON, and verifies only if that matches the challenge the server issued.
const verifiers: Verifiers = {
  verifyRegistrationResponse: (async (o: { response: { id: string; response: { clientDataJSON: string } }; expectedChallenge: unknown }) => {
    if (o.response.response.clientDataJSON !== o.expectedChallenge) return { verified: false };
    return {
      verified: true,
      registrationInfo: {
        credential: { id: o.response.id, publicKey: new Uint8Array([1, 2, 3]), counter: 0, transports: ['internal'] },
        credentialBackedUp: true,
      },
    };
  }) as unknown as Verifiers['verifyRegistrationResponse'],
  verifyAuthenticationResponse: (async (o: { response: { response: { clientDataJSON: string } }; expectedChallenge: unknown; credential: { counter: number } }) => ({
    verified: o.response.response.clientDataJSON === o.expectedChallenge,
    authenticationInfo: { newCounter: o.credential.counter + 1 },
  })) as unknown as Verifiers['verifyAuthenticationResponse'],
};

const credential = (id: string, challenge: string) => ({
  response: { id, rawId: id, type: 'public-key', response: { clientDataJSON: challenge }, clientExtensionResults: {} },
});

let db: DB;
let app: FastifyInstance;
let clock: number;

beforeEach(() => {
  clock = Date.UTC(2026, 9, 6, 12);
  db = openDb(':memory:');
  app = buildApp(db, { timeZone: 'America/New_York', auth: AUTH, verifiers, now: () => clock });
});
afterEach(async () => {
  await app.close();
  db.close();
});

function cookiesFrom(res: LightMyRequestResponse): Record<string, string> {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return Object.fromEntries(list.map((c) => {
    const [pair] = c.split(';');
    const i = pair.indexOf('=');
    return [pair.slice(0, i), c];
  }));
}
const valueOf = (setCookie: string) => setCookie.split(';')[0].split('=').slice(1).join('=');

const post = (url: string, payload: object = {}, cookie = '') =>
  app.inject({ method: 'POST', url, payload, headers: { 'content-type': 'application/json', ...(cookie && { cookie }) } });

/** Enrol a passkey; returns the session cookie header value. */
async function enrol(opts: { token?: string; session?: string; id?: string; name?: string } = {}) {
  const optRes = await post('/api/auth/register/options', { name: opts.name ?? 'Laptop', ...(opts.token && { setupToken: opts.token }) }, opts.session);
  expect(optRes.statusCode).toBe(200);
  const flow = valueOf(cookiesFrom(optRes)[FLOW_COOKIE]);
  const cookie = [`${FLOW_COOKIE}=${flow}`, opts.session].filter(Boolean).join('; ');
  const verRes = await post('/api/auth/register/verify', credential(opts.id ?? 'cred-1', optRes.json().challenge), cookie);
  return { optRes, verRes };
}

async function login(id: string) {
  const optRes = await post('/api/auth/login/options');
  const flow = valueOf(cookiesFrom(optRes)[FLOW_COOKIE]);
  return post('/api/auth/login/verify', credential(id, optRes.json().challenge), `${FLOW_COOKIE}=${flow}`);
}

const sessionHeader = (res: LightMyRequestResponse) => `${SESSION_COOKIE}=${valueOf(cookiesFrom(res)[SESSION_COOKIE])}`;
const forecastWith = (cookie?: string) => app.inject({ url: '/api/settings', headers: cookie ? { cookie } : {} });

describe('the gate', () => {
  it('blocks the API without a session but allows health and status', async () => {
    expect((await forecastWith()).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/health' })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/auth/status' })).json()).toEqual({ authenticated: false, hasPasskeys: false, demo: false });
  });

  it('rejects a forged session cookie', async () => {
    expect((await forecastWith(`${SESSION_COOKIE}=not-a-real-session`)).statusCode).toBe(401);
  });
});

describe('first passkey', () => {
  it('cannot be enrolled without a setup link', async () => {
    expect((await post('/api/auth/register/options', { name: 'x' })).statusCode).toBe(403);
    expect((await post('/api/auth/register/options', { name: 'x', setupToken: 'A'.repeat(43) })).statusCode).toBe(403);
  });

  it('enrols with a setup link, signs in, and sets hardened cookies', async () => {
    const { token } = new Auth(db, AUTH, verifiers, () => clock).createSetupToken();
    const { optRes, verRes } = await enrol({ token });

    const flow = cookiesFrom(optRes)[FLOW_COOKIE];
    expect(flow).toMatch(/HttpOnly/);
    expect(flow).toMatch(/Secure/);
    expect(flow).toMatch(/SameSite=Strict/);

    expect(verRes.statusCode).toBe(200);
    const session = cookiesFrom(verRes)[SESSION_COOKIE];
    expect(session).toMatch(/^__Host-cf_session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; Secure; SameSite=Strict; Max-Age=604800$/);
    expect((await forecastWith(sessionHeader(verRes))).statusCode).toBe(200);
  });

  it('stores only hashes of session ids and setup tokens', async () => {
    const { token } = new Auth(db, AUTH, verifiers, () => clock).createSetupToken();
    const stored = db.prepare('SELECT token_hash FROM setup_tokens').get() as { token_hash: string };
    expect(stored.token_hash).not.toContain(token);
    const { verRes } = await enrol({ token });
    const sid = valueOf(cookiesFrom(verRes)[SESSION_COOKIE]);
    const rows = db.prepare('SELECT id_hash FROM sessions').all() as { id_hash: string }[];
    expect(rows.some((r) => r.id_hash === sid)).toBe(false);
  });

  it('a setup link works once', async () => {
    const { token } = new Auth(db, AUTH, verifiers, () => clock).createSetupToken();
    await enrol({ token });
    expect((await post('/api/auth/register/options', { name: 'again', setupToken: token })).statusCode).toBe(403);
  });

  it('a setup link expires after 15 minutes', async () => {
    const { token } = new Auth(db, AUTH, verifiers, () => clock).createSetupToken();
    clock += 15 * 60_000 + 1;
    expect((await post('/api/auth/register/options', { name: 'late', setupToken: token })).statusCode).toBe(403);
  });

  it('rejects a response to the wrong challenge', async () => {
    const { token } = new Auth(db, AUTH, verifiers, () => clock).createSetupToken();
    const optRes = await post('/api/auth/register/options', { name: 'x', setupToken: token });
    const flow = valueOf(cookiesFrom(optRes)[FLOW_COOKIE]);
    const res = await post('/api/auth/register/verify', credential('c', 'some-other-challenge'), `${FLOW_COOKIE}=${flow}`);
    expect(res.statusCode).toBe(400);
    expect(cookiesFrom(res)[SESSION_COOKIE]).toBeUndefined();
  });
});

describe('signing in', () => {
  beforeEach(async () => {
    const { token } = new Auth(db, AUTH, verifiers, () => clock).createSetupToken();
    await enrol({ token, id: 'cred-1' });
  });

  it('signs in with a registered passkey', async () => {
    const res = await login('cred-1');
    expect(res.statusCode).toBe(200);
    expect((await forecastWith(sessionHeader(res))).statusCode).toBe(200);
  });

  it('refuses an unknown passkey', async () => {
    expect((await login('someone-elses')).statusCode).toBe(401);
  });

  it('refuses a replayed sign-in', async () => {
    const optRes = await post('/api/auth/login/options');
    const flow = valueOf(cookiesFrom(optRes)[FLOW_COOKIE]);
    const body = credential('cred-1', optRes.json().challenge);
    expect((await post('/api/auth/login/verify', body, `${FLOW_COOKIE}=${flow}`)).statusCode).toBe(200);
    expect((await post('/api/auth/login/verify', body, `${FLOW_COOKIE}=${flow}`)).statusCode).toBe(400);
  });

  it('expires a session after 12 idle hours', async () => {
    const s = sessionHeader(await login('cred-1'));
    clock += 11 * HOUR;
    expect((await forecastWith(s)).statusCode).toBe(200);
    clock += 11 * HOUR; // active within the window, so still alive
    expect((await forecastWith(s)).statusCode).toBe(200);
    clock += 12 * HOUR + 1;
    expect((await forecastWith(s)).statusCode).toBe(401);
  });

  it('expires a session after 7 days even when active', async () => {
    const s = sessionHeader(await login('cred-1'));
    for (let h = 0; h < 7 * 24 - 6; h += 6) {
      clock += 6 * HOUR;
      expect((await forecastWith(s)).statusCode).toBe(200);
    }
    clock += 6 * HOUR;
    expect((await forecastWith(s)).statusCode).toBe(401);
  });

  it('signs out this session, or every session', async () => {
    const a = sessionHeader(await login('cred-1'));
    const b = sessionHeader(await login('cred-1'));
    await post('/api/auth/logout', {}, a);
    expect((await forecastWith(a)).statusCode).toBe(401);
    expect((await forecastWith(b)).statusCode).toBe(200);
    await post('/api/auth/logout-all', {}, b);
    expect((await forecastWith(b)).statusCode).toBe(401);
  });

  it('adds a second passkey while signed in, and never removes the last one', async () => {
    const s = sessionHeader(await login('cred-1'));
    const { verRes } = await enrol({ session: s, id: 'cred-2', name: 'Phone' });
    expect(verRes.statusCode).toBe(200);
    const keys = (await app.inject({ url: '/api/auth/passkeys', headers: { cookie: s } })).json();
    expect(keys.map((k: { name: string }) => k.name)).toEqual(['Laptop', 'Phone']);

    const del = (id: string) => app.inject({ method: 'DELETE', url: `/api/auth/passkeys/${id}`, headers: { cookie: s } });
    expect((await del('cred-1')).statusCode).toBe(200);
    expect((await del('cred-2')).statusCode).toBe(409);
  });

  it('needs a session to list or remove passkeys', async () => {
    expect((await app.inject({ url: '/api/auth/passkeys' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'DELETE', url: '/api/auth/passkeys/cred-1' })).statusCode).toBe(401);
  });
});

describe('rate limiting', () => {
  it('limits sign-in attempts to 30 a minute', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 31; i++) codes.push((await post('/api/auth/login/options')).statusCode);
    expect(codes.slice(0, 30).every((c) => c === 200)).toBe(true);
    expect(codes[30]).toBe(429);
    clock += 60_000;
    expect((await post('/api/auth/login/options')).statusCode).toBe(200);
  });
});
