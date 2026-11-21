/**
 * Claude (Anthropic Messages API): an optional paid provider tried FIRST for text, JSON, chat streaming
 * and photo work when the student saves their own key. Gemini (then Cerebras, then the extra models)
 * stays the fallback. Called straight from the device with the browser opt-in header, so the key
 * lives only on this device and is never logged.
 *
 * Gemini request bodies are translated here (systemInstruction, contents with roles, inlineData images,
 * generationConfig.maxOutputTokens / responseSchema / thinkingLevel), so callers keep building one
 * Gemini-shaped body. Failures are ClaudeError: the router in gemini.ts treats any of them as
 * "try the next provider".
 */
import { fitSchema, parseJsonReply, schemaText } from "./cerebras";
import { claudeTokens, countCall, recordTokens, type UsageMeta } from "./usage";

export const ANTHROPIC_BASE = "https://api.anthropic.com/v1";
/** Version header value from the Claude API reference (curl examples). */
export const ANTHROPIC_VERSION = "2023-06-01";
export const CLAUDE_FAST_DEFAULT = "claude-haiku-5-5";
export const CLAUDE_STRONG_DEFAULT = "claude-sonnet-5-5";

/** Output cap per request (thinking counts toward it). */
const MAX_OUT_CAP = 64000;
const DEFAULT_OUT = 16000;

type Rec = Record<string, any>;

/** Tests set `scale` to 0 so retries don't wait. */
export const claudeTuning = { scale: 1 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms * claudeTuning.scale));

export class ClaudeError extends Error {
  constructor(
    message: string,
    public status = 0,
    /** "auth": bad key; "rate": 429; "overloaded": 529/5xx; "refused"/"cutoff": the answer is unusable; "other". */
    public kind: "auth" | "rate" | "overloaded" | "refused" | "cutoff" | "other" = "other",
    public retryAfter: number | null = null,
  ) {
    super(message);
  }
}

// ---- translating a Gemini body ----

const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

/** True when every part is text, an image or a PDF (audio/video/fileData stay on Gemini). */
export function claudeCanTake(body: Rec): boolean {
  for (const c of body.contents ?? [])
    for (const p of c.parts ?? []) {
      if (typeof p.text === "string") continue;
      const mime = String(p.inlineData?.mimeType ?? "").toLowerCase();
      if (p.inlineData && (IMAGE_TYPES.has(mime) || mime === "application/pdf")) continue;
      return false;
    }
  return true;
}

function toBlock(p: Rec): Rec | null {
  if (typeof p.text === "string") return p.text ? { type: "text", text: p.text } : null;
  const mime = String(p.inlineData?.mimeType ?? "").toLowerCase();
  const source = { type: "base64", media_type: mime, data: p.inlineData?.data };
  return { type: mime === "application/pdf" ? "document" : "image", source };
}

/** Gemini `{systemInstruction, contents}` → Messages API `{system, messages}`. */
export function toClaudeMessages(body: Rec): { system: string; messages: Rec[] } {
  const system = ((body.systemInstruction?.parts ?? []) as Rec[]).map((p) => (typeof p.text === "string" ? p.text : "")).join("");
  const messages: Rec[] = [];
  for (const c of body.contents ?? []) {
    const content = ((c.parts ?? []) as Rec[]).map(toBlock).filter(Boolean) as Rec[];
    if (!content.length) continue;
    // Images go before the text that asks about them.
    content.sort((a, b) => Number(a.type === "text") - Number(b.type === "text"));
    messages.push({ role: c.role === "model" ? "assistant" : "user", content });
  }
  return { system, messages };
}

/** Gemini's response schema (types in capitals) → JSON Schema with every property required, as structured output needs. */
export function toJsonSchema(s: Rec): Rec {
  const t = String(s?.type ?? "").toLowerCase();
  const out: Rec = {};
  if (t) out.type = t;
  if (typeof s?.description === "string") out.description = s.description;
  if (Array.isArray(s?.enum)) out.enum = s.enum;
  if (t === "object") {
    const props = Object.fromEntries(Object.entries((s.properties ?? {}) as Rec).map(([k, v]) => [k, toJsonSchema(v)]));
    out.properties = props;
    out.required = Object.keys(props);
    out.additionalProperties = false;
  } else if (t === "array") out.items = toJsonSchema(s.items ?? {});
  return out;
}

