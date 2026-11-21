/**
 * What the measured AI usage would cost on Claude. Pure functions over the per-day usage rows (no database),
 * so the Settings screen, the "Copy usage summary" report and the tests all share one set of numbers.
 *
 * Tokens are counted by each provider's own tokenizer (Gemini, Cerebras, Claude all differ), so every figure
 * here is a ROUGH ESTIMATE.
 */

export type Provider = "gemini" | "cerebras" | "claude";
export const PROVIDERS: Provider[] = ["gemini", "cerebras", "claude"];

/** Tokens measured for one provider and feature tag on one day. Thinking tokens are counted as output. */
export type TokenRec = {
  /** Calls that reported token counts. */
  n: number;
  input: number;
  output: number;
  /** Input tokens that were cache reads (Claude only; already inside `input`). */
  cached?: number;
  /** Input/output of the "strong" calls (exam marking, markscheme drafting, medium thinking): subsets of input/output. */
  sIn?: number;
  sOut?: number;
};

/** One day of usage. `gemini`/`cerebras`/`claude` are request counts per tag (the original format); `tokens` is new and optional. */
export type UsageDay = {
  gemini: Record<string, number>;
  cerebras: Record<string, number>;
  claude: Record<string, number>;
  tokens?: Partial<Record<Provider, Record<string, TokenRec>>>;
};

/**
 * Anthropic API prices in USD per million tokens. Source: the claude-api skill's "Current Models" table
 * (cached 2026-11-03). Haiku 5.5 is $0.10 / $0.50 for prompts up to 100K tokens ($0.50 / $2.50 beyond; not modelled,
 * because per-call prompt sizes are not kept). The skill lists no cache-read price for Haiku 5.5, so cached input
 * is charged at the normal input rate here (Sonnet 5.5 lists $0.10 for cache reads; also not applied).
 */
export const PRICES = {
  haiku: { name: "Claude Haiku 5.5", input: 0.1, output: 0.5 },
  sonnet: { name: "Claude Sonnet 5.5", input: 2, output: 10 },
} as const;
type Price = { input: number; output: number };

export const usd = (input: number, output: number, p: Price): number => (input / 1e6) * p.input + (output / 1e6) * p.output;

/** Tokens and calls summed over some days/features. `estCalls` of the calls had no token data and were estimated. */
export type Row = { calls: number; input: number; output: number; sIn: number; sOut: number; estCalls: number };
export const emptyRow = (): Row => ({ calls: 0, input: 0, output: 0, sIn: 0, sOut: 0, estCalls: 0 });
const addRow = (a: Row, b: Row) => {
  a.calls += b.calls;
  a.input += b.input;
  a.output += b.output;
  a.sIn += b.sIn;
  a.sOut += b.sOut;
  a.estCalls += b.estCalls;
};

/** Everything on Haiku 5.5. */
export const haikuCost = (r: Row): number => usd(r.input, r.output, PRICES.haiku);
/** Strong calls (marking) on Sonnet 5.5, everything else on Haiku 5.5. */
export const mixedCost = (r: Row): number => usd(r.input - r.sIn, r.output - r.sOut, PRICES.haiku) + usd(r.sIn, r.sOut, PRICES.sonnet);

export type DayInput = { day: string; data: UsageDay };
export type DayRow = { day: string; row: Row; estimated: boolean; features: Record<string, FeatureDay> };
export type FeatureDay = {
  row: Row;
  estimated: boolean;
  /** Per provider: calls and measured tokens. */
  providers: Partial<Record<Provider, { calls: number; n: number; input: number; output: number }>>;
};
export type FeatureTotal = { tag: string; row: Row };
export type Summary = {
  days: DayRow[];
  features: FeatureTotal[];
  total: Row;
  /** Features that have calls but no token data anywhere, so they could not be estimated (e.g. audio, uploads). */
  noBasis: { tag: string; calls: number }[];
};

