/**
 * "Read this page with AI": append-only storage, indexing, the background job, scanned PDFs and backups.
 *   npx tsx scripts/aipages-test.mts
 * No network: the PDF reader, page renderer and vision call are replaced through the store's test seam.
 */
import "fake-indexeddb/auto";
import assert from "node:assert/strict";

const { db } = await import("../lib/local/db");
const { chunkText } = await import("../lib/local/chunker");
const { AI_SEP, BLANK_PAGE, applyAiReading, chunkSpan, indexSpans, planAiAppend } = await import("../lib/local/aipages");
const { localApi } = await import("../lib/local/store");
const { summaryPassages, selectPassages, retrieve } = await import("../lib/local/search");
const { forgetSource } = await import("../lib/local/search");
const { exportAll, importAll } = await import("../lib/local/backup");
const { buildSections, pageOfOffset } = await import("../lib/reflow");

let passed = 0;
const ok = (label: string) => (passed++, console.log(`✓ ${label}`));
const now = () => new Date().toISOString();

/** chunk.text == source.text[start:end] for every chunk, and ords are unique. */
async function assertInvariant(sourceId: number, label: string) {
  const src = (await db.sources.get(sourceId))!;
  const chunks = await db.chunks.where("source_id").equals(sourceId).toArray();
  for (const c of chunks) {
    assert.equal(src.text.slice(c.char_start, c.char_end), c.text, `${label}: chunk ord ${c.ord} no longer matches the text`);
    assert.ok(c.char_end > c.char_start);
  }
  assert.equal(new Set(chunks.map((c) => c.ord)).size, chunks.length, `${label}: duplicate ords`);
  return chunks;
}

/** A 3-page PDF-like source with a text layer, indexed like the app does (without vectors). */
async function textSource(title = "Physics") {
  const pageTexts = ["Velocity is the rate of change of displacement. It is a vector.", "Acceleration is the rate of change of velocity.", "Force equals mass times acceleration."];
  let text = "";
  const pages = pageTexts.map((t, i) => {
    if (i) text += "\n\n";
    const start = text.length;
    text += t;
    return { page: i + 1, start, end: text.length };
  });
  const subject = await db.subjects.add({ name: "S-" + title, created_at: now() });
  const id = await db.sources.add({ subject_id: subject, kind: "pdf", title, url: null, text, pages, checked: true, status: "ready", error: null, created_at: now() });
  await db.chunks.bulkAdd(
    chunkText(text, 800, 120, pages).map((c) => ({ source_id: id, subject_id: subject, ord: c.ord, text: c.text, char_start: c.char_start, char_end: c.char_end, page_start: c.page_start, page_end: c.page_end, token_count: c.token_count, embedding: new Float32Array(0) })),
  );
  return { id, subject, text, pages };
}

// 1. Pure planning: append after a separator, never edit.
{
  const orig = "Page one text.\n\nPage two text.";
  const p1 = planAiAppend(orig, [], 2, "  The reading of page two with $x^2$.  ");
  assert.ok(p1.text.startsWith(orig + AI_SEP), "original text is an untouched prefix");
  assert.equal(p1.text.slice(p1.span.start, p1.span.end), "The reading of page two with $x^2$.");
  assert.equal(p1.span.start, orig.length + AI_SEP.length);
  assert.equal(p1.replaced, null);
  const p2 = planAiAppend(p1.text, p1.ai_pages, 1, "Reading of one");
  assert.ok(p2.text.startsWith(p1.text));
  assert.deepEqual(p2.ai_pages.map((a) => a.page), [2, 1]);
  const p3 = planAiAppend(p2.text, p2.ai_pages, 2, "Better reading of two");
  assert.ok(p3.text.startsWith(p2.text), "a re-read only appends");
  assert.deepEqual(p3.replaced, p1.span);
  assert.deepEqual(p3.ai_pages.map((a) => a.page).sort(), [1, 2]);
  assert.equal(p3.text.slice(...(p3.ai_pages.find((a) => a.page === 2)!.start === p3.span.start ? [p3.span.start, p3.span.end] : [0, 0])), "Better reading of two");
  assert.equal(planAiAppend("x", [], 1, "   ").text.slice(-BLANK_PAGE.length), BLANK_PAGE, "an empty reading is recorded as a blank page");
  ok("planAiAppend appends after a separator, keeps the original prefix, replaces a page's entry on re-read");
}

