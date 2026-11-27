"use client";

import { useEffect, useState } from "react";
import { tap } from "@/lib/native";
import {
  PRESET_MINUTES, createTimer, formatClock, isDone, isLastMinute, isRunning, pause, remaining, reset, start, type TimerState,
} from "@/lib/timer";

/** One shared timer, kept in sessionStorage so leaving the screen doesn't reset it. */
const STORAGE_KEY = "marginalia-practice-timer";
const MIN_MINUTES = 1;
const MAX_MINUTES = 600;

type Saved = { minutes: number; t: TimerState };

const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

/** Whole minutes, kept within 1–600. */
const clampMinutes = (raw: number) => Math.min(MAX_MINUTES, Math.max(MIN_MINUTES, Math.round(raw)));

function loadSaved(): Saved | null {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const v: unknown = JSON.parse(raw);
    if (!v || typeof v !== "object") return null;
    const { minutes, t } = v as Record<string, unknown>;
    if (!isNum(minutes) || minutes < MIN_MINUTES || minutes > MAX_MINUTES) return null;
    if (!t || typeof t !== "object") return null;
    const { durationMs, elapsedMs, startedAt } = t as Record<string, unknown>;
    if (!isNum(durationMs) || durationMs < 0) return null;
    if (!isNum(elapsedMs) || elapsedMs < 0) return null;
    if (startedAt !== null && !isNum(startedAt)) return null;
    return { minutes, t: { durationMs, elapsedMs, startedAt } };
  } catch {
    return null;
  }
}

function saveTimer(saved: Saved) {
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
  } catch {
    /* storage unavailable or full: the timer still works in memory */
  }
}

/** Small, optional countdown for Practice runners. Never blocks the student. */
export default function PracticeTimer() {
  const [minutes, setMinutes] = useState(30);
  const [custom, setCustom] = useState("");
  const [open, setOpen] = useState(false);
  const [t, setT] = useState<TimerState>(() => createTimer(30));
  const [now, setNow] = useState(() => Date.now());
  /** False until the saved state has been read, so the defaults never overwrite it. */
  const [ready, setReady] = useState(false);
  const running = isRunning(t);
  const done = isDone(t, now);

  useEffect(() => {
    const saved = loadSaved();
    if (saved) {
      setMinutes(saved.minutes);
      setT(saved.t);
      setNow(Date.now());
      if (saved.t.startedAt !== null || saved.t.elapsedMs > 0) setOpen(true);
    }
    setReady(true);
  }, []);

  useEffect(() => {
    if (!ready) return;
    saveTimer({ minutes, t });
  }, [ready, minutes, t]);

  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => setNow(Date.now()), 250);
    const onVis = () => setNow(Date.now());
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [running]);

  useEffect(() => {
    if (running && done) {
      setT((s) => pause(s, Date.now()));
      tap("error");
    }
  }, [running, done]);

  const pick = (raw: number) => {
    if (!Number.isFinite(raw)) return;
    const m = clampMinutes(raw);
    setMinutes(m);
    setT(createTimer(m));
    setNow(Date.now());
  };
  const started = running || t.elapsedMs > 0;
  const clock = formatClock(started ? remaining(t, now) : t.durationMs);

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="btn-ghost shrink-0 text-sm" aria-label="Open practice timer">
        Timer
      </button>
    );
  }
  return (
    <div className="flex flex-wrap items-center justify-end gap-2" aria-label="Practice timer">
      <span
        role="timer"
        className={`font-display text-lg tabular-nums ${done || isLastMinute(t, now) ? "text-danger" : "text-ink"}`}
      >
        {done ? "Time's up" : clock}
      </span>
      {!started && (
        <>
          <select
            aria-label="Timer minutes"
            value={PRESET_MINUTES.includes(minutes) && !custom ? minutes : ""}
            onChange={(e) => {
              setCustom("");
              pick(Number(e.target.value));
            }}
            className="rounded border border-line bg-card px-2 py-1 text-sm"
          >
            {(!PRESET_MINUTES.includes(minutes) || custom) && <option value="">{minutes} min</option>}
            {PRESET_MINUTES.map((m) => (
              <option key={m} value={m}>
                {m} min
              </option>
            ))}
          </select>
          <input
            type="number"
            min={MIN_MINUTES}
            max={MAX_MINUTES}
            inputMode="numeric"
            placeholder="min"
            aria-label="Custom minutes"
            value={custom}
            onChange={(e) => {
              const v = e.target.value;
              setCustom(v);
              if (v.trim() !== "") pick(Number(v));
            }}
            onBlur={() => {
              if (custom.trim() !== "") setCustom(String(minutes));
            }}
            className="w-16 rounded border border-line bg-card px-2 py-1 text-sm"
          />
        </>
      )}
      {!done && (
        <button
          type="button"
          className="rounded bg-accent px-3 py-1 text-sm text-on-accent"
          onClick={() => {
            const n = Date.now();
            setNow(n);
            setT((s) => (isRunning(s) ? pause(s, n) : start(s, n)));
          }}
        >
          {running ? "Pause" : started ? "Resume" : "Start"}
        </button>
      )}
      <button
        type="button"
        className="rounded border border-line px-3 py-1 text-sm"
        onClick={() => {
          setT((s) => reset(s));
          setNow(Date.now());
        }}
      >
        Reset
      </button>
      {!started && (
        <button type="button" className="btn-ghost text-sm" onClick={() => setOpen(false)} aria-label="Hide timer">
          Hide
        </button>
      )}
    </div>
  );
}
