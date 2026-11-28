/**
 * Picture-only slide decks: accepted like scanned PDFs, then read with AI in batches of 8 slides.
 *   npx tsx scripts/slides-ai-test.mts
 * No network: the deck's pictures are fake bytes, picture shrinking and the vision call are replaced through the store's test seam.
 */
import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { strToU8, zipSync } from "fflate";

const { db } = await import("../lib/local/db");
const { formatOf } = await import("../lib/local/formats");
const { localApi } = await import("../lib/local/store");
const { BLANK_PAGE } = await import("../lib/local/aipages");
const { pickPictures, matchSlides, imageSize, fitSize } = await import("../lib/local/pageread");
const { LIMITS, viewPptx } = await import("../lib/office-view");

let passed = 0;
const ok = (label: string) => (passed++, console.log(`✓ ${label}`));
const now = () => new Date().toISOString();

const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

type SlideSpec = {
  text?: string; pic?: boolean; title?: string; notes?: string;
  /** A small logo shared by every slide that asks for it. */ logo?: boolean;
  /** A picture used as the slide background. */ bg?: boolean;
  /** A video and no picture. */ video?: boolean;
  /** A picture with an SVG version next to its PNG fallback. */ svg?: boolean;
  /** A picture in a format nothing can show (EMF). */ emf?: boolean;
};

