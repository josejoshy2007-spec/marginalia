/**
 * Search/indexing must cost zero API calls:  npx tsx scripts/search-test.mts [--no-model]
 *  1. indexing a source makes no Gemini request and stores 384-d vectors
 *  2. a legacy 768-d (Gemini-era) source is searched by keywords (BM25) with no embedding at all
 *  3. the background re-embed makes it 384-d without touching status or chunk offsets
 *  4. the real bundled ONNX model: 384-d unit vectors, related query beats unrelated one
 * Steps 1-3 use a small fake embedder (setEmbedder); step 4 loads public/models/bge-small-en-v1.5.
 */
import "fake-indexeddb/auto";
import assert from "node:assert/strict";

let geminiCalls = 0;
globalThis.fetch = (async (input: string | URL) => {
  const url = String(input);
  if (url.includes("generativelanguage")) {
    geminiCalls++;
    throw new Error("Gemini must not be called by search/indexing");
  }
  throw new Error("unexpected fetch " + url);
}) as typeof fetch;

const { db } = await import("../lib/local/db");
const { localApi } = await import("../lib/local/store");
const { retrieve } = await import("../lib/local/search");
const { setEmbedder } = await import("../lib/local/embedder");
const { EMBED_DIM } = await import("../lib/local/settings");

let passed = 0;
const ok = (label: string) => (passed++, console.log(`✓ ${label}`));

// Fake model: hashed bag of words, 384-d, unit length.
let embedCalls = 0;
setEmbedder(async (texts) => {
  embedCalls++;
  return texts.map((t) => {
    const v = new Float32Array(384);
    for (const w of t.toLowerCase().match(/[a-z]+/g) ?? []) {
      let h = 7;
      for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) % 384;
      v[h] += 1;
    }
    const n = Math.hypot(...v) || 1;
    return v.map((x) => x / n);
  });
});

const subject = await localApi.createSubject("Biology");
const para = (topic: string, n: number) =>
  Array.from({ length: n }, (_, i) => `${topic} sentence number ${i}. `.repeat(1) + `More about ${topic} and how ${topic} works in detail.`).join(" ");
const text = [
  `Photosynthesis. ${para("chlorophyll", 60)}`,
  `Cell division. ${para("mitosis", 60)}`,
  `Genetics. ${para("heredity", 60)}`,
].join("\n\n");

// 1. Indexing: no Gemini, 384-d.
const added = await localApi.addText(subject.id, "Notes", text);
for (let i = 0; i < 100; i++) {
  if ((await db.sources.get(added.id))?.status !== "processing") break;
  await new Promise((r) => setTimeout(r, 50));
}
const src = (await db.sources.get(added.id))!;
assert.equal(src.status, "ready", src.error ?? "");
const chunks = await db.chunks.where("source_id").equals(added.id).sortBy("ord");
assert.ok(chunks.length > 1);
assert.ok(chunks.every((c) => c.embedding.length === EMBED_DIM && EMBED_DIM === 384));
assert.ok(chunks.every((c) => c.text === src.text.slice(c.char_start, c.char_end)));
assert.equal(geminiCalls, 0);
ok(`indexing ${chunks.length} chunks: 384-d vectors, offsets intact, 0 Gemini calls`);

const hits = await retrieve(subject.id, [added.id], "how does mitosis work", 3);
assert.ok(hits.length > 0 && /mitosis/.test(hits[0].chunk.text));
assert.equal(geminiCalls, 0);
ok("vector search on a local source: 0 Gemini calls");

