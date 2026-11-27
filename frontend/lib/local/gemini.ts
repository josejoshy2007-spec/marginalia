/**
 * Gemini REST client used directly from the device with the student's own key (Gemini allows
 * browser calls: CORS is open for the x-goog-api-key header). Port of the old backend's
 * gemini.py/generate.py resilience: free-tier pacing, retries on 500/503 and short 429s using
 * Google's RetryInfo delay, fallback to a second model when one is overloaded or its daily quota
 * is spent, and retries of dropped connections.
 */
import { GEMINI_BASE, getSettings, type Settings } from "./settings";
import { cerebrasJson, cerebrasOpenStream, cerebrasStream } from "./cerebras";
import {
  CLAUDE_FAST_DEFAULT,
  CLAUDE_STRONG_DEFAULT,
  ClaudeError,
  claudeCanTake,
  claudeJson,
  claudeOpenStream,
  claudeStream,
  claudeText,
} from "./anthropic";
import { countCall, exhaustedModels, geminiToday, geminiTokens, markExhausted, recordTokens } from "./usage";

export class GeminiError extends Error {
  /** "minute": a per-minute quota (waiting a minute helps); "day": the daily quota is spent. */
  constructor(
    message: string,
    public quota: "minute" | "day" | null = null,
    /** Out of quota, overloaded or unreachable: another model (or Cerebras) may still answer. */
    public fallthrough = false,
    /** The student's own daily budget is spent: Cerebras may answer, but no further Gemini request. */
    public budget = false,
  ) {
    super(message);
  }
}

/**
 * Run `fn`, and if it hits a per-minute quota wait a minute and try again (up to `tries` times).
 * For long background jobs (indexing a textbook, transcribing a lecture) where waiting beats failing.
 */
/** A request this big can fail a per-minute token limit on its own; waiting a minute will not make it fit. */
export const UNRETRYABLE_INPUT_TOKENS = 200_000;
export async function patiently<T>(fn: () => Promise<T>, tries = 2, onWait?: () => void, inputTokens = 0): Promise<T> {
  const max = Math.min(tries, 2); // never more than 2 retries (3 runs); each run is a whole routed chain
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      // A spent daily quota or daily budget won't clear in a minute: don't retry those.
      if (!(e instanceof GeminiError) || e.quota !== "minute" || i >= max || inputTokens > UNRETRYABLE_INPUT_TOKENS) throw e;
      onWait?.();
      await sleep(62_000);
    }
  }
}

