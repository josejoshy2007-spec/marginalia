/**
 * Search over the device's chunks. Embeddings are unit length, so cosine similarity is a dot
 * product. Vectors are cached per source in memory (a 900-page book ≈ 3,000 chunks ≈ 9 MB).
 * Only the given (checked) sources are searched; an empty list returns nothing, never "everything".
 */
import { db, type ChunkRow, type Citation, type SourceRow } from "./db";
import { embed } from "./gemini";
import { pageLabel } from "../labels";

export type Retrieved = { chunk: ChunkRow; source: SourceRow; score: number };

type Cached = { chunks: ChunkRow[] };
const cache = new Map<number, Cached>();

export function forgetSource(sourceId: number) {
  cache.delete(sourceId);
}

async function sourceChunks(sourceId: number): Promise<ChunkRow[]> {
  let c = cache.get(sourceId);
  if (!c) {
    const chunks = await db.chunks.where("source_id").equals(sourceId).sortBy("ord");
    c = { chunks };
    cache.set(sourceId, c);
  }
  return c.chunks;
}

async function readySources(subjectId: number, sourceIds: number[]): Promise<SourceRow[]> {
  const rows = await db.sources.bulkGet(sourceIds);
  return rows
    .filter((s): s is SourceRow => !!s && s.subject_id === subjectId)
    .sort((a, b) => a.id! - b.id!);
}

export async function retrieve(subjectId: number, sourceIds: number[], query: string, k: number): Promise<Retrieved[]> {
  if (!sourceIds.length) return [];
  const sources = await readySources(subjectId, sourceIds);
  if (!sources.length) return [];
  const [q] = await embed([query], "RETRIEVAL_QUERY");
  const hits: Retrieved[] = [];
  for (const source of sources) {
    for (const chunk of await sourceChunks(source.id!)) {
      const v = chunk.embedding;
      if (!v || v.length !== q.length) continue;
      let dot = 0;
      for (let i = 0; i < v.length; i++) dot += v[i] * q[i];
      hits.push({ chunk, source, score: dot });
    }
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, k);
}

/** Chunks a generator sees: focus-matched, or spread evenly through each source. */
export async function selectPassages(
  subjectId: number,
  sourceIds: number[],
  focus: string | null | undefined,
  budget: number,
): Promise<Retrieved[]> {
  if (!sourceIds.length) return [];
  if (focus?.trim()) return retrieve(subjectId, sourceIds, focus, budget);
  const sources = await readySources(subjectId, sourceIds);
  if (!sources.length) return [];
  const perSource = Math.max(1, Math.floor(budget / sources.length));
  const picked: Retrieved[] = [];
  for (const source of sources) {
    const chunks = await sourceChunks(source.id!);
    if (!chunks.length) continue;
    let chosen = chunks;
    if (chunks.length > perSource) {
      const step = chunks.length / perSource;
      chosen = Array.from({ length: perSource }, (_, i) => chunks[Math.floor(i * step)]);
    }
    picked.push(...chosen.map((chunk) => ({ chunk, source, score: 0 })));
  }
  return picked.slice(0, budget);
}

export const MAX_SUMMARY_CHUNKS = 700;

/** All chunks of the chosen sources in reading order (optional page range), or focus-matched ones. */
export async function summaryPassages(
  subjectId: number,
  sourceIds: number[],
  focus?: string | null,
  pageFrom?: number | null,
  pageTo?: number | null,
): Promise<Retrieved[]> {
  if (!sourceIds.length) return [];
  if (focus?.trim()) {
    const hits = await retrieve(subjectId, sourceIds, focus, 30);
    return hits.sort((a, b) => a.source.id! - b.source.id! || a.chunk.ord - b.chunk.ord);
  }
  const out: Retrieved[] = [];
  for (const source of await readySources(subjectId, sourceIds)) {
    for (const chunk of await sourceChunks(source.id!)) {
      if (pageFrom && (chunk.page_end ?? 0) < pageFrom) continue;
      if (pageTo && (chunk.page_start ?? Infinity) > pageTo) continue;
      out.push({ chunk, source, score: 0 });
      if (out.length > MAX_SUMMARY_CHUNKS)
        throw new Error("That's more than about 1,000 pages at once. Pick a page range (e.g. one chapter).");
    }
  }
  return out;
}

export function citation(r: Retrieved): Citation {
  return {
    source_id: r.source.id!,
    source_title: r.source.title,
    chunk_id: r.chunk.id!,
    start: r.chunk.char_start,
    end: r.chunk.char_end,
    page: r.chunk.page_start,
    cited_text: r.chunk.text.slice(0, 240),
    page_label: pageLabel(r.source.kind).short,
  };
}

export function passageBlock(n: number, r: Retrieved): string {
  const where = r.chunk.page_start ? `, ${pageLabel(r.source.kind).short} ${r.chunk.page_start}` : "";
  return `<passage n="${n}" source="${r.source.title}${where}">\n${r.chunk.text}\n</passage>`;
}

export const passagesPrompt = (ps: Retrieved[]) => ps.map((r, i) => passageBlock(i + 1, r)).join("\n\n");
