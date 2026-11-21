/** Sentence-level citations:  npx tsx scripts/cite-narrow-test.mts */
import assert from "node:assert/strict";
import { claimBefore, claimTokens, narrowCitation, sentenceSpans } from "../lib/cite-narrow";

let passed = 0;
const ok = (label: string) => (passed++, console.log(`✓ ${label}`));

const chunk =
  "Mitochondria are organelles found in most eukaryotic cells. They produce ATP through aerobic respiration. " +
  "The inner membrane is folded into cristae, which increase the surface area for the electron transport chain. " +
  "Ribosomes, by contrast, assemble proteins from amino acids. Chloroplasts perform photosynthesis in plant cells.";
const before = "Earlier text about something else entirely. ";
const after = " Later text that follows the chunk.";
const text = before + chunk + after;
const cs = before.length;
const ce = cs + chunk.length;
const slice = (s: { start: number; end: number }) => text.slice(s.start, s.end);

// 1. The exact sentence.
{
  const r = narrowCitation(text, cs, ce, "Mitochondria produce ATP by aerobic respiration");
  assert.equal(slice(r), "They produce ATP through aerobic respiration.");
  ok("picks the one sentence the claim paraphrases");
}

// 2. Stemming and stopwords: plural/verb forms still match.
{
  const r = narrowCitation(text, cs, ce, "The cristae are folds that increase the surface area of the inner membrane");
  assert.equal(slice(r), "The inner membrane is folded into cristae, which increase the surface area for the electron transport chain.");
  ok("stems words and ignores stopwords");
}

// 3. A claim spanning two adjacent sentences returns both.
{
  const r = narrowCitation(text, cs, ce, "Mitochondria are organelles in eukaryotic cells that produce ATP through aerobic respiration");
  assert.equal(slice(r), "Mitochondria are organelles found in most eukaryotic cells. They produce ATP through aerobic respiration.");
  ok("returns two adjacent sentences when the pair is clearly better");
}

// 4. Weak match: falls back to the whole chunk.
{
  const r = narrowCitation(text, cs, ce, "The French Revolution began in 1789 with the storming of the Bastille");
  assert.deepEqual(r, { start: cs, end: ce });
  const r2 = narrowCitation(text, cs, ce, "cells");
  assert.deepEqual(r2, { start: cs, end: ce }, "one weak shared word is not enough");
  const r3 = narrowCitation(text, cs, ce, "");
  assert.deepEqual(r3, { start: cs, end: ce }, "no claim: whole chunk");
  const r4 = narrowCitation(text, cs, ce, undefined);
  assert.deepEqual(r4, { start: cs, end: ce });
  ok("weak or missing claim falls back to the whole chunk");
}

// 5. Offsets always stay inside the chunk, on any claim, including out-of-range chunk bounds.
{
  const claims = ["ATP", "electron transport chain surface area", "ribosomes assemble proteins", "plant cells photosynthesis chloroplasts", "zzz qqq", "Mitochondria are organelles found in most eukaryotic cells They produce ATP"];
  for (const c of claims) {
    const r = narrowCitation(text, cs, ce, c);
    assert.ok(r.start >= cs && r.end <= ce && r.end > r.start, `inside chunk for "${c}"`);
    assert.ok(!/^\s|\s$/.test(slice(r)), "no stray whitespace");
  }
  const clamped = narrowCitation(text, -5, text.length + 50, "Chloroplasts perform photosynthesis in plant cells");
  assert.ok(clamped.start >= 0 && clamped.end <= text.length);
  assert.equal(narrowCitation("", 0, 0, "anything").end, 0);
  ok("offsets stay inside the chunk");
}

// 6. Sentence splitting leaves abbreviations and decimals alone, and splits at blank lines.
{
  const t = "See Fig. 3 for details, e.g. the 3.5 mm gap. Next point here.\n\nA new paragraph without a stop";
  const spans = sentenceSpans(t, 0, t.length).map((s) => t.slice(s.start, s.end));
  assert.deepEqual(spans, ["See Fig. 3 for details, e.g. the 3.5 mm gap.", "Next point here.", "A new paragraph without a stop"]);
  ok("sentence splitter handles abbreviations, decimals and paragraphs");
}

// 7. Tokens.
{
  assert.deepEqual(claimTokens("The cells are dividing quickly"), ["cell", "divid", "quick"]);
  ok("claim tokens drop stopwords");
}

// 8. The claim for a marker: back to the previous sentence end or marker.
{
  assert.equal(claimBefore("Cells divide by mitosis. Mitochondria make ATP ⟦1⟧ and more.", "Cells divide by mitosis. Mitochondria make ATP ".length), "Mitochondria make ATP");
  assert.equal(claimBefore("First claim here. Second claim here. ⟦2⟧", "First claim here. Second claim here. ".length), "Second claim here");
  assert.equal(claimBefore("A is true ⟦1⟧ but B is also true ⟦2⟧", "A is true ⟦1⟧ but B is also true ".length), "but B is also true");
  assert.equal(claimBefore("Run of two ⟦1⟧⟦2⟧", "Run of two ⟦1⟧".length), "Run of two");
  assert.equal(claimBefore("⟦1⟧", 0), "");
  ok("claim extraction stops at sentence ends and earlier markers");
}

console.log(`\nALL ${passed} CITE-NARROW CHECKS PASSED`);