// 2. Chunking only the appended span: absolute offsets, page tags, invariant.
{
  const orig = "Intro.";
  const long = Array.from({ length: 400 }, (_, i) => `Sentence number ${i} about energy and work.`).join(" ");
  const plan = planAiAppend(orig, [], 3, long);
  const spans = chunkSpan(plan.text, plan.span, 7);
  assert.ok(spans.length > 1, "long reading makes several chunks");
  spans.forEach((c, i) => {
    assert.equal(plan.text.slice(c.char_start, c.char_end), c.text);
    assert.ok(c.char_start >= plan.span.start && c.char_end <= plan.span.end, "inside the appended span");
    assert.equal(c.ord, 7 + i);
    assert.equal(c.page_start, 3);
    assert.equal(c.page_end, 3);
  });
  ok("chunkSpan covers only the appended span with absolute offsets and page tags");
}

// 3. Database: old and new chunks keep the invariant after an append and after a re-read.
{
  const s = await textSource();
  const before = await assertInvariant(s.id, "before");
  const beforeIds = new Set(before.map((c) => c.id));
  const a1 = await applyAiReading(s.id, 2, "Acceleration is $a = \\frac{\\Delta v}{\\Delta t}$.\n\n| quantity | unit |\n| --- | --- |\n| a | m/s^2 |\n\n[Figure: a v-t graph with a straight line]");
  let src = (await db.sources.get(s.id))!;
  assert.ok(src.text.startsWith(s.text), "extracted text untouched");
  assert.deepEqual(src.pages, s.pages, "page spans untouched");
  assert.equal(src.ai_pages!.length, 1);
  assert.equal(src.content_rev, 1);
  let chunks = await assertInvariant(s.id, "after append");
  for (const c of before) assert.ok(chunks.some((x) => x.id === c.id && x.text === c.text && x.char_start === c.char_start), "old chunk survives unchanged");
  const added = chunks.filter((c) => !beforeIds.has(c.id));
  assert.equal(added.length, a1.added);
  assert.ok(added.every((c) => c.page_start === 2 && c.page_end === 2 && c.char_start >= s.text.length));
  assert.ok(added.every((c) => c.embedding.length === 0), "vectors are left for the background fill");
  ok("append keeps the invariant for old and new chunks");

  // Re-read page 2: entry replaced, its old chunks deleted, new text appended, old text orphaned.
  const oldSpan = src.ai_pages![0];
  const oldIds = added.map((c) => c.id);
  const a2 = await applyAiReading(s.id, 2, "Acceleration is the change in velocity per second.");
  src = (await db.sources.get(s.id))!;
  assert.equal(src.ai_pages!.length, 1);
  assert.ok(src.ai_pages![0].start > oldSpan.end, "new reading sits after the old one");
  assert.equal(src.content_rev, 2);
  assert.equal(a2.removed, oldIds.length);
  chunks = await assertInvariant(s.id, "after re-read");
  assert.ok(chunks.every((c) => !oldIds.includes(c.id)), "old reading's chunks are gone");
  assert.ok(src.text.includes("Acceleration is $a = \\frac"), "orphaned old text stays in source.text");
  for (const c of before) assert.ok(chunks.some((x) => x.id === c.id), "original chunks still there");
  assert.equal(chunks.filter((c) => c.char_start >= src.ai_pages![0].start).length, a2.added);

  // Another page, then offsets map to the right page.
  await applyAiReading(s.id, 3, "Force equals mass times acceleration, F = ma.");
  src = (await db.sources.get(s.id))!;
  await assertInvariant(s.id, "third reading");
  const a3 = src.ai_pages!.find((a) => a.page === 3)!;
  assert.equal(pageOfOffset(src.pages, src.ai_pages, a3.start + 1), 3);
  assert.equal(pageOfOffset(src.pages, src.ai_pages, s.pages[0].start + 2), 1);
  assert.equal(pageOfOffset(src.pages, src.ai_pages, src.ai_pages!.find((a) => a.page === 2)!.start), 2);
  ok("re-reading a page replaces its entry and chunks; the invariant holds throughout");

  // Reading order for summaries still works (page range uses page tags).
  const sub = (await db.sources.get(s.id))!.subject_id;
  const p2 = await summaryPassages(sub, [s.id], null, 2, 2);
  assert.ok(p2.some((r) => r.chunk.char_start >= s.text.length && r.chunk.page_start === 2), "the AI reading of page 2 is in the page-2 range");
  const p1only = await summaryPassages(sub, [s.id], null, 1, 1);
  assert.ok(!p1only.some((r) => r.chunk.char_start >= s.text.length && r.chunk.page_start !== 1), "readings of other pages stay out of page 1");
  ok("summary page ranges see AI readings by page");

  await assert.rejects(applyAiReading(s.id, 9, "x"), /pages/);
  ok("rejects a page the PDF doesn't have");
}

