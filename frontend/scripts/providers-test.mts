/**
 * Model routing test with a fake network (no keys, no quota):  npx tsx scripts/providers-test.mts
 * Order: Gemini main → backup → Cerebras (text only, if a key is saved) → extra Gemini models.
 */
import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { getSettings, saveSettings } from "../lib/local/settings";
import { clearExhausted, getUsage, getUsageHistory, resetUsage } from "../lib/local/usage";
import { db } from "../lib/local/db";
import { averagesPerCall, formatReport, haikuCost, mixedCost, perMonth, summarize, usd, PRICES, type UsageDay } from "../lib/local/cost";
import { generateJson, streamGenerate, uploadFile, GeminiError } from "../lib/local/gemini";
import { fitSchema, parseJsonReply, toMessages } from "../lib/local/cerebras";
import { claudeTuning, checkAnthropicKey } from "../lib/local/anthropic";

type Reply = { status: number; body?: unknown; sse?: string[]; headers?: Record<string, string> };
let calls: string[] = [];
let bodies: any[] = [];
let heads: Record<string, string>[] = [];
let script: (who: string) => Reply;

const DAILY = {
  error: {
    message: "quota",
    details: [{ "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier" }] }],
  },
};
const gem = (obj: unknown) => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] }, finishReason: "STOP" }] });

globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
  const url = String(input);
  const who = url.includes("anthropic")
    ? `claude:${init?.body ? JSON.parse(String(init.body)).model : "models"}`
    : url.includes("cerebras")
    ? `cerebras:${JSON.parse(String(init?.body)).model}`
    : `gemini:${/models\/([^:]+):/.exec(url)?.[1]}`;
  calls.push(who);
  try { bodies.push(JSON.parse(String(init?.body))); } catch { bodies.push(null); }
  heads.push(init?.headers as Record<string, string>);
  const r = script(who);
  if (r.sse) {
    const enc = new TextEncoder();
    const stream = new ReadableStream({
      start(c) {
        for (const line of r.sse!) c.enqueue(enc.encode(line + "\n\n"));
        c.close();
      },
    });
    return new Response(stream, { status: r.status, headers: r.headers });
  }
  return new Response(JSON.stringify(r.body ?? {}), { status: r.status, headers: { "Content-Type": "application/json", ...r.headers } });
}) as typeof fetch;

const SCHEMA = {
  type: "OBJECT",
  properties: { title: { type: "STRING" }, cards: { type: "ARRAY", items: { type: "OBJECT", properties: { front: { type: "STRING" }, cite: { type: "ARRAY", items: { type: "INTEGER" } } } } } },
};
let passed = 0;
const check = async (label: string, fn: () => Promise<void> | void) => {
  calls = [];
  bodies = [];
  heads = [];
  await clearExhausted();
  await resetUsage();
  await saveSettings({ dailyBudget: 750 });
  await fn();
  passed++;
  console.log(`✓ ${label}`);
};

await saveSettings({
  geminiKey: "test",
  model: "main",
  fallbackModel: "backup",
  extraModels: "gone, lite",
  cerebrasKey: "",
  cerebrasModel: "",
  rpm: 0,
});

await check("Gemini main answers when it has quota (nothing else is called)", async () => {
  script = () => ({ status: 200, body: gem({ title: "A", cards: [] }) });
  const out = await generateJson<{ title: string }>("sys", "p", SCHEMA);
  assert.equal(out.title, "A");
  assert.deepEqual(calls, ["gemini:main"]);
});

await check("without a Cerebras key, out-of-quota main+backup go to the extra models, skipping a missing one", async () => {
  script = (w) => (w === "gemini:lite" ? { status: 200, body: gem({ title: "L", cards: [] }) } : w === "gemini:gone" ? { status: 404, body: { error: { message: "not found" } } } : { status: 429, body: DAILY });
  const out = await generateJson<{ title: string }>("sys", "p", SCHEMA);
  assert.equal(out.title, "L");
  assert.deepEqual(calls, ["gemini:main", "gemini:backup", "gemini:gone", "gemini:lite"]);
});

await saveSettings({ cerebrasKey: "csk-test", cerebrasModel: "gpt-oss-120b" });

await check("with a Cerebras key, it answers before the extra models, and missing fields are filled in", async () => {
  script = (w) =>
    w.startsWith("cerebras")
      ? { status: 200, body: { choices: [{ message: { content: '```json\n{"cards":[{"front":"Q","cite":["2"]}]}\n```' }, finish_reason: "stop" }] } }
      : { status: 429, body: DAILY };
  const out = await generateJson<any>("sys", "p", SCHEMA);
  assert.deepEqual(out, { title: "", cards: [{ front: "Q", cite: [2] }] });
  assert.deepEqual(calls, ["gemini:main", "gemini:backup", "cerebras:gpt-oss-120b"]);
});

