/**
 * Daily AI usage on this device: a counter per local calendar day and feature tag (Gemini, Cerebras and
 * Claude separately) plus, per provider and tag, the tokens used (optional, so older rows still load), plus a memory of which Gemini models have spent their free DAILY quota,
 * so later requests skip them without a round trip. Both live in the existing `settings` table
 * (keys `usage-YYYY-MM-DD` and the `exhausted` setting), so there is no schema change.
 */
import { db } from "./db";
import { getSettings, saveSettings } from "./settings";

import type { Provider, TokenRec, UsageDay, DayInput } from "./cost";
export type { Provider, TokenRec, UsageDay };
/** What a provider call needs to record its tokens: the feature tag and whether it is a "strong" (marking) call. */
export type UsageMeta = { tag: string; strong?: boolean };

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
    return normalize(v);
  })();
  mem = { day, p };
  return p;
}

/** Fills in what an older row lacks (the token fields are optional), so old `usage-` rows still read correctly. */
function normalize(v: Partial<UsageDay> | null | undefined): UsageDay {
  const out: UsageDay = { gemini: { ...v?.gemini }, cerebras: { ...v?.cerebras }, claude: { ...v?.claude } };
  if (v?.tokens) {
    out.tokens = {};
    for (const [p, byTag] of Object.entries(v.tokens) as [Provider, Record<string, TokenRec>][])
      out.tokens[p] = Object.fromEntries(Object.entries(byTag ?? {}).map(([k, r]) => [k, { ...r }]));
  }
  return out;
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

/**
 * Record the tokens of one answered request (call it only for a request that succeeded, with the provider that
 * answered). Thinking tokens count as output. `strong` marks the calls that would use the stronger Claude model.
 * Text only: embeddings and speech do not come through here.
 */
export async function recordTokens(
  provider: Provider,
  tag: string,
  t: { input?: number; output?: number; cached?: number },
  strong = false,
): Promise<void> {
  const input = Math.max(0, Math.round(Number(t.input) || 0));
  const output = Math.max(0, Math.round(Number(t.output) || 0));
  if (!input && !output) return; // the response carried no counts
  const data = await today();
  const byTag = ((data.tokens ??= {})[provider] ??= {});
  const r = (byTag[tag] ??= { n: 0, input: 0, output: 0 });
  r.n++;
  r.input += input;
  r.output += output;
  if (t.cached) r.cached = (r.cached ?? 0) + Math.round(t.cached);
  if (strong) {
    r.sIn = (r.sIn ?? 0) + input;
    r.sOut = (r.sOut ?? 0) + output;
  }
  await persist(data);
}

/** Gemini `usageMetadata` -> tokens (thinking counts as output). */
export function geminiTokens(m: Record<string, unknown> | undefined | null): { input: number; output: number } | null {
  if (!m) return null;
  const n = (k: string) => Number(m[k]) || 0;
  return { input: n("promptTokenCount"), output: n("candidatesTokenCount") + n("thoughtsTokenCount") };
}

/** Claude `usage` -> tokens. Cache reads and writes are inside `input` (the API reports them separately). */
export function claudeTokens(u: Record<string, unknown> | undefined | null): { input: number; output: number; cached: number } | null {
  if (!u) return null;
  const n = (k: string) => Number(u[k]) || 0;
  return { input: n("input_tokens") + n("cache_creation_input_tokens") + n("cache_read_input_tokens"), output: n("output_tokens"), cached: n("cache_read_input_tokens") };
}

/** Cerebras (OpenAI-style) `usage` -> tokens. */
export function cerebrasTokens(u: Record<string, unknown> | undefined | null): { input: number; output: number } | null {
  if (!u) return null;
  return { input: Number(u.prompt_tokens) || 0, output: Number(u.completion_tokens) || 0 };
}

/** Per-day usage rows for the last `days` local days (today included), oldest first; days with no activity are left out. */
export async function getUsageHistory(days = 7): Promise<DayInput[]> {
  const out: DayInput[] = [];
  const t = await today();
  for (let i = days - 1; i >= 0; i--) {
    const day = localDay(new Date(Date.now() - i * 86_400_000));
    let data: UsageDay | null = null;
    if (i === 0) data = t;
    else {
      try {
        const v = (await db.settings.get(usageKey(day)))?.value as Partial<UsageDay> | undefined;
        if (v) data = normalize(v);
      } catch {}
    }
    if (data && (sum(data.gemini) || sum(data.cerebras) || sum(data.claude) || data.tokens)) out.push({ day, data });
  }
  return out;
}

/** Gemini requests sent so far today. */
export async function geminiToday(): Promise<number> {
  return sum((await today()).gemini);
}

export async function getUsage(): Promise<UsageDay & { geminiTotal: number; cerebrasTotal: number; claudeTotal: number }> {
  const d = await today();
  return {
    gemini: { ...d.gemini },
    cerebras: { ...d.cerebras },
    claude: { ...d.claude },
    geminiTotal: sum(d.gemini),
    cerebrasTotal: sum(d.cerebras),
    claudeTotal: sum(d.claude),
  };
}

export async function resetUsage(): Promise<void> {
  const data = await today();
  data.gemini = {};
  data.cerebras = {};
  data.claude = {};
  delete data.tokens;
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
