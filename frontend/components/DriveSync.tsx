"use client";

import { useEffect, useState } from "react";
import { prepareSignIn, syncConfigured } from "@/lib/local/google";
import { connect, disconnect, syncNow, syncStatus, type Counts, type SavedSyncReport, type SyncStatus } from "@/lib/local/sync";
import { getSettings } from "@/lib/local/settings";
import { askConfirm } from "@/lib/confirm";

function ago(iso: string | null): string {
  if (!iso) return "not yet";
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const total = (c: Counts) => c.subjects + c.sources + c.items + c.cards;
/** "2 subjects, 1 study item, 45 cards", or "nothing". */
function counts(c: Counts): string {
  const parts = [
    c.subjects && plural(c.subjects, "subject"),
    c.sources && plural(c.sources, "source"),
    c.items && plural(c.items, "study item"),
    c.cards && plural(c.cards, "card"),
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : "nothing";
}

/** Plain-language lines for the last sync's report. */
function reportLines(saved: SavedSyncReport): { text: string; bad?: boolean }[] {
  const r = saved.report;
  const out: { text: string; bad?: boolean }[] = [
    { text: `Last sync: sent ${counts(r.sent)} · received ${counts(r.received)}` },
  ];
  if (total(r.inDrive)) out.push({ text: `Drive now holds ${counts(r.inDrive)}` });
  if (r.uploadFailed.length)
    out.push({
      text: `${plural(r.uploadFailed.length, "source")} couldn't upload (${r.uploadFailed.join(", ")}), they'll retry next sync`,
      bad: true,
    });
  if (r.downloadFailed.length)
    out.push({
      text: `${plural(r.downloadFailed.length, "source")} couldn't download (${r.downloadFailed.join(", ")}), they'll retry next sync`,
      bad: true,
    });
  if (r.waitingHere)
    out.push({ text: `${plural(r.waitingHere, "item")} still being made stays on this device until it's ready` });
  if (saved.error) out.push({ text: `The sync stopped part-way: ${saved.error}`, bad: true });
  return out;
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
  const [saved, setSaved] = useState<SavedSyncReport | null>(null);
  // The last report lives in settings: load it on open and whenever a sync finishes or fails.
  useEffect(() => {
    if (st.state === "syncing") return;
    getSettings().then((s) => setSaved(s.lastSyncReport ?? null)).catch(() => {});
  }, [st]);
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
      {on && st.state !== "syncing" && saved && (
        <ul className="mt-2 space-y-0.5 text-xs">
          {reportLines(saved).map((l) => (
            <li key={l.text} className={l.bad ? "text-danger" : "text-muted"}>
              {l.text}
            </li>
          ))}
        </ul>
      )}
      {note && <p className="mt-2 text-xs text-muted">{note}</p>}
    </section>
  );
}
