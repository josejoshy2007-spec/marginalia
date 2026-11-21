/**
 * Display blocks for Read mode. PDF text arrives with a line break after every printed line, runs of
 * lone axis/graph labels and page furniture. None of that is changed in the stored text (chunk offsets
 * and citations depend on it staying byte-for-byte); this only decides how to *show* it.
 *
 * Every block carries absolute [start, end) offsets into `text`. Blocks are ordered and never overlap;
 * what lies between two blocks is whitespace only. Inside a "para" block a single "\n" is displayed as a
 * space (same length, so offsets stay exact).
 */

export type PageLike = { page: number; start: number; end?: number };

export type Block = {
  kind: "para" | "item" | "heading" | "figure" | "running";
  start: number;
  end: number;
  /** Set on the first block of each page. */
  page?: number;
  /** Number of source lines (figure blocks: shown in the collapsed label). */
  lines?: number;
};

type Line = { start: number; end: number; text: string };

const SENTENCE_END = /[.!?:;]["')\]]?$/;
const BULLET = /^([•·▪◦‣●○■□•]|[-–—*])\s+\S|^(\d{1,2}[.)]|\(?[a-z][.)]|\(?[ivx]{1,4}[.)])\s+\S/;
const HEADING_NUM = /^(\d{1,2}(\.\d{1,2}){0,3})\s+[A-Z][^.!?]{2,70}$/;
const HEADING_WORD = /^(chapter|section|unit|topic|part|exercise|worked example|example|summary|key points?)\b[^.!?]{0,70}$/i;

function splitLines(text: string, start: number, end: number): Line[] {
  const out: Line[] = [];
  let s = start;
  while (s <= end) {
    let e = text.indexOf("\n", s);
    if (e === -1 || e > end) e = end;
    if (e > s) out.push({ start: s, end: e, text: text.slice(s, e) });
    s = e + 1;
  }
  return out;
}

/** A short fragment typical of axis ticks, units, graph labels or equation scraps. */
function isShort(line: string): boolean {
  return line.length <= 12 && line.split(" ").length <= 6 && !SENTENCE_END.test(line);
}

/** Share of the run that is clearly not prose: digits, symbols or tiny tokens. */
function mostlyNonProse(lines: Line[]): boolean {
  let n = 0;
  for (const l of lines) if (/[\d=+\-−/^()<>×÷%°]/.test(l.text) || l.text.replace(/[^A-Za-z]/g, "").length <= 3) n++;
  return n * 2 >= lines.length;
}

function isAllCaps(line: string): boolean {
  const letters = line.replace(/[^A-Za-z]/g, "");
  return letters.length >= 4 && letters === letters.toUpperCase() && !HEADING_NUM.test(line) && !HEADING_WORD.test(line);
}

function isHeading(line: string): boolean {
  if (line.length > 80 || line.length < 3) return false;
  if (HEADING_NUM.test(line) || HEADING_WORD.test(line)) return true;
  const letters = line.replace(/[^A-Za-z]/g, "");
  return letters.length >= 4 && letters === letters.toUpperCase() && !SENTENCE_END.test(line) && line.split(" ").length <= 9;
}