/** Attempts per model for 500/503/dropped connections, and HTTP requests allowed per logical call. */
const MODEL_ATTEMPTS = 2;
const CALL_CAP = 3; // generateJson / generateText / streamGenerate, all models together
const BATCH_CAP = 2; // one embed batch, one speak
const JSON_RETRIES = 1; // re-reads of a response body that dropped mid-way
/** Cerebras' free context is far smaller than Gemini's: bigger inputs would only waste a call. */
export const CEREBRAS_MAX_INPUT_TOKENS = 60_000;
const RETRY_STATUSES = new Set([500, 503]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Sliding-window pacer so we stay under the free tier's requests-per-minute. */
class Pacer {
  private sent: number[] = [];
  async acquire(rpm: number, maxWaitS: number): Promise<void> {
    if (rpm <= 0) return;
    let waited = 0;
    for (;;) {
      const t = Date.now();
      this.sent = this.sent.filter((s) => t - s < 60_000);
      if (this.sent.length < rpm) {
        this.sent.push(t);
        return;
      }
      const need = 60_000 - (t - this.sent[0]) + 50;
      if (waited + need > maxWaitS * 1000)
        throw new GeminiError(
          `You're going faster than Gemini's free tier allows (${rpm}/min). Try again in about ${Math.ceil(need / 1000)}s.`,
          "minute",
          true,
        );
      await sleep(need);
      waited += need;
    }
  }
}
const textPacer = new Pacer();
const embedPacer = new Pacer(); // embedding models have their own (larger) quota

function quotaInfo(body: unknown): { delay: number | null; daily: boolean } {
  let delay: number | null = null;
  let daily = false;
  const details = (body as { error?: { details?: { [k: string]: unknown }[] } })?.error?.details ?? [];
  for (const d of details) {
    const kind = String(d["@type"] ?? "");
    if (kind.endsWith("RetryInfo")) {
      const m = /([\d.]+)s/.exec(String(d.retryDelay ?? ""));
      delay = m ? Number(m[1]) : null;
    } else if (kind.endsWith("QuotaFailure")) {
      daily = ((d.violations as { quotaId?: string }[]) ?? []).some((v) => (v.quotaId ?? "").includes("PerDay"));
    }
  }
  return { delay, daily };
}

function errorMessage(status: number, body: unknown, raw: string): string {
  const msg = (body as { error?: { message?: string } })?.error?.message ?? raw.slice(0, 200);
  if ([400, 401, 403].includes(status) && /key/i.test(msg))
    return "Your Gemini API key is missing or invalid. Add it in Settings (free from aistudio.google.com).";
  if (status === 429) {
    const { delay, daily } = quotaInfo(body);
    if (daily) return "Gemini's free daily quota is used up on every model the app tries. It resets at midnight Pacific time.";
    return `Gemini's free per-minute limit was reached. ${delay ? `Try again in about ${Math.ceil(delay) + 1}s.` : "Wait a minute and retry."}`;
  }
  if (RETRY_STATUSES.has(status)) return "Gemini is overloaded right now (Google says demand is high). Try again in a minute.";
  if (status === 404) return `Gemini model not found. Check the model names in Settings. (${msg})`;
  return `Gemini API error (${status}): ${msg}`;
}

type SendOpts = {
  models: string[];
  action?: string; // e.g. "generateContent"; ignored with endpoint
  endpoint?: string; // e.g. "interactions" (model goes in the body)
  body: Record<string, unknown>;
  params?: Record<string, string>;
  pacer?: Pacer;
  signal?: AbortSignal;
  /** Feature tag for the usage meter. */
  tag?: string;
  /** Requests still allowed for this logical call; shared by every send() of the call. */
  cap?: { left: number };
};

const dailyGone = () =>
  new GeminiError("Gemini's free daily quota is used up on every model the app tries. It resets at midnight Pacific time.", "day", true);

/** Refuse (without sending) once today's Gemini requests reach the student's budget. */
async function checkBudget(budget: number): Promise<void> {
  if (budget > 0 && (await geminiToday()) >= budget)
    throw new GeminiError(`You've used today's AI budget (${budget} calls). It resets at midnight, or raise it in Settings.`, "day", true, true);
}

export type Thinking = "minimal" | "low" | "medium" | "high";
/** Models that rejected thinkingConfig this session: it is not sent to them again. */
const noThinking = new Set<string>();
const thinkingRejected = (status: number, raw: string) => status === 400 && /thinking/i.test(raw);

/** Request body for one model: drops generationConfig.thinkingConfig for models that rejected it. */
function bodyFor(o: SendOpts, model: string): string {
  let b: Record<string, unknown> = o.endpoint ? { ...o.body, model } : o.body;
  const gc = b.generationConfig as Record<string, unknown> | undefined;
  if (gc?.thinkingConfig && noThinking.has(model)) {
    const { thinkingConfig: _t, ...rest } = gc;
    b = { ...b, generationConfig: rest };
  }
  return JSON.stringify(b);
}

/** POST with pacing, retries and model fallback. Returns an OK Response or throws GeminiError. */
export async function send(o: SendOpts): Promise<Response> {
  const s = await getSettings();
  if (!s.geminiKey) throw new GeminiError("Add your free Gemini API key in Settings first (aistudio.google.com → Get API key).");
  const pacer = o.pacer ?? textPacer;
  const cap = o.cap ?? { left: CALL_CAP };
  const tag = o.tag ?? "other";
  const gone = await exhaustedModels();
  const models = o.models.filter((m) => !gone[m]);
  if (!models.length) throw dailyGone();
  if (cap.left <= 0) throw new GeminiError("Gemini kept failing, so the app stopped retrying. Try again in a moment.");
  let last: { status: number; body: unknown; raw: string } | null = null;
  let capped = false;
  for (let mi = 0; mi < models.length && !capped; mi++) {
    const model = models[mi];
    const url = new URL(o.endpoint ? `${GEMINI_BASE}/${o.endpoint}` : `${GEMINI_BASE}/models/${model}:${o.action}`);
    for (const [k, v] of Object.entries(o.params ?? {})) url.searchParams.set(k, v);
    let body = bodyFor(o, model);
    let res: Response | null = null;
    for (let attempt = 0; attempt < MODEL_ATTEMPTS; attempt++) {
      if (cap.left <= 0) {
        capped = true;
        break;
      }
      await checkBudget(s.dailyBudget);
      await pacer.acquire(pacer === textPacer ? s.rpm : 100, s.maxQuotaWait);
      cap.left--;
      await countCall("gemini", tag);
      try {
        res = await fetch(url, {
          method: "POST",
          headers: { "x-goog-api-key": s.geminiKey, "Content-Type": "application/json" },
          body,
          signal: o.signal,
        });
      } catch (e) {
        if ((e as Error).name === "AbortError") throw e;
        if (attempt === MODEL_ATTEMPTS - 1 || cap.left <= 0) {
          const code = ((e as { cause?: { code?: string } }).cause?.code ?? (e as Error).message ?? "").toString().slice(0, 60);
          throw new GeminiError(`Couldn't reach Gemini${code ? ` (${code})` : ""}. Check your internet connection and try again.`, null, true);
        }
        await sleep(2000 * (attempt + 1));
        continue;
      }
      if (res.ok) return res;
      const raw = await res.text();
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(raw);
      } catch {}
      last = { status: res.status, body: parsed, raw };
      if (thinkingRejected(res.status, raw) && !noThinking.has(model) && (o.body.generationConfig as Record<string, unknown> | undefined)?.thinkingConfig) {
        noThinking.add(model); // retry once on this model without the field
        body = bodyFor(o, model);
        cap.left++;
        continue;
      }
      if (res.status === 404) cap.left++; // a retired model name in the list should not eat the call's allowance
      if (res.status === 429) {
        const { delay, daily } = quotaInfo(parsed);
        if (daily) await markExhausted(model);
        if (!daily && attempt < MODEL_ATTEMPTS - 1 && delay != null && delay <= s.maxQuotaWait) {
          await sleep((delay + 0.5) * 1000);
          continue;
        }
        break;
      }
      if (RETRY_STATUSES.has(res.status) && attempt < MODEL_ATTEMPTS - 1) {
        await sleep(2000 * (attempt + 1));
        continue;
      }
      break;
    }
    // Next model on overload or quota; also on 404 so a retired name in the list doesn't stop the chain.
    if (last && (RETRY_STATUSES.has(last.status) || last.status === 429 || last.status === 404) && mi < models.length - 1) continue;
    break;
  }
  if (!last) throw new GeminiError("Gemini request failed.");
  const quota = last.status === 429 ? (quotaInfo(last.body).daily ? "day" : "minute") : null;
  throw new GeminiError(errorMessage(last.status, last.body, last.raw), quota, last.status === 429 || RETRY_STATUSES.has(last.status));
}