/** Gemini thinking level → Claude effort (thinking itself is left at the model's adaptive default). */
function effortFor(body: Rec): "low" | "medium" | "high" | null {
  const lvl = body.generationConfig?.thinkingConfig?.thinkingLevel;
  return lvl === "minimal" || lvl === "low" ? "low" : lvl === "medium" ? "medium" : lvl === "high" ? "high" : null;
}

function request(model: string, body: Rec, extra: Rec = {}, extraSystem = ""): Rec {
  const { system, messages } = toClaudeMessages(body);
  const maxOut = Math.min(Number(body.generationConfig?.maxOutputTokens) || DEFAULT_OUT, MAX_OUT_CAP);
  const effort = effortFor(body);
  const outputConfig = { ...(effort ? { effort } : {}), ...(extra.output_config ?? {}) };
  const { output_config: _o, ...rest } = extra;
  return {
    model,
    max_tokens: maxOut,
    ...((system + extraSystem) ? { system: system + extraSystem } : {}),
    messages,
    ...(Object.keys(outputConfig).length ? { output_config: outputConfig } : {}),
    ...rest,
  };
}

// ---- HTTP ----

function failure(status: number, raw: string, retryAfter: number | null): ClaudeError {
  let type = "";
  let msg = raw.slice(0, 200);
  try {
    const e = JSON.parse(raw)?.error;
    type = String(e?.type ?? "");
    msg = String(e?.message ?? msg);
  } catch {}
  if (status === 401 || status === 403 || type === "authentication_error" || type === "permission_error")
    return new ClaudeError("Your Anthropic (Claude) key was rejected. Check it in Settings.", status, "auth");
  if (status === 429 || type === "rate_limit_error") return new ClaudeError(`Claude's rate limit was reached. ${msg}`, 429, "rate", retryAfter);
  if (status === 529 || status >= 500 || type === "overloaded_error")
    return new ClaudeError("Claude is overloaded right now.", status, "overloaded", retryAfter);
  return new ClaudeError(`Claude API error (${status}): ${msg}`, status, "other");
}

/** One counted POST to /messages with a single retry for 429 (short retry-after) and overload. Returns an OK Response. */
async function post(key: string, payload: Rec, tag: string, signal?: AbortSignal): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    await countCall("claude", tag);
    let res: Response;
    try {
      res = await fetch(`${ANTHROPIC_BASE}/messages`, {
        method: "POST",
        headers: {
          "x-api-key": key,
          "anthropic-version": ANTHROPIC_VERSION,
          "anthropic-dangerous-direct-browser-access": "true",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        signal,
      });
    } catch (e) {
      if ((e as Error).name === "AbortError") throw e;
      if (attempt === 0) {
        await sleep(2000);
        continue;
      }
      throw new ClaudeError("Couldn't reach Claude. Check your internet connection.", 0, "overloaded");
    }
    if (res.ok) return res;
    const raw = await res.text();
    const ra = Number(res.headers.get("retry-after"));
    const err = failure(res.status, raw, Number.isFinite(ra) && ra > 0 ? ra : null);
    const retryable = err.kind === "overloaded" || (err.kind === "rate" && err.retryAfter != null && err.retryAfter <= 20);
    if (attempt === 0 && retryable) {
      await sleep(err.kind === "rate" ? (err.retryAfter ?? 1) * 1000 + 500 : 2000);
      continue;
    }
    throw err;
  }
}

const textOf = (data: Rec) => ((data.content ?? []) as Rec[]).filter((b) => b.type === "text").map((b) => String(b.text ?? "")).join("");

/** Claude stop reason → Gemini finish reason. */
export function finishFor(stop: string | null | undefined): string | null {
  if (!stop) return null;
  if (stop === "max_tokens" || stop === "model_context_window_exceeded") return "MAX_TOKENS";
  if (stop === "refusal") return "SAFETY";
  return "STOP"; // end_turn, stop_sequence, tool_use, pause_turn
}

