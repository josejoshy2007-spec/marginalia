/**
 * Gemini REST client used directly from the device with the student's own key (Gemini allows
 * browser calls: CORS is open for the x-goog-api-key header). Port of the old backend's
 * gemini.py/generate.py resilience: free-tier pacing, retries on 500/503 and short 429s using
 * Google's RetryInfo delay, fallback to a second model when one is overloaded or its daily quota
 * is spent, and retries of dropped connections.
 */
import { GEMINI_BASE, EMBED_DIM, getSettings, type Settings } from "./settings";

export class GeminiError extends Error {
  /** "minute": a per-minute quota (waiting a minute helps); "day": the daily quota is spent. */
  constructor(
    message: string,
    public quota: "minute" | "day" | null = null,
  ) {
    super(message);
  }
}

/**
 * Run `fn`, and if it hits a per-minute quota wait a minute and try again (up to `tries` times).
 * For long background jobs (indexing a textbook, transcribing a lecture) where waiting beats failing.
 */
export async function patiently<T>(fn: () => Promise<T>, tries = 6, onWait?: () => void): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (!(e instanceof GeminiError) || e.quota !== "minute" || i >= tries) throw e;
      onWait?.();
      await sleep(62_000);
    }
  }
}

const RETRIES = 2;
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
    if (daily) return "Gemini's free daily quota is used up (main and backup model). It resets at midnight Pacific time.";
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
};

/** POST with pacing, retries and model fallback. Returns an OK Response or throws GeminiError. */
export async function send(o: SendOpts): Promise<Response> {
  const s = await getSettings();
  if (!s.geminiKey) throw new GeminiError("Add your free Gemini API key in Settings first (aistudio.google.com → Get API key).");
  const pacer = o.pacer ?? textPacer;
  let last: { status: number; body: unknown; raw: string } | null = null;
  for (let mi = 0; mi < o.models.length; mi++) {
    const model = o.models[mi];
    const url = new URL(o.endpoint ? `${GEMINI_BASE}/${o.endpoint}` : `${GEMINI_BASE}/models/${model}:${o.action}`);
    for (const [k, v] of Object.entries(o.params ?? {})) url.searchParams.set(k, v);
    const body = JSON.stringify(o.endpoint ? { ...o.body, model } : o.body);
    let res: Response | null = null;
    for (let attempt = 0; attempt <= RETRIES; attempt++) {
      await pacer.acquire(pacer === textPacer ? s.rpm : 100, s.maxQuotaWait);
      try {
        res = await fetch(url, {
          method: "POST",
          headers: { "x-goog-api-key": s.geminiKey, "Content-Type": "application/json" },
          body,
          signal: o.signal,
        });
      } catch (e) {
        if ((e as Error).name === "AbortError") throw e;
        if (attempt === RETRIES) {
          const code = ((e as { cause?: { code?: string } }).cause?.code ?? (e as Error).message ?? "").toString().slice(0, 60);
          throw new GeminiError(`Couldn't reach Gemini${code ? ` (${code})` : ""}. Check your internet connection and try again.`);
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
      if (res.status === 429 && attempt < RETRIES) {
        const { delay, daily } = quotaInfo(parsed);
        if (!daily && delay != null && delay <= s.maxQuotaWait) {
          await sleep((delay + 0.5) * 1000);
          continue;
        }
        break;
      }
      if (RETRY_STATUSES.has(res.status) && attempt < RETRIES) {
        await sleep(2000 * (attempt + 1));
        continue;
      }
      break;
    }
    if (last && (RETRY_STATUSES.has(last.status) || last.status === 429) && mi < o.models.length - 1) continue;
    break;
  }
  if (!last) throw new GeminiError("Gemini request failed.");
  const quota = last.status === 429 ? (quotaInfo(last.body).daily ? "day" : "minute") : null;
  throw new GeminiError(errorMessage(last.status, last.body, last.raw), quota);
}

export async function textModels(s?: Settings): Promise<string[]> {
  s = s ?? (await getSettings());
  return [s.model, ...(s.fallbackModel && s.fallbackModel !== s.model ? [s.fallbackModel] : [])];
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
  opts: { parts?: Part[]; ctx?: string; signal?: AbortSignal } = {},
): Promise<T> {
  const s = await getSettings();
  const body = {
    systemInstruction: { parts: [{ text: system + (opts.ctx ?? "") }] },
    contents: [{ role: "user", parts: [...(opts.parts ?? []), { text: prompt }] }],
    generationConfig: { maxOutputTokens: s.maxTokens, responseMimeType: "application/json", responseSchema: schema },
  };
  let data: Record<string, unknown> | null = null;
  for (let attempt = 0; attempt <= RETRIES && !data; attempt++) {
    const res = await send({ models: await textModels(s), action: "generateContent", body, signal: opts.signal });
    try {
      data = await res.json();
    } catch {
      if (attempt === RETRIES) throw new GeminiError("The connection to Gemini kept dropping. Try again in a moment.");
      await sleep(2000 * (attempt + 1));
    }
  }
  const { text, finish } = candidateText(data!);
  if (finish === "MAX_TOKENS")
    throw new GeminiError("The result was too long for the output limit. Ask for fewer items or a shorter length.");
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new GeminiError("Gemini returned malformed output. Please try again.");
  }
}

/** One plain-text call (no schema), optionally with tools such as url_context. */
export async function generateText(
  system: string,
  prompt: string,
  opts: { parts?: Part[]; tools?: Part[]; signal?: AbortSignal } = {},
): Promise<{ text: string; finish: string | null }> {
  const s = await getSettings();
  const body: Record<string, unknown> = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts: [...(opts.parts ?? []), { text: prompt }] }],
    generationConfig: { maxOutputTokens: s.maxTokens },
  };
  if (opts.tools) body.tools = opts.tools;
  for (let attempt = 0; ; attempt++) {
    const res = await send({ models: await textModels(s), action: "generateContent", body, signal: opts.signal });
    try {
      return candidateText(await res.json());
    } catch (e) {
      if (e instanceof GeminiError) throw e;
      if (attempt === RETRIES) throw new GeminiError("The connection to Gemini kept dropping. Try again in a moment.");
      await sleep(2000 * (attempt + 1));
    }
  }
}