/** The main and backup model: tried first for everything. */
export function mainModels(s: Settings): string[] {
  return [s.model, ...(s.fallbackModel && s.fallbackModel !== s.model ? [s.fallbackModel] : [])];
}

/** Extra Gemini models tried last (each free model has its own daily quota; lite ones allow far more). */
export function liteModels(s: Settings): string[] {
  const main = new Set(mainModels(s));
  return [...new Set((s.extraModels ?? "").split(/[\s,]+/).map((m) => m.trim()).filter((m) => m && !main.has(m)))];
}

/**
 * Run Claude first when the student saved an Anthropic key and the request allows it; any Claude failure
 * (bad key, rate limit, overload, refusal, malformed output) falls through to `rest`, the Gemini chain.
 * With no Gemini key at all, the Claude error is what the student sees.
 */
async function claudeFirst<T>(
  s: Settings,
  r: { claude?: (key: string, model: string) => Promise<T>; claudeStrong?: boolean },
  rest: () => Promise<T>,
): Promise<T> {
  if (!r.claude || !s.anthropicKey) return rest();
  const model = (r.claudeStrong ? s.claudeStrongModel || CLAUDE_STRONG_DEFAULT : s.claudeFastModel || CLAUDE_FAST_DEFAULT).trim();
  try {
    return await r.claude(s.anthropicKey, model);
  } catch (ce) {
    if ((ce as Error).name === "AbortError") throw ce;
    if (!s.geminiKey)
      throw new GeminiError((ce as Error).message, ce instanceof ClaudeError && ce.kind === "rate" ? "minute" : null, true);
  }
  return rest();
}

