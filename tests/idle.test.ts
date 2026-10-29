import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const HOUR = 60 * 60 * 1000;
const KEY = 'cashflow:last-active';
const T0 = new Date('2026-10-18T09:00:00Z').getTime();

let store: Map<string, string>;

/** A fresh copy of the module, as a page load would get, reading `store` as its localStorage. */
const load = async () => {
  vi.resetModules();
  return import('../src/web/idle.ts');
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  store = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('idle sign-out', () => {
  it('times out an hour after the last use, not before', async () => {
    const idle = await load();
    idle.markActive();
    vi.setSystemTime(T0 + HOUR - 1);
    expect(idle.idleTooLong()).toBe(false);
    vi.setSystemTime(T0 + HOUR);
    expect(idle.idleTooLong()).toBe(true);
  });

  it('counts use in another tab', async () => {
    const idle = await load();
    idle.markActive();
    store.set(KEY, String(T0 + 50 * 60 * 1000)); // the other tab, 50 minutes in
    vi.setSystemTime(T0 + HOUR + 1);
    expect(idle.idleTooLong()).toBe(false);
    vi.setSystemTime(T0 + 50 * 60 * 1000 + HOUR);
    expect(idle.idleTooLong()).toBe(true);
  });

  it('times out at once when the app is reopened more than an hour after its last use', async () => {
    store.set(KEY, String(T0 - 2 * HOUR));
    const idle = await load();
    expect(idle.idleTooLong()).toBe(true);
  });

  it('counts the page load as use when nothing is stored', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
    });
    const idle = await load();
    vi.setSystemTime(T0 + HOUR - 1);
    expect(idle.idleTooLong()).toBe(false);
    vi.setSystemTime(T0 + HOUR);
    expect(idle.idleTooLong()).toBe(true);
  });

  it('writes the shared time at most every 10 seconds but keeps its own exact', async () => {
    const idle = await load();
    idle.markActive();
    vi.setSystemTime(T0 + 5_000);
    idle.markActive();
    expect(store.get(KEY)).toBe(String(T0));
    vi.setSystemTime(T0 + 5_000 + HOUR - 1);
    expect(idle.idleTooLong()).toBe(false);
  });
});