/** Heading-like text only counts as a heading at the start of a paragraph or after a finished sentence. */
function headingContext(lines: Line[], i: number, para: Line[]): boolean {
  const prevOk = i === 0 || para.length === 0 || /[.?!:]["')\]]?$/.test(lines[i - 1].text);
  const next = lines[i + 1];
  return prevOk && (!next || /^["'(\[]?[A-Z]/.test(next.text));
}

/** An equation scrap such as "v = u + at": letters on both sides of an equals sign. */
const isEquation = (s: string) => /[A-Za-z][^=]*=[^=]*[A-Za-z]/.test(s);

const dropLeaders = (s: string) => /(\.\s?){6,}/.test(s);

/** Lines repeated at the top or bottom of many pages (running headers, footers, bare page numbers). */
function runningLines(text: string, pages: PageLike[]): Set<number> {
  const result = new Set<number>(); // start offsets of such lines
  if (pages.length < 4) return result;
  const norm = (s: string) => s.replace(/\d+/g, "#").replace(/\s+/g, " ").trim().toLowerCase();
  const cands: { key: string; start: number }[] = [];
  for (let i = 0; i < pages.length; i++) {
    const s = pages[i].start;
    const e = pages[i].end ?? (i + 1 < pages.length ? pages[i + 1].start : text.length);
    const lines = splitLines(text, s, e);
    if (!lines.length) continue;
    const picks = [lines[0], lines.length > 1 ? lines[lines.length - 1] : null, lines.length > 2 ? lines[1] : null];
    for (const l of picks) if (l && l.text.length <= 90) cands.push({ key: norm(l.text), start: l.start });
  }
  const counts = new Map<string, number>();
  for (const c of cands) counts.set(c.key, (counts.get(c.key) ?? 0) + 1);
  const min = Math.max(3, Math.ceil(pages.length * 0.15));
  for (const c of cands) if ((counts.get(c.key) ?? 0) >= min && c.key.length > 0) result.add(c.start);
  return result;
}

export function buildBlocks(text: string, pagesIn: PageLike[] = []): Block[] {
  const pages = [...pagesIn].sort((a, b) => a.start - b.start);
  const running = runningLines(text, pages);

  // 1. Raw chunks: blank-line separated, additionally cut at page starts.
  const cuts = new Set<number>(pages.map((p) => p.start));
  const raw: [number, number][] = [];
  const re = /\n{2,}/g;
  let last = 0;
  let m: RegExpExecArray | null;
  const pushRaw = (a: number, b: number) => {
    let s = a;
    for (const c of [...cuts].filter((c) => c > a && c < b).sort((x, y) => x - y)) {
      raw.push([s, c]);
      s = c;
    }
    if (b > s) raw.push([s, b]);
  };
  while ((m = re.exec(text))) {
    if (m.index > last) pushRaw(last, m.index);
    last = m.index + m[0].length;
  }
  if (last < text.length) pushRaw(last, text.length);

  // 2. Classify the lines of every raw chunk.
  const blocks: Block[] = [];
  for (const [rs, re_] of raw) {
    // Trim stray whitespace so blocks never start/end on it.
    let s = rs;
    let e = re_;
    while (s < e && /\s/.test(text[s])) s++;
    while (e > s && /\s/.test(text[e - 1])) e--;
    if (e <= s) continue;
    const lines = splitLines(text, s, e);

    let para: Line[] = [];
    const flush = () => {
      if (para.length) blocks.push({ kind: "para", start: para[0].start, end: para[para.length - 1].end, lines: para.length });
      para = [];
    };
    for (let i = 0; i < lines.length; ) {
      const l = lines[i];
      if (running.has(l.start)) {
        flush();
        blocks.push({ kind: "running", start: l.start, end: l.end, lines: 1 });
        i++;
        continue;
      }
      // A run of >= 3 short fragments is debris from a figure.
      if (isShort(l.text)) {
        let j = i;
        while (j < lines.length && isShort(lines[j].text) && !running.has(lines[j].start)) j++;
        const run = lines.slice(i, j);
        if (run.length >= 3 && run.some((r) => isEquation(r.text))) {
          // Equations stay readable text, never collapsed.
          para.push(...run);
          i = j;
          continue;
        }
        if (run.length >= 3 && !run.some((r) => BULLET.test(r.text)) && mostlyNonProse(run)) {
          flush();
          blocks.push({ kind: "figure", start: run[0].start, end: run[run.length - 1].end, lines: run.length });
          i = j;
          continue;
        }
      }
      if (isHeading(l.text) && !dropLeaders(l.text) && (isAllCaps(l.text) || headingContext(lines, i, para))) {
        flush();
        blocks.push({ kind: "heading", start: l.start, end: l.end, lines: 1 });
        i++;
        continue;
      }
      if (BULLET.test(l.text)) {
        flush();
        para.push(l);
        // Items own their continuation lines up to the next bullet/heading/figure-ish line.
        i++;
        while (i < lines.length && !BULLET.test(lines[i].text) && !(isHeading(lines[i].text) && (isAllCaps(lines[i].text) || headingContext(lines, i, para))) && !running.has(lines[i].start)) {
          if (isShort(lines[i].text)) {
            let j = i;
            while (j < lines.length && isShort(lines[j].text)) j++;
            if (j - i >= 3) break;
          }
          para.push(lines[i]);
          i++;
        }
        blocks.push({ kind: "item", start: para[0].start, end: para[para.length - 1].end, lines: para.length });
        para = [];
        continue;
      }
      para.push(l);
      i++;
    }
    flush();
  }

  // 3. Page labels on the first block that starts a page.
  let bi = 0;
  for (const p of pages) {
    while (bi < blocks.length && blocks[bi].start < p.start) bi++;
    if (bi < blocks.length && blocks[bi].page === undefined) blocks[bi].page = p.page;
  }
  return blocks;
}

/** Page number containing an absolute offset (last page whose start <= offset). */
export function pageAt(pages: PageLike[], offset: number): number | null {
  let found: number | null = null;
  for (const p of pages) {
    if (p.start <= offset) found = p.page;
    else break;
  }
  return found;
}

/** A citation click (focus) is acted on once: re-entering Read mode must not replay an old one. */
export function shouldHandleFocus(nonce: number, handled: number): boolean {
  return nonce !== handled;
}

/** One page of a PDF as Read mode's text view shows it. */
export type PageSection = {
  /** Undefined for sources without pages (one section holds everything). */
  page?: number;
  /** The extracted text's display blocks for this page (empty for a page with no text layer). */
  original: Block[];
  /** The AI reading's blocks (blank-line separated Markdown chunks), or null if the page has none. */
  ai: Block[] | null;
};

/**
 * Split the text into per-page sections. AI page readings were appended after the extracted text
 * (`aiPages` spans), so the extracted part is a prefix of `text` and its blocks keep their absolute
 * offsets; an AI reading's blocks are shifted by the span start. Nothing is re-normalised.
 */
export function buildSections(text: string, pagesIn: PageLike[], aiPages: PageLike[] = []): PageSection[] {
  const pages = [...pagesIn].sort((a, b) => a.start - b.start);
  if (!pages.length) return [{ original: buildBlocks(text, []), ai: null }];
  const ai = new Map(aiPages.map((a) => [a.page, a]));
  const origEnd = ai.size ? pages.reduce((m, p) => Math.max(m, p.end ?? p.start), 0) : text.length;
  const blocks = buildBlocks(origEnd < text.length ? text.slice(0, origEnd) : text, pages);
  const sections: PageSection[] = pages.map((p) => ({ page: p.page, original: [], ai: null }));
  let pi = 0;
  for (const b of blocks) {
    while (pi + 1 < pages.length && pages[pi + 1].start <= b.start) pi++;
    sections[pi].original.push(b);
  }
  sections.forEach((sec, i) => {
    const a = ai.get(pages[i].page);
    if (a) sec.ai = markdownBlocks(text, a.start, a.end ?? text.length);
  });
  return sections;
}

/** Blank-line separated chunks of text[start, end) with absolute offsets (an AI reading is Markdown, rendered chunk by chunk). */
export function markdownBlocks(text: string, start: number, end: number): Block[] {
  const out: Block[] = [];
  const re = /\n{2,}/g;
  const body = text.slice(start, end);
  const push = (a: number, b: number) => {
    let s = start + a;
    let e = start + b;
    while (s < e && /\s/.test(text[s])) s++;
    while (e > s && /\s/.test(text[e - 1])) e--;
    if (e > s) out.push({ kind: "para", start: s, end: e });
  };
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    push(last, m.index);
    last = m.index + m[0].length;
  }
  push(last, body.length);
  return out;
}

/** The page a text offset belongs to: an AI reading's page if it lies in one, else the extracted page. */
export function pageOfOffset(pages: PageLike[], aiPages: PageLike[] | undefined, offset: number): number | null {
  for (const a of aiPages ?? []) if (a.end !== undefined && offset >= a.start && offset < a.end) return a.page;
  return pageAt(pages, offset);
}