/** A .pptx in memory. Each picture is `size` bytes of fake PNG data, different on every slide. */
function makePptx(slides: SlideSpec[], size = 12_000): Uint8Array {
  const files: Record<string, Uint8Array> = {
    "ppt/presentation.xml": strToU8(
      `<p:presentation ${NS}><p:sldIdLst>${slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`).join("")}</p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/></p:presentation>`,
    ),
    "ppt/_rels/presentation.xml.rels": strToU8(
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${slides.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${REL}/slide" Target="slides/slide${i + 1}.xml"/>`).join("")}</Relationships>`,
    ),
  };
  slides.forEach((s, i) => {
    const n = i + 1;
    const pic = s.pic
      ? `<p:pic><p:nvPicPr><p:cNvPr id="2" name="Picture"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId2"/></p:blipFill><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="12192000" cy="6858000"/></a:xfrm></p:spPr></p:pic>`
      : "";
    const text = s.text
      ? `<p:sp><p:nvSpPr><p:cNvPr id="3" name="Text"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1000000" cy="500000"/></a:xfrm></p:spPr><p:txBody><a:p><a:r><a:t>${s.text}</a:t></a:r></a:p></p:txBody></p:sp>`
      : "";
    const title = s.title
      ? `<p:sp><p:nvSpPr><p:cNvPr id="4" name="Title"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:p><a:r><a:t>${s.title}</a:t></a:r></a:p></p:txBody></p:sp>`
      : "";
    const logo = s.logo ? `<p:pic><p:nvPicPr><p:cNvPr id="5" name="Logo"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId4"/></p:blipFill><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="500000" cy="500000"/></a:xfrm></p:spPr></p:pic>` : "";
    const bgXml = s.bg ? `<p:bg><p:bgPr><a:blipFill><a:blip r:embed="rId5"/></a:blipFill></p:bgPr></p:bg>` : "";
    const video = s.video ? `<p:pic><p:nvPicPr><p:cNvPr id="9" name="Video"/><p:cNvPicPr/><p:nvPr><a:videoFile r:link="rId6"/></p:nvPr></p:nvPicPr><p:blipFill/><p:spPr/></p:pic>` : "";
    const svg = s.svg ? `<p:pic><p:nvPicPr><p:cNvPr id="8" name="Icon"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId8"><a:extLst><a:ext uri="x"><asvg:svgBlip xmlns:asvg="http://schemas.microsoft.com/office/drawing/2016/SVG/main" r:embed="rId7"/></a:ext></a:extLst></a:blip></p:blipFill><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="500000" cy="500000"/></a:xfrm></p:spPr></p:pic>` : "";
    const emf = s.emf ? `<p:pic><p:nvPicPr><p:cNvPr id="7" name="Clip"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId9"/></p:blipFill><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="500000" cy="500000"/></a:xfrm></p:spPr></p:pic>` : "";
    files[`ppt/slides/slide${n}.xml`] = strToU8(`<p:sld ${NS}><p:cSld>${bgXml}<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${title}${pic}${text}${logo}${video}${svg}${emf}</p:spTree></p:cSld></p:sld>`);
    const relsXml = [
      s.logo ? `<Relationship Id="rId4" Type="${REL}/image" Target="../media/logo.png"/>` : "",
      s.bg ? `<Relationship Id="rId5" Type="${REL}/image" Target="../media/bg${n}.png"/>` : "",
      s.video ? `<Relationship Id="rId6" Type="${REL}/video" Target="../media/clip${n}.mp4"/>` : "",
      s.svg ? `<Relationship Id="rId7" Type="${REL}/image" Target="../media/icon${n}.svg"/><Relationship Id="rId8" Type="${REL}/image" Target="../media/icon${n}.png"/>` : "",
      s.emf ? `<Relationship Id="rId9" Type="${REL}/image" Target="../media/clip${n}.emf"/>` : "",
      s.pic ? `<Relationship Id="rId2" Type="${REL}/image" Target="../media/image${n}.png"/>` : "",
      s.notes ? `<Relationship Id="rId3" Type="${REL}/notesSlide" Target="../notesSlides/notesSlide${n}.xml"/>` : "",
    ].join("");
    if (relsXml) files[`ppt/slides/_rels/slide${n}.xml.rels`] = strToU8(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relsXml}</Relationships>`);
    if (s.pic) files[`ppt/media/image${n}.png`] = pngLike(size, n);
    if (s.logo) files["ppt/media/logo.png"] = new Uint8Array(3000).fill(7);
    if (s.bg) files[`ppt/media/bg${n}.png`] = pngLike(size, 100 + n);
    if (s.video) files[`ppt/media/clip${n}.mp4`] = new Uint8Array(40_000).fill(3);
    if (s.svg) {
      files[`ppt/media/icon${n}.svg`] = new Uint8Array(2000).fill(4);
      files[`ppt/media/icon${n}.png`] = new Uint8Array(2500).fill(5);
    }
    if (s.emf) files[`ppt/media/clip${n}.emf`] = new Uint8Array(20_000).fill(6);
    if (s.notes) files[`ppt/notesSlides/notesSlide${n}.xml`] = strToU8(`<p:notes ${NS}><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${s.notes}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>`);
  });
  return zipSync(files);
}

/** Fake PNG: the real signature and a header saying 4000 x 3000, so size logic can be checked; the rest is filler. */
function pngLike(size: number, fill: number): Uint8Array {
  const d = new Uint8Array(size).fill(fill);
  d.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0x0f, 0xa0, 0, 0, 0x0b, 0xb8]);
  return d;
}

const blobOf = (bytes: Uint8Array) => new Blob([bytes as BlobPart]);

/** Add a slides source the way the app stores one after parsing, with its original file kept. */
async function addDeck(title: string, slides: SlideSpec[], opts: { keepOriginal?: boolean } = {}) {
  const bytes = makePptx(slides);
  const fmt = formatOf(`${title}.pptx`);
  assert.ok(fmt && fmt !== "pdf");
  const doc = await fmt.read(new File([blobOf(bytes)], `${title}.pptx`), `${title}.pptx`);
  const subject = await db.subjects.add({ name: "S-" + title, created_at: now() });
  const id = await db.sources.add({
    subject_id: subject, kind: "slides", title, url: null, text: doc.text, pages: doc.pages, checked: true, status: "ready", error: null,
    created_at: now(), ...(doc.noText ? { no_text_layer: true } : {}),
  });
  if (opts.keepOriginal !== false) await db.blobs.put({ key: `orig-${id}`, blob: blobOf(bytes), name: `${title}.pptx` });
  return { id, subject, doc };
}

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

// Seams: shrinking is a pass-through to base64; the vision call records its batches.
const hooks = localApi._pageRead.hooks as Record<string, unknown>;
const batches: { n: number; text: string; images: number; unreadable: number }[][] = [];
let failBatch = -1; // 1-based index of the request that should fail once
let dropSlide = -1; // a slide the AI leaves out of its answer once
let undecodable = false;
Object.assign(hooks, {
  decode: async (img: { mime: string; data: Uint8Array }) => (undecodable ? null : { mime: "image/jpeg", data: Buffer.from(img.data.slice(0, 8)).toString("base64") }),
  readSlides: async (batch: { n: number; text: string; images: unknown[]; unreadable: number }[]) => {
    batches.push(batch.map((b) => ({ n: b.n, text: b.text, images: b.images.length, unreadable: b.unreadable })));
    if (batches.length === failBatch) {
      failBatch = -1;
      throw new Error("The AI is overloaded.");
    }
    const out = new Map<number, string>();
    for (const b of batch) {
      if (b.n === dropSlide) {
        dropSlide = -1;
        continue;
      }
      out.set(b.n, b.n === 5 ? BLANK_PAGE : `Reading of slide ${b.n}: \`\`\`python\nprint(${b.n})\n\`\`\``);
    }
    return out;
  },
});