// 3b. An AI reading replaces its page's original text for the AI; summaries come out in page order.
{
  const s = await textSource("Dedupe");
  // One original chunk per page (textSource packs the whole text into one chunk spanning every page).
  await db.chunks.where("source_id").equals(s.id).delete();
  await db.chunks.bulkAdd(s.pages.map((pg, i) => ({ source_id: s.id, subject_id: s.subject, ord: i, text: s.text.slice(pg.start, pg.end), char_start: pg.start, char_end: pg.end, page_start: pg.page, page_end: pg.page, token_count: 8, embedding: new Float32Array(0) })));
  const origOf = (page: number) => s.text.slice(s.pages[page - 1].start, s.pages[page - 1].end);
  await applyAiReading(s.id, 3, "AI reading of page three: F = ma.");
  await applyAiReading(s.id, 1, "AI reading of page one: v = ds/dt.");
  forgetSource(s.id);
  const stored = await db.chunks.where("source_id").equals(s.id).toArray();
  assert.equal(stored.length, 5,  "all original chunks stay stored (Read mode's toggle still shows them)");
  const texts = (rs: { chunk: { text: string } }[]) => rs.map((r) => r.chunk.text).join("\n");
  const all = await summaryPassages(s.subject, [s.id]);
  assert.ok(!texts(all).includes(origOf(1)) && !texts(all).includes(origOf(3)), "original text of read pages is left out of summaries");
  assert.ok(texts(all).includes(origOf(2)), "unread pages keep their original text");
  assert.deepEqual(all.map((r) => r.chunk.page_start), [1, 2, 3], "reading page 3 then page 1 still summarises page 1 first");
  const spread = await selectPassages(s.subject, [s.id], null, 20);
  assert.ok(!texts(spread).includes(origOf(1)) && !texts(spread).includes(origOf(3)) && texts(spread).includes("AI reading of page one"), "selectPassages skips superseded originals");
  const hit = await retrieve(s.subject, [s.id], "velocity displacement vector rate", 10);
  assert.ok(!texts(hit).includes(origOf(1)), "retrieval skips the superseded original");
  const hit2 = await retrieve(s.subject, [s.id], "AI reading page one", 10);
  assert.ok(texts(hit2).includes("AI reading of page one"), "retrieval finds the reading");
  const focused = await summaryPassages(s.subject, [s.id], "reading page three force one");
  assert.deepEqual(focused.map((r) => r.chunk.page_start), [...focused.map((r) => r.chunk.page_start)].sort((a, b) => a! - b!), "focused summaries are in page order too");

  // A multi-page original chunk is only dropped when every page it covers has a reading.
  const subject = await db.subjects.add({ name: "Span", created_at: now() });
  const pages = [{ page: 1, start: 0, end: 5 }, { page: 2, start: 7, end: 12 }];
  const id = await db.sources.add({ subject_id: subject, kind: "pdf", title: "Span", url: null, text: "aaaaa\n\nbbbbb", pages, checked: true, status: "ready", error: null, created_at: now() });
  await db.chunks.add({ source_id: id, subject_id: subject, ord: 0, text: "aaaaa\n\nbbbbb", char_start: 0, char_end: 12, page_start: 1, page_end: 2, token_count: 4, embedding: new Float32Array(0) });
  await applyAiReading(id, 2, "second page reading");
  forgetSource(id);
  assert.equal((await summaryPassages(subject, [id])).filter((r) => r.chunk.char_start < 12).length, 1, "a chunk spanning an unread page stays");
  await applyAiReading(id, 1, "first page reading");
  forgetSource(id);
  assert.equal((await summaryPassages(subject, [id])).filter((r) => r.chunk.char_start < 12).length, 0, "and goes once every page it covers is read");

  // Scanned PDF: read page 3 then page 1; the summary starts with page 1.
  const sc = await db.subjects.add({ name: "Scan order", created_at: now() });
  const sid = await db.sources.add({ subject_id: sc, kind: "pdf", title: "Scan order", url: null, text: "", pages: [1, 2, 3].map((page) => ({ page, start: 0, end: 0 })), checked: true, status: "ready", error: null, created_at: now(), no_text_layer: true });
  await applyAiReading(sid, 3, "Third page.");
  await applyAiReading(sid, 1, "First page.");
  forgetSource(sid);
  assert.deepEqual((await summaryPassages(sc, [sid])).map((r) => r.chunk.text), ["First page.", "Third page."]);
  assert.deepEqual((await summaryPassages(sc, [sid], null, 3, 3)).map((r) => r.chunk.text), ["Third page."]);
  ok("AI readings replace their page's original text for retrieval and summaries; summaries are in page order");
}

