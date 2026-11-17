/**
 * Model routing test with a fake network (no keys, no quota):  npx tsx scripts/providers-test.mts
 * Order: Gemini main → backup → Cerebras (text only, if a key is saved) → extra Gemini models.
 */
import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { getSettings, saveSettings } from "../lib/local/settings";
import { clearExhausted, getUsage, resetUsage } from "../lib/local/usage";
import { generateJson, streamGenerate, uploadFile, GeminiError } from "../lib/local/gemini";
import { fitSchema, parseJsonReply, toMessages } from "../lib/local/cerebras";

type Reply = { status: number; body?: unknown; sse?: string[] };
let calls: string[] = [];
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
  const who = url.includes("cerebras")
    ? `cerebras:${JSON.parse(String(init?.body)).model}`
    : `gemini:${/models\/([^:]+):/.exec(url)?.[1]}`;
  calls.push(who);
  const r = script(who);
  if (r.sse) {
    const enc = new TextEncoder();
    const stream = new ReadableStream({
      start(c) {
        for (const line of r.sse!) c.enqueue(enc.encode(line + "\n\n"));
        c.close();
      },
    });
    return new Response(stream, { status: r.status });
  }
  return new Response(JSON.stringify(r.body ?? {}), { status: r.status, headers: { "Content-Type": "application/json" } });
}) as typeof fetch;

const SCHEMA = {
  type: "OBJECT",
  properties: { title: { type: "STRING" }, cards: { type: "ARRAY", items: { type: "OBJECT", properties: { front: { type: "STRING" }, cite: { type: "ARRAY", items: { type: "INTEGER" } } } } } },
};
let passed = 0;
const check = async (label: string, fn: () => Promise<void> | void) => {
  calls = [];
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

console.log(`\nALL ${passed} PROVIDER CHECKS PASSED`);