await check("if Cerebras fails too, the extra Gemini models still get a go", async () => {
  script = (w) => (w.startsWith("cerebras") ? { status: 400, body: { message: "context too long" } } : w === "gemini:lite" ? { status: 200, body: gem({ title: "L", cards: [] }) } : w === "gemini:gone" ? { status: 404, body: { error: { message: "nf" } } } : { status: 429, body: DAILY });
  assert.equal((await generateJson<any>("sys", "p", SCHEMA)).title, "L");
  assert.ok(calls.includes("cerebras:gpt-oss-120b") && calls.at(-1) === "gemini:lite");
});

await check("marking (geminiOnly) and photos never go to Cerebras", async () => {
  script = (w) => (w === "gemini:lite" ? { status: 200, body: gem({ title: "L", cards: [] }) } : w === "gemini:gone" ? { status: 404, body: { error: { message: "nf" } } } : { status: 429, body: DAILY });
  await generateJson("sys", "p", SCHEMA, { geminiOnly: true });
  await generateJson("sys", "p", SCHEMA, { parts: [{ inlineData: { mimeType: "image/jpeg", data: "x" } }] });
  assert.ok(!calls.some((c) => c.startsWith("cerebras")), calls.join(","));
});

await check("when everything is out, the student sees Gemini's daily-quota message", async () => {
  script = (w) => (w === "gemini:gone" ? { status: 404, body: { error: { message: "nf" } } } : w.startsWith("cerebras") ? { status: 429, body: {} } : { status: 429, body: DAILY });
  await assert.rejects(generateJson("sys", "p", SCHEMA), (e: unknown) => e instanceof GeminiError && e.quota === "day" && /daily quota/.test(e.message));
});

await check("a bad request (not a quota problem) is reported at once, without trying others", async () => {
  script = () => ({ status: 400, body: { error: { message: "API key not valid" } } });
  await assert.rejects(generateJson("sys", "p", SCHEMA), /key is missing or invalid/);
  assert.deepEqual(calls, ["gemini:main"]);
});

await check("chat streams from Cerebras when Gemini is out, with Gemini's finish reasons", async () => {
  script = (w) =>
    w.startsWith("cerebras")
      ? { status: 200, sse: ['data: {"choices":[{"delta":{"content":"Hello [1]"}}]}', 'data: {"choices":[{"delta":{"content":" there"},"finish_reason":"length"}]}', "data: [DONE]"] }
      : { status: 429, body: DAILY };
  const body = { systemInstruction: { parts: [{ text: "S" }] }, contents: [{ role: "user", parts: [{ text: "q" }] }] };
  let text = "";
  let finish: string | null | undefined;
  for await (const p of streamGenerate(body)) {
    if (p.text) text += p.text;
    if ("finish" in p) finish = p.finish;
  }
  assert.equal(text, "Hello [1] there");
  assert.equal(finish, "MAX_TOKENS");
});

await check("Gemini bodies become OpenAI messages (model → assistant, system first)", () => {
  const m = toMessages({ systemInstruction: { parts: [{ text: "S" }] }, contents: [{ role: "user", parts: [{ text: "a" }] }, { role: "model", parts: [{ text: "b" }] }] }, "!");
  assert.deepEqual(m, [{ role: "system", content: "S!" }, { role: "user", content: "a" }, { role: "assistant", content: "b" }]);
});

await check("single-escaped LaTeX in Cerebras JSON survives (frac, theta, mixed doubled sqrt and alpha)", () => {
  assert.deepEqual(parseJsonReply('{"a": "$\\frac{1}{2}$ and \\theta"}'), { a: "$\\frac{1}{2}$ and \\theta" });
  assert.deepEqual(parseJsonReply('{"a": "$\\\\sqrt{2} + \\alpha \\times \\nu$"}'), { a: "$\\sqrt{2} + \\alpha \\times \\nu$" });
  assert.deepEqual(parseJsonReply('{"a": "line1\\nline2 \\"q\\""}'), { a: 'line1\nline2 "q"' });
});

await check("JSON replies with chatter around them still parse; numbers and booleans are coerced", () => {
  assert.deepEqual(parseJsonReply('Here you go: {"a": 1} hope that helps'), { a: 1 });
  assert.deepEqual(fitSchema({ type: "OBJECT", properties: { n: { type: "INTEGER" }, ok: { type: "BOOLEAN" } } }, { n: "4.6", ok: "true" }), { n: 5, ok: true });
});


// ---- retry storms, exhausted-model memory, per-call cap, daily budget, usage meter ----

const OK = { status: 200, body: gem({ title: "A", cards: [] }) };

