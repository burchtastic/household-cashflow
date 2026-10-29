// Signs the app out after an hour without use, so balances don't sit on an unattended screen.
//
// The time of the last tap, key or scroll is shared between tabs through localStorage, so using
// one tab keeps the others (and the session they share) signed in. It also outlives a reload or a
// closed browser, so reopening the app later doesn't bring the numbers back up.
import { useEffect } from 'react';

export const IDLE_LIMIT_MS = 60 * 60 * 1000;

const KEY = 'cashflow:last-active';
const WRITE_EVERY_MS = 10_000;
const CHECK_EVERY_MS = 30_000;
const ACTIVITY = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'scroll', 'touchstart'];

function stored(): number {
  try { return Number(localStorage.getItem(KEY)) || 0; } catch { return 0; }
}

// Without a stored time (first visit, or storage blocked), the page load counts as use.
let lastActive = stored() || Date.now();
let lastWritten = 0;

export function markActive(): void {
  lastActive = Date.now();
  if (lastActive - lastWritten < WRITE_EVERY_MS) return;
  lastWritten = lastActive;
  try { localStorage.setItem(KEY, String(lastActive)); } catch { /* this tab still keeps its own time */ }
}

export function idleTooLong(): boolean {
  const now = Date.now();
  if (now - lastActive < IDLE_LIMIT_MS) return false;
  lastActive = Math.max(lastActive, stored()); // picks up use in other tabs
  return now - lastActive >= IDLE_LIMIT_MS;
}

/**
 * While signed in, calls onIdle once no tab has been used for IDLE_LIMIT_MS. Timers stall while
 * a device sleeps, so it also checks the moment the page is shown again.
 */
export function useIdleSignOut(signedIn: boolean, onIdle: () => void): void {
  useEffect(() => {
    if (!signedIn) return;
    let fired = false;
    const timeOut = () => {
      if (fired) return;
      fired = true;
      onIdle();
    };
    const check = () => { if (idleTooLong()) timeOut(); };
    // Use after the limit (moving the mouse to wake the screen, say) signs out rather than carrying on.
    const onUse = () => { if (idleTooLong()) timeOut(); else markActive(); };
    const onVisible = () => { if (document.visibilityState === 'visible') check(); };
    const opts = { capture: true, passive: true };
    for (const e of ACTIVITY) addEventListener(e, onUse, opts);
    document.addEventListener('visibilitychange', onVisible);
    addEventListener('focus', check);
    addEventListener('pageshow', check);
    const timer = setInterval(check, CHECK_EVERY_MS);
    return () => {
      for (const e of ACTIVITY) removeEventListener(e, onUse, opts);
      document.removeEventListener('visibilitychange', onVisible);
      removeEventListener('focus', check);
      removeEventListener('pageshow', check);
      clearInterval(timer);
    };
  }, [signedIn, onIdle]);
}
