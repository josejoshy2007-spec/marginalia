/**
 * Search over the device's chunks, with no API calls. Chunks carry 384-d unit-length vectors from the
 * on-device model (embedder.ts), so cosine similarity is a dot product. Chunks that still have an
 * older vector (e.g. 768-d from Gemini, until the background re-embed reaches them) or when the model
 * can't load are searched by keywords instead (BM25). If both kinds are in play the two rankings are
 * merged with reciprocal-rank fusion. Only the given (checked) sources are searched; an empty list
 * returns nothing, never "everything".
 */
import { db, type ChunkRow, type Citation, type SourceRow } from "./db";
import { embedQuery } from "./embedder";
import { EMBED_DIM } from "./settings";
import { pageLabel } from "../labels";

export type Retrieved = { chunk: ChunkRow; source: SourceRow; score: number };

type Bm25 = { tf: Map<string, number>[]; len: number[]; df: Map<string, number>; avg: number };
type Cached = { chunks: ChunkRow[]; bm25?: Bm25 };
const cache = new Map<number, Cached>();

export function forgetSource(sourceId: number) {
  cache.delete(sourceId);
}

async function cached(sourceId: number): Promise<Cached> {
  let c = cache.get(sourceId);
  if (!c) {
    const chunks = await db.chunks.where("source_id").equals(sourceId).sortBy("ord");
    c = { chunks };
    cache.set(sourceId, c);
  }
  return c;
}

async function sourceChunks(sourceId: number): Promise<ChunkRow[]> {
  return (await cached(sourceId)).chunks;
}

async function readySources(subjectId: number, sourceIds: number[]): Promise<SourceRow[]> {
  const rows = await db.sources.bulkGet(sourceIds);
  return rows
    .filter((s): s is SourceRow => !!s && s.subject_id === subjectId)
    .sort((a, b) => a.id! - b.id!);
}

export const hasLocalVector = (c: ChunkRow) => c.embedding?.length === EMBED_DIM;

// ---------------------------------------------------------------- keyword search (BM25)

export const tokenize = (text: string): string[] => (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length >= 3);

function bm25Index(c: Cached): Bm25 {
  if (c.bm25) return c.bm25;
  const tf: Map<string, number>[] = [];
  const len: number[] = [];
  const df = new Map<string, number>();
  for (const chunk of c.chunks) {
    const m = new Map<string, number>();
    const words = tokenize(chunk.text);
    for (const w of words) m.set(w, (m.get(w) ?? 0) + 1);
    for (const w of m.keys()) df.set(w, (df.get(w) ?? 0) + 1);
    tf.push(m);
    len.push(words.length);
  }
  const avg = len.reduce((a, b) => a + b, 0) / Math.max(1, len.length);
  return (c.bm25 = { tf, len, df, avg });
}

const K1 = 1.4;
const B = 0.75;

/** BM25 score of the given chunk indexes of one cached source. */
function bm25Scores(c: Cached, indexes: number[], terms: string[]): number[] {
  const idx = bm25Index(c);
  const n = c.chunks.length;
  return indexes.map((i) => {
    let score = 0;
    for (const t of terms) {
      const f = idx.tf[i].get(t);
      if (!f) continue;
      const df = idx.df.get(t) ?? 0;
      const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
      score += (idf * f * (K1 + 1)) / (f + K1 * (1 - B + (B * idx.len[i]) / (idx.avg || 1)));
    }
    return score;
  });
}

// ---------------------------------------------------------------- retrieval

export async function retrieve(subjectId: number, sourceIds: number[], query: string, k: number): Promise<Retrieved[]> {
  if (!sourceIds.length) return [];
  const sources = await readySources(subjectId, sourceIds);
  if (!sources.length) return [];

  const vector: Retrieved[] = [];
  const keyword: Retrieved[] = [];
  const entries = await Promise.all(sources.map(async (source) => ({ source, c: await cached(source.id!) })));
  const anyLocal = entries.some((e) => e.c.chunks.some(hasLocalVector));
  let q: Float32Array | null = null;
  if (anyLocal) {
    try {
      q = await embedQuery(query);
    } catch {
      q = null; // the model could not load: everything falls back to keywords
    }
  }
  const terms = [...new Set(tokenize(query))];
  for (const { source, c } of entries) {
    const kwIdx: number[] = [];
    c.chunks.forEach((chunk, i) => {
      if (q && hasLocalVector(chunk)) {
        const v = chunk.embedding;
        let dot = 0;
        for (let j = 0; j < v.length; j++) dot += v[j] * q![j];
        vector.push({ chunk, source, score: dot });
      } else kwIdx.push(i);
    });
    if (kwIdx.length && terms.length) {
      const scores = bm25Scores(c, kwIdx, terms);
      kwIdx.forEach((i, j) => {
        if (scores[j] > 0) keyword.push({ chunk: c.chunks[i], source, score: scores[j] });
      });
    }
  }
  vector.sort((a, b) => b.score - a.score);
  keyword.sort((a, b) => b.score - a.score);
  if (!keyword.length) return vector.slice(0, k);
  if (!vector.length) return keyword.slice(0, k);
  // Both kinds: reciprocal-rank fusion (scores of the two methods aren't comparable).
  const fused = new Map<number, Retrieved & { rrf: number }>();
  for (const list of [vector, keyword])
    list.forEach((r, rank) => {
      const f = fused.get(r.chunk.id!) ?? { ...r, rrf: 0 };
      f.rrf += 1 / (60 + rank + 1);
      fused.set(r.chunk.id!, f);
    });
  return [...fused.values()]
    .sort((a, b) => b.rrf - a.rrf)
    .slice(0, k)
    .map(({ rrf, ...r }) => ({ ...r, score: rrf }));
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