/**
 * Where a text request goes: Claude first if the student added an Anthropic key and the request allows it,
 * then Gemini's main + backup model, then (out of quota, overloaded or unreachable) Cerebras if the
 * student added a key and the request allows it, then the extra Gemini models. If everything fails,
 * the first Gemini error is reported (it says why).
 */
export async function routed<T>(r: {
  tag?: string;
  gemini: (models: string[]) => Promise<T>;
  cerebras?: (key: string, model: string) => Promise<T>;
  claude?: (key: string, model: string) => Promise<T>;
  /** Use the stronger Claude model (exam marking, markscheme drafting). */
  claudeStrong?: boolean;
}): Promise<T> {
  const s = await getSettings();
  return claudeFirst(s, r, () => routedGemini(s, r));
}

async function routedGemini<T>(
  s: Settings,
  r: {
    tag?: string;
    gemini: (models: string[]) => Promise<T>;
    cerebras?: (key: string, model: string) => Promise<T>;
  },
): Promise<T> {
  try {
    return await r.gemini(mainModels(s));
  } catch (e) {
    if (!(e instanceof GeminiError) || !e.fallthrough) throw e;
    if (r.cerebras && s.cerebrasKey && s.cerebrasModel) {
      try {
        await countCall("cerebras", r.tag ?? "other");
        return await r.cerebras(s.cerebrasKey, s.cerebrasModel);
      } catch (ce) {
        if ((ce as Error).name === "AbortError") throw ce;
      }
    }
    if (e.budget) throw e; // the budget covers every Gemini model: don't try the extra ones
    // Out for the day with no second AI set up: say how to keep going.
    const hinted =
      e.quota === "day" && r.cerebras && !s.cerebrasKey
        ? new GeminiError(`${e.message} To keep going today, add a free Cerebras key in Settings → Extra free AI.`, e.quota, true)
        : e;
    const lite = liteModels(s);
    if (!lite.length) throw hinted;
    try {
      return await r.gemini(lite);
    } catch (le) {
      if ((le as Error).name === "AbortError") throw le;
      throw hinted;
    }
  }
}

type Part = Record<string, unknown>;

function candidateText(data: Record<string, unknown>): { text: string; finish: string | null } {
  const block = (data.promptFeedback as { blockReason?: string } | undefined)?.blockReason;
  if (block) throw new GeminiError(`Gemini blocked this request (${block}).`);
  const cand = (data.candidates as { content?: { parts?: Part[] }; finishReason?: string }[] | undefined)?.[0];
  if (!cand) throw new GeminiError("Gemini returned no answer.");
  const text = (cand.content?.parts ?? [])
    .filter((p) => !p.thought)
    .map((p) => (p.text as string) ?? "")
    .join("");
  return { text, finish: cand.finishReason ?? null };
}