// 1. Parsing: a deck of pictures is accepted like a scanned PDF.
{
  const d = await addDeck("Pictures", Array.from({ length: 10 }, () => ({ pic: true })));
  assert.equal(d.doc.noText, true);
  assert.equal(d.doc.text, "");
  assert.equal(d.doc.pages.length, 10);
  assert.ok(d.doc.pages.every((p, i) => p.page === i + 1 && p.start === 0 && p.end === 0));
  const listed = (await localApi.sources(d.subject))[0];
  assert.equal(listed.no_text_layer, true);
  assert.equal(listed.page_count, 10);
  assert.equal(listed.chunk_count, 0);

  const mixed = await addDeck("Mixed", [{ text: "Intro to files" }, { pic: true }, { text: "Reading a file", pic: true }, { pic: true }]);
  assert.equal(mixed.doc.noText, true, "some picture-only slides: flagged");
  assert.equal(mixed.doc.pages.length, 4);
  assert.ok(mixed.doc.text.includes("Intro to files") && mixed.doc.text.includes("Reading a file"));
  assert.ok(mixed.doc.pages[1].start === mixed.doc.pages[1].end && mixed.doc.pages[3].start === mixed.doc.pages[3].end);
  assert.ok(mixed.doc.pages[0].end > mixed.doc.pages[0].start);

  const plain = await addDeck("Plain", [{ text: "One" }, { text: "Two" }]);
  assert.equal(plain.doc.noText, undefined, "a normal deck is not flagged");
  const fmt = formatOf("empty.pptx") as { read: (f: Blob, n: string) => Promise<unknown> };
  await assert.rejects(fmt.read(blobOf(makePptx([{}, {}])), "empty.pptx"), /No readable text/);
  ok("picture-only deck accepted (no_text_layer, one empty page per slide); mixed deck flagged; empty deck still refused");
}

// 2. Picture choice: logos and repeated layout art are skipped, unless nothing else is left.
{
  const big = (v: number) => ({ data: new Uint8Array(20_000).fill(v) });
  const logo = { data: new Uint8Array(500) };
  const art = big(99);
  const repeats = new Map([[art.data, 9]]);
  assert.deepEqual(pickPictures([logo, big(1), art], repeats, 10).map((x) => x.data.length), [20_000]);
  assert.equal(pickPictures([logo], new Map(), 10).length, 1, "a small picture is kept when it is the only one");
  assert.equal(pickPictures([art], repeats, 10).length, 1, "repeated art is kept when it is the only one");
  assert.equal(pickPictures([1, 2, 3, 4, 5, 6].map(big), new Map(), 10).length, 4, "at most 4 per slide");
  ok("picture choice: skips logos and layout art, keeps a lone picture, caps at 4");
}