/** A structured-output call: JSON Schema output format, then fitted to the schema like Cerebras/Gemini results. */
export async function claudeJson<T>(key: string, model: string, body: Rec, schema: Rec, tag: string, signal?: AbortSignal, strong = false): Promise<T> {
  const run = async (payload: Rec) => {
    const data = await (await post(key, payload, tag, signal)).json();
    const ut = claudeTokens(data.usage);
    if (ut) await recordTokens("claude", tag, ut, strong);
    const finish = finishFor(data.stop_reason);
    if (finish === "SAFETY") throw new ClaudeError("Claude declined this request.", 200, "refused");
    if (finish === "MAX_TOKENS") throw new ClaudeError("Claude ran out of output space.", 200, "cutoff");
    const text = textOf(data);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      try {
        parsed = parseJsonReply(text);
      } catch {
        throw new ClaudeError("Claude returned malformed output.", 200, "other");
      }
    }
    return fitSchema(schema, parsed) as T;
  };
  try {
    return await run(request(model, body, { output_config: { format: { type: "json_schema", schema: toJsonSchema(schema) } } }));
  } catch (e) {
    // A schema the structured-output mode rejects: ask for the same JSON in the prompt instead.
    if (e instanceof ClaudeError && e.status === 400 && /schema|format|output_config/i.test(e.message))
      return run(
        request(
          model,
          body,
          {},
          "\n\nReply with a single JSON object and nothing else. It must match this JSON Schema, with every property present " +
            `(use [] or "" or 0 when one doesn't apply):\n${schemaText(schema)}`,
        ),
      );
    throw e;
  }
}

/** A plain-text call. */
export async function claudeText(key: string, model: string, body: Rec, tag: string, signal?: AbortSignal, strong = false): Promise<{ text: string; finish: string | null }> {
  const data = await (await post(key, request(model, body), tag, signal)).json();
  const ut = claudeTokens(data.usage);
  if (ut) await recordTokens("claude", tag, ut, strong);
  const finish = finishFor(data.stop_reason);
  if (finish === "SAFETY") throw new ClaudeError("Claude declined this request.", 200, "refused");
  return { text: textOf(data), finish };
}

/** Open a streamed chat request (resolves once the answer starts, so a failure can still fall back). */
export function claudeOpenStream(key: string, model: string, body: Rec, tag: string, signal?: AbortSignal): Promise<Response> {
  return post(key, request(model, body, { stream: true }), tag, signal);
}

/** A streamed answer; yields text pieces and finally the finish reason in Gemini's words. */
export async function* claudeStream(res: Response, meta?: UsageMeta): AsyncGenerator<{ text?: string; finish?: string | null }> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let finish: string | null = null;
  const usage: Rec = {}; // message_start carries the input tokens, message_delta the running output total
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith("data:")) continue;
      const ev = JSON.parse(line.slice(5).trim());
      if (ev.type === "error") throw new ClaudeError(`Claude: ${ev.error?.message ?? "stream error"}`, 0, ev.error?.type === "overloaded_error" ? "overloaded" : "other");
      if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta" && ev.delta.text) yield { text: ev.delta.text };
      if (ev.type === "message_start" && ev.message?.usage) Object.assign(usage, ev.message.usage);
      if (ev.type === "message_delta" && ev.usage) Object.assign(usage, ev.usage);
      if (ev.type === "message_delta" && ev.delta?.stop_reason) finish = finishFor(ev.delta.stop_reason);
    }
  }
  const ut = claudeTokens(usage);
  if (ut && meta) await recordTokens("claude", meta.tag, ut, meta.strong);
  yield { finish };
}

/** Check a key and model with a free metadata call (no tokens used). Returns an error message, or null if it works. */
export async function checkAnthropicKey(key: string, model = CLAUDE_FAST_DEFAULT): Promise<string | null> {
  try {
    const r = await fetch(`${ANTHROPIC_BASE}/models/${encodeURIComponent(model || CLAUDE_FAST_DEFAULT)}`, {
      headers: { "x-api-key": key.trim(), "anthropic-version": ANTHROPIC_VERSION, "anthropic-dangerous-direct-browser-access": "true" },
    });
    if (r.ok) return null;
    if (r.status === 401 || r.status === 403) return "Anthropic rejected that key. Copy it again from console.anthropic.com.";
    if (r.status === 404) return `That key works, but the model "${model}" wasn't found. Check the model name.`;
    return `Anthropic answered ${r.status}.`;
  } catch {
    return "Couldn't reach Anthropic. Check your internet connection.";
  }
}
