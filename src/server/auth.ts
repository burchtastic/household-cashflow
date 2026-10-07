// Passkey (WebAuthn) authentication and server-side sessions.
//
// - One household user; any registered passkey signs in.
// - The first passkey (and recovery, if all are lost) requires a one-time setup
//   token that can only be minted from a shell on the server (npm run setup-token).
// - Session ids and setup tokens are random 256-bit values; only their SHA-256
//   hashes are stored, so a copy of the database cannot be used to sign in.
import { createHash, randomBytes } from 'node:crypto';
import {
  generateAuthenticationOptions, generateRegistrationOptions,
  verifyAuthenticationResponse, verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON, type WebAuthnCredential,
} from '@simplewebauthn/server';
import type { DB } from './db.ts';

export const SESSION_COOKIE = '__Host-cf_session';
export const FLOW_COOKIE = '__Host-cf_flow';

export interface AuthConfig {
  rpID: string;
  rpName: string;
  /** Exact origins the browser may present, e.g. https://cashflow.tail1234.ts.net */
  origins: string[];
  sessionIdleMs: number;
  sessionMaxMs: number;
}

export const DEFAULT_SESSION = {
  sessionIdleMs: 12 * 60 * 60 * 1000,      // 12 hours without use
  sessionMaxMs: 7 * 24 * 60 * 60 * 1000,   // 7 days regardless
};

/** Indirection so tests can stand in for a real authenticator. */
export interface Verifiers {
  verifyRegistrationResponse: typeof verifyRegistrationResponse;
  verifyAuthenticationResponse: typeof verifyAuthenticationResponse;
}
export const realVerifiers: Verifiers = { verifyRegistrationResponse, verifyAuthenticationResponse };

const FLOW_TTL_MS = 5 * 60 * 1000;
const SETUP_TTL_MS = 15 * 60 * 1000;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const token = () => randomBytes(32).toString('base64url');

export interface Passkey {
  id: string;
  name: string;
  backedUp: boolean;
  createdAt: number;
  lastUsedAt: number | null;
}

interface Flow {
  kind: 'register' | 'login';
  challenge: string;
  expires: number;
  /** Hash of the setup token that authorised this registration, consumed on success. */
  setupTokenHash: string | null;
  name: string;
}

export class Auth {
  private readonly flows = new Map<string, Flow>();
  private readonly db: DB;
  private readonly cfg: AuthConfig;
  private readonly verifiers: Verifiers;
  private readonly now: () => number;

  constructor(db: DB, cfg: AuthConfig, verifiers: Verifiers = realVerifiers, now: () => number = Date.now) {
    this.db = db;
    this.cfg = cfg;
    this.verifiers = verifiers;
    this.now = now;
  }

  // ── Setup tokens ───────────────────────────────────────────────────────

  createSetupToken(): { token: string; expiresAt: number } {
    const t = token();
    const expiresAt = this.now() + SETUP_TTL_MS;
    this.db.prepare('DELETE FROM setup_tokens WHERE expires_at < ?').run(this.now());
    this.db.prepare('INSERT INTO setup_tokens (token_hash, expires_at) VALUES (?, ?)').run(sha256(t), expiresAt);
    return { token: t, expiresAt };
  }

  private validSetupTokenHash(t: string | undefined): string | null {
    if (!t) return null;
    const h = sha256(t);
    const row = this.db.prepare('SELECT expires_at FROM setup_tokens WHERE token_hash = ?').get(h) as
      { expires_at: number } | undefined;
    return row && row.expires_at > this.now() ? h : null;
  }

  // ── Sessions ───────────────────────────────────────────────────────────

