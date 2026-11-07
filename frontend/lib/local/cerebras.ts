/**
 * Cerebras: an optional second free AI (about 30 requests/min and 14,400/day, no card) that takes
 * over text-only work when Gemini's free quota runs out. OpenAI-compatible chat completions, called
 * straight from the device with the student's own key (CORS is open). Groq offers the same, but it
 * blocks the student's network ("Access denied"), so Cerebras it is.
 *
 * Gemini request bodies are translated here, so callers keep building one Gemini-shaped body.
 * Errors are plain Errors: the router in gemini.ts treats any failure here as "try the next model".
 */
export const CEREBRAS_BASE = "https://api.cerebras.ai/v1";

/** Preferred models, best first; the first one the key can use is saved on "Save key". */
export const CEREBRAS_PREFERRED = [
  "gpt-oss-120b",
  "qwen-3-235b-a22b-instruct-2507",
  "llama-3.3-70b",
  "llama3.3-70b",
  "llama-4-maverick-17b-128e-instruct",
  "qwen-3-32b",
  "llama-4-scout-17b-16e-instruct",
  "llama3.1-8b",
];

/** Output cap per request; the free tier rejects larger ones on some models (then Gemini lite takes over). */
const MAX_OUT = 8192;

type Rec = Record<string, any>;
type Msg = { role: "system" | "user" | "assistant"; content: string };

const partsText = (parts: Rec[] | undefined) => (parts ?? []).map((p) => (typeof p.text === "string" ? p.text : "")).join("");

/** Gemini `{systemInstruction, contents}` → OpenAI messages. */
export function toMessages(body: Rec, extraSystem = ""): Msg[] {
  const msgs: Msg[] = [];
  const sys = partsText(body.systemInstruction?.parts) + extraSystem;
  if (sys) msgs.push({ role: "system", content: sys });
  for (const c of body.contents ?? []) msgs.push({ role: c.role === "model" ? "assistant" : "user", content: partsText(c.parts) });
  return msgs;
}

/** Gemini's response schema (types in capitals) as standard JSON Schema text, for the prompt. */
export function schemaText(schema: Rec): string {
  return JSON.stringify(schema).replace(/"type":"([A-Z]+)"/g, (_, t: string) => `"type":"${t.toLowerCase()}"`);
}

/**
 * Make a parsed reply fit the schema the callers expect: Gemini's schema mode fills every field,
 * other models sometimes leave one out or send "3" for 3. Missing arrays → [], strings → "", numbers → 0.
 */
export function fitSchema(schema: Rec, v: unknown): unknown {
  const t = String(schema?.type ?? "").toLowerCase();
  if (t === "object") {
    const o: Rec = v && typeof v === "object" && !Array.isArray(v) ? { ...(v as Rec) } : {};
    for (const [k, sub] of Object.entries((schema.properties ?? {}) as Rec)) o[k] = fitSchema(sub, o[k]);
    return o;
  }
  if (t === "array") return Array.isArray(v) ? v.map((x) => fitSchema(schema.items ?? {}, x)) : [];
  if (t === "string") return typeof v === "string" ? v : v == null ? "" : String(v);
  if (t === "integer" || t === "number") {
    const n = Number(v);
    return Number.isFinite(n) ? (t === "integer" ? Math.round(n) : n) : 0;
  }
  if (t === "boolean") return typeof v === "boolean" ? v : v === "true";
  return v;
}

/** Pull the JSON object out of a reply, tolerating ```json fences or a sentence around it. */
export function parseJsonReply(text: string): unknown {
  const t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(t);
  } catch {
    const a = t.indexOf("{");
    const b = t.lastIndexOf("}");
    if (a >= 0 && b > a) return JSON.parse(t.slice(a, b + 1));
    throw new Error("Cerebras returned malformed output.");
  }
}

async function post(key: string, model: string, messages: Msg[], extra: Rec, signal?: AbortSignal): Promise<Response> {
  const res = await fetch(`${CEREBRAS_BASE}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages, max_completion_tokens: MAX_OUT, ...extra }),
    signal,
  });
  if (!res.ok) throw new Error(`Cerebras answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res;
}

/** A structured-output call: the schema goes in the prompt, JSON mode on, then fitted to the schema. */
export async function cerebrasJson<T>(key: string, model: string, body: Rec, schema: Rec, signal?: AbortSignal): Promise<T> {
  const msgs = toMessages(
    body,
    "\n\nReply with a single JSON object and nothing else. It must match this JSON Schema, with every " +
      `property present (use [] or "" or 0 when one doesn't apply):\n${schemaText(schema)}`,
  );
  const res = await post(key, model, msgs, { response_format: { type: "json_object" } }, signal);
  const data = await res.json();
  const choice = data.choices?.[0];
  if (choice?.finish_reason === "length") throw new Error("Cerebras ran out of output space.");
  return fitSchema(schema, parseJsonReply(String(choice?.message?.content ?? ""))) as T;
}

/** A streamed chat answer; yields text pieces and finally the finish reason in Gemini's words. */
export async function* cerebrasStream(res: Response): AsyncGenerator<{ text?: string; finish?: string | null }> {
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
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") continue;
      const data = JSON.parse(payload);
      if (data.error) throw new Error(`Cerebras: ${data.error.message ?? "stream error"}`);
      for (const c of data.choices ?? []) {
        if (c.delta?.content) yield { text: c.delta.content };
        if (c.finish_reason) finish = c.finish_reason === "length" ? "MAX_TOKENS" : c.finish_reason === "content_filter" ? "SAFETY" : "STOP";
      }
    }
  }
  yield { finish };
}

/** Open a streamed chat request (resolves once the answer starts, so a failure can still fall back). */
export function cerebrasOpenStream(key: string, model: string, body: Rec, signal?: AbortSignal): Promise<Response> {
  return post(key, model, toMessages(body), { stream: true }, signal);
}

/** Check a key and pick the best model it can use. */
export async function checkCerebrasKey(key: string): Promise<{ model: string } | { error: string }> {
  try {
    const r = await fetch(`${CEREBRAS_BASE}/models`, { headers: { Authorization: `Bearer ${key.trim()}` } });
    if (r.status === 401 || r.status === 403) return { error: "Cerebras rejected that key. Copy it again from cloud.cerebras.ai." };
    if (!r.ok) return { error: `Cerebras answered ${r.status}.` };
    const ids: string[] = ((await r.json()).data ?? []).map((m: Rec) => String(m.id));
    const model = CEREBRAS_PREFERRED.find((m) => ids.includes(m)) ?? ids[0];
    return model ? { model } : { error: "That key has no models available." };
  } catch {
    return { error: "Couldn't reach Cerebras. Check your internet connection." };
  }
}