await check("a model with a spent daily quota is skipped on the next call (zero requests to it)", async () => {
  await saveSettings({ cerebrasKey: "", cerebrasModel: "" });
  script = (w) => (w === "gemini:lite" ? OK : w === "gemini:gone" ? { status: 404, body: { error: { message: "nf" } } } : { status: 429, body: DAILY });
  await generateJson("sys", "p", SCHEMA);
  assert.deepEqual(calls, ["gemini:main", "gemini:backup", "gemini:gone", "gemini:lite"]);
  const ex = (await getSettings()).exhausted;
  assert.deepEqual(Object.keys(ex).sort(), ["backup", "main"]);
  const hours = (Date.parse(ex.main) - Date.now()) / 3_600_000;
  assert.ok(hours > 0 && hours <= 25, `reset in ${hours}h`);
  calls = [];
  await generateJson("sys", "p", SCHEMA);
  assert.deepEqual(calls, ["gemini:gone", "gemini:lite"]);
});

await check("when every model is exhausted, the call throws the daily error without any request", async () => {
  await saveSettings({ extraModels: "lite" });
  script = () => ({ status: 429, body: DAILY });
  await assert.rejects(generateJson("sys", "p", SCHEMA), (e: unknown) => e instanceof GeminiError && e.quota === "day");
  assert.deepEqual(calls, ["gemini:main", "gemini:backup", "gemini:lite"]);
  calls = [];
  await assert.rejects(generateJson("sys", "p", SCHEMA), (e: unknown) => e instanceof GeminiError && e.quota === "day" && e.fallthrough && /daily quota/.test(e.message));
  assert.deepEqual(calls, []);
  await saveSettings({ extraModels: "gone, lite" });
});

await check("a 503 storm makes at most 3 requests for one call", async () => {
  script = () => ({ status: 503, body: { error: { message: "overloaded" } } });
  await assert.rejects(generateJson("sys", "p", SCHEMA), /overloaded/);
  assert.ok(calls.length <= 3 && calls.length >= 2, calls.join(","));
});

