/**
 * Token-bounded chunking with exact character offsets (port of backend ingestion/chunker.py).
 * Every chunk's text is exactly `text.slice(char_start, char_end)`, which citations and Read-mode
 * highlighting rely on. Tokens are estimated (≈ 4 chars per token, words count at least one), a
 * close enough proxy for sizing.
 */
import type { PageSpan } from "./db";

export type ChunkSpan = {
  ord: number;
  text: string;
  char_start: number;
  char_end: number;
  token_count: number;
  page_start: number | null;
  page_end: number | null;
};

type Unit = { start: number; end: number; tokens: number };

export function countTokens(s: string): number {
  if (!s) return 0;
  const words = s.match(/\S+/g)?.length ?? 0;
  return Math.max(words, Math.ceil(s.length / 4));
}

const SENTENCE = /[^\n.!?]*(?:[.!?]+["')\]]*|\n+|$)/g;
const WORDS = /\S+\s*/g;

function units(text: string, maxTokens: number): Unit[] {
  const out: Unit[] = [];
  SENTENCE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SENTENCE.exec(text))) {
    const start = m.index;
    const end = start + m[0].length;
    if (start === end) {
      if (start >= text.length) break;
      SENTENCE.lastIndex++; // empty match: step forward
      continue;
    }
    const seg = text.slice(start, end);
    const tok = countTokens(seg);
    if (tok <= maxTokens) {
      out.push({ start, end, tokens: tok });
      continue;
    }
    // Oversized sentence: fall back to word runs, then to hard slices.
    WORDS.lastIndex = 0;
    let w: RegExpExecArray | null;
    while ((w = WORDS.exec(seg))) {
      const ws = start + w.index;
      const we = ws + w[0].length;
      const wt = countTokens(w[0]);
      if (wt <= maxTokens) out.push({ start: ws, end: we, tokens: wt });
      else {
        const step = Math.max(1, Math.floor(((we - ws) * maxTokens) / (wt + 1)));
        for (let s = ws; s < we; s += step) {
          const e = Math.min(we, s + step);
          out.push({ start: s, end: e, tokens: countTokens(text.slice(s, e)) });
        }
      }
    }
  }
  out.sort((a, b) => a.start - b.start);
  return out;
}

const isSpace = (c: string) => /\s/.test(c);

export function chunkText(text: string, maxTokens = 800, overlapTokens = 120, pages?: PageSpan[]): ChunkSpan[] {
  const us = units(text, maxTokens);
  const chunks: ChunkSpan[] = [];
  let i = 0;
  while (i < us.length) {
    let total = 0;
    let j = i;
    while (j < us.length && total + us[j].tokens <= maxTokens) {
      total += us[j].tokens;
      j++;
    }
    if (j === i) j = i + 1;
    let start = us[i].start;
    let end = us[j - 1].end;
    while (start < end && isSpace(text[start])) start++;
    while (end > start && isSpace(text[end - 1])) end--;
    if (end > start) {
      const body = text.slice(start, end);
      chunks.push({
        ord: chunks.length,
        text: body,
        char_start: start,
        char_end: end,
        token_count: countTokens(body),
        page_start: null,
        page_end: null,
      });
    }
    if (j >= us.length) break;
    let k = j;
    let back = 0;
    while (k - 1 > i && back + us[k - 1].tokens <= overlapTokens) {
      k--;
      back += us[k].tokens;
    }
    i = k;
  }
  if (pages?.length)
    for (const c of chunks) {
      c.page_start = pageForOffset(pages, c.char_start);
      c.page_end = pageForOffset(pages, Math.max(c.char_start, c.char_end - 1));
    }
  return chunks;
}

export function pageForOffset(pages: PageSpan[], offset: number): number | null {
  if (!pages.length) return null;
  let lo = 0;
  let hi = pages.length; // first index with start > offset
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (pages[mid].start <= offset) lo = mid + 1;
    else hi = mid;
  }
  return pages[Math.max(lo - 1, 0)].page;
}
