/**
 * Sentence-level citations. A citation spans a whole chunk (up to ~800 tokens); the claim it supports is
 * usually one sentence of it. `narrowCitation` finds that sentence by token overlap with the answer's
 * claim, so Read mode can flash the sentence and only outline the chunk. Pure and offset-exact: the
 * returned span is always inside [chunkStart, chunkEnd) of the untouched source text.
 */

export type Span = { start: number; end: number };

const STOPWORDS = new Set(
  (
    "a an the and or but nor so yet of in on at to for from by with without into onto over under about as than then that this these those " +
    "is are was were be been being am do does did done have has had having will would can could may might must shall should " +
    "it its itself he she they them their theirs we us our you your i me my his her him which who whom whose what when where why how " +
    "not no also such there here very more most much many some any each both either neither other another same own just only too " +
    "if else while during after before between through because since until up down out off again further once all few one two"
  ).split(" "),
);

/** Light stemming: plural and common verb endings. Short words are left alone. */
function stem(w: string): string {
  if (w.length <= 3) return w;
  if (w.endsWith("ies") && w.length > 4) return w.slice(0, -3) + "y";
  for (const suf of ["ingly", "edly", "ing", "ed", "es", "ly", "s"]) {
    if (w.endsWith(suf) && w.length - suf.length >= 3) {
      if (suf === "s" && (w.endsWith("ss") || w.endsWith("us") || w.endsWith("is"))) return w;
      return w.slice(0, -suf.length);
    }
  }
  return w;
}

/** Lower-cased content words of `s`: stopwords out, light stemming, numbers kept. */
export function claimTokens(s: string): string[] {
  const words = s
    .toLowerCase()
    .replace(/\\[a-z]+/g, " ") // LaTeX commands
    .match(/[\p{L}\p{N}]+/gu);
  if (!words) return [];
  const out: string[] = [];
  for (const w of words) {
    if (STOPWORDS.has(w)) continue;
    if (w.length < 2 && !/\d/.test(w)) continue;
    out.push(stem(w));
  }
  return out;
}

const ABBREV = /(?:\b(?:e\.g|i\.e|etc|vs|fig|figs|eq|eqs|approx|cf|dr|mr|mrs|ms|prof|no|st|al|ca)|\b[A-Za-z]|\d)\.$/i;

/** Sentence spans (absolute offsets, trimmed) of text[start, end). Splits after . ! ? when a capital, digit or quote follows, and at blank lines. */
export function sentenceSpans(text: string, start: number, end: number): Span[] {
  const out: Span[] = [];
  const push = (a: number, b: number) => {
    while (a < b && /\s/.test(text[a])) a++;
    while (b > a && /\s/.test(text[b - 1])) b--;
    if (b > a) out.push({ start: a, end: b });
  };
  let s = start;
  const re = /[.!?]+["'”’)\]]*\s+|\n{2,}/g;
  const body = text.slice(start, end);
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    const cut = start + m.index + m[0].length;
    const isBlank = m[0].startsWith("\n");
    if (!isBlank) {
      const next = text[cut];
      if (cut >= end || !/[\p{Lu}\p{N}"'“‘(\[•\-–]/u.test(next ?? "")) continue; // lowercase after the full stop: not a boundary
      if (ABBREV.test(text.slice(Math.max(start, cut - 12), cut).trimEnd())) continue;
    }
    push(s, cut);
    s = cut;
  }
  push(s, end);
  return out;
}

type Scored = { tokens: Set<string>; inter: number; score: number };

function score(claim: Set<string>, tokens: Set<string>): Scored {
  let inter = 0;
  for (const t of claim) if (tokens.has(t)) inter++;
  const cover = claim.size ? inter / claim.size : 0;
  const dice = claim.size + tokens.size ? (2 * inter) / (claim.size + tokens.size) : 0;
  return { tokens, inter, score: 0.75 * cover + 0.25 * dice };
}

const WEAK = 0.34; // below this the match is not trusted: highlight the whole chunk
const PAIR_GAIN = 0.12; // two adjacent sentences must beat the best single one by this much

/**
 * The sentence of text[chunkStart, chunkEnd) that best matches `claim`, or two adjacent sentences if that
 * is clearly better. Falls back to the whole chunk when nothing matches well.
 */
export function narrowCitation(sourceText: string, chunkStart: number, chunkEnd: number, claim: string | null | undefined): Span {
  const start = Math.max(0, Math.min(chunkStart, sourceText.length));
  const end = Math.max(start, Math.min(chunkEnd, sourceText.length));
  const whole = { start, end };
  const ctoks = new Set(claimTokens(claim ?? ""));
  if (ctoks.size < 2 || end <= start) return whole; // one word says too little to pick a sentence
  const sents = sentenceSpans(sourceText, start, end);
  if (sents.length < 2) return whole;

  const toks = sents.map((s) => new Set(claimTokens(sourceText.slice(s.start, s.end))));
  const single = toks.map((t) => score(ctoks, t));
  let best = 0;
  for (let i = 1; i < sents.length; i++) if (single[i].score > single[best].score) best = i;

  let from = best;
  let to = best;
  let top = single[best];
  for (const j of [best - 1, best + 1]) {
    if (j < 0 || j >= sents.length) continue;
    const pair = score(ctoks, new Set([...toks[best], ...toks[j]]));
    // Both sentences must contribute something the other lacks, and the pair must be clearly better.
    const gain = [...toks[j]].some((t) => ctoks.has(t) && !toks[best].has(t));
    if (gain && pair.score >= top.score + PAIR_GAIN && pair.score > score(ctoks, toks[best]).score) {
      from = Math.min(best, j);
      to = Math.max(best, j);
      top = pair;
    }
  }
  if (top.score < WEAK || top.inter < 2) return whole;
  // Another sentence matches just as well: the claim does not single one out.
  for (let i = 0; i < sents.length; i++) if ((i < from || i > to) && single[i].score >= top.score - 0.02) return whole;
  return { start: Math.max(start, sents[from].start), end: Math.min(end, sents[to].end) };
}

/**
 * The claim a citation marker belongs to: the text before the marker, back to the previous sentence end or
 * marker. Handles "⟦1⟧⟦2⟧" runs and markers placed after the full stop ("… cells. ⟦1⟧").
 */
export function claimBefore(text: string, markerIndex: number): string {
  let before = text.slice(0, markerIndex);
  before = before.replace(/(?:\s*⟦\d+⟧)+\s*$/, "").trimEnd(); // earlier markers of the same run
  before = before.replace(/[.!?]+["'”’)\]]*$/, "").trimEnd(); // the full stop the marker follows
  let from = 0;
  const marker = before.lastIndexOf("⟦");
  const close = marker >= 0 ? before.indexOf("⟧", marker) : -1;
  if (close >= 0) from = close + 1;
  const re = /[.!?]+["'”’)\]]*\s+(?=[\p{Lu}\p{N}"'“‘(\[])|\n+/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(before))) if (m.index + m[0].length > from && !ABBREV.test(before.slice(0, m.index + 1))) from = m.index + m[0].length;
  return before
    .slice(from)
    .replace(/⟦\d+⟧/g, " ")
    .replace(/\$+/g, " ")
    .replace(/[*_`#>]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
