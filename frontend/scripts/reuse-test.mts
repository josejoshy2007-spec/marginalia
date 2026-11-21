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
let lastBody = "";
let streamMode: "normal" | "nofinish" | "empty" = "normal";
const sse = (text: string) =>
  `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: streamMode === "empty" ? "  " : text }] }, ...(streamMode === "nofinish" ? {} : { finishReason: "STOP" }) }] })}

`;
globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
  lastBody = String(init?.body ?? "");
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

// 2b. Photo questions: image sent inline, never cached, thread keeps only the thumbnail.
{
  const callsBefore = calls; // later checks count requests from here, so this block restores the counter
  const full = new Blob([new Uint8Array(5000).fill(7)], { type: "image/jpeg" });
  const [img] = await (localApi as any).saveAskImages([full]).catch(() => null) ?? [];
  // makeThumb needs a canvas (browser only); in Node it degrades to "" and the blob is still stored.
  assert.ok(img?.id, "photo saved");
  assert.equal(await db.blobs.get(`askimg-${img.id}`).then((r) => r?.blob.size), 5000);
  const n = calls;
  const q = { message: "What is shown here?", source_ids: [a.id], images: [img.id] };
  const e1 = await ask(subject.id, q);
  assert.equal(calls, n + 1);
  assert.equal(e1.at(-1).type, "done");
  const sent = JSON.parse(lastBody);
  const parts = sent.contents.at(-1).parts;
  assert.equal(parts[0].inlineData.mimeType, "image/jpeg");
  assert.ok(parts.at(-1).text.includes("What is shown here?"));
  assert.match(sent.systemInstruction.parts[0].text, /attach photos/);
  await ask(subject.id, q);
  assert.equal(calls, n + 2, "a question with a photo is never replayed from the cache");
  assert.equal(await db.settings.where("key").startsWith("answer-").count(), 3, "and never saved");
  // No photo: the note is absent.
  await ask(subject.id, { message: "Second plain question", source_ids: [a.id], history: [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }] });
  assert.doesNotMatch(JSON.parse(lastBody).systemInstruction.parts[0].text, /attach photos/);
  // A missing blob is reported, not silently dropped.
  const bad = await ask(subject.id, { ...q, images: ["gone"] });
  assert.equal(bad.at(-1).type, "error");
  // The saved conversation carries thumbnails only (no full image) and round-trips.
  const thread: any = {
    id: "t-photo", kind: "ask", mode: "sources", busy: false,
    turns: [{ role: "user", text: "q", images: [{ id: img.id, thumb: "data:image/jpeg;base64,AAAA" }] }, { role: "assistant", body: "a", citations: [] }],
  };
  await localApi.saveThread(subject.id, thread);
  const back = (await localApi.threads(subject.id)).find((t) => t.id === "t-photo")!;
  assert.deepEqual((back.turns[0] as any).images, [{ id: img.id, thumb: "data:image/jpeg;base64,AAAA" }]);
  assert.ok(JSON.stringify(back).length < 2000, "thread row stays small");
  await localApi.deleteThread("t-photo");
  assert.equal(await db.blobs.get(`askimg-${img.id}`), undefined, "deleting the conversation removes the full image");
  calls = callsBefore;
  ok("photo question: inline image + prompt note, never cached, thumbnail-only thread, blob removed with it");
}