await check("a daily budget stops requests before they are sent, with the budget message", async () => {
  await saveSettings({ dailyBudget: 2 });
  script = () => OK;
  await generateJson("sys", "p", SCHEMA);
  await generateJson("sys", "p", SCHEMA);
  assert.equal(calls.length, 2);
  await assert.rejects(generateJson("sys", "p", SCHEMA), (e: unknown) => e instanceof GeminiError && e.quota === "day" && e.budget && /today's AI budget \(2 calls\)/.test(e.message));
  assert.equal(calls.length, 2);
  await saveSettings({ dailyBudget: 0 }); // 0 = no limit
  await generateJson("sys", "p", SCHEMA);
  assert.equal(calls.length, 3);
});

await check("every request is counted by feature tag (Cerebras separately)", async () => {
  script = () => OK;
  await generateJson("sys", "p", SCHEMA, { tag: "deck" });
  await generateJson("sys", "p", SCHEMA, { tag: "quiz" });
  await generateJson("sys", "p", SCHEMA, { tag: "quiz" });
  let u = await getUsage();
  assert.deepEqual(u.gemini, { deck: 1, quiz: 2 });
  assert.equal(u.geminiTotal, 3);
  await saveSettings({ cerebrasKey: "csk-test", cerebrasModel: "gpt-oss-120b" });
  script = (w) => (w.startsWith("cerebras") ? { status: 200, body: { choices: [{ message: { content: '{"title":"C","cards":[]}' }, finish_reason: "stop" }] } } : { status: 429, body: DAILY });
  await generateJson("sys", "p", SCHEMA, { tag: "sheet" });
  u = await getUsage();
  assert.deepEqual(u.cerebras, { sheet: 1 });
  assert.equal(u.gemini.sheet, 2); // main + backup were tried
});

await check("daily budget spent: Cerebras still answers, no further Gemini model (extra models included) is tried", async () => {
  await saveSettings({ dailyBudget: 1, cerebrasKey: "csk-test", cerebrasModel: "gpt-oss-120b" });
  script = (w) => (w.startsWith("cerebras") ? { status: 200, body: { choices: [{ message: { content: '{"title":"C","cards":[]}' }, finish_reason: "stop" }] } } : { status: 429, body: DAILY });
  assert.equal((await generateJson<any>("sys", "p", SCHEMA)).title, "C");
  assert.deepEqual(calls, ["gemini:main", "cerebras:gpt-oss-120b"]);
});

await check("daily budget spent with no Cerebras key: the budget message, and no request to any extra model", async () => {
  await saveSettings({ dailyBudget: 1, cerebrasKey: "" });
  script = () => ({ status: 429, body: DAILY });
  await assert.rejects(generateJson("sys", "p", SCHEMA), (e: unknown) => e instanceof GeminiError && /AI budget/.test(e.message));
  assert.deepEqual(calls, ["gemini:main"]);
});

await check("an input over ~60k tokens skips Cerebras (it can't hold it); a small one still uses it", async () => {
  await saveSettings({ cerebrasKey: "csk-test", cerebrasModel: "gpt-oss-120b" });
  script = (w) => (w === "gemini:lite" ? { status: 200, body: gem({ title: "L", cards: [] }) } : w === "gemini:gone" ? { status: 404, body: { error: { message: "nf" } } } : w.startsWith("cerebras") ? { status: 200, body: { choices: [{ message: { content: '{"title":"C","cards":[]}' }, finish_reason: "stop" }] } } : { status: 429, body: DAILY });
  assert.equal((await generateJson<any>("sys", "p", SCHEMA, { inputTokens: 150_000 })).title, "L");
  assert.ok(!calls.some((c) => c.startsWith("cerebras")), calls.join(","));
  calls = [];
  assert.equal((await generateJson<any>("sys", "p", SCHEMA, { inputTokens: 20_000 })).title, "C");
  assert.ok(calls.some((c) => c.startsWith("cerebras")));
});

await check("thinking level is sent as thinkingConfig; a 400 about it retries once without it and is remembered", async () => {
  script = (w) => ({ status: 200, body: gem({ title: "T", cards: [] }) });
  assert.equal((await generateJson<any>("sys", "p", SCHEMA, { thinking: "low" })).title, "T");
  assert.deepEqual(bodies[0].generationConfig.thinkingConfig, { thinkingLevel: "low" });
  calls = []; bodies = [];
  await generateJson<any>("sys", "p", SCHEMA);
  assert.equal(bodies[0].generationConfig.thinkingConfig, undefined);
  calls = []; bodies = [];
  let n = 0;
  script = () => (n++ === 0 ? { status: 400, body: { error: { message: "Unknown name \"thinkingConfig\": Cannot find field." } } } : { status: 200, body: gem({ title: "R", cards: [] }) });
  assert.equal((await generateJson<any>("sys", "p", SCHEMA, { thinking: "medium" })).title, "R");
  assert.deepEqual(calls, ["gemini:main", "gemini:main"]);
  assert.ok(bodies[0].generationConfig.thinkingConfig);
  assert.equal(bodies[1].generationConfig.thinkingConfig, undefined);
  calls = []; bodies = [];
  script = () => ({ status: 200, body: gem({ title: "Z", cards: [] }) });
  await generateJson<any>("sys", "p", SCHEMA, { thinking: "low" });
  assert.equal(bodies[0].generationConfig.thinkingConfig, undefined); // remembered for this model
});

await check("uploading a 17 MB file counts one Gemini call (the start), not one per 8 MB piece", async () => {
  const real = globalThis.fetch;
  let posts = 0;
  globalThis.fetch = (async (input: string | URL) => {
    const url = String(input);
    posts++;
    if (url.includes("/upload/v1beta/files")) return new Response("{}", { status: 200, headers: { "x-goog-upload-url": "https://upload.example/session" } });
    return new Response(JSON.stringify({ file: { name: "files/x", uri: "https://files/x", state: "ACTIVE" } }), { status: 200 });
  }) as typeof fetch;
  try {
    const uri = await uploadFile(new Blob([new Uint8Array(17 * 1024 * 1024)]), "audio/mpeg", "lecture", undefined, { tag: "recording" });
    assert.equal(uri, "https://files/x");
  } finally {
    globalThis.fetch = real;
  }
  assert.equal(posts, 4); // start + 3 pieces
  const u = await getUsage();
  assert.deepEqual(u.gemini, { recording: 1 });
  assert.equal(u.geminiTotal, 1);
});

// ---- Claude (Anthropic) first, Gemini as the fallback ----

claudeTuning.scale = 0; // no real waiting between retries
const claudeMsg = (obj: unknown, stop = "end_turn") => ({ status: 200, body: { content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj) }], stop_reason: stop } });
const GEM_OK = { status: 200, body: gem({ title: "G", cards: [] }) };

await check("no Anthropic key: Claude is never called", async () => {
  await saveSettings({ anthropicKey: "", cerebrasKey: "", cerebrasModel: "" });
  script = () => GEM_OK;
  assert.equal((await generateJson<any>("sys", "p", SCHEMA)).title, "G");
  assert.deepEqual(calls, ["gemini:main"]);
  assert.equal((await getUsage()).claudeTotal, 0);
});

await saveSettings({ anthropicKey: "sk-ant-test", claudeFastModel: "fast-x", claudeStrongModel: "strong-x" });

await check("with a key, Claude answers first (fast model), schema is sent as structured output, missing fields are filled", async () => {
  script = (w) => (w.startsWith("claude") ? claudeMsg({ cards: [{ front: "Q", cite: ["2"] }] }) : GEM_OK);
  const out = await generateJson<any>("sys", "p", SCHEMA, { tag: "deck", thinking: "low" });
  assert.deepEqual(out, { title: "", cards: [{ front: "Q", cite: [2] }] });
  assert.deepEqual(calls, ["claude:fast-x"]);
  const b = bodies[0];
  assert.equal(b.system, "sys");
  assert.deepEqual(b.messages, [{ role: "user", content: [{ type: "text", text: "p" }] }]);
  assert.equal(b.output_config.effort, "low");
  assert.equal(b.output_config.format.type, "json_schema");
  const sch = b.output_config.format.schema;
  assert.equal(sch.type, "object");
  assert.deepEqual(sch.required, ["title", "cards"]);
  assert.equal(sch.additionalProperties, false);
  assert.equal(sch.properties.cards.items.properties.cite.items.type, "integer");
  assert.equal(heads[0]["x-api-key"], "sk-ant-test");
  assert.equal(heads[0]["anthropic-dangerous-direct-browser-access"], "true");
  assert.deepEqual((await getUsage()).claude, { deck: 1 });
});

