"use client";

import { useEffect, useState } from "react";
import { prepareSignIn, syncConfigured } from "@/lib/local/google";
import { connect, disconnect, syncNow, syncStatus, type SyncStatus } from "@/lib/local/sync";
import { askConfirm } from "@/lib/confirm";

function ago(iso: string | null): string {
  if (!iso) return "not yet";
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
}

/** Keeps the latest sync status (shared with the rail's attention dot). */
export function useSyncStatus(): SyncStatus {
  const [st, setSt] = useState<SyncStatus>(syncStatus());
  useEffect(() => {
    const on = (e: Event) => setSt((e as CustomEvent<SyncStatus>).detail);
    window.addEventListener("marginalia:sync-status", on);
    setSt(syncStatus());
    return () => window.removeEventListener("marginalia:sync-status", on);
  }, []);
  return st;
}

/** Settings section: connect Google Drive, see when it last synced, sync now, disconnect. */
export default function DriveSync() {
  const st = useSyncStatus();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [, tick] = useState(0);
  // Have Google's sign-in ready before the student taps, so the browser lets its window open.
  useEffect(() => {
    prepareSignIn().catch(() => {});
  }, []);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setNote(null);
    try {
      const r = (await fn()) as { added: number; updated: number; removed: number; missing: string[] } | null;
      if (r) {
        const n = r.added + r.updated + r.removed;
        setNote(
          (n ? `Synced ${n} change${n === 1 ? "" : "s"}.` : "Everything is up to date.") +
            (r.missing.length ? ` ${r.missing.length} source${r.missing.length === 1 ? " is" : "s are"} still uploading from another device.` : ""),
        );
      }
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!syncConfigured())
    return (
      <section className="mt-6 border-t border-line pt-4">
        <h3 className="text-sm font-semibold">Sync with Google Drive</h3>
        <p className="mt-1 text-xs text-muted">Not set up in this build yet (add the GOOGLE_CLIENT_ID repository variable and rebuild).</p>
      </section>
    );

  const on = st.state !== "off";
  return (
    <section className="mt-6 border-t border-line pt-4">
      <h3 className="text-sm font-semibold">Sync with Google Drive</h3>
      <p className="mt-1 text-xs text-muted">
        Keeps your subjects, sources, cards, quizzes and marks the same on every device you sign in on (this phone,
        the web version, a tablet). Stored in a hidden app folder in your own Drive that only Marginalia can see.
      </p>
      {!on ? (
        <button type="button" className="btn-primary mt-3" disabled={busy} onClick={() => run(connect)}>
          {busy ? "Connecting…" : "Connect Google Drive"}
        </button>
      ) : (
        <>
          <p className="mt-3 text-sm">
            {st.state === "syncing" ? (
              <span className="text-muted">{st.stage}…</span>
            ) : st.state === "idle" ? (
              <>
                <span className="text-moss">●</span> {st.email ? `${st.email} · ` : ""}last synced {ago(st.lastSyncAt)}
              </>
            ) : (
              <span className="text-danger">{st.message}</span>
            )}
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button type="button" className="btn-ghost" disabled={busy || st.state === "syncing"} onClick={() => run(() => syncNow(true))}>
              {busy || st.state === "syncing" ? "Syncing…" : "Sync now"}
            </button>
            <button
              type="button"
              className="btn-ghost"
              disabled={busy}
              onClick={async () => {
                if (
                  await askConfirm("Stop syncing this device?", {
                    detail: "Your library stays on this device and in Drive; this device just stops exchanging changes.",
                    confirmLabel: "Disconnect",
                    danger: false,
                  })
                )
                  run(disconnect);
              }}
            >
              Disconnect
            </button>
          </div>
        </>
      )}
      {note && <p className="mt-2 text-xs text-muted">{note}</p>}
    </section>
  );
}