// 2c. Earlier photos ride along on follow-ups (most recent 4 overall); never cached; missing history blobs are skipped.
{
  const callsBefore = calls;
  const save = async (n: number) => (await (localApi as any).saveAskImages([new Blob([new Uint8Array(100 + n).fill(n)], { type: "image/jpeg" })]))[0].id as string;
  const ids: string[] = [];
  for (let i = 0; i < 6; i++) ids.push(await save(i));
  const histOf = (imgs: string[][]) => imgs.flatMap((im, i) => [{ role: "user" as const, content: `q${i}`, ...(im.length ? { images: im } : {}) }, { role: "assistant" as const, content: `a${i}` }]);
  const n = calls;
  const keys0 = await db.settings.where("key").startsWith("answer-").count();
  const e1 = await ask(subject.id, { message: "What about part (b) of the photo?", source_ids: [a.id], history: histOf([[ids[0]]]) });
  assert.equal(e1.at(-1).type, "done");
  const c1 = JSON.parse(lastBody).contents;
  assert.equal(c1.length, 3);
  assert.equal(c1[0].parts[0].inlineData.mimeType, "image/jpeg", "earlier user turn carries its photo");
  assert.equal(c1[0].parts.at(-1).text, "q0");
  assert.equal(c1[2].parts.some((p: any) => p.inlineData), false, "no photo on this turn");
  assert.match(JSON.parse(lastBody).systemInstruction.parts[0].text, /attach photos/);
  // Cap: 5 earlier photos plus 1 now -> only the most recent 4 in total.
  const e2 = await ask(subject.id, { message: "compare", source_ids: [a.id], images: [ids[5]], history: histOf([[ids[0], ids[1]], [ids[2], ids[3]], [ids[4]]]) });
  assert.equal(e2.at(-1).type, "done");
  const c2 = JSON.parse(lastBody).contents;
  const count = c2.flatMap((c: any) => c.parts).filter((p: any) => p.inlineData).length;
  assert.equal(count, 4, "at most 4 images across the conversation");
  assert.equal(c2.at(-1).parts.filter((p: any) => p.inlineData).length, 1, "the current photo is always kept");
  assert.equal(c2[0].parts.some((p: any) => p.inlineData), false, "oldest photos are dropped first");
  // A missing history blob is skipped silently; the turn still succeeds.
  const e3 = await ask(subject.id, { message: "and now?", source_ids: [a.id], history: histOf([["gone"]]) });
  assert.equal(e3.at(-1).type, "done");
  assert.equal(JSON.parse(lastBody).contents[0].parts.some((p: any) => p.inlineData), false);
  assert.equal(calls, n + 3);
  assert.equal(await db.settings.where("key").startsWith("answer-").count(), keys0, "nothing cached when images are involved");
  calls = callsBefore;
  ok("history photos: sent as inlineData on follow-ups, capped at 4, missing blobs skipped, never cached");
}

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
  localApi._search.resume(); // the failed fill paused progress reporting; a later start clears it
  setEmbedder(async (texts) => texts.map(() => new Float32Array(384).fill(1 / Math.sqrt(384))));
  await localApi.reembedStale();
  const after = await db.chunks.where("source_id").equals(c.id).toArray();
  assert.ok(after.every((x) => x.embedding.length === 384), "reembedStale fills empty vectors");
  ok("reembedStale treats empty vectors as stale and fills them in");
}

// 1b. Instant ready: a new source is ready without the embedder; vectors are filled in later, newest source first.
{
  await localApi.reembedStale(); // settle anything pending from earlier tests
  let embedCalls = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r)); // holds the embedder shut, so "ready" is proven independent of it
  const order: string[] = [];
  setEmbedder(async (texts) => {
    embedCalls++;
    for (const t of texts) order.push(t.slice(0, 5));
    await gate;
    return texts.map(() => new Float32Array(384).fill(1 / Math.sqrt(384)));
  });
  // An older ready source with no vectors, then a newer one added through the normal path.
  const oldText = "Zebra stripes camouflage herds on the savanna. ".repeat(40);
  const olderId = await db.sources.add({ subject_id: subject.id, kind: "text", title: "Old", url: null, text: oldText, pages: [], checked: true, status: "ready", error: null, created_at: stamp0() } as any);
  await db.chunks.add({ source_id: olderId, subject_id: subject.id, ord: 0, text: "Zebra stripes camouflage.", char_start: 0, char_end: 25, page_start: null, page_end: null, token_count: 5, embedding: new Float32Array(0) } as any);
  const n = await localApi.addText(subject.id, "Newer", "Quark confinement binds particles inside hadrons. ".repeat(40));
  await settle(n.id);
  assert.equal((await db.sources.get(n.id))!.status, "ready", "ready while the embedder is still blocked");
  const bare = await db.chunks.where("source_id").equals(n.id).toArray();
  assert.ok(bare.length > 0 && bare.every((x) => x.embedding.length === 0));
  const before = (await localApi.sources(subject.id)).find((x) => x.id === n.id)!;
  assert.equal(before.search_progress, 0, "search_progress starts at 0");
  ok("new source is ready while the embedder is blocked; search_progress starts at 0");
  release();
  await localApi.reembedStale();
  assert.ok(embedCalls > 0);
  const filled = await db.chunks.where("source_id").equals(n.id).toArray();
  assert.ok(filled.every((x) => x.embedding.length === 384), "vectors filled in");
  assert.ok((await db.chunks.where("source_id").equals(olderId).toArray()).every((x) => x.embedding.length === 384));
  assert.equal(order[0], "Quark".slice(0, 5), "newest source is embedded first");
  const after = (await localApi.sources(subject.id)).find((x) => x.id === n.id)!;
  assert.ok(after.search_progress === undefined || after.search_progress === 1, "search_progress reaches 1 (omitted)");
  ok("reembedStale fills vectors newest source first; search_progress goes 0 to complete");
  const k = (await answerKey(subject.id, subj0(), { message: "q", source_ids: [n.id] }, [n.id]));
  assert.ok(k.includes(`:0]`) || k.includes(":0\""), "answer key records no bare chunks once filled");
  ok("answerKey reflects vectors being filled in");
}
// 1c. Progress race: a batch landing while searchProgress is reading must not leave progress stuck below 100%.
{
  await localApi.reembedStale();
  setEmbedder(async (texts) => texts.map(() => new Float32Array(384).fill(1 / Math.sqrt(384))));
  const sid = await db.sources.add({ subject_id: subject.id, kind: "text", title: "Race", url: null, text: "Race text. ".repeat(30), pages: [], checked: true, status: "ready", error: null, created_at: stamp0() } as any);
  for (let o = 0; o < 3; o++) await db.chunks.add({ source_id: sid, subject_id: subject.id, ord: o, text: `Race chunk ${o}`, char_start: 0, char_end: 5, page_start: null, page_end: null, token_count: 3, embedding: new Float32Array(0) } as any);
  let fired = 0;
  localApi._search.hooks.afterRead = async (id) => {
    if (id === sid && fired++ === 0) await localApi.reembedStale(); // the whole fill lands during this source's first read
  };
  const mid = (await localApi.sources(subject.id)).find((x) => x.id === sid)!;
  localApi._search.hooks.afterRead = undefined;
  assert.ok(fired >= 1);
  assert.ok(mid.search_progress === undefined, `progress must not stick below complete (got ${mid.search_progress})`);
  const later = (await localApi.sources(subject.id)).find((x) => x.id === sid)!;
  assert.ok(later.search_progress === undefined, "cached count is not stale");
  ok("progress race: a batch landing during the read is not lost; progress ends complete");
}

