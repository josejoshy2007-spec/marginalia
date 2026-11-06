/**
 * Dark/Light appearance. Dark is the default (tokens on :root in app/globals.css); light sets
 * data-theme="light" on <html>. The choice is a device setting (lib/local/settings.ts), mirrored to
 * localStorage so THEME_BOOTSTRAP can apply it before first paint, with no flash of the wrong theme.
 */
import { Capacitor, SystemBars, SystemBarsStyle } from "@capacitor/core";

export type Theme = "dark" | "light";
export const THEME_KEY = "marginalia.theme";

export const normalizeTheme = (v: unknown): Theme => (v === "light" ? "light" : "dark");

/** Inline <head> script (runs before React): applies a saved light theme; storage errors are ignored. */
export const THEME_BOOTSTRAP = `try{if(localStorage.getItem(${JSON.stringify(THEME_KEY)})==="light")document.documentElement.dataset.theme="light"}catch(e){}`;

export function applyTheme(t: Theme): void {
  const el = document.documentElement;
  if (t === "light") el.dataset.theme = "light";
  else delete el.dataset.theme;
  try {
    localStorage.setItem(THEME_KEY, t);
  } catch {}
  // Android draws the app edge-to-edge: status/navigation bar icons must contrast with the theme.
  if (Capacitor.isNativePlatform())
    SystemBars.setStyle({ style: t === "dark" ? SystemBarsStyle.Dark : SystemBarsStyle.Light }).catch(() => {});
}