/** One structured-output call (responseSchema). `ctx` is appended to the system prompt (IB conventions). */
export async function generateJson<T = Record<string, unknown>>(
  system: string,
  prompt: string,
  schema: Record<string, unknown>,
  /** geminiOnly: keep this on Gemini (exam marking, where the stronger model matters). */
  opts: {
    parts?: Part[];
    ctx?: string;
    signal?: AbortSignal;
    geminiOnly?: boolean;
    tag?: string;
    /** Estimated input size in tokens: above CEREBRAS_MAX_INPUT_TOKENS the request skips Cerebras (its context is too small). */
    inputTokens?: number;
    /** Gemini 3 thinking level (omit for the model's default). */
    thinking?: Thinking;
    /** Video/image token cost per frame (low cuts video tokens a lot). */
    mediaResolution?: "MEDIA_RESOLUTION_LOW" | "MEDIA_RESOLUTION_MEDIUM" | "MEDIA_RESOLUTION_HIGH";
  } = {},
): Promise<T> {
  const s = await getSettings();
  const body = {
    systemInstruction: { parts: [{ text: system + (opts.ctx ?? "") }] },
    contents: [{ role: "user", parts: [...(opts.parts ?? []), { text: prompt }] }],
    generationConfig: {
      ...(opts.mediaResolution ? { mediaResolution: opts.mediaResolution } : {}),
      maxOutputTokens: s.maxTokens,
      responseMimeType: "application/json",
      responseSchema: schema,
      ...(opts.thinking ? { thinkingConfig: { thinkingLevel: opts.thinking } } : {}),
    },
  };
  const cap = { left: CALL_CAP };
  const strong = !!opts.geminiOnly || opts.thinking === "medium";
  const viaGemini = async (models: string[]): Promise<T> => {
    let data: Record<string, unknown> | null = null;
    for (let attempt = 0; attempt <= JSON_RETRIES && !data; attempt++) {
      const res = await send({ models, action: "generateContent", body, signal: opts.signal, tag: opts.tag, cap });
      try {
        data = await res.json();
      } catch {
        if (attempt === JSON_RETRIES) throw new GeminiError("The connection to Gemini kept dropping. Try again in a moment.");
        await sleep(2000 * (attempt + 1));
      }
    }
    const gt = geminiTokens(data!.usageMetadata as Record<string, unknown> | undefined);
    if (gt) await recordTokens("gemini", opts.tag ?? "other", gt, strong);
    const { text, finish } = candidateText(data!);
    if (finish === "MAX_TOKENS")
      throw new GeminiError("The result was too long for the output limit. Ask for fewer items or a shorter length.");
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new GeminiError("Gemini returned malformed output. Please try again.");
    }
  };
  // Photos and files need Gemini; so does anything the caller marks geminiOnly.
  const textOnly = !opts.parts?.length && !opts.geminiOnly && !((opts.inputTokens ?? 0) > CEREBRAS_MAX_INPUT_TOKENS);
  return routed({
    tag: opts.tag,
    gemini: viaGemini,
    cerebras: textOnly ? (key, model) => cerebrasJson<T>(key, model, body, schema, opts.signal, { tag: opts.tag ?? "other", strong }) : undefined,
    // Claude takes text and photos; marking and medium-thinking work use the stronger model.
    claude: claudeCanTake(body) ? (key, model) => claudeJson<T>(key, model, body, schema, opts.tag ?? "other", opts.signal, strong) : undefined,
    claudeStrong: strong,
  });
}

/** One plain-text call (no schema), optionally with tools such as url_context. */
export async function generateText(
  system: string,
  prompt: string,
  opts: { parts?: Part[]; tools?: Part[]; signal?: AbortSignal; tag?: string; thinking?: Thinking } = {},
): Promise<{ text: string; finish: string | null }> {
  const s = await getSettings();
  const body: Record<string, unknown> = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts: [...(opts.parts ?? []), { text: prompt }] }],
    generationConfig: {
      maxOutputTokens: s.maxTokens,
      ...(opts.thinking ? { thinkingConfig: { thinkingLevel: opts.thinking } } : {}),
    },
  };
  if (opts.tools) body.tools = opts.tools;
  const models = mainModels(s).concat(liteModels(s));
  const cap = { left: CALL_CAP };
  const viaGemini = async () => {
    for (let attempt = 0; ; attempt++) {
      const res = await send({ models, action: "generateContent", body, signal: opts.signal, tag: opts.tag, cap });
      try {
        const data = await res.json();
        const gt = geminiTokens(data.usageMetadata);
        if (gt) await recordTokens("gemini", opts.tag ?? "other", gt, opts.thinking === "medium");
        return candidateText(data);
      } catch (e) {
        if (e instanceof GeminiError) throw e;
        if (attempt === JSON_RETRIES) throw new GeminiError("The connection to Gemini kept dropping. Try again in a moment.");
        await sleep(2000 * (attempt + 1));
      }
    }
  };
  // url_context, transcripts and any other file/photo input stay on Gemini.
  const plain = !opts.tools && !opts.parts?.length;
  return claudeFirst(
    s,
    {
      claude: plain ? (key, model) => claudeText(key, model, body, opts.tag ?? "other", opts.signal, opts.thinking === "medium") : undefined,
      claudeStrong: opts.thinking === "medium",
    },
    viaGemini,
  );
}

/** True when any message carries a photo or file (inlineData / fileData), which Cerebras can't read. */
function hasMedia(body: Record<string, unknown>): boolean {
  const contents = (body.contents as { parts?: Record<string, unknown>[] }[] | undefined) ?? [];
  return contents.some((c) => (c.parts ?? []).some((p) => p.inlineData || p.fileData));
}

