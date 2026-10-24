"use client";

import { useEffect, useRef, useState } from "react";
import { checkKey } from "@/lib/local/gemini";
import { DEFAULTS, getSettings, saveSettings, type Settings } from "@/lib/local/settings";
import { localApi } from "@/lib/local/store";
import { saveFile, scheduleReminder, isNative } from "@/lib/native";
import { CloseIcon } from "./icons";
import DriveSync from "./DriveSync";

const mb = (n: number) => (n > 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`);

/**
 * Settings overlay for the on-device version: the student's Gemini key (kept only on this device),
 * the daily review reminder, and backups (export / import, including from the laptop version).
 */
export default function SettingsSheet({
  firstRun,
  onClose,
  onImported,
}: {
  firstRun: boolean;
  onClose: () => void;
  onImported: () => void;
}) {
  const [s, setS] = useState<Settings | null>(null);
  const [key, setKey] = useState("");
  const [show, setShow] = useState(false);
  const [keyMsg, setKeyMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [checking, setChecking] = useState(false);
  const [backupMsg, setBackupMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<"export" | "import" | null>(null);
  const [usage, setUsage] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    getSettings().then((v) => {
      setS(v);
      setKey(v.geminiKey);
    });
    navigator.storage
      ?.estimate?.()
      .then((e) => e.usage != null && setUsage(`${mb(e.usage)} used on this device${e.quota ? ` of ${mb(e.quota)} available` : ""}`))
      .catch(() => {});
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !firstRun && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [firstRun, onClose]);

  const update = async (patch: Partial<Settings>) => {
    const next = await saveSettings(patch);
    setS(next);
    if ("remindersOn" in patch || "reminderHour" in patch)
      scheduleReminder(next.remindersOn, next.reminderHour, await localApi.dueCards());
  };

  const saveKey = async () => {
    setChecking(true);
    setKeyMsg(null);
    const err = await checkKey(key);
    setChecking(false);
    if (err) return setKeyMsg({ ok: false, text: err });
    await update({ geminiKey: key.trim() });
    setKeyMsg({ ok: true, text: "Key works and is saved on this device." });
    if (firstRun) setTimeout(onClose, 700);
  };

  const doExport = async () => {
    setBusy("export");
    setBackupMsg(null);
    try {
      const blob = await localApi.exportBackup();
      await saveFile(blob, `marginalia-${new Date().toISOString().slice(0, 10)}.json`);
      setBackupMsg(`Backup ready (${mb(blob.size)}).`);
    } catch (e) {
      setBackupMsg(`Couldn't make the backup: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  const doImport = async (file: File) => {
    setBusy("import");
    setBackupMsg(null);
    try {
      const r = await localApi.importBackup(file);
      setBackupMsg(
        `Added ${r.subjects} subject${r.subjects === 1 ? "" : "s"}, ${r.sources} source${r.sources === 1 ? "" : "s"} and ${r.artifacts} study item${r.artifacts === 1 ? "" : "s"}.` +
          (r.reindex ? ` ${r.reindex} source${r.reindex === 1 ? " is" : "s are"} being indexed for search in the background.` : ""),
      );
      onImported();
    } catch (e) {
      setBackupMsg((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  if (!s) return null;
  return (
    <div
      className="fixed inset-0 z-[90] overflow-y-auto bg-ink/30 backdrop-blur-[2px]"
    >
      {/* min-h-full + items-center: centred when it fits, scrolls from the top on short phone screens. */}
      <div
        className="safe-overlay flex min-h-full items-center justify-center px-3"
        onMouseDown={(e) => e.target === e.currentTarget && !firstRun && onClose()}
      >
      <div role="dialog" aria-modal="true" aria-label="Settings" className="sheet-rise w-full max-w-lg rounded-2xl border border-line bg-card p-5 shadow-xl">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="font-display text-2xl">{firstRun ? "Welcome to Marginalia" : "Settings"}</h2>
            {firstRun && (
              <p className="mt-1 text-sm text-muted">
                Everything runs on this device. Answers come from Google Gemini using your own free key, so nothing
                costs money and your sources stay with you.
              </p>
            )}
          </div>
          {!firstRun && (
            <button type="button" className="btn-ghost !px-2" onClick={onClose} aria-label="Close settings">
              <CloseIcon width={18} height={18} />
            </button>
          )}
        </div>

        <section className="mt-5">
          <h3 className="text-sm font-semibold">Gemini API key</h3>
          <p className="mt-1 text-xs text-muted">
            Free from{" "}
            <a className="text-accent underline" href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">
              aistudio.google.com/apikey
            </a>{" "}
            → Create API key. It&apos;s stored only on this device and sent only to Google.
          </p>
          <div className="mt-2 flex gap-2">
            <input
              className="field min-w-0 flex-1 font-mono text-sm"
              type={show ? "text" : "password"}
              autoComplete="off"
              spellCheck={false}
              placeholder="AIza…"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && key.trim() && saveKey()}
            />
            <button type="button" className="btn-ghost" onClick={() => setShow((v) => !v)}>
              {show ? "Hide" : "Show"}
            </button>
          </div>
          <div className="mt-2 flex items-center gap-3">
            <button type="button" className="btn-primary" disabled={!key.trim() || checking} onClick={saveKey}>
              {checking ? "Checking…" : "Save key"}
            </button>
            {keyMsg && <span className={`text-xs ${keyMsg.ok ? "text-moss" : "text-danger"}`}>{keyMsg.text}</span>}
            {firstRun && !keyMsg?.ok && (
              <button type="button" className="ml-auto text-xs text-muted underline" onClick={onClose}>
                Later
              </button>
            )}
          </div>
        </section>

        {!firstRun && (
          <>
            <DriveSync />

            <section className="mt-6 border-t border-line pt-4">
              <h3 className="text-sm font-semibold">Review reminder</h3>
              <label className="mt-2 flex items-center gap-2 text-sm">
                <input type="checkbox" checked={s.remindersOn} onChange={(e) => update({ remindersOn: e.target.checked })} />
                Remind me daily when recall cards are due, at
                <select
                  className="field !w-auto !py-1"
                  value={s.reminderHour}
                  disabled={!s.remindersOn}
                  onChange={(e) => update({ reminderHour: Number(e.target.value) })}
                >
                  {Array.from({ length: 24 }, (_, h) => (
                    <option key={h} value={h}>
                      {String(h).padStart(2, "0")}:00
                    </option>
                  ))}
                </select>
              </label>
              {!isNative() && <p className="mt-1 text-xs text-muted">Reminders work in the Android app.</p>}
            </section>

            <section className="mt-6 border-t border-line pt-4">
              <h3 className="text-sm font-semibold">Backup</h3>
              <p className="mt-1 text-xs text-muted">
                Your library lives only on this device. Export a backup now and then (save it to Drive), or import one
                here, including the file from the laptop version&apos;s Export.
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <button type="button" className="btn-ghost" disabled={!!busy} onClick={doExport}>
                  {busy === "export" ? "Exporting…" : "Export backup"}
                </button>
                <button type="button" className="btn-ghost" disabled={!!busy} onClick={() => fileInput.current?.click()}>
                  {busy === "import" ? "Importing…" : "Import backup"}
                </button>
                <input
                  ref={fileInput}
                  type="file"
                  accept="application/json,.json"
                  hidden
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    e.target.value = "";
                    if (f) doImport(f);
                  }}
                />
              </div>
              {backupMsg && <p className="mt-2 text-xs text-muted">{backupMsg}</p>}
              {usage && <p className="mt-2 text-xs text-muted">{usage}.</p>}
            </section>

            <details className="mt-6 border-t border-line pt-4 text-sm">
              <summary className="cursor-pointer font-semibold">Advanced</summary>
              <p className="mt-2 text-xs text-muted">
                Change a model name only if Google retires one. Requests per minute keeps you under the free tier.
              </p>
              <div className="mt-2 grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2 text-xs">
                {(
                  [
                    ["model", "Main model"],
                    ["fallbackModel", "Backup model"],
                    ["ttsModel", "Speech model"],
                    ["embedModel", "Search model"],
                  ] as const
                ).map(([k, label]) => (
                  <label key={k} className="contents">
                    <span className="text-muted">{label}</span>
                    <input
                      className="field !py-1 font-mono text-xs"
                      defaultValue={s[k]}
                      onBlur={(e) => update({ [k]: e.target.value.trim() || DEFAULTS[k] })}
                    />
                  </label>
                ))}
                <label className="contents">
                  <span className="text-muted">Requests / min</span>
                  <input
                    className="field !w-24 !py-1 text-xs"
                    type="number"
                    min={1}
                    max={60}
                    defaultValue={s.rpm}
                    onBlur={(e) => update({ rpm: Math.max(1, Math.min(60, Number(e.target.value) || DEFAULTS.rpm)) })}
                  />
                </label>
              </div>
            </details>
          </>
        )}
      </div>
      </div>
    </div>
  );
}