// 1d. Worker failure: the fill stops, search_progress is omitted (so the label and polling stop), and one retry resumes it.
{
  setEmbedder(null);
  const { configureEmbedderForTests } = await import("../lib/local/embedder");
  configureEmbedderForTests(); // no worker available in Node: embedPassages(allowMain:false) throws
  const sid = await db.sources.add({ subject_id: subject.id, kind: "text", title: "NoWorker", url: null, text: "No worker. ".repeat(30), pages: [], checked: true, status: "ready", error: null, created_at: stamp0() } as any);
  await db.chunks.add({ source_id: sid, subject_id: subject.id, ord: 0, text: "No worker chunk", char_start: 0, char_end: 5, page_start: null, page_end: null, token_count: 3, embedding: new Float32Array(0) } as any);
  localApi._search.setRetryMs(30);
  await localApi.reembedStale();
  assert.ok(localApi._search.paused());
  const out = (await localApi.sources(subject.id)).find((x) => x.id === sid)!;
  assert.equal(out.search_progress, undefined, "search_progress omitted while paused");
  assert.equal(out.status, "ready");
  // the single retry: the worker is still unavailable, so it pauses again and does not loop
  await new Promise((r) => setTimeout(r, 150));
  assert.ok(localApi._search.paused(), "stays paused after the one retry fails");
  assert.equal((await localApi.sources(subject.id)).find((x) => x.id === sid)!.search_progress, undefined);
  localApi._search.setRetryMs(60_000);
  // A later fill that works un-pauses at its first batch (not at its end) and fires the resumed event once.
  for (let o = 1; o < 20; o++) await db.chunks.add({ source_id: sid, subject_id: subject.id, ord: o, text: `No worker chunk ${o}`, char_start: 0, char_end: 5, page_start: null, page_end: null, token_count: 3, embedding: new Float32Array(0) } as any);
  let batches = 0;
  let release2!: () => void;
  const gate2 = new Promise<void>((r) => (release2 = r));
  setEmbedder(async (texts) => {
    if (++batches > 1) await gate2; // first batch succeeds at once, the second waits
    return texts.map(() => new Float32Array(384).fill(1 / Math.sqrt(384)));
  });
  let resumed = 0;
  (globalThis as any).window = { dispatchEvent: (e: Event) => void (e.type === "marginalia:search-resumed" && resumed++) };
  let filled = false;
  const fill = localApi.reembedStale().then(() => void (filled = true));
  for (let i = 0; i < 100 && !resumed; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(resumed, 1, "resumed event fires after the first successful batch");
  assert.ok(!localApi._search.paused(), "paused cleared by the first successful batch");
  assert.ok(!filled, "the fill is still running when it fires");
  release2();
  await fill;
  assert.equal(resumed, 1, "one-shot: not fired again when the fill completes");
  delete (globalThis as any).window;
  ok("worker failure: search_progress omitted, one retry, resumed fires at the first good batch");
}
function stamp0() {
  return new Date().toISOString();
}
function subj0() {
  return undefined;
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