// 4. Scanned PDFs: no text, no chunks, still usable; reading fills them.
{
  const subject = await db.subjects.add({ name: "Scanned", created_at: now() });
  const pages = [1, 2, 3].map((page) => ({ page, start: 0, end: 0 }));
  const id = await db.sources.add({ subject_id: subject, kind: "pdf", title: "Scan", url: null, text: "", pages, checked: true, status: "ready", error: null, created_at: now(), no_text_layer: true });
  assert.deepEqual(await summaryPassages(subject, [id]), [], "zero chunks is fine");
  const out = await localApi.source(id);
  assert.equal(out.no_text_layer, true);
  assert.equal(out.page_count, 3);
  const listed = (await localApi.sources(subject))[0];
  assert.equal(listed.no_text_layer, true);
  assert.equal(listed.chunk_count, 0);
  await applyAiReading(id, 2, "Page two of the scan, with $E = mc^2$.");
  await assertInvariant(id, "scan");
  const src = (await db.sources.get(id))!;
  assert.equal(src.text.slice(src.ai_pages![0].start, src.ai_pages![0].end), "Page two of the scan, with $E = mc^2$.");
  assert.equal(src.pages.length, 3);
  const chunks = await db.chunks.where("source_id").equals(id).toArray();
  assert.ok(chunks.length === 1 && chunks[0].page_start === 2);
  const sections = buildSections(src.text, src.pages, src.ai_pages);
  assert.equal(sections.length, 3);
  assert.equal(sections[1].ai!.length, 1);
  assert.ok(sections[0].ai === null && sections[0].original.length === 0, "unread scanned pages are empty sections");
  ok("scanned PDF: kept with no text, zero chunks is fine, reading fills a page");
}

// 5. The background job: progress, skip already-read pages, failure and Try again.
{
  const s = await textSource("Job");
  await db.blobs.put({ key: `pdf-${s.id}`, blob: new Blob(["%PDF-fake"]), name: "job.pdf" });
  const seen: number[] = [];
  let failOnce = true;
  const calls: string[] = [];
  Object.assign(localApi._pageRead.hooks, {
    open: async () => ({ doc: {}, task: { destroy: async () => void calls.push("destroy") } }),
    render: async (_d: unknown, page: number) => (seen.push(page), new Blob([`page-${page}`])),
    read: async (jpeg: Blob) => {
      const page = Number((await jpeg.text()).replace("page-", ""));
      if (page === 2 && failOnce) {
        failOnce = false;
        throw new Error("The AI is overloaded.");
      }
      return `Reading of page ${page}`;
    },
  });
  {
    const subject = await db.subjects.add({ name: "Big", created_at: now() });
    const pages = Array.from({ length: 40 }, (_, i) => ({ page: i + 1, start: 0, end: 0 }));
    const big = await db.sources.add({ subject_id: subject, kind: "pdf", title: "Big scan", url: null, text: "", pages, checked: true, status: "ready", error: null, created_at: now(), no_text_layer: true });
    await db.blobs.put({ key: `pdf-${big}`, blob: new Blob(["%PDF-fake"]), name: "big.pdf" });
    await assert.rejects(localApi.readPagesWithAI(big, 1, 40), /Up to 30/);
    await assert.rejects(localApi.readPagesWithAI(big, 50, 60), /between/);
  }
  const st = await localApi.readPagesWithAI(s.id, 1, 3);
  assert.equal(st.state, "running");
  assert.equal(st.total, 3);
  await assert.rejects(localApi.readPagesWithAI(s.id, 1, 3), /already/);
  await localApi._pageRead.wait(s.id);
  let status = (await localApi.pageReadStatus(s.id))!;
  assert.equal(status.state, "failed");
  assert.equal(status.error, "The AI is overloaded.");
  assert.deepEqual(status.pending, [2, 3]);
  assert.equal((await db.sources.get(s.id))!.ai_pages!.length, 1, "page 1 was kept");
  await assertInvariant(s.id, "failed run");
  await localApi.retryPageRead(s.id);
  await localApi._pageRead.wait(s.id);
  status = (await localApi.pageReadStatus(s.id))!;
  assert.equal(status.state, "done");
  assert.deepEqual(status.pending, []);
  const src = (await db.sources.get(s.id))!;
  assert.deepEqual(src.ai_pages!.map((a) => a.page).sort(), [1, 2, 3]);
  assert.equal(src.content_rev, 3);
  assert.deepEqual(seen, [1, 2, 2, 3], "retry resumed at the failed page");
  assert.ok(calls.length >= 2, "the pdf is closed after each run");
  await assertInvariant(s.id, "job");
  // A range skips pages that already have a reading; the single-page action re-reads.
  seen.length = 0;
  await localApi.readPagesWithAI(s.id, 1, 3);
  await localApi._pageRead.wait(s.id);
  assert.deepEqual(seen, [], "range run skipped pages already read");
  await localApi.readPagesWithAI(s.id, 2, 2, { replace: true });
  await localApi._pageRead.wait(s.id);
  assert.deepEqual(seen, [2]);
  assert.equal((await db.sources.get(s.id))!.ai_pages!.length, 3);
  await assertInvariant(s.id, "re-read via job");
  // No original PDF on this device: a clear error.
  const noPdf = await textSource("NoPdf");
  await assert.rejects(localApi.readPagesWithAI(noPdf.id, 1), /original PDF/);
  assert.equal(await localApi.hasPdf(noPdf.id), false);
  assert.equal(await localApi.hasPdf(s.id), true);
  ok("background job: progress, skip/replace, failure keeps finished pages, Try again resumes");
}

