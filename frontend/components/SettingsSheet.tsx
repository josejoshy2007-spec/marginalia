"use client";

import { useEffect, useRef, useState } from "react";
import { checkKey } from "@/lib/local/gemini";
import { checkCerebrasKey } from "@/lib/local/cerebras";
import { DEFAULTS, getSettings, saveSettings, type Settings } from "@/lib/local/settings";
import { clearExhausted, exhaustedModels, getUsage, resetUsage, type UsageDay } from "@/lib/local/usage";
import { localApi } from "@/lib/local/store";
import { saveFile, scheduleReminder, isNative } from "@/lib/native";
import { CloseIcon } from "./icons";
import DriveSync from "./DriveSync";
import { Segmented } from "./study/shared";
import { applyTheme } from "@/lib/theme";

type UsageView = UsageDay & { geminiTotal: number; cerebrasTotal: number; exhausted: Record<string, string> };

const top = (r: Record<string, number>) => Object.entries(r).sort((a, b) => b[1] - a[1]);

/** "AI usage today": calls sent to Gemini by feature, the daily budget, and which models are out for the day. */
function UsageSection({ s, update }: { s: Settings; update: (patch: Partial<Settings>) => Promise<void> }) {
  const [u, setU] = useState<UsageView | null>(null);
  const [budget, setBudget] = useState(String(s.dailyBudget));
  const load = async () => setU({ ...(await getUsage()), exhausted: await exhaustedModels() });
  useEffect(() => {
    load().catch(() => {});
  }, []);
  const commit = () => {
    const n = Math.max(0, Math.floor(Number(budget)));
    const v = Number.isFinite(n) ? n : s.dailyBudget;
    setBudget(String(v));
    if (v !== s.dailyBudget) update({ dailyBudget: v });
  };
  const used = u?.geminiTotal ?? 0;
  const pct = s.dailyBudget > 0 ? Math.min(100, (used / s.dailyBudget) * 100) : 0;
  const over = s.dailyBudget > 0 && used >= s.dailyBudget;
  const when = (iso: string) => new Date(iso).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" });
  return (
    <section className="mt-6 border-t border-line pt-4">
      <h3 className="text-sm font-semibold">AI usage today</h3>
      <p className="mt-1 text-sm">
        <span className={over ? "text-danger" : ""}>{used}</span>
        <span className="text-muted"> / {s.dailyBudget > 0 ? s.dailyBudget : "no limit"} Gemini calls</span>
      </p>
      {s.dailyBudget > 0 && (
        <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-sunken" role="progressbar" aria-valuemin={0} aria-valuemax={s.dailyBudget} aria-valuenow={used} aria-label="Gemini calls used today">
          <div className={`h-full rounded ${over ? "bg-danger" : "bg-accent"}`} style={{ width: `${pct}%` }} />
        </div>
      )}
      {u && top(u.gemini).length > 0 && (
        <ul className="mt-2 grid grid-cols-2 gap-x-4 gap-y-0.5 text-xs text-muted">
          {top(u.gemini).slice(0, 8).map(([tag, n]) => (
            <li key={tag} className="flex justify-between">
              <span>{tag}</span>
              <span className="tabular-nums text-ink">{n}</span>
            </li>
          ))}
        </ul>
      )}
      {u && u.cerebrasTotal > 0 && <p className="mt-2 text-xs text-muted">Cerebras: {u.cerebrasTotal} calls today (not limited by the budget).</p>}
      {u && Object.keys(u.exhausted).length > 0 && (
        <div className="mt-2 text-xs text-muted">
          <p>Out of free quota for today (skipped until reset):</p>
          <ul className="mt-0.5">
            {Object.entries(u.exhausted).map(([m, until]) => (
              <li key={m}>
                {m} <span className="text-muted">until {when(until)}</span>
              </li>
            ))}
          </ul>
          <button type="button" className="mt-1 underline" onClick={() => clearExhausted().then(load)}>
            Try them again
          </button>
        </div>
      )}
      <label className="mt-3 flex items-center gap-2 text-sm">
        Daily budget
        <input
          className="field !w-24 !py-1"
          type="number"
          min={0}
          step={50}
          inputMode="numeric"
          aria-label="Daily Gemini call budget"
          value={budget}
          onChange={(e) => setBudget(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === "Enter" && commit()}
        />
        <span className="text-xs text-muted">0 = no limit</span>
      </label>
      <button type="button" className="mt-2 text-xs text-muted underline" onClick={() => resetUsage().then(load)}>
        Reset counter
      </button>
    </section>
  );
}

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
  const [cKey, setCKey] = useState("");
  const [cMsg, setCMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [cChecking, setCChecking] = useState(false);

  useEffect(() => {
    getSettings().then((v) => {
      setS(v);
      setKey(v.geminiKey);
      setCKey(v.cerebrasKey);
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
    // A different key has its own free quota: forget which models the old one had used up.
    if (key.trim() !== (s?.geminiKey ?? "").trim()) await clearExhausted();
    await update({ geminiKey: key.trim() });
    setKeyMsg({ ok: true, text: "Key works and is saved on this device." });
    if (firstRun) setTimeout(onClose, 700);
  };

  const saveCerebras = async () => {
    setCChecking(true);
    setCMsg(null);
    const r = await checkCerebrasKey(cKey);
    setCChecking(false);
    if ("error" in r) return setCMsg({ ok: false, text: r.error });
    await update({ cerebrasKey: cKey.trim(), cerebrasModel: r.model });
    setCMsg({ ok: true, text: `Key works. Using ${r.model}.` });
  };

  const removeCerebras = async () => {
    await update({ cerebrasKey: "", cerebrasModel: "" });
    setCKey("");
    setCMsg({ ok: true, text: "Removed." });
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
      className="fixed inset-0 z-[90] overflow-y-auto bg-black/60 backdrop-blur-[2px]"
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
            <UsageSection s={s} update={update} />

            <section className="mt-6 border-t border-line pt-4">
              <h3 className="text-sm font-semibold">Extra free AI (optional)</h3>
              <p className="mt-1 text-xs text-muted">
                When Gemini&apos;s free quota runs out, chat, quizzes, exam questions, summaries and study sheets carry on
                with Cerebras (free, about 14,000 requests a day, no card). Marking, photos and recordings stay on Gemini.
                Get a key at{" "}
                <a className="text-accent underline" href="https://cloud.cerebras.ai" target="_blank" rel="noreferrer">
                  cloud.cerebras.ai
                </a>{" "}
                → API Keys.
              </p>
              <div className="mt-2 flex gap-2">
                <input
                  className="field min-w-0 flex-1 font-mono text-sm"
                  type={show ? "text" : "password"}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="csk-…"
                  aria-label="Cerebras API key"
                  value={cKey}
                  onChange={(e) => setCKey(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && cKey.trim() && saveCerebras()}
                />
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-3">
                <button type="button" className="btn-ghost" disabled={!cKey.trim() || cChecking} onClick={saveCerebras}>
                  {cChecking ? "Checking…" : "Save key"}
                </button>
                {s.cerebrasKey && (
                  <button type="button" className="text-xs text-muted underline" onClick={removeCerebras}>
                    Remove
                  </button>
                )}
                {cMsg ? (
                  <span className={`text-xs ${cMsg.ok ? "text-moss" : "text-danger"}`}>{cMsg.text}</span>
                ) : (
                  s.cerebrasKey && <span className="text-xs text-muted">On, using {s.cerebrasModel}.</span>
                )}
              </div>
            </section>

            <DriveSync />

            <section className="mt-6 border-t border-line pt-4">
              <h3 className="text-sm font-semibold">Appearance</h3>
              <div className="mt-2">
                <Segmented
                  label="Appearance"
                  value={s.theme}
                  options={[
                    { value: "dark", label: "Dark" },
                    { value: "light", label: "Light" },
                  ]}
                  onChange={(theme) => {
                    applyTheme(theme);
                    update({ theme });
                  }}
                />
              </div>
            </section>

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
                Change a model name only if Google retires one. Extra models (comma-separated) are tried last, after
                Cerebras; each has its own free daily quota. Requests per minute keeps you under the free tier.
              </p>
              <div className="mt-2 grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2 text-xs">
                {(
                  [
                    ["model", "Main model"],
                    ["fallbackModel", "Backup model"],
                    ["extraModels", "Extra models"],
                    ["ttsModel", "Speech model"],
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
