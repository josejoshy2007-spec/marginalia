/** Read-mode display blocks:  npx tsx scripts/reflow-test.mts */
import assert from "node:assert/strict";
import { buildBlocks, buildSections, markdownBlocks, pageAt, pageOfOffset, shouldHandleFocus, type Block } from "../lib/reflow";

let passed = 0;
const ok = (label: string) => (passed++, console.log(`✓ ${label}`));

/** Blocks are ordered, never overlap, and everything between them is whitespace. */
function assertCovers(text: string, blocks: Block[]) {
  let pos = 0;
  for (const b of blocks) {
    assert.ok(b.start >= pos, `block at ${b.start} overlaps previous end ${pos}`);
    assert.ok(b.end > b.start && b.end <= text.length);
    assert.equal(text.slice(pos, b.start).trim(), "", `non-whitespace dropped before ${b.start}: ${JSON.stringify(text.slice(pos, b.start))}`);
    pos = b.end;
  }
  assert.equal(text.slice(pos).trim(), "", "non-whitespace dropped at the end");
}

// 1. Hard-wrapped prose becomes a single paragraph block (one block, newlines inside).
{
  const text = "Velocity is the rate of change\nof displacement with time. It is a\nvector quantity.\n\nAcceleration is the rate of change of velocity.";
  const b = buildBlocks(text, []);
  assertCovers(text, b);
  assert.equal(b.length, 2);
  assert.equal(b[0].kind, "para");
  assert.equal(text.slice(b[0].start, b[0].end), "Velocity is the rate of change\nof displacement with time. It is a\nvector quantity.");
  ok("hard-wrapped lines stay one paragraph block");
}

// 2. Figure debris: axis labels collapse into one figure block, prose around it stays.
{
  const text = ["The graph below shows displacement against time.", "-4", "-3", "y/m", "0 2 3 4 5", "sl m", "The gradient gives the velocity of the object."].join("\n");
  const b = buildBlocks(text, []);
  assertCovers(text, b);
  const kinds = b.map((x) => x.kind);
  assert.deepEqual(kinds, ["para", "figure", "para"]);
  assert.equal(text.slice(b[1].start, b[1].end), "-4\n-3\ny/m\n0 2 3 4 5\nsl m");
  assert.equal(b[1].lines, 5);
  ok("figure/graph label run collapses to one figure block");
}

// 3. Broken equations and two short lines are NOT treated as figures.
{
  const text = "We have V = S - 5 initial\nI- 0\ns =s. + vtI\nso the object moves.";
  const b = buildBlocks(text, []);
  assertCovers(text, b);
  assert.ok(b.every((x) => x.kind !== "figure"));
  ok("equation scraps and short pairs stay readable text");
}

// 4. A list of plain words is prose, not debris.
{
  const text = "Mass\nForce\nEnergy\nPower";
  const b = buildBlocks(text, []);
  assertCovers(text, b);
  assert.ok(b.every((x) => x.kind !== "figure"));
  ok("a list of plain words is not a figure");
}

// 5. List items and headings split paragraphs; items keep continuation lines.
{
  const text = "1.2 Motion in a line\nBodies move as follows.\n- first point that runs\nover two lines\n- second point\nDone here.";
  const b = buildBlocks(text, []);
  assertCovers(text, b);
  assert.deepEqual(b.map((x) => x.kind), ["heading", "para", "item", "item"]);
  assert.equal(text.slice(b[2].start, b[2].end), "- first point that runs\nover two lines");
  ok("headings and list items start their own blocks");
}

// 6. Pages: labels, running headers, offsets cover the text exactly.
{
  const pageText = (n: number) => `Chapter header\nBody of page ${n} line one\nline two of the body.\n${n}`;
  const parts: string[] = [];
  const pages: { page: number; start: number; end: number }[] = [];
  let cursor = 0;
  for (let n = 1; n <= 6; n++) {
    if (parts.length) (parts.push("\n\n"), (cursor += 2));
    const t = pageText(n);
    pages.push({ page: n, start: cursor, end: cursor + t.length });
    parts.push(t);
    cursor += t.length;
  }
  const text = parts.join("");
  const b = buildBlocks(text, pages);
  assertCovers(text, b);
  assert.deepEqual(b.filter((x) => x.page !== undefined).map((x) => x.page), [1, 2, 3, 4, 5, 6]);
  assert.ok(b.filter((x) => x.kind === "running").length >= 6, "running header/page number found");
  assert.equal(pageAt(pages, pages[3].start + 5), 4);
  assert.equal(pageAt(pages, 0), 1);
  ok("page labels, running headers and exact coverage across pages");
}

