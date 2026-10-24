/**
 * Checks the file readers (lib/local/formats.ts) on real Office/OpenDocument/EPUB files made by
 * scripts/make-format-fixtures.py:  npx tsx scripts/formats-test.mts <fixtures-dir>
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { formatOf, unsupportedReason } from "../lib/local/formats";
import { chunkText } from "../lib/local/chunker";

const dir = process.argv[2];
let passed = 0;

async function read(name: string) {
  const fmt = formatOf(name);
  assert.ok(fmt && fmt !== "pdf", `no reader for ${name}`);
  const file = new File([readFileSync(path.join(dir, name))], name);
  const doc = await fmt.read(file, name);
  // Same invariants the PDF path keeps: page spans inside the text, chunks are exact slices.
  for (const p of doc.pages) assert.ok(p.start <= p.end && p.end <= doc.text.length, `${name}: bad page span`);
  for (const c of chunkText(doc.text, 800, 120, doc.pages)) assert.equal(doc.text.slice(c.char_start, c.char_end), c.text);
  return { kind: fmt.kind, ...doc, page: (n: number) => doc.text.slice(doc.pages[n - 1].start, doc.pages[n - 1].end) };
}

async function check(label: string, fn: () => Promise<void>) {
  await fn();
  passed++;
  console.log(`✓ ${label}`);
}

await check("PowerPoint: one page per slide, in order, with notes and tables", async () => {
  const d = await read("cells.pptx");
  assert.equal(d.kind, "slides");
  assert.equal(d.pages.length, 3);
  assert.match(d.page(1), /Cell Biology\nUnit 1 & overview/);
  assert.match(d.page(2), /Organelles\nMitochondria produce ATP\nRibosomes synthesise proteins/);
  assert.match(d.page(2), /Speaker notes:\nMention the double membrane\./);
  assert.match(d.page(3), /Prokaryote[\s\S]*Eukaryote[\s\S]*No nucleus/);
  assert.equal(d.title, "cells");
});

await check("Word: paragraphs, table cells, symbols and escaped characters", async () => {
  const d = await read("notes.docx");
  assert.equal(d.kind, "doc");
  assert.match(d.text, /^Photosynthesis\n\nLight-dependent reactions happen in the thylakoids\./);
  assert.ok(d.text.includes("CO₂ + H₂O → glucose < energy > & oxygen"));
  assert.match(d.text, /Calvin cycle\n\nStroma/);
});

await check("Excel: one page per sheet, shared strings, numbers, booleans, column gaps", async () => {
  const d = await read("data.xlsx");
  assert.equal(d.kind, "sheet");
  assert.equal(d.pages.length, 2);
  assert.equal(d.page(1), "## Results\nTrial | Temp (°C) | Rate\n1 | 25 | 0.42 | | outlier?\n2 | 35 | 0.61");
  assert.equal(d.page(2), "## Notes\nRate peaks near 35 °C\nTRUE");
});

await check("CSV: quoted commas and doubled quotes", async () => {
  const d = await read("scores.csv");
  assert.equal(d.text, '## scores\nName | Score | Comment\nAna | 7 | Good, clear\nBen | 5 | Said "maybe"');
});

await check("OpenDocument slides, text and spreadsheet", async () => {
  const p = await read("waves.odp");
  assert.equal(p.pages.length, 2);
  assert.equal(p.page(2), "Interference slide text");
  const t = await read("econ.odt");
  assert.equal(t.text, "Economics\n\nDemand falls when price rises.");
  const s = await read("prices.ods");
  assert.equal(s.text, "## Prices\nItem | Price\nBread | 2.50");
});

await check("EPUB: chapters in spine order, book title", async () => {
  const d = await read("history.epub");
  assert.equal(d.title, "Short History");
  const chapters = d.pages.map((_, i) => d.page(i + 1)).filter((t) => t.includes("Chapter"));
  assert.match(chapters[0], /Chapter One\n\nThe Treaty of Versailles was signed in 1919\./);
  assert.match(chapters[1], /Chapter Two/);
});

await check("Markdown/text files", async () => {
  const d = await read("readme.md");
  assert.equal(d.text, "# Revision plan\n\nWeek 1: cells");
});

await check("old .ppt and unknown files get a clear explanation", async () => {
  assert.equal(formatOf("old.ppt"), null);
  assert.match(unsupportedReason("old.ppt")!, /save it as \.pptx/);
  assert.match(unsupportedReason("thing.xyz")!, /Supported: PDF, PowerPoint/);
  assert.equal(formatOf("photo.HEIC") && (formatOf("photo.HEIC") as { kind: string }).kind, "image");
});

console.log(`\nALL ${passed} FORMAT CHECKS PASSED`);