await check("marking (geminiOnly) and medium thinking use the strong Claude model", async () => {
  script = (w) => (w.startsWith("claude") ? claudeMsg({ title: "S", cards: [] }) : GEM_OK);
  await generateJson("sys", "p", SCHEMA, { geminiOnly: true });
  await generateJson("sys", "p", SCHEMA, { thinking: "medium" });
  assert.deepEqual(calls, ["claude:strong-x", "claude:strong-x"]);
  assert.equal(bodies[1].output_config.effort, "medium");
});

await check("Claude 429 and 529 fall back to Gemini (overload is retried once first)", async () => {
  script = (w) => (w.startsWith("claude") ? { status: 429, body: { error: { type: "rate_limit_error", message: "slow down" } } } : GEM_OK);
  assert.equal((await generateJson<any>("sys", "p", SCHEMA)).title, "G");
  assert.deepEqual(calls, ["claude:fast-x", "gemini:main"]);
  calls = [];
  script = (w) => (w.startsWith("claude") ? { status: 529, body: { error: { type: "overloaded_error", message: "Overloaded" } } } : GEM_OK);
  assert.equal((await generateJson<any>("sys", "p", SCHEMA)).title, "G");
  assert.deepEqual(calls, ["claude:fast-x", "claude:fast-x", "gemini:main"]);
  calls = [];
  let n = 0;
  script = (w) => (w.startsWith("claude") ? (n++ === 0 ? { status: 429, body: { error: { type: "rate_limit_error", message: "x" } }, headers: { "retry-after": "1" } } : claudeMsg({ title: "R", cards: [] })) : GEM_OK);
  assert.equal((await generateJson<any>("sys", "p", SCHEMA)).title, "R"); // short retry-after: waited, then Claude answered
  assert.deepEqual(calls, ["claude:fast-x", "claude:fast-x"]);
});

await check("a bad Claude key (401) and a refusal fall back to Gemini", async () => {
  script = (w) => (w.startsWith("claude") ? { status: 401, body: { error: { type: "authentication_error", message: "invalid x-api-key" } } } : GEM_OK);
  assert.equal((await generateJson<any>("sys", "p", SCHEMA)).title, "G");
  assert.deepEqual(calls, ["claude:fast-x", "gemini:main"]);
  calls = [];
  script = (w) => (w.startsWith("claude") ? claudeMsg("", "refusal") : GEM_OK);
  assert.equal((await generateJson<any>("sys", "p", SCHEMA)).title, "G");
  assert.deepEqual(calls, ["claude:fast-x", "gemini:main"]);
});

await check("an image part becomes a base64 image block before the text; audio stays on Gemini", async () => {
  script = (w) => (w.startsWith("claude") ? claudeMsg({ title: "P", cards: [] }) : GEM_OK);
  await generateJson("sys", "read this", SCHEMA, { parts: [{ inlineData: { mimeType: "image/jpeg", data: "QUJD" } }] });
  assert.deepEqual(bodies[0].messages[0].content, [
    { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "QUJD" } },
    { type: "text", text: "read this" },
  ]);
  calls = [];
  await generateJson("sys", "p", SCHEMA, { parts: [{ inlineData: { mimeType: "audio/mpeg", data: "x" } }] });
  assert.deepEqual(calls, ["gemini:main"]);
});

await check("Claude 400 about the schema retries once with the schema in the prompt", async () => {
  let n = 0;
  script = (w) =>
    w.startsWith("claude")
      ? n++ === 0
        ? { status: 400, body: { error: { type: "invalid_request_error", message: "output_config.format: schema not supported" } } }
        : claudeMsg('```json\n{"title":"F","cards":[]}\n```')
      : GEM_OK;
  assert.equal((await generateJson<any>("sys", "p", SCHEMA)).title, "F");
  assert.deepEqual(calls, ["claude:fast-x", "claude:fast-x"]);
  assert.equal(bodies[1].output_config?.format, undefined);
  assert.match(bodies[1].system, /JSON Schema/);
});

const sseEv = (o: unknown) => `data: ${JSON.stringify(o)}`;
const chatBody = { systemInstruction: { parts: [{ text: "S" }] }, contents: [{ role: "user", parts: [{ text: "q" }] }, { role: "model", parts: [{ text: "a" }] }, { role: "user", parts: [{ text: "q2" }] }] };

