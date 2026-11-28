/**
 * "Read this page with AI": the data side. A page's AI reading is APPENDED to `source.text` (after a blank
 * line) and recorded in `source.ai_pages`, so no existing offset ever moves and `chunk.text ==
 * source.text[char_start:char_end]` keeps holding for old and new chunks alike. Only the appended span is
 * chunked (offsets relative to the full text, page_start = page_end = the page); vectors are filled in
 * later by the usual background fill. Reading a page again replaces its ai_pages entry, deletes that
 * entry's old chunks and appends the new reading; the orphaned old text just stays in `text`.
 */
import { chunkText, type ChunkSpan } from "./chunker";
import { db, type PageSpan } from "./db";

export const AI_SEP = "\n\n";
export const BLANK_PAGE = "[Blank page]";

export type AppendPlan = { text: string; ai_pages: PageSpan[]; span: PageSpan; replaced: PageSpan | null };

/** Pure: the new text and ai_pages after appending `reading` as page `page`. */
export function planAiAppend(text: string, aiPages: PageSpan[], page: number, reading: string): AppendPlan {
  const body = reading.replace(/\r\n?/g, "\n").replace(/\x00/g, "").trim() || BLANK_PAGE;
  const start = text.length + AI_SEP.length;
  const next = text + AI_SEP + body;
  const span: PageSpan = { page, start, end: next.length };
  return {
    text: next,
    ai_pages: [...aiPages.filter((p) => p.page !== page), span],
    span,
    replaced: aiPages.find((p) => p.page === page) ?? null,
  };
}

/** Pure: chunks of text[span.start, span.end) with absolute offsets, tagged with the page, ords from `firstOrd`. */
export function chunkSpan(text: string, span: PageSpan, firstOrd: number): ChunkSpan[] {
  return chunkText(text.slice(span.start, span.end), 800, 120).map((c, i) => ({
    ...c,
    ord: firstOrd + i,
    char_start: c.char_start + span.start,
    char_end: c.char_end + span.start,
    page_start: span.page,
    page_end: span.page,
  }));
}

/** End of the extracted (original) text: where the first AI reading was appended from. */
export function originalEnd(pages: PageSpan[]): number {
  return pages.reduce((m, p) => Math.max(m, p.end), 0);
}

/**
 * Every chunk a source should have, from scratch: the extracted text with its page spans, then each page's
 * current AI reading (orphaned older readings are not indexed). Same as plain chunking when there are no readings.
 */
export function indexSpans(src: { text: string; pages: PageSpan[]; ai_pages?: PageSpan[] }): ChunkSpan[] {
  if (!src.ai_pages?.length) return chunkText(src.text, 800, 120, src.pages);
  const out = chunkText(src.text.slice(0, originalEnd(src.pages)), 800, 120, src.pages);
  for (const span of [...src.ai_pages].sort((a, b) => a.start - b.start)) out.push(...chunkSpan(src.text, span, out.length));
  return out;
}

/** A fresh id for one content revision: the same revision number on two devices can hold different readings. */
export const newContentTag = () => Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-3);

type Chunky = { ord: number; char_start: number; page_start: number | null; page_end: number | null };

/** True for a chunk of an AI reading (it sits after the extracted text). */
export const isAiChunk = (c: Chunky, pages: PageSpan[]) => c.char_start >= originalEnd(pages);

/**
 * Chunks the AI should see: an AI reading REPLACES the original text of its page, so original chunks whose
 * pages all have a reading are left out. (The chunks stay stored; Read mode's toggle still shows them.)
 */
export function withoutSuperseded<T extends Chunky>(chunks: T[], src: { pages: PageSpan[]; ai_pages?: PageSpan[] }): T[] {
  if (!src.ai_pages?.length) return chunks;
  const read = new Set(src.ai_pages.map((p) => p.page));
  return chunks.filter((c) => {
    if (isAiChunk(c, src.pages) || c.page_start == null) return true;
    for (let p = c.page_start; p <= (c.page_end ?? c.page_start); p++) if (!read.has(p)) return true;
    return false;
  });
}

/** Reading order: by page, the original text before the AI reading, then ord. */
export const readingOrder =
  (pages: PageSpan[]) =>
  (a: Chunky, b: Chunky): number =>
    (a.page_start ?? 0) - (b.page_start ?? 0) ||
    Number(isAiChunk(a, pages)) - Number(isAiChunk(b, pages)) ||
    a.ord - b.ord;

export type AppendResult = { span: PageSpan; added: number; removed: number; text: string };

/** Append a page reading to a source and index it (chunks without vectors). Atomic. */
export async function applyAiReading(sourceId: number, page: number, reading: string): Promise<AppendResult> {
  return db.transaction("rw", db.sources, db.chunks, async () => {
    const src = await db.sources.get(sourceId);
    if (!src) throw new Error("Source not found");
    if (src.kind !== "pdf" && src.kind !== "slides") throw new Error("Only PDFs and slides can be read with AI.");
    if (src.status !== "ready") throw new Error("Wait until the source is ready");
    if (page < 1 || page > src.pages.length) throw new Error(`This ${src.kind === "slides" ? "deck" : "PDF"} has ${src.pages.length} ${src.kind === "slides" ? "slides" : "pages"}.`);
    const plan = planAiAppend(src.text, src.ai_pages ?? [], page, reading);
    const chunks = await db.chunks.where("source_id").equals(sourceId).toArray();
    let removed = 0;
    if (plan.replaced) {
      const old = chunks.filter((c) => c.char_start >= plan.replaced!.start && c.char_start < plan.replaced!.end).map((c) => c.id!);
      await db.chunks.bulkDelete(old);
      removed = old.length;
    }
    const firstOrd = chunks.reduce((m, c) => Math.max(m, c.ord), -1) + 1;
    const spans = chunkSpan(plan.text, plan.span, firstOrd);
    await db.chunks.bulkAdd(
      spans.map((c) => ({
        source_id: sourceId, subject_id: src.subject_id, ord: c.ord, text: c.text, char_start: c.char_start, char_end: c.char_end,
        page_start: c.page_start, page_end: c.page_end, token_count: c.token_count, embedding: new Float32Array(0),
      })),
    );
    await db.sources.update(sourceId, { text: plan.text, ai_pages: plan.ai_pages, content_rev: (src.content_rev ?? 0) + 1, content_tag: newContentTag() });
    return { span: plan.span, added: spans.length, removed, text: plan.text };
  });
}
