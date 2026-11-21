"use client";

import { createContext, useContext, useEffect, useRef } from "react";

/**
 * Lets a mode report its sub-view (open deck/quiz/exam/summary, tab, view) to App's history stack
 * and have it put back when the student goes Back. Without a provider the hook does nothing.
 */
export type NavCtx = {
  setSub: (key: string, value: unknown) => void;
  /** Set only while App is restoring a location; the sub-view state to apply. */
  restore: { sub: Record<string, unknown> } | null;
};

export const NavContext = createContext<NavCtx | null>(null);

export function useNavSub<T>(key: string, value: T, setValue: (v: T) => void, exists?: (v: T) => Promise<boolean>) {
  const ctx = useContext(NavContext);
  const initial = useRef(value);
  const latest = useRef({ value, setValue, exists });
  latest.current = { value, setValue, exists };
  const restore = ctx?.restore;
  useEffect(() => {
    if (!restore) return;
    const want = (key in restore.sub ? restore.sub[key] : initial.current) as T;
    if (JSON.stringify(want) === JSON.stringify(latest.current.value)) return;
    const apply = (v: T) => JSON.stringify(v) !== JSON.stringify(latest.current.value) && latest.current.setValue(v);
    const check = want != null ? latest.current.exists : undefined;
    // A restored open item that was deleted meanwhile becomes "nothing open".
    if (check) check(want).then((ok) => apply(ok ? want : initial.current), () => apply(want));
    else apply(want);
  }, [restore, key]);
  const json = JSON.stringify(value);
  useEffect(() => {
    ctx?.setSub(key, JSON.parse(json));
  }, [ctx, key, json]);
  useEffect(() => () => ctx?.setSub(key, undefined), [ctx, key]);
}
