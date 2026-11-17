/**
 * Fewer Gemini calls:  npx tsx scripts/reuse-test.mts
 *  1. an identical first-turn question is replayed from the saved answer (0 requests, 0 usage)
 *  2. a different source set, a follow-up turn, or the other mode still calls Gemini
 *  3. summaries: 150k tokens = 1 request; 255k tokens = 2 parts + 1 combine
 *  4. boot: interrupted generations and Gemini-backed sources fail with a retry (0 requests);
 *     local indexing (text/PDF with its text already extracted) resumes by itself
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import "fake-indexeddb/auto";
import assert from "node:assert/strict";

let calls = 0;
let streamMode: "normal" | "nofinish" | "empty" = "normal";
const sse = (text: string) =>
  `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: streamMode === "empty" ? "  " : text }] }, ...(streamMode === "nofinish" ? {} : { finishReason: "STOP" }) }] })}

`;
globalThis.fetch = (async (input: string | URL) => {
  const url = String(input);
  if (!url.includes("generativelanguage")) throw new Error("unexpected fetch " + url);
  calls++;
  if (url.includes("streamGenerateContent")) {
    return new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(sse("Mitosis splits a cell in two [1].")));
          c.close();
        },
      }),
      { status: 200 },
    );
  }
  return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ title: "T", body: "Summary [1]." }) }] }, finishReason: "STOP" }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}) as typeof fetch;

const { db } = await import("../lib/local/db");
const { localApi, streamChat } = await import("../lib/local/store");
const { setEmbedder } = await import("../lib/local/embedder");
const { saveSettings } = await import("../lib/local/settings");
const { getUsage } = await import("../lib/local/usage");
const { buildSummary, mapGap } = await import("../lib/local/summarize");
const { answerKey, mergeText } = await import("../lib/local/store");
const { getSettings } = await import("../lib/local/settings");
mapGap.ms = 0; // no 60 s pause between map batches in tests

await saveSettings({ geminiKey: "test", rpm: 0, cerebrasKey: "" });
setEmbedder(async (texts) =>
  texts.map((t) => {
    const v = new Float32Array(384);
    for (const w of t.toLowerCase().match(/[a-z]+/g) ?? []) {
      let h = 7;
      for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) % 384;
      v[h] += 1;
    }
    const n = Math.hypot(...v) || 1;
    return v.map((x) => x / n);
  }),
);

let passed = 0;
const ok = (l: string) => (passed++, console.log(`✓ ${l}`));
const settle = async (id: number) => {
  for (let i = 0; i < 200; i++) {
    if ((await db.sources.get(id))?.status !== "processing") return;
    await new Promise((r) => setTimeout(r, 25));
  }
};
const ask = async (subjectId: number, payload: Parameters<typeof streamChat>[1]) => {
  const ev: any[] = [];
  await streamChat(subjectId, payload, (e) => ev.push(e));
  return ev;
};

const subject = await localApi.createSubject("Biology");
const a = await localApi.addText(subject.id, "Cells", "Mitosis is how a cell divides into two identical cells. ".repeat(20));
const b = await localApi.addText(subject.id, "Plants", "Chlorophyll absorbs light for photosynthesis in leaves. ".repeat(20));
await settle(a.id);
await settle(b.id);

// 1. Reuse.
calls = 0;
const first = await ask(subject.id, { message: "What is mitosis?", source_ids: [a.id] });
assert.equal(calls, 1);
assert.equal(first.at(-1).type, "done");
assert.ok(first.some((e) => e.type === "cite"));
const used = (await getUsage()).geminiTotal;
const again = await ask(subject.id, { message: "  what IS   mitosis? ", source_ids: [a.id] });
assert.equal(calls, 1, "repeat must not call Gemini");
assert.deepEqual(again, first);
assert.equal((await getUsage()).geminiTotal, used, "cache hit not counted");
ok("repeated first-turn question replays the saved answer: 0 requests, 0 usage");

// 2. Misses.
await ask(subject.id, { message: "What is mitosis?", source_ids: [a.id, b.id] });
assert.equal(calls, 2);
await ask(subject.id, { message: "What is mitosis?", source_ids: [a.id], history: [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }] });
assert.equal(calls, 3);
await ask(subject.id, { message: "What is mitosis?", source_ids: [a.id], mode: "general" });
assert.equal(calls, 4);
await ask(subject.id, { message: "What is mitosis?", source_ids: [a.id] });
assert.equal(calls, 4, "original still cached");
ok("different source set, follow-up turn and general mode call Gemini; original stays cached");

// Re-indexing changes the chunk count, so the key changes.
assert.equal(await db.settings.where("key").startsWith("answer-").count(), 3);
const chunkCount = await db.chunks.where("source_id").equals(a.id).count();
await db.chunks.add({ ...(await db.chunks.where("source_id").equals(a.id).first())!, id: undefined, ord: 99 } as any);
assert.equal(await db.chunks.where("source_id").equals(a.id).count(), chunkCount + 1);
await ask(subject.id, { message: "What is mitosis?", source_ids: [a.id] });
assert.equal(calls, 5, "changed chunk count invalidates the answer");
ok("re-indexed source (different chunk count) does not serve a stale answer");

// Re-indexing with the SAME chunk count (new chunk ids) must not replay old citations.
{
  const before = await db.settings.where("key").startsWith("answer-").count();
  const rows = await db.chunks.where("source_id").equals(a.id).toArray();
  await db.chunks.where("source_id").equals(a.id).delete();
  await db.chunks.bulkAdd(rows.map((r) => ({ ...r, id: undefined })) as any);
  const n = calls;
  await ask(subject.id, { message: "What is mitosis?", source_ids: [a.id] });
  assert.equal(calls, n + 1, "new chunk ids invalidate the answer");
  assert.ok((await db.settings.where("key").startsWith("answer-").count()) > before);
  ok("re-index with the same chunk count (new chunk ids) does not replay old citations");

  // Keyword-search answers are not replayed once vectors exist: the key includes chunks lacking a 384-d vector.
  const subj = { id: subject.id } as any;
  const k1 = await answerKey(subject.id, subj, { message: "q", source_ids: [b.id] }, [b.id]);
  const first = await db.chunks.where("source_id").equals(b.id).first();
  await db.chunks.update(first!.id!, { embedding: new Float32Array(0) });
  const k2 = await answerKey(subject.id, subj, { message: "q", source_ids: [b.id] }, [b.id]);
  assert.notEqual(k1, k2);
  await db.chunks.update(first!.id!, { embedding: first!.embedding });
  assert.equal(await answerKey(subject.id, subj, { message: "q", source_ids: [b.id] }, [b.id]), k1);
  ok("answer key changes while chunks lack an on-device vector");

  // fresh: a retry always calls the AI.
  const m = calls;
  await ask(subject.id, { message: "What is mitosis?", source_ids: [a.id] });
  assert.equal(calls, m, "plain repeat replays");
  await ask(subject.id, { message: "What is mitosis?", source_ids: [a.id], fresh: true });
  assert.equal(calls, m + 1, "fresh bypasses the cache");
  ok("fresh (retry) bypasses the saved answer");

  // Saved answers are compact, and are not loaded as settings.
  const slot = (await db.settings.where("key").startsWith("answer-").toArray())[0].value as any;
  assert.ok(slot.events.filter((e: any) => e.type === "text").length <= 1 + slot.events.filter((e: any) => e.type === "cite").length);
  assert.deepEqual(mergeText([{ type: "text", text: "a" }, { type: "text", text: "b" }, { type: "done" }] as any), [{ type: "text", text: "ab" }, { type: "done" }]);
  const st = (await getSettings()) as any;
  assert.ok(!Object.keys(st).some((k) => /^(answer|usage)-/.test(k)));
  ok("getSettings skips answer-/usage- rows; cached answers merge consecutive text events");
}

// Only a normal STOP with real text is cached.
{
  const countAnswers = () => db.settings.where("key").startsWith("answer-").count();
  for (const mode of ["nofinish", "empty"] as const) {
    streamMode = mode;
    const before = await countAnswers();
    const n: number = calls;
    await ask(subject.id, { message: "Unique question about " + mode, source_ids: [a.id] });
    await ask(subject.id, { message: "Unique question about " + mode, source_ids: [a.id] });
    assert.equal(calls, n + 2, mode + ": not replayed");
    assert.equal(await countAnswers(), before, mode + ": not cached");
  }
  streamMode = "normal";
  ok("a stream with no finish reason, or with blank text, is not cached");
}

// 3. Summaries.
const fake = (n: number, tokens: number) =>
  Array.from({ length: n }, (_, i) => ({ source: { id: 1, title: "Book", kind: "pdf" }, chunk: { id: i, ord: i, text: `Passage ${i}.`, token_count: tokens, page_start: i + 1 } })) as any;
calls = 0;
const s1 = await buildSummary(fake(10, 15_000), "key_points", "standard", null, () => {}, "");
assert.equal(calls, 1);
assert.equal(s1.parts, 1);
ok("150k-token summary input: exactly 1 request");
calls = 0;
const s2 = await buildSummary(fake(17, 15_000), "key_points", "standard", null, () => {}, "");
assert.equal(calls, 3);
assert.equal(s2.parts, 2);
ok("255k-token summary input: 2 parts + 1 combine = 3 requests");

// 1. (embedder failure) A source added while the model can't load still ends ready, keyword-searchable, and is re-embedded later.
{
  setEmbedder(async () => {
    throw new Error("model failed to load");
  });
  const c = await localApi.addText(subject.id, "Genetics", "Alleles segregate during meiosis and recombine in gametes. ".repeat(20));
  await settle(c.id);
  const row = (await db.sources.get(c.id))!;
  assert.equal(row.status, "ready", row.error ?? "");
  const cs = await db.chunks.where("source_id").equals(c.id).toArray();
  assert.ok(cs.length > 0 && cs.every((x) => x.embedding.length === 0));
  const { retrieve } = await import("../lib/local/search");
  const hits = await retrieve(subject.id, [c.id], "alleles segregate meiosis", 3);
  assert.ok(hits.length > 0, "keyword fallback finds the empty-vector chunks");
  ok("embedder failure: source still ends ready with empty vectors; keyword search works");
  setEmbedder(async (texts) => texts.map(() => new Float32Array(384).fill(1 / Math.sqrt(384))));
  await localApi.reembedStale();
  const after = await db.chunks.where("source_id").equals(c.id).toArray();
  assert.ok(after.every((x) => x.embedding.length === 384), "reembedStale fills empty vectors");
  ok("reembedStale treats empty vectors as stale and fills them in");
}

// 4. Boot / resume.
calls = 0;
const stamp = new Date().toISOString();
const row = (kind: string, title: string, text: string) =>
  ({ subject_id: subject.id, kind, title, url: null, text, pages: [], checked: true, status: "processing", error: null, created_at: stamp }) as any;
const quiz = await db.artifacts.add({ subject_id: subject.id, kind: "quiz", subtype: "quiz", title: "Quiz", params: {}, content: {}, passages: [], status: "processing", error: null, created_at: stamp } as any);
const rec = await db.sources.add(row("audio", "Lecture", ""));
await db.blobs.put({ key: `upload-${rec}`, blob: new Blob(["x"]), name: "l.mp3" } as any);
const img = await db.sources.add(row("image", "Photo", ""));
await db.blobs.put({ key: `upload-${img}`, blob: new Blob(["x"]), name: "p.jpg" } as any);
const pdf = await db.sources.add(row("pdf", "Book", "Osmosis moves water across a membrane. ".repeat(30)));
await localApi.resumeJobs();
await settle(pdf);
assert.equal(calls, 0, "boot must not call Gemini");
assert.equal((await db.artifacts.get(quiz))!.status, "failed");
assert.match((await db.artifacts.get(quiz))!.error!, /Tap Try again/);
const listed = await localApi.sources(subject.id);
for (const id of [rec, img]) {
  const s = (await db.sources.get(id))!;
  assert.equal(s.status, "failed");
  assert.match(s.error!, /Tap Try again/);
  assert.equal(listed.find((x) => x.id === id)!.can_retry, true);
}
const p = (await db.sources.get(pdf))!;
assert.equal(p.status, "ready", p.error ?? "");
assert.ok((await db.chunks.where("source_id").equals(pdf).count()) > 0);
ok("boot: interrupted quiz, recording and photo marked failed with retry (0 requests); PDF/text indexing resumed locally");

// CJK text is about 1 token per character: 250k characters is over the single-pass limit although chars/4 says 62k.
{
  const { estimateTokens } = await import("../lib/local/summarize");
  assert.equal(estimateTokens("abcd".repeat(10)), 10);
  assert.equal(estimateTokens("中".repeat(100)), 100);
  assert.equal(estimateTokens("あいう한글"), 5);
  const cjk = (n: number, chars: number) =>
    Array.from({ length: n }, (_, i) => ({ source: { id: 1, title: "Book", kind: "pdf" }, chunk: { id: i, ord: i, text: "漢".repeat(chars), token_count: Math.ceil(chars / 4), page_start: i + 1 } })) as any;
  calls = 0;
  const big = await buildSummary(cjk(25, 10_000), "key_points", "standard", null, () => {}, "");
  assert.ok(big.parts >= 2 && calls >= 3, `250k CJK chars must be map-reduced, got ${big.parts} parts / ${calls} calls`);
  calls = 0;
  const small = await buildSummary(cjk(15, 10_000), "key_points", "standard", null, () => {}, "");
  assert.equal(small.parts, 1);
  assert.equal(calls, 1);
  ok("CJK-heavy input: 250k characters is split into batches; 150k stays single-pass");
}

// patiently does not retry a per-minute 429 caused by an oversized request.
{
  const { patiently, GeminiError } = await import("../lib/local/gemini");
  let runs = 0;
  const fail = () => {
    runs++;
    return Promise.reject(new GeminiError("tpm", "minute"));
  };
  await assert.rejects(patiently(fail, 2, undefined, 250_000));
  assert.equal(runs, 1, "oversized request is not retried");
  ok("patiently: no retry after a per-minute 429 on a request over 200k tokens");
}

console.log(`\n${passed} reuse checks passed`);
process.exit(0);