/** Stream a chat answer (SSE). Yields text pieces (thoughts skipped) and the final finish reason. */
export async function* streamGenerate(
  body: Record<string, unknown>,
  signal?: AbortSignal,
  opts: { tag?: string; thinking?: Thinking } = {},
): AsyncGenerator<{ text?: string; finish?: string | null }> {
  if (opts.thinking)
    body = { ...body, generationConfig: { ...(body.generationConfig as object), thinkingConfig: { thinkingLevel: opts.thinking } } };
  const cap = { left: CALL_CAP };
  const meta = { tag: opts.tag ?? "other", strong: opts.thinking === "medium" };
  const opened = await routed<{ res: Response; who: "gemini" | "cerebras" | "claude" }>({
    tag: opts.tag,
    gemini: (models) =>
      send({ models, action: "streamGenerateContent", params: { alt: "sse" }, body, signal, tag: opts.tag, cap }).then((res) => ({ res, who: "gemini" as const })),
    // Cerebras is text only: a question with photos stays on Claude / Gemini.
    cerebras: hasMedia(body) ? undefined : (key, model) => cerebrasOpenStream(key, model, body, signal).then((res) => ({ res, who: "cerebras" as const })),
    claude: claudeCanTake(body)
      ? (key, model) => claudeOpenStream(key, model, body, opts.tag ?? "other", signal).then((res) => ({ res, who: "claude" as const }))
      : undefined,
    claudeStrong: opts.thinking === "medium",
  });
  if (opened.who === "cerebras") {
    yield* cerebrasStream(opened.res, meta);
    return;
  }
  if (opened.who === "claude") {
    yield* claudeStream(opened.res, meta);
    return;
  }
  const res = opened.res;
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let finish: string | null = null;
  let usage: Record<string, unknown> | undefined; // the last chunk carries the totals
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith("data:")) continue;
      const data = JSON.parse(line.slice(5).trim());
      if (data.usageMetadata) usage = data.usageMetadata;
      const block = data.promptFeedback?.blockReason;
      if (block) throw new GeminiError(`Gemini blocked this request (${block}).`);
      for (const cand of data.candidates ?? []) {
        for (const p of cand.content?.parts ?? []) if (p.text && !p.thought) yield { text: p.text };
        finish = cand.finishReason ?? finish;
      }
    }
  }
  const gt = geminiTokens(usage);
  if (gt) await recordTokens("gemini", meta.tag, gt, meta.strong);
  yield { finish };
}

/** Embed texts for search. Batches of ≤100 per request; returns unit-length vectors. */
/** Gemini embeddings. No longer used for search or indexing (those run on the device); kept for reference. */
const GEMINI_EMBED_DIM = 768;
export async function embed(
  texts: string[],
  task: "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY",
  opts: { tag?: string } = {},
): Promise<Float32Array[]> {
  const s = await getSettings();
  const out: Float32Array[] = [];
  for (let i = 0; i < texts.length; i += 100) {
    const batch = texts.slice(i, i + 100);
    const res = await send({
      models: [s.embedModel],
      action: "batchEmbedContents",
      pacer: embedPacer,
      tag: opts.tag,
      cap: { left: BATCH_CAP },
      body: {
        requests: batch.map((t) => ({
          model: `models/${s.embedModel}`,
          content: { parts: [{ text: t }] },
          taskType: task,
          outputDimensionality: GEMINI_EMBED_DIM,
        })),
      },
    });
    const data = (await res.json()) as { embeddings: { values: number[] }[] };
    for (const e of data.embeddings) out.push(normalize(e.values));
  }
  return out;
}

function normalize(v: number[]): Float32Array {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  return Float32Array.from(v, (x) => x / n);
}