await check("chat streams from Claude: text deltas and finish reasons mapped (end_turn, max_tokens, refusal)", async () => {
  for (const [stop, want] of [["end_turn", "STOP"], ["max_tokens", "MAX_TOKENS"], ["refusal", "SAFETY"]] as const) {
    calls = [];
    bodies = [];
    script = (w) =>
      w.startsWith("claude")
        ? { status: 200, sse: [sseEv({ type: "message_start" }), sseEv({ type: "content_block_delta", delta: { type: "text_delta", text: "Hello [1]" } }), sseEv({ type: "content_block_delta", delta: { type: "text_delta", text: " there" } }), sseEv({ type: "message_delta", delta: { stop_reason: stop } }), sseEv({ type: "message_stop" })] }
        : { status: 429, body: DAILY };
    let text = "";
    let finish: string | null | undefined;
    for await (const p of streamGenerate(chatBody, undefined, { tag: "chat" })) {
      if (p.text) text += p.text;
      if ("finish" in p) finish = p.finish;
    }
    assert.equal(text, "Hello [1] there");
    assert.equal(finish, want);
    assert.deepEqual(calls, ["claude:fast-x"]);
    assert.equal(bodies[0].stream, true);
    assert.deepEqual(bodies[0].messages.map((m: any) => m.role), ["user", "assistant", "user"]);
  }
});

await check("a failing Claude stream request falls back to Gemini's stream", async () => {
  script = (w) =>
    w.startsWith("claude")
      ? { status: 529, body: { error: { type: "overloaded_error", message: "o" } } }
      : { status: 200, sse: [sseEv({ candidates: [{ content: { parts: [{ text: "From Gemini" }] }, finishReason: "STOP" }] })] };
  let text = "";
  for await (const p of streamGenerate(chatBody)) if (p.text) text += p.text;
  assert.equal(text, "From Gemini");
  assert.deepEqual(calls, ["claude:fast-x", "claude:fast-x", "gemini:main"]);
});

const photoBody = { systemInstruction: { parts: [{ text: "S" }] }, contents: [{ role: "user", parts: [{ inlineData: { mimeType: "image/jpeg", data: "AAAA" } }, { text: "what is this?" }] }] };

await check("a chat question with a photo goes to Claude (image block sent) when a key is set", async () => {
  script = (w) =>
    w.startsWith("claude")
      ? { status: 200, sse: [sseEv({ type: "message_start" }), sseEv({ type: "content_block_delta", delta: { type: "text_delta", text: "A graph" } }), sseEv({ type: "message_delta", delta: { stop_reason: "end_turn" } }), sseEv({ type: "message_stop" })] }
      : { status: 429, body: DAILY };
  let text = "";
  for await (const p of streamGenerate(photoBody, undefined, { tag: "chat" })) if (p.text) text += p.text;
  assert.equal(text, "A graph");
  assert.deepEqual(calls, ["claude:fast-x"]);
  assert.ok(JSON.stringify(bodies[0].messages).includes('"type":"image"'));
});

await check("a chat question with a photo never goes to Cerebras, even when Gemini and Claude are out", async () => {
  await saveSettings({ anthropicKey: "", cerebrasKey: "csk-test", cerebrasModel: "gpt-oss-120b" });
  script = (w) => (w.startsWith("cerebras") ? { status: 200, sse: ['data: {"choices":[{"delta":{"content":"no"},"finish_reason":"stop"}]}', "data: [DONE]"] } : { status: 429, body: DAILY });
  await assert.rejects(async () => {
    for await (const _ of streamGenerate(photoBody, undefined, { tag: "chat" }));
  }, GeminiError);
  assert.ok(!calls.some((c) => c.startsWith("cerebras")), calls.join(","));
  // The same stream without a photo does use Cerebras (control).
  calls = [];
  let text = "";
  for await (const p of streamGenerate(chatBody)) if (p.text) text += p.text;
  assert.equal(text, "no");
  assert.ok(calls.some((c) => c.startsWith("cerebras")));
  await saveSettings({ anthropicKey: "sk-ant-test", cerebrasKey: "", cerebrasModel: "" });
});

await check("with no Gemini key, a Claude failure is reported as such", async () => {
  await saveSettings({ geminiKey: "" });
  script = () => ({ status: 401, body: { error: { type: "authentication_error", message: "bad" } } });
  await assert.rejects(generateJson("sys", "p", SCHEMA), (e: unknown) => e instanceof GeminiError && /Anthropic/.test(e.message));
  await saveSettings({ geminiKey: "test" });
});

await check("checkAnthropicKey: ok, rejected key, unknown model", async () => {
  script = () => ({ status: 200, body: {} });
  assert.equal(await checkAnthropicKey("k", "fast-x"), null);
  script = () => ({ status: 401, body: {} });
  assert.match((await checkAnthropicKey("k"))!, /rejected/);
  script = () => ({ status: 404, body: {} });
  assert.match((await checkAnthropicKey("k", "nope"))!, /nope/);
});

