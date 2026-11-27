/** Pure countdown logic for the practice timer. Time comes from Date.now() deltas, never tick counts. */
export type TimerState = {
  durationMs: number;
  /** Time used before the current run (while paused or idle). */
  elapsedMs: number;
  /** Timestamp the current run began, or null when not running. */
  startedAt: number | null;
};

export const PRESET_MINUTES = [5, 10, 15, 30, 45, 60];

export function createTimer(minutes: number): TimerState {
  return { durationMs: Math.max(0, Math.round(minutes * 60000)), elapsedMs: 0, startedAt: null };
}
export const isRunning = (s: TimerState) => s.startedAt !== null;
export function elapsed(s: TimerState, now: number): number {
  return s.elapsedMs + (s.startedAt === null ? 0 : Math.max(0, now - s.startedAt));
}
export function remaining(s: TimerState, now: number): number {
  return Math.max(0, s.durationMs - elapsed(s, now));
}
export const isDone = (s: TimerState, now: number) => s.durationMs > 0 && remaining(s, now) <= 0;
export function start(s: TimerState, now: number): TimerState {
  if (s.startedAt !== null || isDone(s, now)) return s;
  return { ...s, startedAt: now };
}
export function pause(s: TimerState, now: number): TimerState {
  if (s.startedAt === null) return s;
  return { ...s, elapsedMs: elapsed(s, now), startedAt: null };
}
export const reset = (s: TimerState): TimerState => ({ ...s, elapsedMs: 0, startedAt: null });
/** True during the last minute while time is still left. */
export const isLastMinute = (s: TimerState, now: number) => {
  const r = remaining(s, now);
  return r > 0 && r <= 60000;
};
/** mm:ss, rounding up so 0:00 only shows when time is truly up. */
export function formatClock(ms: number): string {
  const total = Math.ceil(Math.max(0, ms) / 1000);
  const m = Math.floor(total / 60);
  const sec = total % 60;
  return `${m}:${String(sec).padStart(2, "0")}`;
}