// 6. Backup keeps AI readings.
{
  const s = await textSource("Backup");
  await applyAiReading(s.id, 1, "Backup reading of page one.");
  const file = await exportAll();
  const before = await db.sources.count();
  await importAll(file);
  assert.ok((await db.sources.count()) > before);
  const copies = (await db.sources.toArray()).filter((x) => x.title === "Backup");
  assert.equal(copies.length, 2);
  const copy = copies.find((x) => x.id !== s.id)!;
  assert.deepEqual(copy.ai_pages, (await db.sources.get(s.id))!.ai_pages);
  assert.equal(copy.content_rev, 1);
  // An import without vectors is re-indexed from its text: that must rebuild the same chunks, readings included.
  const rebuilt = indexSpans(copy).map((c) => `${c.char_start}-${c.char_end}-${c.page_start}`);
  const original = (await db.chunks.where("source_id").equals(s.id).toArray()).map((c) => `${c.char_start}-${c.char_end}-${c.page_start}`);
  assert.deepEqual(rebuilt.sort(), original.sort(), "re-indexing an imported source reproduces its chunks");
  // A scanned PDF with no text survives a round trip.
  const scanned = (await db.sources.toArray()).find((x) => x.title === "Scan")!;
  const n = (await db.sources.toArray()).filter((x) => x.title === "Scan").length;
  await importAll(await exportAll());
  const scans = (await db.sources.toArray()).filter((x) => x.title === "Scan");
  assert.equal(scans.length, n * 2);
  assert.ok(scans.every((x) => x.no_text_layer === true && x.ai_pages?.length === 1 && x.pages.length === 3), "scanned copies keep their reading");
  // And one nobody has read: no text, no chunks, still imported and ready.
  const blank = await db.sources.add({ subject_id: scanned.subject_id, kind: "pdf", title: "Unread scan", url: null, text: "", pages: [{ page: 1, start: 0, end: 0 }], checked: true, status: "ready", error: null, created_at: now(), no_text_layer: true });
  await importAll(await exportAll());
  const unread = (await db.sources.toArray()).filter((x) => x.title === "Unread scan");
  assert.ok(unread.length >= 2 && unread.every((x) => x.status === "ready" && x.no_text_layer === true), "an unread scan survives a round trip");
  void blank;
  ok("backup/import keeps ai_pages, content_rev and scanned PDFs");
}

// Pages can only be read on a ready source.
{
  const s = await textSource("Not ready");
  await db.blobs.put({ key: `pdf-${s.id}`, blob: new Blob(["%PDF-fake"]), name: "n.pdf" });
  await db.sources.update(s.id, { status: "processing" });
  await assert.rejects(localApi.readPagesWithAI(s.id, 1), /Wait until the source is ready/);
  await assert.rejects(applyAiReading(s.id, 1, "reading"), /Wait until the source is ready/);
  assert.equal((await db.sources.get(s.id))!.ai_pages?.length ?? 0, 0, "nothing was appended");
  await db.sources.update(s.id, { status: "ready" });
  await applyAiReading(s.id, 1, "reading");
  ok("reading pages with AI is refused until the source is ready");
}

console.log(`\nALL ${passed} AI-PAGE CHECKS PASSED`);
process.exit(0);