await check("a webm voice recording is sent to Gemini as video/webm (codec suffix stripped)", async () => {
  const { transcribeVoice } = await import("../lib/local/vision");
  for (const type of ["audio/webm", "audio/webm;codecs=opus", ""]) {
    calls = [];
    bodies = [];
    script = () => ({ status: 200, body: { candidates: [{ content: { parts: [{ text: "what is entropy" }] }, finishReason: "STOP" }] } });
    assert.equal(await transcribeVoice(new Blob(["abc"], { type })), "what is entropy");
    const part = bodies[0].contents[0].parts.find((p: any) => p.inlineData);
    assert.equal(part.inlineData.mimeType, "video/webm", `type "${type}"`);
  }
});

// ---- token usage and the Claude cost estimate ----

const todayTokens = async () => (await getUsageHistory(1)).at(-1)?.data.tokens ?? {};
const gemTok = (obj: unknown, usageMetadata: unknown) => ({ status: 200, body: { ...gem(obj), usageMetadata } });
const CER_OK = (usage?: unknown) => ({ status: 200, body: { choices: [{ message: { content: '{"title":"C","cards":[]}' }, finish_reason: "stop" }], ...(usage ? { usage } : {}) } });

await check("Gemini tokens are recorded per tag (thinking counts as output); marking is flagged strong; failures record nothing", async () => {
  await saveSettings({ anthropicKey: "", cerebrasKey: "", cerebrasModel: "" });
  script = () => gemTok({ title: "A", cards: [] }, { promptTokenCount: 100, candidatesTokenCount: 40, thoughtsTokenCount: 10, totalTokenCount: 150 });
  await generateJson("sys", "p", SCHEMA, { tag: "deck" });
  await generateJson("sys", "p", SCHEMA, { tag: "deck" });
  await generateJson("sys", "p", SCHEMA, { tag: "mark", geminiOnly: true });
  let t = await todayTokens();
  assert.deepEqual(t.gemini?.deck, { n: 2, input: 200, output: 100 });
  assert.deepEqual(t.gemini?.mark, { n: 1, input: 100, output: 50, sIn: 100, sOut: 50 });
  assert.equal((await getUsage()).gemini.deck, 2); // call counts unchanged
  // an error response carries no usage: nothing recorded
  script = () => ({ status: 429, body: DAILY });
  await assert.rejects(generateJson("sys", "p", SCHEMA, { tag: "quiz" }));
  t = await todayTokens();
  assert.equal(t.gemini?.quiz, undefined);
  assert.ok((await getUsage()).gemini.quiz > 0);
});

await check("a streamed Gemini answer records the totals from the last chunk, not each chunk", async () => {
  await saveSettings({ anthropicKey: "", cerebrasKey: "", cerebrasModel: "" });
  const chunk = (text: string, u: unknown) => sseEv({ candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }], usageMetadata: u });
  script = () => ({ status: 200, sse: [chunk("Hi", { promptTokenCount: 500, candidatesTokenCount: 2 }), chunk(" there", { promptTokenCount: 500, candidatesTokenCount: 30, thoughtsTokenCount: 70 })] });
  let text = "";
  for await (const p of streamGenerate(chatBody, undefined, { tag: "chat" })) if (p.text) text += p.text;
  assert.equal(text, "Hi there");
  assert.deepEqual((await todayTokens()).gemini?.chat, { n: 1, input: 500, output: 100 });
});

await check("Cerebras tokens come from usage (normal and streamed), under cerebras", async () => {
  await saveSettings({ anthropicKey: "", cerebrasKey: "csk-test", cerebrasModel: "gpt-oss-120b" });
  script = (w) => (w.startsWith("cerebras") ? CER_OK({ prompt_tokens: 300, completion_tokens: 80, total_tokens: 380 }) : { status: 429, body: DAILY });
  await generateJson("sys", "p", SCHEMA, { tag: "sheet" });
  script = (w) =>
    w.startsWith("cerebras")
      ? { status: 200, sse: ['data: {"choices":[{"delta":{"content":"ok"}}]}', 'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":40,"completion_tokens":6}}', "data: [DONE]"] }
      : { status: 429, body: DAILY };
  for await (const _ of streamGenerate(chatBody, undefined, { tag: "chat" }));
  const t = await todayTokens();
  assert.deepEqual(t.cerebras?.sheet, { n: 1, input: 300, output: 80 });
  assert.deepEqual(t.cerebras?.chat, { n: 1, input: 40, output: 6 });
  assert.equal(t.gemini, undefined); // Gemini only failed
  await saveSettings({ cerebrasKey: "", cerebrasModel: "" });
});

