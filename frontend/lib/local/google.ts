/**
 * Google sign-in for Drive sync, asking only for the `drive.appdata` scope: a hidden folder in the
 * student's own Drive that only this app can see. Android uses the native account sheet
 * (Credential Manager via @capgo/capacitor-social-login, renewed silently afterwards); browsers use
 * Google Identity Services' token client. Tokens live in memory only (about an hour).
 */
import { Capacitor } from "@capacitor/core";

export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.appdata";
/** The OAuth "Web application" client id from Google Cloud (public; not a secret). */
export const GOOGLE_CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ?? "";

export class AuthNeeded extends Error {
  constructor(message = "Sign in to Google again to keep syncing.") {
    super(message);
  }
}

let token: { value: string; expires: number } | null = null;
const valid = () => !!token && token.expires - Date.now() > 60_000;

export const syncConfigured = () => !!GOOGLE_CLIENT_ID;

// ---------------------------------------------------------------- Android

let nativeReady: Promise<typeof import("@capgo/capacitor-social-login")> | null = null;
function native() {
  nativeReady ??= import("@capgo/capacitor-social-login").then(async (m) => {
    await m.SocialLogin.initialize({ google: { webClientId: GOOGLE_CLIENT_ID, mode: "online" } });
    return m;
  });
  return nativeReady;
}

async function nativeToken(interactive: boolean): Promise<string> {
  const { SocialLogin } = await native();
  const fromSession = async () => {
    const r = await SocialLogin.getAuthorizationCode({ provider: "google" });
    if (!r.accessToken) throw new AuthNeeded();
    return r.accessToken;
  };
  try {
    return await fromSession();
  } catch {}
  try {
    await SocialLogin.refresh({ provider: "google", options: { scopes: [DRIVE_SCOPE] } });
    return await fromSession();
  } catch {}
  if (!interactive) throw new AuthNeeded();
  const res = await SocialLogin.login({ provider: "google", options: { scopes: [DRIVE_SCOPE] } });
  const r = res.result as { accessToken?: { token?: string } | null };
  if (!r.accessToken?.token) throw new Error("Google didn't grant Drive access. Try again and allow it.");
  return r.accessToken.token;
}

// ---------------------------------------------------------------- browser

type TokenResponse = { access_token?: string; expires_in?: number; error?: string; error_description?: string };
type TokenClient = { requestAccessToken: (o?: { prompt?: string }) => void; callback: (r: TokenResponse) => void };
declare global {
  interface Window {
    google?: { accounts: { oauth2: { initTokenClient: (c: Record<string, unknown>) => TokenClient; revoke: (t: string, cb?: () => void) => void } } };
  }
}

let gis: Promise<void> | null = null;
function loadGis() {
  gis ??= new Promise<void>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client";
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => {
      gis = null;
      reject(new Error("Couldn't load Google sign-in. Check your internet connection."));
    };
    document.head.appendChild(s);
  });
  return gis;
}

let tokenClient: TokenClient | null = null;
let waiting: { resolve: (t: { value: string; expiresIn: number }) => void; reject: (e: Error) => void } | null = null;

/**
 * Load Google's sign-in code ahead of time (when Settings opens). Browsers only allow the sign-in
 * window to open straight from a tap, so nothing slow may run between the tap and the request.
 */
export function prepareSignIn(): Promise<void> {
  if (!GOOGLE_CLIENT_ID || Capacitor.isNativePlatform()) return Promise.resolve();
  return loadGis().then(() => {
    tokenClient ??= window.google!.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: DRIVE_SCOPE,
      callback: (r: TokenResponse) => {
        const w = waiting;
        waiting = null;
        if (r.access_token) w?.resolve({ value: r.access_token, expiresIn: r.expires_in ?? 3600 });
        else w?.reject(new Error(r.error_description || r.error || "Google sign-in was cancelled."));
      },
      error_callback: (e: { type?: string }) => {
        const w = waiting;
        waiting = null;
        w?.reject(
          new Error(
            e?.type === "popup_failed_to_open"
              ? "Your browser blocked Google's sign-in window. Allow pop-ups for this site (icon at the right of the address bar) and try again."
              : e?.type === "popup_closed"
                ? "Google's sign-in window was closed before finishing."
                : "Google sign-in failed. Try again.",
          ),
        );
      },
    });
  });
}

/** Must be called synchronously inside a tap handler (no awaits before it). */
function webTokenFromTap(): Promise<{ value: string; expiresIn: number }> {
  if (!tokenClient) {
    prepareSignIn().catch(() => {});
    return Promise.reject(new Error("Google sign-in is still loading. Tap again in a moment."));
  }
  waiting?.reject(new Error("Google sign-in was restarted."));
  return new Promise((resolve, reject) => {
    waiting = { resolve, reject };
    tokenClient!.requestAccessToken({ prompt: "" });
  });
}

// ---------------------------------------------------------------- shared

/**
 * A Drive access token. `interactive` may show Google's sign-in: call it first thing in a tap
 * handler (in browsers the window must open synchronously from the tap). Without it, only a cached
 * or silently renewed token is used, else AuthNeeded is thrown.
 */
export function driveToken(interactive = false): Promise<string> {
  if (!GOOGLE_CLIENT_ID) return Promise.reject(new Error("Drive sync isn't set up in this build yet."));
  if (valid()) return Promise.resolve(token!.value);
  if (Capacitor.isNativePlatform())
    return nativeToken(interactive).then((value) => {
      token = { value, expires: Date.now() + 50 * 60_000 };
      return value;
    });
  if (!interactive)
    return Promise.reject(new AuthNeeded("Tap Sync now to sign in to Google again (browsers ask about once an hour)."));
  return webTokenFromTap().then((t) => {
    token = { value: t.value, expires: Date.now() + t.expiresIn * 1000 };
    return t.value;
  });
}

/** Forget the token (after a 401, or when the student disconnects). */
export function dropToken() {
  token = null;
}

export async function signOut() {
  const t = token?.value;
  token = null;
  try {
    if (Capacitor.isNativePlatform()) await (await native()).SocialLogin.logout({ provider: "google" });
    else if (t && window.google) window.google.accounts.oauth2.revoke(t);
  } catch {}
}
