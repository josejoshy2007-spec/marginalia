/**
 * Pure back-stack logic for the universal Back button (no React, no DOM).
 * `cur` is where the user is now; `back` holds earlier locations, oldest first.
 */
export type Nav<T> = { cur: T | null; back: T[] };

export const NAV_CAP = 50;

export const createNav = <T>(): Nav<T> => ({ cur: null, back: [] });

export const canGoBack = <T>(n: Nav<T>): boolean => n.back.length > 0;

/** Move to `loc`. The same location (by `key`) is not a navigation: the same Nav object comes back. */
export function pushLocation<T>(n: Nav<T>, loc: T, key: (l: T) => string, cap = NAV_CAP): Nav<T> {
  if (n.cur == null) return { cur: loc, back: [] };
  if (key(n.cur) === key(loc)) return n;
  const back = [...n.back, n.cur];
  return { cur: loc, back: back.length > cap ? back.slice(back.length - cap) : back };
}

/** Replace the current location without growing the stack (e.g. initial data loading). */
export const replaceLocation = <T>(n: Nav<T>, loc: T): Nav<T> => ({ cur: loc, back: n.back });

/** Step back `steps` locations (never past the oldest). Returns the same object when there is nowhere to go. */
export function goBack<T>(n: Nav<T>, steps = 1): Nav<T> {
  const k = Math.min(steps, n.back.length);
  if (k <= 0) return n;
  return { cur: n.back[n.back.length - k], back: n.back.slice(0, n.back.length - k) };
}

export type NavLoc = {
  mode: string;
  subjectId: number | null;
  readSourceId: number | null;
  askActiveId: string | null;
  focus: { sourceId: number; start: number; end: number; claim?: string } | null;
  /** Sub-view state reported by the mounted mode (Practice tab/open item, Summarise item, Library view…). */
  sub: Record<string, unknown>;
};

/** Identity of a location. Ignores the focus nonce, so re-clicking the same citation isn't a navigation. */
export const locKey = (l: NavLoc): string =>
  JSON.stringify([
    l.mode,
    l.subjectId,
    l.readSourceId,
    l.askActiveId,
    l.focus ? [l.focus.sourceId, l.focus.start, l.focus.end, l.focus.claim ?? ""] : null,
    Object.keys(l.sub).sort().map((k) => [k, l.sub[k]]),
  ]);

/** Ids that still exist. `sourceIds`/`threadIds` are given only when they are loaded for the location's subject. */
export type NavValid = { subjectIds: number[]; sourceIds?: number[]; threadIds?: string[] };

/** Drop references to a source or conversation that no longer exists (the location itself is kept). */
export function sanitizeLoc(l: NavLoc, v: NavValid): NavLoc {
  const srcOk = (id: number) => !v.sourceIds || v.sourceIds.includes(id);
  const focus = l.focus && srcOk(l.focus.sourceId) ? l.focus : null;
  return {
    ...l,
    focus,
    readSourceId: l.readSourceId != null && srcOk(l.readSourceId) ? l.readSourceId : null,
    askActiveId: l.askActiveId != null && (!v.threadIds || v.threadIds.includes(l.askActiveId)) ? l.askActiveId : null,
  };
}

/** Keep stepping back while the current location's subject was deleted (stops at the oldest entry). */
export function skipMissing(n: Nav<NavLoc>, subjectIds: number[]): Nav<NavLoc> {
  let m = n;
  while (m.cur && m.cur.subjectId != null && !subjectIds.includes(m.cur.subjectId) && m.back.length > 0) m = goBack(m);
  return m;
}

/**
 * Browser history and the app stack stay in step: the entry index equals `back.length`.
 * A new location pushes a browser entry, except the very first one and once the stack is at its cap
 * (the oldest app entry is dropped, so the browser entry is replaced instead of added).
 */
export const historyOp = <T>(before: Nav<T>, cap = NAV_CAP): "push" | "replace" =>
  before.cur == null || before.back.length >= cap ? "replace" : "push";