type PerCall = { input: number; output: number; sIn: number; sOut: number };

/** Average tokens per call for each feature, from every day that has token data. */
export function averagesPerCall(days: DayInput[]): Record<string, PerCall> {
  const acc: Record<string, Row & { n: number }> = {};
  for (const { data } of days)
    for (const provider of PROVIDERS)
      for (const [tag, t] of Object.entries(data.tokens?.[provider] ?? {})) {
        if (!(t.n > 0)) continue;
        const a = (acc[tag] ??= { ...emptyRow(), n: 0 });
        a.n += t.n;
        a.input += t.input;
        a.output += t.output;
        a.sIn += t.sIn ?? 0;
        a.sOut += t.sOut ?? 0;
      }
  const out: Record<string, PerCall> = {};
  for (const [tag, a] of Object.entries(acc)) out[tag] = { input: a.input / a.n, output: a.output / a.n, sIn: a.sIn / a.n, sOut: a.sOut / a.n };
  return out;
}

/**
 * Totals per day and per feature. A feature on a day that has calls but no token data (days before token
 * counting existed) is estimated as calls x the feature's average tokens per call from days that do have data.
 * Calls include retries and fallbacks, so such an estimate leans high.
 */
export function summarize(days: DayInput[]): Summary {
  const avg = averagesPerCall(days);
  const featureTotals: Record<string, Row> = {};
  const noBasis: Record<string, number> = {};
  const total = emptyRow();
  const rows: DayRow[] = [];
  for (const { day, data } of [...days].sort((a, b) => a.day.localeCompare(b.day))) {
    const tags = new Set<string>();
    for (const p of PROVIDERS) {
      for (const t of Object.keys(data[p] ?? {})) tags.add(t);
      for (const t of Object.keys(data.tokens?.[p] ?? {})) tags.add(t);
    }
    const dayRow = emptyRow();
    const features: Record<string, FeatureDay> = {};
    let dayEstimated = false;
    for (const tag of [...tags].sort()) {
      const providers: FeatureDay["providers"] = {};
      const row = emptyRow();
      let measuredCalls = 0;
      for (const p of PROVIDERS) {
        const calls = data[p]?.[tag] ?? 0;
        const t = data.tokens?.[p]?.[tag];
        if (!calls && !t) continue;
        providers[p] = { calls, n: t?.n ?? 0, input: t?.input ?? 0, output: t?.output ?? 0 };
        row.calls += calls;
        row.input += t?.input ?? 0;
        row.output += t?.output ?? 0;
        row.sIn += t?.sIn ?? 0;
        row.sOut += t?.sOut ?? 0;
        measuredCalls += t?.n ?? 0;
      }
      let estimated = false;
      if (row.calls > 0 && measuredCalls === 0) {
        const a = avg[tag];
        if (a) {
          row.input += Math.round(a.input * row.calls);
          row.output += Math.round(a.output * row.calls);
          row.sIn += Math.round(a.sIn * row.calls);
          row.sOut += Math.round(a.sOut * row.calls);
          row.estCalls = row.calls;
          estimated = true;
          dayEstimated = true;
        } else noBasis[tag] = (noBasis[tag] ?? 0) + row.calls;
      }
      features[tag] = { row, estimated, providers };
      addRow(dayRow, row);
      addRow((featureTotals[tag] ??= emptyRow()), row);
    }
    addRow(total, dayRow);
    rows.push({ day, row: dayRow, estimated: dayEstimated, features });
  }
  return {
    days: rows,
    features: Object.entries(featureTotals)
      .map(([tag, row]) => ({ tag, row }))
      .sort((a, b) => haikuCost(b.row) - haikuCost(a.row) || b.row.calls - a.row.calls),
    total,
    noBasis: Object.entries(noBasis).map(([tag, calls]) => ({ tag, calls })),
  };
}