await check("Claude tokens (normal and streamed) include cache fields; the strong model is flagged", async () => {
  await saveSettings({ anthropicKey: "sk-ant-test", cerebrasKey: "", cerebrasModel: "" });
  const withUsage = (usage: unknown) => ({ status: 200, body: { content: [{ type: "text", text: '{"title":"S","cards":[]}' }], stop_reason: "end_turn", usage } });
  script = (w) => (w.startsWith("claude") ? withUsage({ input_tokens: 50, cache_creation_input_tokens: 10, cache_read_input_tokens: 40, output_tokens: 25 }) : GEM_OK);
  await generateJson("sys", "p", SCHEMA, { tag: "deck" });
  await generateJson("sys", "p", SCHEMA, { tag: "mark", geminiOnly: true });
  script = (w) =>
    w.startsWith("claude")
      ? { status: 200, sse: [sseEv({ type: "message_start", message: { usage: { input_tokens: 700, output_tokens: 1 } } }), sseEv({ type: "content_block_delta", delta: { type: "text_delta", text: "Hi" } }), sseEv({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 90 } })] }
      : { status: 429, body: DAILY };
  for await (const _ of streamGenerate(chatBody, undefined, { tag: "chat" }));
  const t = await todayTokens();
  assert.deepEqual(t.claude?.deck, { n: 1, input: 100, output: 25, cached: 40 });
  assert.deepEqual(t.claude?.mark, { n: 1, input: 100, output: 25, cached: 40, sIn: 100, sOut: 25 });
  assert.deepEqual(t.claude?.chat, { n: 1, input: 700, output: 90 });
  assert.equal(t.gemini, undefined);
});

await check("cost maths with the Haiku 5.5 and Sonnet 5.5 prices (exact numbers)", () => {
  assert.equal(PRICES.haiku.input, 0.1);
  assert.equal(PRICES.haiku.output, 0.5);
  assert.equal(PRICES.sonnet.input, 2);
  assert.equal(PRICES.sonnet.output, 10);
  assert.equal(usd(1_000_000, 200_000, PRICES.haiku).toFixed(6), "0.200000");
  const row = { calls: 10, input: 1_000_000, output: 200_000, sIn: 100_000, sOut: 20_000, estCalls: 0 };
  assert.equal(haikuCost(row).toFixed(6), "0.200000");
  assert.equal(mixedCost(row).toFixed(6), "0.580000"); // 900k/180k on Haiku = 0.18, 100k/20k on Sonnet = 0.40
  assert.equal(perMonth(0.7).toFixed(6), ((0.7 * 30) / 7).toFixed(6));
});

await check("days with calls but no tokens are estimated from the feature's average tokens per call", () => {
  const day = (calls: Record<string, number>, tokens?: UsageDay["tokens"]): UsageDay => ({ gemini: calls, cerebras: {}, claude: {}, ...(tokens ? { tokens } : {}) });
  const days = [
    { day: "2026-11-19", data: day({ quiz: 2 }, { gemini: { quiz: { n: 2, input: 2000, output: 600 } } }) },
    { day: "2026-11-20", data: day({ quiz: 5, audio: 3 }) }, // old row: calls only
    { day: "2026-11-21", data: day({ quiz: 1 }, { gemini: { quiz: { n: 1, input: 900, output: 300 } } }) },
  ];
  assert.deepEqual(averagesPerCall(days).quiz, { input: 2900 / 3, output: 900 / 3, sIn: 0, sOut: 0 });
  const sum = summarize(days);
  const d20 = sum.days.find((d) => d.day === "2026-11-20")!;
  assert.equal(d20.estimated, true);
  assert.equal(d20.features.quiz.estimated, true);
  assert.equal(d20.row.input, Math.round((2900 / 3) * 5));
  assert.equal(d20.row.output, 1500);
  assert.equal(d20.row.estCalls, 5);
  assert.equal(sum.days.find((d) => d.day === "2026-11-21")!.estimated, false); // measured stays measured
  assert.deepEqual(sum.noBasis, [{ tag: "audio", calls: 3 }]); // no token data for audio anywhere: not priced
  assert.equal(sum.total.input, 2000 + 900 + Math.round((2900 / 3) * 5));
  const text = formatReport(sum, "2026-11-21");
  assert.match(text, /estimated from call counts/);
  assert.match(text, /Haiku 5\.5 \$0\.10 in \/ \$0\.50 out/);
  assert.match(text, /No token basis \(calls not priced\): audio 3/);
});

await check("old usage rows (calls only, no tokens field) still load, alone and in the history", async () => {
  const y = new Date(Date.now() - 86_400_000);
  const p = (n: number) => String(n).padStart(2, "0");
  const label = `${y.getFullYear()}-${p(y.getMonth() + 1)}-${p(y.getDate())}`;
  const key = `usage-${label}`;
  await db.settings.put({ key, value: { gemini: { deck: 4 }, cerebras: {}, claude: {} } });
  const h = await getUsageHistory(7);
  const old = h.find((d) => d.day === label)!;
  assert.deepEqual(old.data.gemini, { deck: 4 });
  assert.equal(old.data.tokens, undefined);
  assert.equal(summarize(h).total.calls, 4);
  // a row that is missing even the per-provider maps also loads
  await db.settings.put({ key, value: { gemini: { deck: 1 } } });
  assert.deepEqual((await getUsageHistory(7)).find((d) => d.day === label)!.data.claude, {});
  await db.settings.delete(key);
});

console.log(`\nALL ${passed} PROVIDER CHECKS PASSED`);
