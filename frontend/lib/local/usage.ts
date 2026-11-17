/**
 * Daily AI usage on this device: a counter per local calendar day and feature tag (Gemini and
 * Cerebras separately), plus a memory of which Gemini models have spent their free DAILY quota,
 * so later requests skip them without a round trip. Both live in the existing `settings` table
 * (keys `usage-YYYY-MM-DD` and the `exhausted` setting), so there is no schema change.
 */
import { db } from "./db";
import { getSettings, saveSettings } from "./settings";

export type Provider = "gemini" | "cerebras";
export type UsageDay = { gemini: Record<string, number>; cerebras: Record<string, number> };

const usageKey = (day: string) => `usage-${day}`;

export function localDay(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

let mem: { day: string; p: Promise<UsageDay> } | null = null;

function today(): Promise<UsageDay> {
  const day = localDay();
  if (mem?.day === day) return mem.p;
  const p = (async () => {
    let v: Partial<UsageDay> = {};
    try {
      v = ((await db.settings.get(usageKey(day)))?.value ?? {}) as Partial<UsageDay>;
      // Keep about a month of history, no more.
      const old = usageKey(localDay(new Date(Date.now() - 30 * 86_400_000)));
      const stale = (await db.settings.where("key").startsWith("usage-").primaryKeys()).filter((k) => k < old);
      if (stale.length) await db.settings.bulkDelete(stale);
    } catch {}
    return { gemini: { ...v.gemini }, cerebras: { ...v.cerebras } };
  })();
  mem = { day, p };
  return p;
}

const sum = (r: Record<string, number>) => Object.values(r).reduce((a, b) => a + b, 0);

async function persist(data: UsageDay) {
  try {
    await db.settings.put({ key: usageKey(localDay()), value: data });
  } catch {}
}

/** Record one HTTP request that is about to be sent. */
export async function countCall(provider: Provider, tag: string): Promise<void> {
  const data = await today();
  data[provider][tag] = (data[provider][tag] ?? 0) + 1;
  await persist(data);
}

/** Gemini requests sent so far today. */
export async function geminiToday(): Promise<number> {
  return sum((await today()).gemini);
}

export async function getUsage(): Promise<UsageDay & { geminiTotal: number; cerebrasTotal: number }> {
  const d = await today();
  return { gemini: { ...d.gemini }, cerebras: { ...d.cerebras }, geminiTotal: sum(d.gemini), cerebrasTotal: sum(d.cerebras) };
}

export async function resetUsage(): Promise<void> {
  const data = await today();
  data.gemini = {};
  data.cerebras = {};
  await persist(data);
}

// ---- models whose daily quota is spent ----

const LA = "America/Los_Angeles";

function laSeconds(t: number): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: LA, hourCycle: "h23", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(t));
  const g = (type: string) => Number(parts.find((x) => x.type === type)?.value ?? 0);
  return (g("hour") % 24) * 3600 + g("minute") * 60 + g("second");
}

/** The next midnight in Pacific time, when Google resets free daily quotas. */
export function nextMidnightLA(from = new Date()): Date {
  let t = from.getTime() + (86_400 - laSeconds(from.getTime())) * 1000;
  for (let i = 0; i < 2; i++) {
    const s = laSeconds(t); // 0 when exact; off by an hour across a daylight-saving change
    if (s === 0) break;
    t += (s < 43_200 ? -s : 86_400 - s) * 1000;
  }
  return new Date(t);
}

const pending: Record<string, string> = {};

function live(map: Record<string, string> | undefined): Record<string, string> {
  const now = Date.now();
  return Object.fromEntries(Object.entries({ ...map, ...pending }).filter(([, until]) => Date.parse(until) > now));
}

/** Models (with ISO reset times) whose free daily quota is spent right now. */
export async function exhaustedModels(): Promise<Record<string, string>> {
  return live((await getSettings()).exhausted);
}

export async function markExhausted(model: string): Promise<void> {
  pending[model] = nextMidnightLA().toISOString();
  try {
    await saveSettings({ exhausted: live((await getSettings()).exhausted) });
  } catch {}
}

export async function clearExhausted(): Promise<void> {
  for (const k of Object.keys(pending)) delete pending[k];
  await saveSettings({ exhausted: {} });
}
