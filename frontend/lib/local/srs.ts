/** Spaced repetition: a compact SM-2 variant with four grades (port of backend srs.py). */
export type Grade = "again" | "hard" | "good" | "easy";
export const GRADES: Grade[] = ["again", "hard", "good", "easy"];
export type CardState = { ease: number; interval_days: number; reps: number; lapses: number };

const MIN_EASE = 1.3;
const RELEARN_MINUTES = 10;
const DAY = 86_400_000;

export function schedule(s: CardState, grade: Grade, now: number): [CardState, number] {
  let { ease, interval_days: interval, reps, lapses } = s;
  if (grade === "again") {
    lapses += reps > 0 ? 1 : 0;
    return [{ ease: Math.max(MIN_EASE, ease - 0.2), interval_days: 0, reps: 0, lapses }, now + RELEARN_MINUTES * 60_000];
  }
  if (reps === 0) interval = { hard: 0.5, good: 1, easy: 3 }[grade];
  else if (reps === 1) interval = { hard: 2, good: 3, easy: 5 }[grade];
  else {
    const factor = { hard: 1.2, good: ease, easy: ease * 1.3 }[grade];
    interval = Math.max(interval + 1, interval * factor);
  }
  ease = Math.max(MIN_EASE, ease + { hard: -0.15, good: 0, easy: 0.15 }[grade]);
  return [{ ease, interval_days: interval, reps: reps + 1, lapses }, now + interval * DAY];
}

export function preview(s: CardState, now: number): Record<Grade, string> {
  const out = {} as Record<Grade, string>;
  for (const g of GRADES) out[g] = human(schedule(s, g, now)[1] - now);
  return out;
}

function human(ms: number): string {
  const mins = ms / 60_000;
  if (mins < 60) return `${Math.round(mins)}m`;
  const hours = mins / 60;
  if (hours < 24) return `${Math.round(hours)}h`;
  const days = hours / 24;
  if (days < 14) return `${Math.round(days)}d`;
  if (days < 60) return `${Math.round(days / 7)}w`;
  return `${Math.round(days / 30)}mo`;
}