// 2. Legacy 768-d source: keyword search, no embedding needed.
const topics: [string, string][] = [
  ["Volcanoes", "Magma rises through the crust and erupts as lava from a volcano vent."],
  ["Rivers", "A river erodes its channel and deposits sediment in the delta near the sea."],
  ["Tectonics", "Tectonic plates collide at convergent boundaries producing mountain ranges."],
];
const legacyText = topics.map(([t, b]) => `${t}\n${b}`).join("\n\n");
const legacyId = await db.sources.add({
  subject_id: subject.id, kind: "text", title: "Geography", url: null, text: legacyText, pages: [], checked: true,
  status: "ready", error: null, created_at: new Date().toISOString(),
});
const rnd = () => Float32Array.from({ length: 768 }, () => Math.random() - 0.5);
let pos = 0;
const legacyChunks = topics.map(([t, b], ord) => {
  const start = legacyText.indexOf(t, pos);
  const end = start + t.length + 1 + b.length;
  pos = end;
  return { source_id: legacyId, subject_id: subject.id, ord, text: legacyText.slice(start, end), char_start: start, char_end: end, page_start: null, page_end: null, token_count: 20, embedding: rnd() };
});
await db.chunks.bulkAdd(legacyChunks);
const before = (await db.chunks.where("source_id").equals(legacyId).sortBy("ord")).map((c) => [c.text, c.char_start, c.char_end]);
embedCalls = 0;
const kw = await retrieve(subject.id, [legacyId], "which plates collide to form mountains?", 2);
assert.equal(kw[0].chunk.ord, 2);
assert.equal(embedCalls, 0, "legacy-only search must not need the model");
assert.equal(geminiCalls, 0);
ok("legacy 768-d source answered by BM25 keywords (top hit: tectonics), no model, 0 Gemini calls");

// Mixed: both kinds together still return the relevant chunks from each.
const mixed = await retrieve(subject.id, [added.id, legacyId], "mountains tectonic plates and mitosis cell", 4);
assert.ok(mixed.some((h) => h.source.id === legacyId && h.chunk.ord === 2));
assert.ok(mixed.some((h) => h.source.id === added.id && /mitosis/.test(h.chunk.text)));
ok("mixed vector + keyword sources are fused");

// 3. Background re-embed.
await localApi.reembedStale();
const after = await db.chunks.where("source_id").equals(legacyId).sortBy("ord");
assert.ok(after.every((c) => c.embedding.length === 384));
assert.deepEqual(after.map((c) => [c.text, c.char_start, c.char_end]), before);
assert.equal((await db.sources.get(legacyId))!.status, "ready");
assert.equal(geminiCalls, 0);
const kw2 = await retrieve(subject.id, [legacyId], "magma lava volcano", 1);
assert.equal(kw2[0].chunk.ord, 0);
ok("re-embed: 384-d, same text and offsets, status still ready, vector search works, 0 Gemini calls");

// 3b. Long passages are windowed so the tail is embedded too.
{
  const { windows, WINDOW_CHARS } = await import("../lib/local/embed-core");
  const long = "x".repeat(4000);
  const w = windows(long);
  assert.ok(w.length >= 3 && w.every((x) => x.length <= WINDOW_CHARS));
  assert.equal(windows("short").length, 1);
  const tail = "The mitochondrion produces ATP. ".repeat(80);
  const t = windows("a".repeat(100) + tail);
  assert.ok(t[t.length - 1].endsWith(tail.slice(-40)), "last window reaches the end");
  ok(`long passages split into overlapping ${WINDOW_CHARS}-char windows (4000 chars -> ${w.length}), last one ends at the end`);
}