/** The 7-day total scaled to a 30-day month. */
export const perMonth = (week: number): number => (week * 30) / 7;

export const money = (v: number): string => (v === 0 ? "$0" : v < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`);
export const num = (n: number): string => Math.round(n).toLocaleString("en-US");

/** A plain-text report for the student to paste to Claude. */
export function formatReport(week: Summary, generated: string): string {
  const L: string[] = [];
  const row = (r: Row) => `${r.calls} calls, ${num(r.input)} input / ${num(r.output)} output tokens`;
  L.push(`Marginalia AI usage summary (generated ${generated})`);
  L.push("");
  L.push("ASSUMPTIONS");
  L.push("- Token counts are measured by each provider's own tokenizer (Gemini, Cerebras, Claude differ), so every cost is a ROUGH ESTIMATE.");
  L.push("- Thinking/reasoning tokens are counted as output tokens. Embeddings and speech are not counted as text tokens.");
  L.push(`- Prices (USD per 1M tokens, claude-api skill model table cached 2026-11-03): ${PRICES.haiku.name} $${PRICES.haiku.input.toFixed(2)} in / $${PRICES.haiku.output.toFixed(2)} out (prompts up to 100K tokens; $0.50 / $2.50 beyond, not modelled); ${PRICES.sonnet.name} $${PRICES.sonnet.input.toFixed(2)} in / $${PRICES.sonnet.output.toFixed(2)} out.`);
  L.push('- "Haiku" = all tokens at Haiku 5.5 rates. "Haiku + Sonnet marking" = marking / markscheme / medium-thinking calls at Sonnet 5.5 rates, the rest at Haiku 5.5. No cache discount applied.');
  L.push('- Days marked "estimated from call counts" had calls but no token data: tokens = calls x that feature\'s average tokens per call from days with data (calls include retries, so this leans high).');
  L.push("");
  const t = week.total;
  L.push(`LAST 7 DAYS: ${row(t)}`);
  L.push(`  Haiku 5.5: ${money(haikuCost(t))} for 7 days, ~${money(perMonth(haikuCost(t)))} per month (x30/7)`);
  L.push(`  Haiku + Sonnet marking: ${money(mixedCost(t))} for 7 days, ~${money(perMonth(mixedCost(t)))} per month`);
  if (t.estCalls) L.push(`  ${t.estCalls} of ${t.calls} calls were estimated from call counts.`);
  if (week.noBasis.length) L.push(`  No token basis (calls not priced): ${week.noBasis.map((x) => `${x.tag} ${x.calls}`).join(", ")}`);
  L.push("");
  L.push("PER DAY");
  for (const d of week.days) {
    L.push(`${d.day}: ${row(d.row)}; Haiku ${money(haikuCost(d.row))}, with Sonnet marking ${money(mixedCost(d.row))}${d.estimated ? " (partly estimated from call counts)" : ""}`);
    for (const [tag, f] of Object.entries(d.features)) {
      const by = Object.entries(f.providers)
        .map(([p, v]) => `${p} ${v!.calls} calls${v!.n ? `, ${num(v!.input)} in / ${num(v!.output)} out` : ""}`)
        .join("; ");
      L.push(`  ${tag}: ${by}${f.estimated ? ` | estimated from call counts: ${num(f.row.input)} in / ${num(f.row.output)} out` : ""}`);
    }
  }
  L.push("");
  L.push("PER FEATURE (7 days, most expensive first)");
  for (const f of week.features)
    L.push(`${f.tag}: ${row(f.row)}; Haiku ${money(haikuCost(f.row))}, with Sonnet marking ${money(mixedCost(f.row))}${f.row.estCalls ? ` (${f.row.estCalls} calls estimated)` : ""}`);
  return L.join("\n");
}

/** Today as YYYY-MM-DD in local time (same as usage.ts `localDay`, kept here so this file stays free of the database). */
export const localDayLabel = (d = new Date()): string => {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