// 7. Ligature junk and dot leaders keep their characters (display only).
{
  const text = "The re-a rranged formula a nd more.\nContents ............ 12\nIntroduction ............ 3";
  const b = buildBlocks(text, []);
  assertCovers(text, b);
  const rebuilt = b.map((x) => text.slice(x.start, x.end)).join("\n");
  assert.ok(rebuilt.includes("re-a rranged") && rebuilt.includes("a nd"));
  ok("source characters are never altered");
}

// 8. Heading-like words in the middle of a sentence stay in the paragraph; real headings still split.
{
  const text = "The motion of a projectile is\nExample\nof two independent motions that\n2 Newtons act on it.\n\nUnit 4 Waves\nWaves carry energy without moving matter.";
  const b = buildBlocks(text, []);
  assertCovers(text, b);
  assert.equal(b[0].kind, "para");
  assert.equal(text.slice(b[0].start, b[0].end).split("\n").length, 4);
  assert.deepEqual(b.slice(1).map((x) => x.kind), ["heading", "para"]);
  ok("mid-paragraph Example / number lines are not headings; a standalone unit heading still is");
}

// 9. Equation scraps and bullets in short-line runs are not collapsed as figure debris.
{
  const eq = "Use the formula\nv = u + at\ns = ut\nF = ma\nto solve it.";
  const b1 = buildBlocks(eq, []);
  assertCovers(eq, b1);
  assert.ok(b1.every((x) => x.kind !== "figure"));
  const bl = "Steps:\n- add\n- mix\n- stir\n- bake";
  const b2 = buildBlocks(bl, []);
  assertCovers(bl, b2);
  assert.ok(b2.every((x) => x.kind !== "figure"));
  ok("equation runs and short bullets are kept as text");
}

{
  assert.equal(shouldHandleFocus(5, 0), true);
  assert.equal(shouldHandleFocus(5, 5), false);
  assert.equal(shouldHandleFocus(6, 5), true);
  ok("a citation focus is handled once, new clicks still are");
}

// Per-page sections with AI readings appended after the extracted text: original offsets never move.
{
  const p1 = "Velocity is the rate of change of displacement.";
  const p2 = "Acceleration is the rate of change of velocity.";
  const orig = `${p1}\n\n${p2}`;
  const pages = [
    { page: 1, start: 0, end: p1.length },
    { page: 2, start: p1.length + 2, end: orig.length },
  ];
  const reading = "Acceleration is $a = \\frac{\\Delta v}{\\Delta t}$.\n\n| q | unit |\n| --- | --- |\n| a | m/s2 |";
  const text = `${orig}\n\n${reading}`;
  const ai = [{ page: 2, start: orig.length + 2, end: text.length }];

  const plain = buildSections(orig, pages);
  const withAi = buildSections(text, pages, ai);
  assert.equal(withAi.length, 2);
  assert.deepEqual(
    withAi.map((x) => x.original.map((b) => [b.start, b.end])),
    plain.map((x) => x.original.map((b) => [b.start, b.end])),
    "extracted blocks keep their offsets once readings are appended",
  );
  assert.equal(withAi[0].ai, null);
  assert.equal(withAi[1].ai!.length, 2, "the reading splits into Markdown chunks at blank lines");
  assert.equal(text.slice(withAi[1].ai![0].start, withAi[1].ai![0].end), "Acceleration is $a = \\frac{\\Delta v}{\\Delta t}$.");
  assert.equal(text.slice(withAi[1].ai![1].start, withAi[1].ai![1].end), "| q | unit |\n| --- | --- |\n| a | m/s2 |");
  assert.equal(pageOfOffset(pages, ai, ai[0].start + 3), 2);
  assert.equal(pageOfOffset(pages, ai, 3), 1);
  assert.deepEqual(markdownBlocks("a\n\n\nb", 0, 5), [
    { kind: "para", start: 0, end: 1 },
    { kind: "para", start: 4, end: 5 },
  ]);
  // Scanned PDF: pages without any text still get a section each.
  const blank = buildSections("", [1, 2, 3].map((page) => ({ page, start: 0, end: 0 })));
  assert.equal(blank.length, 3);
  assert.ok(blank.every((x) => x.original.length === 0 && x.ai === null));
  // No pages: one section, as before.
  assert.equal(buildSections("Just text.", []).length, 1);
  ok("AI readings: per-page sections, extracted offsets unchanged, scanned pages get sections");
}

console.log(`\n${passed} reflow checks passed`);