// 3. Batching: 10 slides = 2 requests (8 + 2); readings become ai_pages and keep the chunk invariant.
{
  const d = await addDeck("Batch", Array.from({ length: 10 }, () => ({ pic: true })));
  batches.length = 0;
  const st = await localApi.readPagesWithAI(d.id, 1, 10);
  assert.equal(st.state, "running");
  assert.equal(st.total, 10);
  await localApi._pageRead.wait(d.id);
  const status = (await localApi.pageReadStatus(d.id))!;
  assert.equal(status.state, "done");
  assert.deepEqual(status.pending, []);
  assert.deepEqual(batches.map((b) => b.map((x) => x.n)), [[1, 2, 3, 4, 5, 6, 7, 8], [9, 10]]);
  assert.ok(batches.flat().every((x) => x.images === 1 && x.unreadable === 0));
  const src = (await db.sources.get(d.id))!;
  assert.deepEqual(src.ai_pages!.map((a) => a.page).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(src.text.slice(src.ai_pages!.find((a) => a.page === 3)!.start, src.ai_pages!.find((a) => a.page === 3)!.end), "Reading of slide 3: ```python\nprint(3)\n```");
  assert.equal(src.text.slice(src.ai_pages!.find((a) => a.page === 5)!.start, src.ai_pages!.find((a) => a.page === 5)!.end), BLANK_PAGE);
  assert.equal(src.pages.length, 10);
  const chunks = await assertInvariant(d.id, "batch");
  assert.ok(chunks.length >= 9 && chunks.every((c) => c.page_start != null && c.page_start === c.page_end));
  assert.equal((await localApi.sources(d.subject))[0].ai_page_count, 10);
  ok("10 slides = 2 requests (8 + 2); readings land as ai_pages and the chunk invariant holds");
}

// 4. A failed request leaves its slides pending; Try again sends only those.
{
  const d = await addDeck("Retry", Array.from({ length: 12 }, () => ({ pic: true })));
  batches.length = 0;
  failBatch = 2;
  await localApi.readPagesWithAI(d.id, 1, 12);
  await localApi._pageRead.wait(d.id);
  let status = (await localApi.pageReadStatus(d.id))!;
  assert.equal(status.state, "failed");
  assert.equal(status.error, "The AI is overloaded.");
  assert.deepEqual(status.pending, [9, 10, 11, 12]);
  assert.equal((await db.sources.get(d.id))!.ai_pages!.length, 8, "the first request's slides were kept");
  await assertInvariant(d.id, "failed run");
  await localApi.retryPageRead(d.id);
  await localApi._pageRead.wait(d.id);
  status = (await localApi.pageReadStatus(d.id))!;
  assert.equal(status.state, "done");
  assert.deepEqual(batches.map((b) => b.map((x) => x.n)), [[1, 2, 3, 4, 5, 6, 7, 8], [9, 10, 11, 12], [9, 10, 11, 12]]);
  assert.equal((await db.sources.get(d.id))!.ai_pages!.length, 12);
  await assertInvariant(d.id, "retried run");

  // A slide the AI leaves out stays pending too.
  const e = await addDeck("Dropped", Array.from({ length: 3 }, () => ({ pic: true })));
  dropSlide = 2;
  await localApi.readPagesWithAI(e.id, 1, 3);
  await localApi._pageRead.wait(e.id);
  status = (await localApi.pageReadStatus(e.id))!;
  assert.equal(status.state, "failed");
  assert.match(status.error!, /skipped slide 2/);
  assert.deepEqual(status.pending, [2]);
  assert.equal((await db.sources.get(e.id))!.ai_pages!.length, 2);
  ok("a failed request keeps its slides pending, Try again resends only them; a slide the AI skips stays pending");
}

// 5. Mixed deck: a range read leaves text slides alone; one slide can be re-read on request. Undecodable pictures are noted.
{
  const d = await addDeck("MixedRead", [{ text: "Intro to files" }, { pic: true }, { text: "Reading a file", pic: true }, { pic: true }]);
  batches.length = 0;
  const st = await localApi.readPagesWithAI(d.id, 1, 4);
  assert.equal(st.total, 3, "the picture slides, including the one with a short caption");
  await localApi._pageRead.wait(d.id);
  assert.deepEqual(batches.map((b) => b.map((x) => x.n)), [[2, 3, 4]]);
  assert.equal(batches[0][1].text, "Reading a file", "the slide's own text goes along");
  let src = (await db.sources.get(d.id))!;
  assert.deepEqual(src.ai_pages!.map((a) => a.page).sort(), [2, 3, 4]);
  await assertInvariant(d.id, "mixed");
  batches.length = 0;
  await localApi.readPagesWithAI(d.id, 3, 3); // single slide: re-read, with its own text passed along
  await localApi._pageRead.wait(d.id);
  assert.equal(batches[0][0].text, "Reading a file");
  await assert.rejects(localApi.readPagesWithAI(d.id, 1, 1, { replace: false }), /already been read/);

  const u = await addDeck("Undecodable", [{ pic: true }, { pic: true }]);
  undecodable = true;
  batches.length = 0;
  await localApi.readPagesWithAI(u.id, 1, 2);
  await localApi._pageRead.wait(u.id);
  undecodable = false;
  assert.equal(batches.length, 0, "nothing to look at: no request");
  src = (await db.sources.get(u.id))!;
  assert.equal(src.ai_pages!.length, 2);
  assert.equal(src.text.slice(src.ai_pages![0].start, src.ai_pages![0].end), "[Figure not readable]");
  await assertInvariant(u.id, "undecodable");
  ok("mixed deck: range reads only picture slides, single re-read passes the slide's text; undecodable pictures are noted without a request");
}

// 6. Guards: original missing, cap, wrong kind.
{
  const d = await addDeck("NoOriginal", [{ pic: true }], { keepOriginal: false });
  await assert.rejects(localApi.readPagesWithAI(d.id, 1), /original slides file[\s\S]*attach/);
  const big = await addDeck("Big", Array.from({ length: 61 }, () => ({ pic: true })));
  await assert.rejects(localApi.readPagesWithAI(big.id, 1, 61), /Up to 60/);
  const sixty = await addDeck("Sixty", Array.from({ length: 60 }, () => ({ pic: true })));
  batches.length = 0;
  await localApi.readPagesWithAI(sixty.id, 1, 60);
  await localApi._pageRead.wait(sixty.id);
  assert.equal(batches.length, 8, "60 slides = 8 requests");
  assert.equal((await db.sources.get(sixty.id))!.ai_pages!.length, 60);
  const text = await db.sources.add({ subject_id: sixty.subject, kind: "text", title: "t", url: null, text: "hello", pages: [], checked: true, status: "ready", error: null, created_at: now() });
  await assert.rejects(localApi.readPagesWithAI(text, 1), /Only PDFs and slides/);
  ok("guards: missing original, 60-slide cap in one run (8 requests), other kinds refused");
}

// 7. Classification: a screenshot under a title, or with speaker notes, is a picture slide; a text-heavy slide is not.
{
  const long = "This slide explains reading a text file line by line with a loop and closes the file afterwards.";
  const d = await addDeck("Classify", [
    { title: "Opening a file", pic: true },
    { title: "Reading", pic: true, notes: "Walk through the screenshot slowly" },
    { title: "Theory", text: long, pic: true },
    { title: "Just words", text: long },
    { pic: true, text: "Output:" },
  ]);
  assert.equal(d.doc.noText, true, "flagged although every slide has a title or notes");
  assert.ok(d.doc.text.includes("Opening a file") && d.doc.text.includes("Speaker notes:"), "titles and notes stay as text");
  assert.deepEqual(await localApi.slidesNeedingAI(d.id), [1, 2, 5]);
  batches.length = 0;
  const st = await localApi.readPagesWithAI(d.id, 1, 5);
  assert.equal(st.total, 3);
  await localApi._pageRead.wait(d.id);
  assert.deepEqual(batches.flat().map((x) => x.n), [1, 2, 5]);
  assert.match(batches[0][0].text, /Opening a file/, "the existing title goes into the request");
  assert.match(batches[0][1].text, /Speaker notes:\nWalk through/, "so do the notes");
  assert.deepEqual(await localApi.slidesNeedingAI(d.id), []);
  await assertInvariant(d.id, "classify");
  // A deck with nothing but text and no pictures is not flagged.
  assert.equal((await addDeck("Words", [{ title: "A", text: long }, { text: long }])).doc.noText, undefined);
  ok("a picture under a title or notes counts as a picture slide; text-heavy slides do not; titles and notes ride along");
}

// 8. Numbering: a batch the model numbers 1..n maps by order; real mismatches stay missing.
{
  const e = (slide: number, text: string) => ({ slide, text, blank: false });
  assert.deepEqual([...matchSlides([9, 10, 11], [e(9, "a"), e(10, "b"), e(11, "c")])], [[9, "a"], [10, "b"], [11, "c"]]);
  assert.deepEqual([...matchSlides([9, 10, 11], [e(1, "a"), e(2, "b"), e(3, "c")])], [[9, "a"], [10, "b"], [11, "c"]]);
  assert.deepEqual([...matchSlides([9, 10], [e(1, "a"), e(2, "b"), e(3, "c")])], [], "wrong count and numbers: nothing guessed");
  // The renumbered batch overlaps the real numbers: still by order, never filed under the wrong slide.
  const asOneToEight = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => e(n, `r${n}`));
  assert.deepEqual([...matchSlides([5, 6, 7, 8, 9, 10, 11, 12], asOneToEight)].map(([k, v]) => `${k}:${v}`), ["5:r1", "6:r2", "7:r3", "8:r4", "9:r5", "10:r6", "11:r7", "12:r8"]);
  assert.deepEqual([...matchSlides([2, 3, 5, 7, 8, 10, 11, 12], asOneToEight)].map(([k, v]) => `${k}:${v}`), ["2:r1", "3:r2", "5:r3", "7:r4", "8:r5", "10:r6", "11:r7", "12:r8"]);
  assert.deepEqual([...matchSlides([5, 6, 7, 8, 9, 10, 11, 12], asOneToEight.slice(0, 5))], [], "overlapping numbers and the wrong count: nothing stored");
  assert.deepEqual([...matchSlides([5, 6, 7], [e(5, "a"), e(5, "b")])], [], "a repeated number with the wrong count is not trusted");
  assert.deepEqual([...matchSlides([9, 10, 11], [e(9, "a"), e(11, "c")])], [[9, "a"], [11, "c"]], "a gap stays missing");
  assert.equal(matchSlides([4], [{ slide: 1, text: "", blank: true }]).get(4), BLANK_PAGE);
  ok("slide numbers: matched by number, by order when the model renumbers, never guessed otherwise");
}