/** Stream a chat answer (SSE). Yields text pieces (thoughts skipped) and the final finish reason. */
export async function* streamGenerate(
  body: Record<string, unknown>,
  signal?: AbortSignal,
): AsyncGenerator<{ text?: string; finish?: string | null }> {
  const res = await send({
    models: await textModels(),
    action: "streamGenerateContent",
    params: { alt: "sse" },
    body,
    signal,
  });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let finish: string | null = null;
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
      const block = data.promptFeedback?.blockReason;
      if (block) throw new GeminiError(`Gemini blocked this request (${block}).`);
      for (const cand of data.candidates ?? []) {
        for (const p of cand.content?.parts ?? []) if (p.text && !p.thought) yield { text: p.text };
        finish = cand.finishReason ?? finish;
      }
    }
  }
  yield { finish };
}

/** Embed texts for search. Batches of ≤100 per request; returns unit-length vectors. */
export async function embed(texts: string[], task: "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY"): Promise<Float32Array[]> {
  const s = await getSettings();
  const out: Float32Array[] = [];
  for (let i = 0; i < texts.length; i += 100) {
    const batch = texts.slice(i, i + 100);
    const res = await send({
      models: [s.embedModel],
      action: "batchEmbedContents",
      pacer: embedPacer,
      body: {
        requests: batch.map((t) => ({
          model: `models/${s.embedModel}`,
          content: { parts: [{ text: t }] },
          taskType: task,
          outputDimensionality: EMBED_DIM,
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
  const res = await send({ models: [s.ttsModel], endpoint: "interactions", body });
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
): Promise<string> {
  const s = await getSettings();
  if (!s.geminiKey) throw new GeminiError("Add your free Gemini API key in Settings first.");
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