// 3b. A worker that never answers, errors silently or fails to load the model must not hang indexing or chat.
{
  setEmbedder(null);
  const { embedder, configureEmbedderForTests } = await import("../lib/local/embedder");
  const unit = (x: number) => Float32Array.from({ length: 384 }, (_, i) => (i === 0 ? x : 0));
  let mainCalls = 0;
  const main = async (texts: string[]) => (mainCalls++, texts.map(() => unit(1)));
  const mkWorker = (onPost: (w: any, m: any) => void) => () => {
    const w: any = { terminated: false, onmessage: null, onerror: null, onmessageerror: null, postMessage: (m: any) => onPost(w, m), terminate: () => (w.terminated = true) };
    return w;
  };
  const quick = { first: 80, passage: 80, query: 40 };
  const within = async <T,>(p: Promise<T>, ms = 3000) => Promise.race([p, new Promise<never>((_, r) => setTimeout(() => r(new Error("hung")), ms))]);

  // silent worker: times out, is terminated, and the call is answered on the main thread; later calls skip the worker
  let made: any[] = [];
  configureEmbedderForTests({ worker: () => (made.push(mkWorker(() => {})()), made.at(-1)), timeouts: quick, main });
  let r = await within(embedder(["a"], "passage"));
  assert.equal(r[0][0], 1);
  assert.equal(mainCalls, 1);
  assert.ok(made[0].terminated, "hung worker terminated");
  await within(embedder(["b"], "query"));
  assert.equal(made.length, 1, "broken worker is not recreated");
  assert.equal(mainCalls, 2);

  // messageerror only
  mainCalls = 0;
  configureEmbedderForTests({ worker: mkWorker((w) => setTimeout(() => w.onmessageerror?.({}), 5)), timeouts: { first: 5000, passage: 5000, query: 5000 }, main });
  await within(embedder(["a"], "query"));
  assert.equal(mainCalls, 1);

  // model-load failure reported by the worker: main thread once
  mainCalls = 0;
  configureEmbedderForTests({ worker: mkWorker((w, m) => setTimeout(() => w.onmessage?.({ data: { id: m.id, error: "no wasm", loadFailed: true } }), 5)), timeouts: { first: 5000, passage: 5000, query: 5000 }, main });
  await within(embedder(["a"], "passage"));
  assert.equal(mainCalls, 1);

  // a healthy worker still works, and a real (non-load) model error is not retried elsewhere
  mainCalls = 0;
  configureEmbedderForTests({ worker: mkWorker((w, m) => setTimeout(() => w.onmessage?.({ data: { id: m.id, vectors: [unit(2)] } }), 5)), timeouts: quick, main });
  assert.equal((await within(embedder(["a"], "query")))[0][0], 2);
  assert.equal(mainCalls, 0);
  configureEmbedderForTests({ worker: mkWorker((w, m) => setTimeout(() => w.onmessage?.({ data: { id: m.id, error: "bad input" } }), 5)), timeouts: quick, main });
  await assert.rejects(within(embedder(["a"], "query")), /bad input/);
  assert.equal(mainCalls, 0);
  configureEmbedderForTests();
  ok("embedding worker: timeout, messageerror and load failure fall back to the main thread; healthy worker and real errors unchanged");
}

// 4. The real model.
if (!process.argv.includes("--no-model")) {
  setEmbedder(null);
  const { embedLocal } = await import("../lib/local/embed-core");
  const t0 = Date.now();
  const [q] = await embedLocal(["How do plants make sugar from light?"], "query");
  const [rel, unrel] = await embedLocal(
    ["Photosynthesis uses sunlight, water and carbon dioxide to produce glucose in chloroplasts.", "The French parliament voted on the new budget for road maintenance."],
    "passage",
  );
  for (const v of [q, rel, unrel]) {
    assert.equal(v.length, 384);
    assert.ok(Math.abs(Math.hypot(...v) - 1) < 1e-3, "unit length");
  }
  const dot = (a: Float32Array, b: Float32Array) => a.reduce((s, x, i) => s + x * b[i], 0);
  const [sr, su] = [dot(q, rel), dot(q, unrel)];
  assert.ok(sr > su + 0.1, `related ${sr} should beat unrelated ${su}`);
  // A passage whose answer sits past the 512-token cut-off is still found through its later window.
  const filler = "The French parliament voted on the new budget for road maintenance and bridges. ".repeat(40);
  const tailFact = "Photosynthesis uses sunlight, water and carbon dioxide to produce glucose in chloroplasts.";
  const [longV, otherV] = await embedLocal([filler + tailFact, filler], "passage");
  const [sugarQ] = await embedLocal(["How do plants make sugar from light?"], "query");
  assert.ok(Math.abs(Math.hypot(...longV) - 1) < 1e-3, "windowed vector is unit length");
  assert.ok(dot(sugarQ, longV) > dot(sugarQ, otherV), "tail of a long passage is represented");
  assert.equal(geminiCalls, 0);
  ok(`real bge-small model: 384-d unit vectors, related ${sr.toFixed(3)} > unrelated ${su.toFixed(3)} (${Date.now() - t0} ms)`);
}
console.log(`\n${passed} search checks passed`);
process.exit(0);
