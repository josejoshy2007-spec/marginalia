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

async function webToken(interactive: boolean): Promise<{ value: string; expiresIn: number }> {
  // A browser can only open Google's window in response to a tap, so background syncs wait for one.
  if (!interactive) throw new AuthNeeded("Tap Sync now to sign in to Google again (browsers allow this once an hour).");
  await loadGis();
  return new Promise((resolve, reject) => {
    const client = window.google!.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: DRIVE_SCOPE,
      callback: (r: TokenResponse) =>
        r.access_token
          ? resolve({ value: r.access_token, expiresIn: r.expires_in ?? 3600 })
          : reject(new Error(r.error_description || r.error || "Google sign-in was cancelled.")),
      error_callback: (e: { type?: string }) =>
        reject(new Error(e?.type === "popup_closed" ? "Google sign-in was closed." : "Google sign-in failed.")),
    });
    client.requestAccessToken({ prompt: "" });
  });
}

// ---------------------------------------------------------------- shared

/**
 * A Drive access token. `interactive` may show Google's sign-in (call it from a tap); without it,
 * only a cached or silently renewed token is used, else AuthNeeded is thrown.
 */
export async function driveToken(interactive = false): Promise<string> {
  if (!GOOGLE_CLIENT_ID) throw new Error("Drive sync isn't set up in this build yet.");
  if (valid()) return token!.value;
  if (Capacitor.isNativePlatform()) {
    const value = await nativeToken(interactive);
    token = { value, expires: Date.now() + 50 * 60_000 };
  } else {
    const t = await webToken(interactive);
    token = { value: t.value, expires: Date.now() + t.expiresIn * 1000 };
  }
  return token.value;
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