  createSession(): string {
    const id = token();
    const now = this.now();
    this.db.prepare('DELETE FROM sessions WHERE expires_at < ? OR last_seen_at < ?')
      .run(now, now - this.cfg.sessionIdleMs);
    this.db.prepare('INSERT INTO sessions (id_hash, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(sha256(id), now, now, now + this.cfg.sessionMaxMs);
    return id;
  }

  /** True if the session is live; slides its idle timer. */
  checkSession(id: string | undefined): boolean {
    if (!id) return false;
    const h = sha256(id);
    const row = this.db.prepare('SELECT last_seen_at, expires_at FROM sessions WHERE id_hash = ?').get(h) as
      { last_seen_at: number; expires_at: number } | undefined;
    const now = this.now();
    if (!row) return false;
    if (row.expires_at <= now || row.last_seen_at + this.cfg.sessionIdleMs <= now) {
      this.db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(h);
      return false;
    }
    // Only write when it matters, to keep reads cheap.
    if (now - row.last_seen_at > 60_000) {
      this.db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id_hash = ?').run(now, h);
    }
    return true;
  }

  endSession(id: string | undefined): void {
    if (id) this.db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(sha256(id));
  }

  endAllSessions(): void {
    this.db.exec('DELETE FROM sessions');
  }

  // ── Passkeys ───────────────────────────────────────────────────────────

  listPasskeys(): Passkey[] {
    return (this.db.prepare('SELECT id, name, backed_up, created_at, last_used_at FROM passkeys ORDER BY created_at').all() as
      { id: string; name: string; backed_up: number; created_at: number; last_used_at: number | null }[])
      .map((r) => ({ id: r.id, name: r.name, backedUp: r.backed_up === 1, createdAt: r.created_at, lastUsedAt: r.last_used_at }));
  }

  hasPasskeys(): boolean {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM passkeys').get() as { n: number }).n > 0;
  }

  deletePasskey(id: string): 'ok' | 'not-found' | 'last' {
    const n = (this.db.prepare('SELECT COUNT(*) AS n FROM passkeys').get() as { n: number }).n;
    const exists = this.db.prepare('SELECT 1 FROM passkeys WHERE id = ?').get(id);
    if (!exists) return 'not-found';
    if (n <= 1) return 'last';
    this.db.prepare('DELETE FROM passkeys WHERE id = ?').run(id);
    return 'ok';
  }

  private getCredential(id: string): WebAuthnCredential | null {
    const r = this.db.prepare('SELECT id, public_key, counter, transports FROM passkeys WHERE id = ?').get(id) as
      { id: string; public_key: Uint8Array; counter: number; transports: string } | undefined;
    if (!r) return null;
    return {
      id: r.id,
      publicKey: new Uint8Array(r.public_key),
      counter: r.counter,
      transports: JSON.parse(r.transports) as string[],
    };
  }

  private userId(): Uint8Array<ArrayBuffer> {
    const row = this.db.prepare("SELECT value FROM auth_meta WHERE key = 'user_id'").get() as { value: string } | undefined;
    if (row) return new Uint8Array(Buffer.from(row.value, 'base64url'));
    const id = randomBytes(32);
    this.db.prepare("INSERT INTO auth_meta (key, value) VALUES ('user_id', ?)").run(id.toString('base64url'));
    return new Uint8Array(id);
  }

  // ── Ceremonies ─────────────────────────────────────────────────────────

  private startFlow(flow: Omit<Flow, 'expires'>): string {
    const now = this.now();
    for (const [k, f] of this.flows) if (f.expires < now) this.flows.delete(k);
    if (this.flows.size > 100) throw new AuthError(429, 'Too many sign-in attempts in progress');
    const id = token();
    this.flows.set(id, { ...flow, expires: now + FLOW_TTL_MS });
    return id;
  }

  /** Each flow can be finished exactly once. */
  private takeFlow(id: string | undefined, kind: Flow['kind']): Flow {
    const f = id ? this.flows.get(id) : undefined;
    if (id) this.flows.delete(id);
    if (!f || f.kind !== kind || f.expires < this.now()) throw new AuthError(400, 'Sign-in expired. Try again.');
    return f;
  }

  /** Registration is allowed for a signed-in user, or with a valid setup token. */
  async registrationOptions(opts: { authenticated: boolean; setupToken?: string; name: string }) {
    const setupTokenHash = this.validSetupTokenHash(opts.setupToken);
    if (!opts.authenticated && !setupTokenHash) {
      throw new AuthError(403, 'A setup link is required to add the first passkey');
    }
    const existing = this.listPasskeys().map((p) => ({ id: p.id }));
    const options = await generateRegistrationOptions({
      rpName: this.cfg.rpName,
      rpID: this.cfg.rpID,
      userName: 'household',
      userDisplayName: 'Cashflow',
      userID: this.userId(),
      attestationType: 'none',
      excludeCredentials: existing,
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    });
    const flowId = this.startFlow({ kind: 'register', challenge: options.challenge, setupTokenHash, name: opts.name });
    return { options, flowId };
  }

  async finishRegistration(flowId: string | undefined, response: RegistrationResponseJSON): Promise<Passkey> {
    const flow = this.takeFlow(flowId, 'register');
    let result;
    try {
      result = await this.verifiers.verifyRegistrationResponse({
        response,
        expectedChallenge: flow.challenge,
        expectedOrigin: this.cfg.origins,
        expectedRPID: this.cfg.rpID,
        requireUserVerification: true,
      });
    } catch {
      throw new AuthError(400, 'Passkey could not be verified');
    }
    if (!result.verified) throw new AuthError(400, 'Passkey could not be verified');

    const { credential, credentialBackedUp } = result.registrationInfo;
    const now = this.now();
    const run = () => {
      if (flow.setupTokenHash) {
        // Single use: a second registration with the same link fails here.
        const del = this.db.prepare('DELETE FROM setup_tokens WHERE token_hash = ? AND expires_at > ?')
          .run(flow.setupTokenHash, now);
        if (del.changes !== 1) throw new AuthError(403, 'This setup link has already been used or expired');
      }
      this.db.prepare(`
        INSERT INTO passkeys (id, public_key, counter, transports, name, backed_up, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(credential.id, credential.publicKey, credential.counter, JSON.stringify(credential.transports ?? []),
        flow.name, credentialBackedUp ? 1 : 0, now);
    };
    this.db.exec('BEGIN IMMEDIATE');
    try { run(); this.db.exec('COMMIT'); } catch (e) { this.db.exec('ROLLBACK'); throw e; }

    return this.listPasskeys().find((p) => p.id === credential.id)!;
  }

  async loginOptions() {
    // Empty allowCredentials: the browser offers any passkey it has for this site.
    const options = await generateAuthenticationOptions({ rpID: this.cfg.rpID, userVerification: 'required' });
    const flowId = this.startFlow({ kind: 'login', challenge: options.challenge, setupTokenHash: null, name: '' });
    return { options, flowId };
  }

  async finishLogin(flowId: string | undefined, response: AuthenticationResponseJSON): Promise<void> {
    const flow = this.takeFlow(flowId, 'login');
    const credential = this.getCredential(response.id);
    if (!credential) throw new AuthError(401, 'This passkey is not registered here');
    let result;
    try {
      result = await this.verifiers.verifyAuthenticationResponse({
        response,
        expectedChallenge: flow.challenge,
        expectedOrigin: this.cfg.origins,
        expectedRPID: this.cfg.rpID,
        credential,
        requireUserVerification: true,
      });
    } catch {
      throw new AuthError(401, 'Sign-in failed');
    }
    if (!result.verified) throw new AuthError(401, 'Sign-in failed');
    this.db.prepare('UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ?')
      .run(result.authenticationInfo.newCounter, this.now(), credential.id);
  }
}

export class AuthError extends Error {
  readonly statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

/** A fixed-window limiter for the unauthenticated auth endpoints. */
export class RateLimiter {
  private windowStart = 0;
  private count = 0;
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  constructor(limit: number, windowMs: number, now: () => number = Date.now) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
  }
  take(): boolean {
    const t = this.now();
    if (t - this.windowStart >= this.windowMs) { this.windowStart = t; this.count = 0; }
    return ++this.count <= this.limit;
  }
}