// 9. Attaching the original: must be the same deck.
{
  const d = await addDeck("Attach", [{ pic: true }, { pic: true }, { pic: true }], { keepOriginal: false });
  const file = (bytes: Uint8Array, name: string) => new File([blobOf(bytes)], name);
  const events: number[] = [];
  const target = new EventTarget();
  (globalThis as any).window = target;
  target.addEventListener("marginalia:original-changed", (e: any) => events.push(e.detail.sourceId));
  await assert.rejects(localApi.attachOriginal(d.id, file(makePptx([{ pic: true }, { pic: true }]), "two.pptx")), /2 slides but this source has 3/);
  await assert.rejects(localApi.attachOriginal(d.id, file(new Uint8Array([1, 2, 3]), "old.ppt")), /not a PowerPoint|isn't a PowerPoint/);
  await assert.rejects(localApi.attachOriginal(d.id, file(new Uint8Array([1, 2, 3]), "bad.pptx")), /doesn't look like a PowerPoint/);
  assert.equal(await localApi.sourceOriginal(d.id), null, "nothing was stored");
  assert.equal(await localApi.slidesNeedingAI(d.id), null, "unknown without the file");
  await localApi.attachOriginal(d.id, file(makePptx([{ pic: true }, { pic: true }, { pic: true }]), "three.pptx"));
  assert.equal((await localApi.sourceOriginal(d.id))!.name, "three.pptx");
  assert.deepEqual(events, [d.id], "the Read panel is told");
  assert.deepEqual(await localApi.slidesNeedingAI(d.id), [1, 2, 3]);
  delete (globalThis as any).window;
  ok("attaching an original checks it is a .pptx with the same slide count, and announces the change");
}

// 10. Size limits: dropped pictures are never read as blank; an XML part past the cap gives an honest error.
{
  const d = await addDeck("Limits", [{ pic: true }, { pic: true, text: "x" }]);
  const keep = { ...LIMITS };
  try {
    LIMITS.entry = 5000; // the 12 KB fake pictures no longer fit; the XML parts still do
    batches.length = 0;
    await localApi.readPagesWithAI(d.id, 1, 2);
    await localApi._pageRead.wait(d.id);
    const st = (await localApi.pageReadStatus(d.id))!;
    assert.equal(st.state, "failed");
    assert.match(st.error!, /pictures are too large to read[\s\S]*slides 1, 2/);
    assert.deepEqual(st.pending, [1, 2], "still pending, not stored as blank");
    assert.equal(batches.length, 0);
    assert.equal((await db.sources.get(d.id))!.ai_pages ?? undefined, undefined);
    LIMITS.entry = 100; // now the slide XML itself is over the cap
    await localApi.retryPageRead(d.id);
    await localApi._pageRead.wait(d.id);
    assert.match((await localApi.pageReadStatus(d.id))!.error!, /too large to read with AI/);
  } finally {
    Object.assign(LIMITS, keep);
  }
  ok("pictures dropped by the size limits keep their slide pending with a clear message; an oversize file says so");
}

// 11. Picture size: read from the header, scaled to 1600 on the long side.
{
  assert.deepEqual(imageSize(pngLike(100, 1)), { w: 4000, h: 3000 });
  assert.deepEqual(fitSize({ w: 4000, h: 3000 }), { w: 1600, h: 1200 });
  assert.deepEqual(fitSize({ w: 1200, h: 3000 }), { w: 640, h: 1600 });
  assert.equal(fitSize({ w: 800, h: 600 }), null);
  assert.equal(fitSize(imageSize(new Uint8Array(30))), null);
  ok("picture size from the header; the decoder is asked for at most 1600 px, aspect kept");
}

// 12. One classifier: parsing, the banner and range reads agree.
{
  const long = "This slide explains reading a text file line by line with a loop and closes the file afterwards.";
  const flagged = async (specs: SlideSpec[]) => {
    const d = await addDeck("C" + Math.random().toString(36).slice(2, 7), specs);
    return { noText: d.doc.noText === true, needs: await localApi.slidesNeedingAI(d.id), id: d.id };
  };
  // A text deck with a logo on every slide, a title slide with its logo, a background picture and a video: not picture slides.
  const text = await flagged([{ title: "Title", logo: true }, { text: long, logo: true }, { text: long, logo: true, bg: true }, { title: "Clip", video: true }, { text: long, logo: true }]);
  assert.equal(text.noText, false, "logos, backgrounds and videos do not flag a text deck");
  assert.equal(text.needs, null, "and nothing is scanned for it");
  // Every slide carries the same small picture and there is no text: they still need reading.
  const same = await flagged(Array.from({ length: 5 }, () => ({ logo: true })));
  assert.equal(same.noText, true);
  assert.deepEqual(same.needs, [1, 2, 3, 4, 5], "all-picture deck with small repeated pictures keeps its bulk buttons");
  // A text deck whose slides are mostly screenshots next to a repeated logo: only the screenshots count.
  const mix = await flagged([{ title: "A", pic: true, logo: true }, { text: long, logo: true }, { title: "B", logo: true }, { text: long, logo: true }, { title: "C", pic: true, logo: true }]);
  assert.equal(mix.noText, true);
  assert.deepEqual(mix.needs, [1, 5]);
  // A lone small picture that only this slide has counts; a picture format nothing can open counts too.
  const lone = await flagged([{ title: "x", text: long }, { title: "y", emf: true }, { title: "z", text: long }]);
  assert.equal(lone.noText, true);
  assert.deepEqual(lone.needs, [2]);
  // viewPptx: video and SVG-with-PNG do not count as unreadable pictures; an EMF does, once.
  const bytes = makePptx([{ video: true }, { svg: true }, { emf: true }]);
  const view = viewPptx(bytes)!;
  assert.deepEqual(view.map((v) => v.skipped ?? 0), [0, 0, 1]);
  const videoOnly = await flagged([{ title: "Clip", video: true }, { text: long }]);
  assert.equal(videoOnly.noText, false, "a video-only slide is not a picture slide");
  ok("one classifier: logos, backgrounds, videos and SVG icons never flag a deck; repeated small pictures still do when there is no text");
}

console.log(`\n${passed} groups passed`);