/** Speech via the Interactions API: one text item per line tagged with its speaker → 24 kHz l16 PCM. */
export async function speak(
  lines: { speaker: string; text: string }[],
  speakers: string[],
  voices: Record<string, string>,
  opts: { tag?: string } = {},
): Promise<{ pcm: Uint8Array; rate: number }> {
  const s = await getSettings();
  const single = speakers.length === 1;
  const body = {
    input: [
      {
        type: "user_input",
        content: lines.map((ln) =>
          single
            ? { type: "text", text: ln.text }
            : { type: "text", text: ln.text, annotations: [{ type: "speech_metadata", speaker: ln.speaker }] },
        ),
      },
    ],
    response_format: { type: "audio", mime_type: "audio/l16", sample_rate: 24000 },
    generation_config: {
      speech_config: single
        ? [{ voice: voices[speakers[0]] ?? "Kore" }]
        : { mode: "conversational", speakers: speakers.map((sp) => ({ speaker: sp, voice: voices[sp] ?? "Kore" })) },
    },
  };
  const res = await send({ models: [s.ttsModel], endpoint: "interactions", body, tag: opts.tag ?? "audio", cap: { left: BATCH_CAP } });
  const data = await res.json();
  const chunks: Uint8Array[] = [];
  let rate = 24000;
  for (const step of data.steps ?? [])
    for (const c of step.content ?? [])
      if (c.type === "audio") {
        rate = c.sample_rate ?? rate;
        chunks.push(Uint8Array.from(atob(c.data), (ch) => ch.charCodeAt(0)));
      }
  if (!chunks.length) throw new GeminiError("Gemini's speech model returned no audio.");
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const pcm = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    pcm.set(c, off);
    off += c.length;
  }
  return { pcm, rate };
}

/**
 * Upload a big file (lecture recording) with the Files API's resumable protocol, then wait until
 * Gemini has processed it. Returns the file URI to reference in a request.
 */
export async function uploadFile(
  blob: Blob,
  mime: string,
  name: string,
  onProgress?: (f: number, stage: string) => void,
  opts: { tag?: string } = {},
): Promise<string> {
  const s = await getSettings();
  if (!s.geminiKey) throw new GeminiError("Add your free Gemini API key in Settings first.");
  const tag = opts.tag ?? "recording";
  await checkBudget(s.dailyBudget);
  await countCall("gemini", tag);
  const start = await fetch("https://generativelanguage.googleapis.com/upload/v1beta/files", {
    method: "POST",
    headers: {
      "x-goog-api-key": s.geminiKey,
      "X-Goog-Upload-Protocol": "resumable",
      "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": String(blob.size),
      "X-Goog-Upload-Header-Content-Type": mime,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ file: { display_name: name.slice(0, 100) } }),
  });
  const uploadUrl = start.headers.get("x-goog-upload-url");
  if (!start.ok || !uploadUrl) throw new GeminiError(`Couldn't start the upload to Gemini (${start.status}).`);

  // Upload in 8 MB pieces so progress can be shown and a 300 MB file never sits in memory twice.
  const CHUNK = 8 * 1024 * 1024;
  let offset = 0;
  let fileInfo: { name: string; uri: string; state: string } | null = null;
  while (offset < blob.size || blob.size === 0) {
    const end = Math.min(blob.size, offset + CHUNK);
    const last = end >= blob.size;
    const res = await fetch(uploadUrl, {
      method: "POST",
      headers: {
        "X-Goog-Upload-Offset": String(offset),
        "X-Goog-Upload-Command": last ? "upload, finalize" : "upload",
      },
      body: blob.slice(offset, end),
    });
    if (!res.ok) throw new GeminiError(`Upload to Gemini failed (${res.status}). Try again.`);
    offset = end;
    onProgress?.(blob.size ? offset / blob.size : 1, "Uploading");
    if (last) {
      fileInfo = (await res.json()).file;
      break;
    }
  }
  let info = fileInfo as { name: string; uri: string; state: string } | null;
  if (!info) throw new GeminiError("Upload to Gemini didn't finish.");
  for (let i = 0; info.state === "PROCESSING" && i < 240; i++) {
    onProgress?.(1, "Gemini is processing the file");
    await sleep(5000);
    const r: Response = await fetch(`${GEMINI_BASE}/${info.name}`, { headers: { "x-goog-api-key": s.geminiKey } });
    info = (await r.json()) as { name: string; uri: string; state: string };
  }
  const fileInfo2 = info;
  if (fileInfo2.state !== "ACTIVE") throw new GeminiError("Gemini couldn't process that file.");
  return fileInfo2.uri;
}

/** Check a key by listing one model (no quota used). Returns an error message, or null if it works. */
export async function checkKey(key: string): Promise<string | null> {
  try {
    const r = await fetch(`${GEMINI_BASE}/models?pageSize=1`, { headers: { "x-goog-api-key": key.trim() } });
    if (r.ok) return null;
    return r.status === 400 || r.status === 403 ? "Google rejected that key. Copy it again from aistudio.google.com." : `Gemini answered ${r.status}.`;
  } catch {
    return "Couldn't reach Gemini. Check your internet connection.";
  }
}
