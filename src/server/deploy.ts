import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Updating from the app. The app never runs the update itself: it drops a request file
 * saying "check" or "deploy", and a root systemd unit (deploy/cashflow-deploy.path) picks it
 * up, always fetches the main branch from GitHub, builds it as an unprivileged user, and swaps
 * it in. The app can't choose what code runs, only when. Progress comes back as a status file
 * the app can read but not write.
 */
export interface DeployConfig {
  /** Directory the app may write the request file into. */
  requestDir: string;
  /** Status written by deploy/self-update.sh (root-owned, read-only to the app). */
  statusFile: string;
  /** version.json beside the running code, written at build time. */
  versionFile: string;
}

export type DeployAction = 'check' | 'deploy';

export interface Version { commit: string; committedAt: string; subject: string }

export interface DeployStatus {
  state: 'running' | 'ok' | 'failed';
  action: DeployAction;
  startedAt: string;
  finishedAt?: string;
  step?: string;
  message?: string;
  latest?: Version;
  /** Commits on GitHub that the running copy doesn't have, newest first. */
  pending?: Version[];
  /** Set when the running commit (this one) has exactly the code of latest. */
  sameAs?: string;
  log?: string[];
}

/** A run that has said "running" this long has died (the unit's timeout is 20 minutes). */
const STALE_MS = 30 * 60_000;

function readJson<T>(path: string): T | null {
  try { return JSON.parse(readFileSync(path, 'utf8')) as T; } catch { return null; }
}

export function readVersion(path: string): Version | null {
  const v = readJson<Version>(path);
  return v && typeof v.commit === 'string' ? v : null;
}

export function deployState(cfg: DeployConfig | undefined, now: number) {
  if (!cfg || !existsSync(cfg.requestDir)) return { enabled: false as const, status: null, queued: false };
  const status = readJson<DeployStatus>(cfg.statusFile);
  const busy = status?.state === 'running' && now - Date.parse(status.startedAt) < STALE_MS;
  return {
    enabled: true as const,
    status: status && status.state === 'running' && !busy ? { ...status, state: 'failed' as const, message: 'The last run stopped without finishing.' } : status,
    queued: existsSync(join(cfg.requestDir, 'request')),
  };
}

/** Returns false when a run is already queued or in progress. */
export function requestDeploy(cfg: DeployConfig, action: DeployAction, now: number): boolean {
  const s = deployState(cfg, now);
  if (s.queued || s.status?.state === 'running') return false;
  writeFileSync(join(cfg.requestDir, 'request'), action, { mode: 0o600 });
  return true;
}
