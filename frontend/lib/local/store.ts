/**
 * The on-device engine behind the same `api` surface the UI used against the FastAPI server.
 * Data lives in IndexedDB; Gemini is called directly with the student's key. Background jobs
 * (indexing, transcription, generation) run in the page, keep their status in the database, and
 * are resumed when the app is opened again.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import type {
  ArtifactDetail,
  ArtifactKind,
  ArtifactSummary,
  CardItem,
  ChatPayload,
  GenerateRequest,
  IBOptions,
  MarkResult,
  QuizResult,
  PageReadStatus,
  Source,
  SourceDetail,
  StreamEvent,
  Subject,
} from "../api";
import { db, now, requestPersistence, tombstone, type ArtifactRow, type CardRow, type SourceRow, type SubjectRow } from "./db";
import { chunkText } from "./chunker";
import { buildExam, draftMarkscheme, EXAM_SIZES, markAnswer, markQuiz } from "./exams";
import {
  buildConceptMap,
  buildDeck,
  buildEpisode,
  buildQuiz,
  buildSheet,
  EPISODE_FORMATS,
  questionMarks,
  SHEETS,
  type Rec,
} from "./gen";
import { GeminiError, patiently, speak, streamGenerate } from "./gemini";
import { embedPassages, resetWorker, whenIdle } from "./embedder";
import * as ib from "./ib";
import { youtubeInfo, videoIdOf } from "./youtube";
import { parseText, parseUrl, parsePdf, openPdf, pdfPageCount, ParseError, transcribeRecording, transcribeYoutube, YOUTUBE_RE } from "./parse";
import { citation, forgetSource, passageBlock, retrieve, selectPassages, summaryPassages, type Retrieved } from "./search";
import { EMBED_DIM, getSettings } from "./settings";
import { preview, schedule, type Grade } from "./srs";
import { buildSummary, SUMMARY_FORMATS, SUMMARY_LENGTH } from "./summarize";
import { blobToBase64, readAnswer, readQuestion, readQuizAnswers, transcribeVoice } from "./vision";
import { makeThumb } from "../photos";
import { exportAll, importAll } from "./backup";
import type { Thread } from "../threads";
import type { ThreadRow } from "./db";
import { formatOf, scanPptx, unsupportedReason } from "./formats";
import { applyAiReading, BLANK_PAGE, indexSpans } from "./aipages";
import { base64Bytes, MAX_REQUEST_BYTES, pickPictures, readPageImage, readSlideBatch, renderPageJpeg, shrinkPicture, SLIDES_PER_REQUEST, UNREADABLE_FIGURE, type SlideInput } from "./pageread";
import { viewPptxChecked, type Img as DeckImg, type Slide as DeckSlide } from "../office-view";

// ---------------------------------------------------------------- jobs

type Progress = { progress: number; stage: string };
const sourceProgress = new Map<number, Progress>();
const genProgress = new Map<number, Progress>();

/** A tiny FIFO with `n` concurrent workers. */
class Queue {
  private running = 0;
  private waiting: (() => Promise<void>)[] = [];
  constructor(private n: number) {}
  push(task: () => Promise<void>) {
    this.waiting.push(task);
    this.pump();
  }
  private pump() {
    while (this.running < this.n && this.waiting.length) {
      const t = this.waiting.shift()!;
      this.running++;
      t().finally(() => {
        this.running--;
        this.pump();
      });
    }
  }
}
const docsQueue = new Queue(1); // phones have little memory: one book at a time
const mediaQueue = new Queue(1);
const genQueue = new Queue(2);

const changed = (detail?: { subjectId: number; kind: string }) => {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("marginalia:artifacts-changed", { detail: detail ?? null }));
};

const message = (e: unknown) =>
  e instanceof GeminiError || e instanceof ParseError || e instanceof Error ? e.message : "Something went wrong.";

const uploadKey = (sourceId: number) => `upload-${sourceId}`;
/** The original PDF, kept on this device for Read mode's page view (not synced, not in backups). */
const pdfKey = (sourceId: number) => `pdf-${sourceId}`;
/** The original of a non-PDF file source (photo, slides, document, recording); local only, never synced. */
const origKey = (sourceId: number) => `orig-${sourceId}`;
const audioKey = (episodeId: number) => `episode-${episodeId}`;

let booted: Promise<void> | null = null;
/** Once per app start: resume interrupted jobs. */
function boot(): Promise<void> {
  booted ??= (async () => {
    requestPersistence();
    await resumeJobs();
    if (typeof window !== "undefined") window.addEventListener("marginalia:library-changed", () => (forgetStats(), void reembedStale()));
    void reembedStale();
  })();
  return booted;
}

/**
 * Rows left "processing" (app closed mid-job, or an imported backup). Work that is free (local parsing,
 * local embeddings) resumes by itself. Anything that would spend Gemini calls the student did not ask for
 * (transcribing a recording, reading a photo, re-running a generation) is marked failed with a Try again.
 */
const STOPPED = "Stopped when the app closed. Tap Try again.";
async function resumeJobs() {
  for (const s of await db.sources.where("status").equals("processing").toArray()) {
    if (sourceProgress.has(s.id!)) continue;
    const hasFile = !!(await db.blobs.get(uploadKey(s.id!)));
    if (s.text) submitSource(s.id!); // text is already here: only local chunking and embedding is left
    else if (hasFile && s.kind !== "audio" && s.kind !== "image") submitSource(s.id!); // local parse of a stored file
    else if (hasFile) await db.sources.update(s.id!, { status: "failed", error: STOPPED }); // Try again re-runs Gemini on the stored upload
    else await db.sources.update(s.id!, { status: "failed", error: "Interrupted. Please add it again." });
  }
  for (const a of await db.artifacts.where("status").equals("processing").toArray()) {
    if (genProgress.has(a.id!)) continue;
    await db.artifacts.update(a.id!, { status: "failed", error: a.subtype === "custom" ? "Interrupted." : STOPPED });
  }
}

// ---------------------------------------------------------------- serialisers

async function subjectOut(s: SubjectRow): Promise<Subject> {
  const source_count = await db.sources.where("subject_id").equals(s.id!).count();
  return { id: s.id!, name: s.name, created_at: s.created_at, source_count, ib_course: s.ib_course ?? null, ib_level: s.ib_level ?? null };
}

async function sourceOut(s: SourceRow): Promise<Source> {
  const p = s.status === "processing" ? sourceProgress.get(s.id!) : undefined;
  const canRetry = s.status === "failed" && (!!s.text || !!(await db.blobs.get(uploadKey(s.id!))));
  return {
    id: s.id!,
    subject_id: s.subject_id,
    kind: s.kind,
    title: s.title,
    url: s.url,
    checked: s.checked,
    status: s.status,
    chunk_count: await db.chunks.where("source_id").equals(s.id!).count(),
    char_count: s.text.length,
    page_count: s.pages.length,
    created_at: s.created_at,
    progress: p?.progress ?? null,
    stage: p?.stage ?? null,
    error: s.error ?? null,
    can_retry: canRetry,
    ...(s.no_text_layer ? { no_text_layer: true } : {}),
    ...(s.ai_pages?.length ? { ai_page_count: s.ai_pages.length } : {}),
    ...(s.status === "ready" ? { search_progress: await searchProgress(s.id!) } : {}),
  };
}

function cleanCard(input: { front: string; back: string }) {
  const front = String(input.front ?? "").trim();
  const back = String(input.back ?? "").trim();
  if (!front || !back) throw new Error("A card needs both a front and a back.");
  return { front, back };
}

function cardOut(c: CardRow, t = Date.now()): CardItem {
  return {
    id: c.id!,
    front: c.front,
    back: c.back,
    cite: c.cite,
    reps: c.reps,
    lapses: c.lapses,
    interval_days: Math.round(c.interval_days * 100) / 100,
    due_at: c.due_at,
    is_new: c.reps === 0 && !c.last_reviewed_at,
    next: preview(c, t),
  };
}

async function latestMarks(artId: number): Promise<Record<number, { answer: string; result: MarkResult | null }>> {
  const latest: Record<number, { answer: string; result: MarkResult | null }> = {};
  for (const att of await db.attempts.where("quiz_id").equals(artId).sortBy("id"))
    for (const e of att.answers as Rec[])
      if (e && typeof e === "object" && "q" in e) latest[e.q] = { answer: e.answer ?? "", result: e.result ?? null };
  return latest;
}

async function artifactOut(a: ArtifactRow, detail: true): Promise<ArtifactDetail>;
async function artifactOut(a: ArtifactRow, detail?: false): Promise<ArtifactSummary>;
async function artifactOut(a: ArtifactRow, detail = false): Promise<ArtifactSummary | ArtifactDetail> {
  const c = a.content as Rec;
  const out: Rec = {
    id: a.id,
    subject_id: a.subject_id,
    kind: a.kind,
    subtype: a.subtype,
    title: a.title,
    params: a.params,
    created_at: a.created_at,
    has_audio: a.kind === "episode" && !!(await db.blobs.get(audioKey(a.id!))),
    status: a.status,
    error: a.error ?? null,
  };
  if (a.status === "processing") {
    const p = genProgress.get(a.id!);
    out.progress = p?.progress ?? null;
    out.stage = p?.stage ?? null;
  }
  if (a.kind === "deck") {
    const cards = await db.cards.where("deck_id").equals(a.id!).toArray();
    const t = now();
    out.card_count = cards.length;
    out.due_count = cards.filter((x) => x.due_at <= t).length;
    if (detail) out.cards = cards.sort((x, y) => x.id! - y.id!).map((x) => cardOut(x));
  }
  if (a.kind === "quiz") {
    const qs: Rec[] = c.questions ?? [];
    const attempts = await db.attempts.where("quiz_id").equals(a.id!).sortBy("id");
    out.question_count = qs.length;
    out.total_marks = qs.reduce((s, q) => s + questionMarks(q), 0);
    out.types = [...new Set(qs.map((q) => q.type ?? "mcq"))].sort();
    out.attempts = attempts.length;
    out.best = attempts.length ? Math.max(...attempts.map((t) => t.score)) : null;
    out.last = attempts.length ? attempts[attempts.length - 1].score : null;
  }
  if (a.kind === "summary") out.parts = c.parts ?? null;
  if (a.kind === "exam") {
    const qs: Rec[] = c.questions ?? [];
    const latest = await latestMarks(a.id!);
    const idx = Object.keys(latest).map(Number);
    out.question_count = qs.length;
    out.total_marks = qs.reduce((s, q) => s + q.marks, 0);
    out.answered = idx.length;
    out.scored = idx.reduce((s, i) => s + (latest[i].result?.marks_awarded ?? 0), 0);
    out.scored_of = idx.filter((i) => i < qs.length).reduce((s, i) => s + qs[i].marks, 0);
    if (detail) out.marked = Object.fromEntries(Object.entries(latest));
  }
  if (a.kind === "episode") {
    const words = (c.lines ?? []).reduce((s: number, l: Rec) => s + l.text.split(/\s+/).length, 0);
    out.minutes = Math.max(1, Math.round(words / 150));
    out.summary = c.summary ?? "";
  }
  if (detail) {
    out.content = a.content;
    out.passages = a.passages;
  }
  return out as ArtifactSummary;
}

async function need<T>(p: Promise<T | undefined>, what = "Not found"): Promise<T> {
  const v = await p;
  if (v === undefined) throw new Error(what);
  return v;
}

// ---------------------------------------------------------------- sources

const EMBED_BATCH = 4; // small, so a search query waits behind at most one short batch
const INSERT_BATCH = 400;

/** Per source: how many chunks have no 384-d vector yet. Counting loads the vectors, so it is cached. */
const searchStats = new Map<number, { total: number; bare: number }>();
/** Bumped whenever a source's vectors change, so a count read before the change is never cached or trusted. */
const statsVersion = new Map<number, number>();
let statsEpoch = 0;
const versionOf = (id: number) => `${statsEpoch}:${statsVersion.get(id) ?? 0}`;
const bumpStats = (id: number) => statsVersion.set(id, (statsVersion.get(id) ?? 0) + 1);
function forgetStats(id?: number) {
  if (id === undefined) {
    searchStats.clear();
    statsEpoch++;
  } else {
    searchStats.delete(id);
    bumpStats(id);
  }
}
/** Test seam: runs after searchProgress has read a source's chunks, before it stores the count. */
const searchHooks: { afterRead?: (id: number) => Promise<void> } = {};
/** Background vector filling gave up (no worker, or it timed out). While set, no search_progress is reported. */
let searchFillPaused = false;
let fillRetryMs = 60_000;
let fillRetryTimer: ReturnType<typeof setTimeout> | null = null;
let fillRetried = false;

async function searchProgress(id: number): Promise<number | undefined> {
  if (searchFillPaused) return undefined; // nothing is improving it: don't show a label that polling would chase forever
  let st = searchStats.get(id);
  for (let attempt = 0; !st; attempt++) {
    const v = versionOf(id);
    const chunks = await db.chunks.where("source_id").equals(id).toArray();
    const fresh = { total: chunks.length, bare: chunks.filter((c) => c.embedding?.length !== EMBED_DIM).length };
    await searchHooks.afterRead?.(id);
    if (v === versionOf(id)) {
      searchStats.set(id, fresh);
      st = fresh;
    } else if (attempt >= 2) {
      st = fresh; // keeps changing: report what we have, uncached
      break;
    }
  }
  if (searchFillPaused || !st.total || !st.bare) return undefined;
  return Math.round(((st.total - st.bare) / st.total) * 1000) / 1000;
}

/** The fill stopped on a worker failure: hide progress, and try once more (fresh worker) after a minute. */
function pauseSearchFill() {
  searchFillPaused = true;
  if (fillRetried || fillRetryTimer) return;
  fillRetried = true;
  fillRetryTimer = setTimeout(() => {
    fillRetryTimer = null;
    resetWorker();
    void reembedStale(); // stays paused until a batch succeeds (see fillBatchWorked)
  }, fillRetryMs);
  (fillRetryTimer as { unref?: () => void }).unref?.();
}

/** A batch was embedded: a later failure gets its own retry, and a paused fill resumes (one-shot) so the UI refreshes at once. */
function fillBatchWorked() {
  fillRetried = false;
  if (!searchFillPaused) return;
  searchFillPaused = false;
  if (typeof window !== "undefined") window.dispatchEvent(new Event("marginalia:search-resumed"));
}

/**
 * (Re)build the chunks for a source, resuming after the chunks already stored. Chunks are stored WITHOUT
 * vectors (keyword search works at once); reembedStale() fills the vectors in the background afterwards.
 */
async function indexSource(src: SourceRow, report: (f: number, stage: string) => void) {
  const spans = indexSpans(src); // chunks of the text, plus any AI page readings appended to it
  let done = await db.chunks.where("source_id").equals(src.id!).count();
  if (done > spans.length) {
    await db.chunks.where("source_id").equals(src.id!).delete();
    done = 0;
  }
  for (let i = done; i < spans.length; i += INSERT_BATCH) {
    const batch = spans.slice(i, i + INSERT_BATCH);
    report(i / spans.length, `Saving passages (${i}/${spans.length})`);
    if (!(await db.sources.get(src.id!))) return; // deleted meanwhile
    await db.chunks.bulkAdd(
      batch.map((c) => ({
        source_id: src.id!,
        subject_id: src.subject_id,
        ord: c.ord,
        text: c.text,
        char_start: c.char_start,
        char_end: c.char_end,
        page_start: c.page_start,
        page_end: c.page_end,
        token_count: c.token_count,
        embedding: new Float32Array(0),
      })),
    );
  }
  forgetSource(src.id!);
  forgetStats(src.id!);
}

/**
 * Sources indexed earlier (Gemini's 768-d vectors, or a backup/sync from elsewhere) are re-embedded
 * on the device in the background. Vectors are replaced in place: the source keeps its "ready"
 * status and every chunk keeps its text and offsets. Until a chunk is done, search uses keywords for it.
 */
let reembedding: Promise<void> | null = null;
let reembedAgain = false;
function reembedStale(): Promise<void> {
  if (reembedding) {
    reembedAgain = true; // a newer source may have appeared: the running pass re-checks after its current batch
    return reembedding;
  }
  reembedding = (async () => {
    do {
      reembedAgain = false;
      forgetStats();
      let restart = false;
      // Newest first, so a source just added gets its vectors before the old library.
      const ready = (await db.sources.where("status").equals("ready").toArray()).sort((a, b) => b.id! - a.id!);
      for (const s of ready) {
        if (sourceProgress.has(s.id!)) continue;
        const stale = (await db.chunks.where("source_id").equals(s.id!).sortBy("ord")).filter((c) => c.embedding?.length !== EMBED_DIM);
        for (let i = 0; i < stale.length; i += EMBED_BATCH) {
          const batch = stale.slice(i, i + EMBED_BATCH);
          let vecs: Float32Array[];
          await whenIdle(); // search queries go first
          try {
            vecs = await embedPassages(batch.map((c) => c.text), { allowMain: false });
          } catch {
            pauseSearchFill(); // the worker/model isn't available: keyword search keeps working; no progress label
            return;
          }
          fillBatchWorked(); // it works again
          await new Promise((r) => setTimeout(r, 0)); // let the UI breathe between batches
          if (!(await db.sources.get(s.id!))) break; // deleted meanwhile
          await db.transaction("rw", db.chunks, () => Promise.all(batch.map((c, j) => db.chunks.update(c.id!, { embedding: vecs[j] }))));
          forgetSource(s.id!);
          bumpStats(s.id!);
          const st = searchStats.get(s.id!);
          if (st) st.bare = Math.max(0, st.bare - batch.length);
          if (reembedAgain) {
            restart = true; // something changed (a new source): re-plan, newest first
            break;
          }
        }
        if (restart) break;
      }
    } while (reembedAgain);
  })().finally(() => (reembedding = null));
  return reembedding;
}

function submitSource(id: number) {
  sourceProgress.set(id, { progress: 0, stage: "Queued" });
  const run = async () => {
    const report = (f: number, stage: string) => sourceProgress.set(id, { progress: Math.round(f * 1000) / 1000, stage });
    try {
      let src = await db.sources.get(id);
      if (!src) return;
      const share = src.kind === "pdf" ? 0.5 : src.kind === "audio" ? 0.9 : src.kind === "image" ? 0.6 : 0.15;
      if (!src.text) {
        const stored = await db.blobs.get(uploadKey(id));
        const file = stored?.blob;
        if (!file) throw new Error("The uploaded file is gone. Please add it again.");
        let doc;
        if (src.kind === "pdf") doc = await parsePdf(file, (f, s) => report(f * share, s));
        else if (src.kind === "audio") doc = await transcribeRecording(file, src.title, (f, s) => report(f * share, s));
        else {
          const name = stored?.name ?? (file as File).name ?? src.title;
          const fmt = formatOf(name, file.type);
          if (!fmt || fmt === "pdf") throw new Error(unsupportedReason(name, file.type) ?? "Unsupported file.");
          report(0.05, src.kind === "image" ? "Reading the photo with Gemini" : "Reading the file");
          doc = await fmt.read(file, name);
        }
        // PDFs keep their own title if they have one; photos get Gemini's topic title; other files keep the file name.
        const title = (src.kind === "pdf" && doc.title !== "Untitled PDF") || src.kind === "image" ? doc.title : src.title;
        await db.sources.update(id, { text: doc.text, pages: doc.pages, title: title.slice(0, 500), ...(doc.noText ? { no_text_layer: true } : {}) });
        src = (await db.sources.get(id))!;
      }
      await indexSource(src, (f, s) => report(share + f * (1 - share), s));
      if (!(await db.sources.get(id))) return;
      await db.sources.update(id, { status: "ready", error: null });
      try {
        const kept = src.kind === "pdf" ? await db.blobs.get(uploadKey(id)) : undefined;
        if (kept) await db.blobs.put({ key: pdfKey(id), blob: kept.blob, name: kept.name });
        else if (src.kind !== "pdf") {
          const up = await db.blobs.get(uploadKey(id));
          if (up) await db.blobs.put({ key: origKey(id), blob: up.blob, name: up.name });
        }
        // The source may have been deleted while we were writing: don't leave orphan blobs.
        if (!(await db.sources.get(id))) await db.blobs.bulkDelete([origKey(id), pdfKey(id)]);
      } catch {
        /* best effort: keeping the original must never fail the source */
      }
      await db.blobs.delete(uploadKey(id));
    } catch (e) {
      if (await db.sources.get(id)) await db.sources.update(id, { status: "failed", error: message(e) });
    } finally {
      sourceProgress.delete(id);
    }
    void reembedStale(); // fill in the vectors in the background, newest source first
  };
  db.sources.get(id).then((s) => ((s?.kind === "audio" ? mediaQueue : docsQueue).push(run)));
}

async function newSource(subjectId: number, row: Partial<SourceRow>): Promise<SourceRow> {
  await need(db.subjects.get(subjectId), "Subject not found");
  const src: SourceRow = {
    subject_id: subjectId,
    kind: "text",
    title: "Untitled",
    url: null,
    text: "",
    pages: [],
    checked: true,
    status: "processing",
    error: null,
    created_at: now(),
    ...row,
  };
  src.id = await db.sources.add(src);
  return src;
}

async function addParsed(subjectId: number, kind: SourceRow["kind"], doc: { title: string; text: string; pages: SourceRow["pages"] }, url: string | null = null) {
  const src = await newSource(subjectId, { kind, title: doc.title.slice(0, 500), text: doc.text, pages: doc.pages, url });
  submitSource(src.id!);
  return sourceOut(src);
}

async function addUpload(subjectId: number, kind: SourceRow["kind"], file: Blob, filename: string, onUpload?: (f: number) => void) {
  const title = filename.replace(/\.[^.]+$/, "").replace(/_/g, " ").trim() || (kind === "pdf" ? "Untitled PDF" : "Lecture recording");
  if (kind === "pdf") {
    const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
    if (String.fromCharCode(...head) !== "%PDF") throw new Error("That file isn't a PDF");
  }
  if (!file.size) throw new Error("That file is empty.");
  onUpload?.(0.05);
  const src = await newSource(subjectId, { kind, title });
  // Keep a copy so the job survives the app being closed and failures can be retried.
  await db.blobs.put({ key: uploadKey(src.id!), blob: file, name: filename });
  onUpload?.(1);
  submitSource(src.id!);
  return sourceOut(src);
}

async function deleteSourceRows(id: number) {
  const src = await db.sources.get(id);
  // Margin threads beside this source go with it.
  const margins = (await db.threads.where("subject_id").equals(src?.subject_id ?? -1).toArray()).filter((t) => t.source_id === id);
  if (margins.length) {
    await tombstone("threads", margins.map((t) => t.uid));
    await db.threads.bulkDelete(margins.map((t) => t.id!));
  }
  if (src?.status === "ready") await tombstone("sources", [src.uid]);
  await db.chunks.where("source_id").equals(id).delete();
  await db.blobs.delete(uploadKey(id));
  await db.blobs.delete(pdfKey(id));
  await db.blobs.delete(origKey(id));
  needsCache.delete(id);
  await db.sources.delete(id);
  forgetSource(id);
  forgetStats(id);
}

// ---------------------------------------------------------------- "Read this page with AI"

/** Most pages one "Read pages..." run takes (each page is one vision call). */
export const MAX_AI_PAGES_PER_RUN = 30;
/** Most slides one run takes (about 8 slides per vision call, so a whole deck is one run). */
export const MAX_AI_SLIDES_PER_RUN = 60;

type PageReadJob = PageReadStatus & { replace: boolean };

/** In memory only: a run interrupted by closing the app is simply started again. */
const pageReads = new Map<number, PageReadJob>();
/** Test seams: the PDF reader, page renderer and vision call can be replaced (Node has no canvas or Gemini). */
const pageReadHooks: {
  open?: (blob: Blob) => Promise<{ doc: any; task: { destroy: () => Promise<void> } }>;
  render?: (doc: any, page: number) => Promise<Blob>;
  read?: (jpeg: Blob) => Promise<string>;
  /** Slides: the deck reader, the picture shrinker and the batched vision call. */
  slides?: (bytes: Uint8Array) => DeckSlide[] | null;
  decode?: (img: { mime: string; data: Uint8Array }) => Promise<{ mime: string; data: string } | null>;
  readSlides?: (batch: SlideInput[]) => Promise<Map<number, string>>;
} = {};

const pageReadChanged = (sourceId: number) => {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("marginalia:page-read", { detail: { sourceId } }));
};
const pageReadOut = (j: PageReadJob | undefined): PageReadStatus | null =>
  j ? { state: j.state, pending: [...j.pending], total: j.total, done: j.done, stage: j.stage, error: j.error } : null;

/** Append one page's AI reading to the source and make it searchable. */
async function storeAiReading(sourceId: number, page: number, reading: string) {
  const res = await applyAiReading(sourceId, page, reading);
  forgetSource(sourceId);
  forgetStats(sourceId);
  return res;
}

const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The pictures of a slide, in slide order: what the positioned rebuild placed (layout pictures included), else the ones it names. */
const slidePictures = (sl: DeckSlide): DeckImg[] => {
  const placed = (sl.els ?? []).flatMap((e) => (e.t === "img" ? [e.img] : []));
  return placed.length ? placed : sl.images;
};

const TOO_BIG_DECK = "This file is too large to read with AI (its slides or pictures are over the 150 MB size limit). Save a copy with smaller pictures and attach that.";
const PPTX_NAME = /\.(pptx|ppsx|potx)$/i;

/** The slides of a kept .pptx, or an honest reason it can't be read. */
async function deckSlides(blob: Blob): Promise<DeckSlide[]> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (pageReadHooks.slides) {
    const hooked = pageReadHooks.slides(bytes);
    if (hooked) return hooked;
  } else {
    const r = viewPptxChecked(bytes);
    if (r.tooBig) throw new Error(TOO_BIG_DECK);
    if (r.slides) return r.slides;
  }
  throw new Error("Only PowerPoint (.pptx) slides can be read with AI. Save the deck as .pptx and attach that.");
}

/** How many slides carry each picture (a layout's artwork sits on most of them and isn't content). */
function deckRepeats(slides: DeckSlide[]): Map<Uint8Array, number> {
  const repeats = new Map<Uint8Array, number>();
  for (const sl of slides) for (const d of new Set(slidePictures(sl).map((im) => im.data))) repeats.set(d, (repeats.get(d) ?? 0) + 1);
  return repeats;
}

/** Picture slides per source, from a light scan of the kept file (no rebuild). Keyed by file name + size; dropped when the original changes. */
const needsCache = new Map<number, { key: string; needs: number[] }>();

/** Slides (1-based) that are mostly a picture, ignoring AI readings. Null when the kept file can't be scanned. */
async function pictureSlides(id: number): Promise<number[] | null> {
  const orig = await db.blobs.get(origKey(id));
  if (!orig || !PPTX_NAME.test(orig.name ?? "")) return null;
  const key = `${orig.name}:${orig.blob.size}`;
  const hit = needsCache.get(id);
  if (hit?.key === key) return hit.needs;
  const needs = await scanPptx(orig.blob, orig.name ?? undefined);
  needsCache.set(id, { key, needs });
  return needs;
}

/**
 * Read slides with AI, about 8 per request: each slide's pictures (shrunk to 1600 px JPEGs) and any text it has go in
 * one request that returns a transcription per slide. A slide is stored (and leaves `pending`) as soon as its reading
 * arrives; a failed request leaves its slides pending for "Try again".
 */
async function runSlideRead(sourceId: number, job: PageReadJob) {
  const orig = await db.blobs.get(origKey(sourceId));
  if (!orig) throw new Error("This device doesn't have the original slides file. Open the Original view and attach it first.");
  const slides = await deckSlides(orig.blob);
  const first = await db.sources.get(sourceId);
  if (first && slides.length !== first.pages.length)
    throw new Error(`That file has ${slides.length} slides but this source has ${first.pages.length}. Attach the same file you added.`);
  const repeats = deckRepeats(slides);

  /** `tooLarge`: every picture of the slide was dropped for the file's size limits, so there is nothing to read. */
  type Prepared = { n: number; input: SlideInput; tooLarge: boolean };
  const prepared = new Map<number, Prepared>();
  const prepare = async (n: number, text: string): Promise<Prepared> => {
    const sl = slides[n - 1];
    const images: SlideInput["images"] = [];
    let unreadable = (sl.skipped ?? 0) + (sl.dropped ?? 0);
    for (const im of pickPictures(slidePictures(sl), repeats, slides.length)) {
      const d = await (pageReadHooks.decode ?? shrinkPicture)(im);
      if (d) images.push(d);
      else unreadable++;
    }
    return { n, input: { n, text, images, unreadable }, tooLarge: !images.length && (sl.dropped ?? 0) > 0 };
  };
  const finish = async (n: number, reading: string, unreadable: number) => {
    await storeAiReading(sourceId, n, unreadable ? `${reading === BLANK_PAGE ? "" : reading + "\n\n"}${UNREADABLE_FIGURE}` : reading);
    job.pending = job.pending.filter((x) => x !== n);
    job.done++;
    prepared.delete(n);
    pageReadChanged(sourceId);
  };

  const estimate = Math.max(1, Math.ceil(job.total / SLIDES_PER_REQUEST));
  let requests = 0;
  const blocked = new Set<number>(); // slides whose pictures were too large: they stay pending, the rest carry on
  while (job.pending.some((n) => !blocked.has(n))) {
    const src = await db.sources.get(sourceId);
    if (!src) return; // deleted meanwhile
    const batch: Prepared[] = [];
    let bytes = 0;
    for (const n of [...job.pending]) {
      if (batch.length >= SLIDES_PER_REQUEST) break;
      if (blocked.has(n)) continue;
      if (!job.replace && src.ai_pages?.some((p) => p.page === n)) {
        job.pending = job.pending.filter((x) => x !== n);
        job.done++;
        continue;
      }
      const span = src.pages[n - 1];
      const text = span ? src.text.slice(span.start, span.end) : "";
      const p = prepared.get(n) ?? (await prepare(n, text));
      prepared.set(n, p);
      if (p.tooLarge) {
        blocked.add(n);
        continue;
      }
      if (!p.input.images.length) {
        // Nothing to look at: no request. Keep any text the slide has, and say if its pictures couldn't be opened.
        await finish(n, text.trim() || BLANK_PAGE, p.input.unreadable);
        continue;
      }
      const size = p.input.images.reduce((a, im) => a + base64Bytes(im.data), 0);
      if (batch.length && bytes + size > MAX_REQUEST_BYTES) break;
      batch.push(p);
      bytes += size;
    }
    if (!batch.length) continue;
    if (requests > 0) await sleepMs(pageReadHooks.readSlides ? 0 : 1500); // a breath between requests; the AI pacer does the rest
    requests++;
    const a = batch[0].n;
    const b = batch[batch.length - 1].n;
    job.stage = `Reading slides ${a === b ? a : `${a}–${b}`} (${requests}/${Math.max(estimate, requests)})`;
    pageReadChanged(sourceId);
    const got = await patiently(() => (pageReadHooks.readSlides ?? readSlideBatch)(batch.map((x) => x.input)), 2, () => {
      job.stage = "Waiting for the AI's per-minute limit";
      pageReadChanged(sourceId);
    });
    if (!(await db.sources.get(sourceId))) return;
    const missing: number[] = [];
    for (const x of batch) {
      const reading = got.get(x.n);
      if (reading == null) missing.push(x.n);
      else await finish(x.n, reading, x.input.unreadable);
    }
    if (missing.length) throw new Error(`The AI skipped slide${missing.length > 1 ? "s" : ""} ${missing.join(", ")}. Try again.`);
  }
  if (blocked.size) {
    const list = [...blocked].sort((a, b) => a - b).join(", ");
    throw new Error(`This slide's pictures are too large to read (slide${blocked.size > 1 ? "s" : ""} ${list}; the file is over the 150 MB limit). Save a copy with smaller pictures and attach that.`);
  }
}

function startPageRead(sourceId: number, pages: number[], replace: boolean): PageReadStatus {
  if (pageReads.get(sourceId)?.state === "running") throw new Error("Pages of this source are already being read.");
  const job: PageReadJob = { state: "running", pending: pages, total: pages.length, done: 0, stage: "Queued", error: null, replace };
  pageReads.set(sourceId, job);
  pageReadChanged(sourceId);
  genQueue.push(async () => {
    let task: { destroy: () => Promise<void> } | null = null;
    try {
      if ((await db.sources.get(sourceId))?.kind === "slides") {
        await runSlideRead(sourceId, job);
        job.state = "done";
        job.stage = "Done";
        return;
      }
      const blob = (await db.blobs.get(pdfKey(sourceId)))?.blob;
      if (!blob) throw new Error("This device doesn't have the original PDF. Attach it in Page view first.");
      const opened = await (pageReadHooks.open ?? openPdf)(blob);
      task = opened.task;
      let first = true;
      while (job.pending.length) {
        const page = job.pending[0];
        const src = await db.sources.get(sourceId);
        if (!src) break; // deleted meanwhile
        if (!job.replace && src.ai_pages?.some((p) => p.page === page)) {
          job.pending.shift();
          job.done++;
          continue;
        }
        if (!first) await new Promise((r) => setTimeout(r, pageReadHooks.render ? 0 : 1500)); // a breath between pages; the AI pacer does the rest
        first = false;
        job.stage = `Reading page ${page} (${job.done + 1}/${job.total})`;
        pageReadChanged(sourceId);
        const jpeg = await (pageReadHooks.render ?? renderPageJpeg)(opened.doc, page);
        const reading = await patiently(() => (pageReadHooks.read ?? readPageImage)(jpeg), 2, () => {
          job.stage = "Waiting for the AI's per-minute limit";
          pageReadChanged(sourceId);
        });
        if (!(await db.sources.get(sourceId))) break;
        await storeAiReading(sourceId, page, reading);
        job.pending.shift();
        job.done++;
        pageReadChanged(sourceId);
      }
      job.state = "done";
      job.stage = "Done";
    } catch (e) {
      job.state = "failed";
      job.error = message(e);
      job.stage = "Stopped";
    } finally {
      try {
        await task?.destroy();
      } catch {}
      pageReadChanged(sourceId);
      if (typeof window !== "undefined") window.dispatchEvent(new Event("marginalia:library-changed")); // the source list (chunk and character counts) refreshes
      void reembedStale(); // vectors for the new passages, in the background
    }
  });
  return pageReadOut(job)!;
}

// ---------------------------------------------------------------- generation

const PASSAGE_BUDGET: Record<string, number> = { deck: 20, quiz: 14, sheet: 24, episode: 18, exam: 24 };

function placeholderTitle(kind: string, subtype: string): string {
  if (kind === "sheet") return subtype === "concept_map" ? "Concept map" : (SHEETS[subtype]?.[0] ?? "Study sheet");
  if (kind === "episode") return EPISODE_FORMATS[subtype]?.[0] ?? "Episode";
  if (kind === "summary") return SUMMARY_FORMATS[subtype]?.[0] ?? "Summary";
  return { deck: "Recall cards", quiz: "Quiz", exam: "Exam practice" }[kind] ?? kind;
}

type Plan = { subtype: string; passages: Retrieved[]; produce: (report: (f: number, s: string) => void) => Promise<Rec> };

/** Validate a request and pick passages; returns what the background job will run. */
async function plan(subjectId: number, req: GenerateRequest): Promise<Plan> {
  const subject = await need(db.subjects.get(subjectId), "Subject not found");
  const ctx = ib.context(subject);
  const label = ib.courseLabel(subject);
  // A topic code such as "A4" expands to the syllabus topic: retrieval uses its key terms, the prompt its scope.
  const rf = ib.resolveFocus(req.focus, subject.ib_course, subject.ib_level);
  const focus = rf.prompt;
  let subtype = req.subtype ?? "";
  if (req.kind === "summary") {
    subtype = subtype || "key_points";
    if (!SUMMARY_FORMATS[subtype]) throw new Error(`Unknown summary format '${subtype}'`);
    const passages = await summaryPassages(subjectId, req.source_ids, rf.query, req.page_from, req.page_to);
    if (!passages.length) throw new Error("Nothing to summarise: check a ready source (and a page range that exists).");
    const length = SUMMARY_LENGTH[req.length ?? "medium"];
    return { subtype, passages, produce: (r) => buildSummary(passages, subtype, length, focus, r, ctx) };
  }
  if (req.kind === "sheet" && !SHEETS[subtype] && subtype !== "concept_map") throw new Error(`Unknown sheet type '${subtype}'`);
  if (req.kind === "episode") {
    subtype = subtype || "conversation";
    if (!EPISODE_FORMATS[subtype]) throw new Error(`Unknown episode format '${subtype}'`);
  }
  if (req.kind === "exam") subtype = EXAM_SIZES[subtype] ? subtype : "short";
  const passages = await selectPassages(subjectId, req.source_ids, rf.query, PASSAGE_BUDGET[req.kind]);
  if (!passages.length) throw new Error("Check at least one source with text in the Library first.");
  const o = { ctx };
  const produce = async (r: (f: number, s: string) => void): Promise<Rec> => {
    switch (req.kind) {
      case "deck":
        r(0.1, "Writing the cards");
        return buildDeck(passages, req.count ?? 15, focus, o);
      case "quiz":
        r(0.1, "Writing the questions");
        return buildQuiz(passages, req.count ?? 8, req.difficulty ?? "medium", focus, req.types, o, req.avoid);
      case "sheet":
        if (subtype === "concept_map") {
          r(0.1, "Mapping the ideas");
          return buildConceptMap(passages, focus, o);
        }
        r(0.1, "Writing the sheet");
        return buildSheet(passages, subtype, focus, o);
      case "exam":
        r(0.1, "Writing questions and markschemes");
        return buildExam(passages, subtype, req.extended ?? true, focus, label, ctx, {
          style: req.style, course: subject.ib_course, level: subject.ib_level, calculator: req.calculator,
          paper: req.paper, language: req.language,
        });
      default:
        r(0.1, "Writing the script");
        return buildEpisode(passages, subtype, req.length ?? "medium", focus, o);
    }
  };
  return { subtype, passages, produce };
}

async function fill(artId: number, content: Rec) {
  const { title, cards, ...rest } = content;
  await db.artifacts.update(artId, { title: String(title ?? "").slice(0, 300) || undefined, content: rest });
  if (cards?.length) {
    const t = now();
    await db.cards.bulkAdd(
      cards.map((c: Rec) => ({
        deck_id: artId, front: c.front, back: c.back, cite: c.cite,
        ease: 2.5, interval_days: 0, reps: 0, lapses: 0, due_at: t, last_reviewed_at: null,
      })),
    );
  }
}

const requestOf = (a: ArtifactRow): GenerateRequest => ({ ...(a.params as any), kind: a.kind, subtype: a.subtype });

/** (Re)start the job for an existing artifact row from its stored request. */
async function startGeneration(artId: number, p?: Plan) {
  const art = await need(db.artifacts.get(artId));
  p ??= await plan(art.subject_id, requestOf(art));
  const title = placeholderTitle(art.kind, p.subtype);
  await db.cards.where("deck_id").equals(artId).delete();
  await db.artifacts.update(artId, {
    title, subtype: p.subtype, content: {}, error: null, status: "processing", passages: p.passages.map(citation),
  });
  genProgress.set(artId, { progress: 0, stage: "Queued" });
  const produce = p.produce;
  genQueue.push(async () => {
    try {
      const content = await produce((f, stage) => genProgress.set(artId, { progress: Math.round(f * 1000) / 1000, stage }));
      if (!(await db.artifacts.get(artId))) return;
      await fill(artId, content);
      await db.artifacts.update(artId, { status: "ready" });
    } catch (e) {
      if (await db.artifacts.get(artId))
        await db.artifacts.update(artId, { status: "failed", error: message(e), title: `${title} (failed)` });
    } finally {
      genProgress.delete(artId);
      const row = await db.artifacts.get(artId).catch(() => undefined);
      changed(row ? { subjectId: row.subject_id, kind: row.kind } : undefined);
    }
  });
}

// ---------------------------------------------------------------- chat

const SYSTEM = `You are a study companion working only from the student's own sources, which are given as numbered passages.

Ground every factual statement in those passages and cite them by number in square brackets right after the claim, e.g. "Chlorophyll absorbs red and blue light [2]." Use only the passage numbers you were given; cite several like [1][3]. If the passages don't cover something, say so plainly instead of filling the gap from general knowledge; you may then offer a clearly-labelled general explanation.

Requests are either questions or generation requests (quizzes, summaries, flashcards, outlines). For generation requests, produce the artefact directly from the passages, still citing them.

When the student has highlighted a passage, treat it as the focus of their question.

Write for a student: clear, compact, no filler. Use short paragraphs or flat lists; light Markdown (bold, italics, headings) is fine. Write maths in LaTeX: $…$ inline and $$…$$ for display equations, with units and words outside the maths. Write money as "5 dollars" or "USD 5", never "$5".`;

/** Ask AI's "Ask anything": a general tutor, not limited to (or citing) the student's sources. */
const GENERAL_SYSTEM = `You are a patient, knowledgeable tutor helping a student study. Answer from general knowledge (the student's own sources are not attached to this conversation, so never claim something comes from "your notes" or "your sources").

Be accurate and say when something is uncertain, debated, or depends on the syllabus or teacher. For problems, show the steps. Prefer explaining and checking understanding over just giving answers; for homework-style tasks, guide the student to the answer.

Write clearly and compactly: short paragraphs or flat lists, light Markdown (bold, italics, headings) is fine. Write maths in LaTeX: $…$ inline and $$…$$ for display equations, with units and words outside the maths. Write money as "5 dollars" or "USD 5", never "$5".`;

/** Added to either system prompt when the question carries photos. */
const PHOTO_NOTE = `

The student may attach photos of a problem, a diagram or their own working. Read them carefully (say so if something is illegible), and still ground factual claims in the passages, with citations, when passages are given.`;

const MAX_ASK_IMAGES = 4;
const askImageKey = (id: string) => `askimg-${id}`;

/** Save full-size photos to the blob store (key `askimg-<id>`) and return ids plus small thumbnails for the thread. */
async function saveAskImages(files: Blob[]): Promise<{ id: string; thumb: string }[]> {
  if (files.length > MAX_ASK_IMAGES) throw new GeminiError(`Up to ${MAX_ASK_IMAGES} photos per question.`);
  const out: { id: string; thumb: string }[] = [];
  for (const f of files) {
    if (f.size > 10 * 1024 * 1024) throw new GeminiError("Each photo must be under 10 MB.");
    const id = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
    await db.blobs.put({ key: askImageKey(id), blob: f, name: "photo" });
    out.push({ id, thumb: await makeThumb(f) });
  }
  return out;
}

const MARKER = /\[(\d{1,3}(?:\s*[,;]\s*\d{1,3})*)\]/g;
const PARTIAL = /\[[\d,;\s]{0,20}$/;

/** Turns streamed text with [n] markers into text/cite events, safe across chunk splits. */
class CiteParser {
  private buf = "";
  constructor(private hits: Retrieved[]) {}
  private events(text: string): StreamEvent[] {
    const out: StreamEvent[] = [];
    let last = 0;
    for (const m of text.matchAll(MARKER)) {
      const nums = m[1].split(/\s*[,;]\s*/).map(Number);
      const cites = nums.filter((n) => n >= 1 && n <= this.hits.length).map((n) => citation(this.hits[n - 1]));
      if (!cites.length) continue; // e.g. "[1990]" isn't a passage reference
      if (m.index! > last) out.push({ type: "text", text: text.slice(last, m.index) });
      out.push({ type: "cite", citations: cites });
      last = m.index! + m[0].length;
    }
    if (last < text.length) out.push({ type: "text", text: text.slice(last) });
    return out;
  }
  feed(text: string): StreamEvent[] {
    this.buf += text;
    const hold = PARTIAL.exec(this.buf);
    const cut = hold ? hold.index : this.buf.length;
    const ready = this.buf.slice(0, cut);
    this.buf = this.buf.slice(cut);
    return ready ? this.events(ready) : [];
  }
  flush(): StreamEvent[] {
    const rest = this.buf;
    this.buf = "";
    return rest ? this.events(rest) : [];
  }
}

// ---- answer reuse: an identical first-turn question is replayed, not re-asked ----

const ANSWER_TTL_MS = 7 * 86_400_000;
const ANSWER_CAP = 200;
const SELECTION_QUERY_CHARS = 1200;
type CachedAnswer = { key: string; at: number; events: StreamEvent[] };

function fnv(str: string, seed: number): string {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(36);
}
const answerSlot = (key: string) => `answer-${fnv(key, 2166136261)}${fnv(key, 0x9747b28c)}`;

/** Per source: chunk count, newest chunk id, and how many chunks lack an on-device vector (keyword search). */
export async function answerKey(subjectId: number, subject: SubjectRow | undefined, payload: ChatPayload, ids: number[]): Promise<string> {
  const parts = await Promise.all(
    [...new Set(ids)].sort((a, b) => a - b).map(async (id) => {
      const chunks = await db.chunks.where("source_id").equals(id).toArray();
      const maxId = chunks.reduce((m, c) => Math.max(m, c.id ?? 0), 0);
      const bare = chunks.filter((c) => c.embedding?.length !== EMBED_DIM).length;
      return `${id}:${chunks.length}:${maxId}:${bare}`;
    }),
  );
  const q = payload.message.trim().toLowerCase().replace(/\s+/g, " ");
  return JSON.stringify([subjectId, payload.mode === "general" ? "general" : "sources", subject?.ib_course ?? "", subject?.ib_level ?? "", parts, payload.selection?.text.trim() ?? "", q]);
}

/** Consecutive text events become one, so a saved answer is a handful of events instead of hundreds. */
export function mergeText(events: StreamEvent[]): StreamEvent[] {
  const out: StreamEvent[] = [];
  for (const e of events) {
    const last = out[out.length - 1];
    if (e.type === "text" && last?.type === "text") out[out.length - 1] = { ...last, text: last.text + e.text };
    else out.push(e);
  }
  return out;
}

/** Only a finished, non-empty answer is worth replaying: not a cut-off, dropped or blank one. */
export function cacheableAnswer(finish: string | null, events: StreamEvent[]): boolean {
  if (finish !== "STOP") return false; // Cerebras's normal stop is mapped to "STOP" in cerebrasStream
  return mergeText(events).some((e) => e.type === "text" && e.text.trim() !== "");
}

async function saveAnswer(key: string, events: StreamEvent[]) {
  try {
    await db.settings.put({ key: answerSlot(key), value: { key, at: Date.now(), events: mergeText(events) } satisfies CachedAnswer });
    const keys = await db.settings.where("key").startsWith("answer-").primaryKeys();
    if (keys.length > ANSWER_CAP) {
      const rows = (await db.settings.bulkGet(keys)).filter(Boolean).map((r) => ({ k: r!.key, at: (r!.value as CachedAnswer).at ?? 0 }));
      rows.sort((a, b) => a.at - b.at);
      await db.settings.bulkDelete(rows.slice(0, rows.length - ANSWER_CAP).map((r) => r.k));
    }
  } catch {}
}

const hasHistoryImages = (contents: Rec[]) => contents.some((c) => (c.parts ?? []).some((p: Rec) => p.inlineData));

export async function streamChat(
  subjectId: number,
  payload: ChatPayload,
  emitTo: (e: StreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  let onEvent = emitTo;
  await boot();
  const subject = await db.subjects.get(subjectId);
  const s = await getSettings();
  const general = payload.mode === "general";
  const ids = [...payload.source_ids];
  if (payload.selection && !ids.includes(payload.selection.source_id)) ids.push(payload.selection.source_id);
  const firstTurn = !(payload.history ?? []).some((t) => t.content.trim());
  let cacheKey: string | null = null;
  // A question with photos is never cached or replayed: the cache key doesn't cover the image bytes.
  const imageIds = (payload.images ?? []).slice(0, MAX_ASK_IMAGES);
  if (firstTurn && payload.message.trim() && !imageIds.length) {
    try {
      cacheKey = await answerKey(subjectId, subject, payload, ids);
      // A retry ("Try again") must ask the AI again, never replay the saved answer.
      const hit = payload.fresh ? undefined : ((await db.settings.get(answerSlot(cacheKey)))?.value as CachedAnswer | undefined);
      if (hit && hit.key === cacheKey && Date.now() - hit.at < ANSWER_TTL_MS && hit.events.length) {
        hit.events.forEach(onEvent);
        return;
      }
    } catch {
      cacheKey = null;
    }
  }
  const sent: StreamEvent[] = [];
  const emit = (e: StreamEvent) => {
    sent.push(e);
    emitTo(e);
  };
  onEvent = emit;
  let hits: Retrieved[] = [];
  if (!general) try {
    // The embedding model reads ~512 tokens: question first, and only the start of a long highlight.
    const query = payload.selection ? `${payload.message}\n\n${payload.selection.text.slice(0, SELECTION_QUERY_CHARS)}` : payload.message;
    const subj = await db.subjects.get(subjectId);
    const topic = ib.resolveFocus(payload.message, subj?.ib_course, subj?.ib_level, { codesOnly: true });
    hits = await retrieve(subjectId, ids, topic.topic ? `${query}

${topic.query}` : query, s.retrievalK);
  } catch (e) {
    onEvent({ type: "error", message: message(e) });
    return;
  }
  onEvent({
    type: "sources",
    sources: hits.map((r) => ({ source_id: r.source.id!, chunk_id: r.chunk.id!, title: r.source.title, page: r.chunk.page_start })),
  });
  if (!hits.length && !general) {
    onEvent({ type: "text", text: "None of the checked sources contain anything I can use yet. Check at least one ready source in the Library and ask again." });
    onEvent({ type: "done" });
    return;
  }
  const contents: Rec[] = [];
  // Earlier photos go back to the AI too (most recent MAX_ASK_IMAGES across the conversation, this turn's included),
  // so a follow-up about "the photo" still has it. A missing blob in history is skipped silently.
  const history = payload.history ?? [];
  let historyBudget = Math.max(0, MAX_ASK_IMAGES - imageIds.length);
  const keepHistory = new Map<number, string[]>();
  for (let i = history.length - 1; i >= 0 && historyBudget > 0; i--) {
    const ids = history[i].role === "user" ? (history[i].images ?? []) : [];
    if (!ids.length) continue;
    const take = ids.slice(-historyBudget);
    keepHistory.set(i, take);
    historyBudget -= take.length;
  }
  for (let i = 0; i < history.length; i++) {
    const t = history[i];
    if (!t.content.trim()) continue;
    const role = t.role === "assistant" ? "model" : "user";
    if (!contents.length && role !== "user") continue;
    const parts: Rec[] = [];
    for (const id of keepHistory.get(i) ?? []) {
      try {
        const r = await db.blobs.get(askImageKey(id));
        if (r) parts.push({ inlineData: { mimeType: r.blob.type.startsWith("image/") ? r.blob.type : "image/jpeg", data: await blobToBase64(r.blob) } });
      } catch {}
    }
    contents.push({ role, parts: [...parts, { text: t.content }] });
  }
  const question = payload.selection
    ? `I highlighted this passage:\n<highlight>\n${payload.selection.text}\n</highlight>\n\n${payload.message}`
    : payload.message;
  const imageParts: Rec[] = [];
  if (imageIds.length) {
    const rows = await db.blobs.bulkGet(imageIds.map(askImageKey));
    if (rows.some((r) => !r)) {
      onEvent({ type: "error", message: "A photo on this question is no longer stored on this device (it may have come from another device). Attach it again." });
      return;
    }
    for (const r of rows) imageParts.push({ inlineData: { mimeType: r!.blob.type.startsWith("image/") ? r!.blob.type : "image/jpeg", data: await blobToBase64(r!.blob) } });
  }
  contents.push({
    role: "user",
    parts: [
      ...imageParts,
      { text: general ? question : "Passages:\n\n" + hits.map((r, i) => passageBlock(i + 1, r)).join("\n\n") + "\n\n" + question },
    ],
  });
  const body = {
    systemInstruction: { parts: [{ text: (general ? GENERAL_SYSTEM : SYSTEM) + (imageParts.length || hasHistoryImages(contents) ? PHOTO_NOTE : "") + ib.context(subject) }] },
    contents,
    generationConfig: { maxOutputTokens: s.maxTokens },
  };
  const parser = new CiteParser(hits);
  let finish: string | null = null;
  try {
    for await (const piece of streamGenerate(body, signal, { tag: "chat" })) {
      if (piece.text) parser.feed(piece.text).forEach(onEvent);
      if ("finish" in piece) finish = piece.finish ?? null;
    }
    parser.flush().forEach(onEvent);
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    onEvent({ type: "error", message: e instanceof GeminiError ? e.message : "The connection to Gemini dropped. Try again." });
    return;
  }
  const cutOff = finish === "MAX_TOKENS";
  if (cutOff) onEvent({ type: "text", text: "\n\n_(answer cut off at the length limit)_" });
  else if (finish && ["SAFETY", "RECITATION", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII"].includes(finish)) {
    onEvent({ type: "error", message: `Gemini stopped the answer (${finish}).` });
    return;
  }
  onEvent({ type: "done" });
  if (cacheKey && !cutOff && cacheableAnswer(finish, sent) && hits.length + Number(general) > 0) await saveAnswer(cacheKey, sent);
}

// ---------------------------------------------------------------- speech

const VOICES: Record<string, string> = { Maya: "Kore", Theo: "Puck" };
const TTS_CHUNK_CHARS = 2400;

function wav(pcm: Uint8Array, rate: number): Blob {
  const header = new DataView(new ArrayBuffer(44));
  const w = (o: number, s: string) => [...s].forEach((c, i) => header.setUint8(o + i, c.charCodeAt(0)));
  w(0, "RIFF");
  header.setUint32(4, 36 + pcm.length, true);
  w(8, "WAVE");
  w(12, "fmt ");
  header.setUint32(16, 16, true);
  header.setUint16(20, 1, true);
  header.setUint16(22, 1, true);
  header.setUint32(24, rate, true);
  header.setUint32(28, rate * 2, true);
  header.setUint16(32, 2, true);
  header.setUint16(34, 16, true);
  w(36, "data");
  header.setUint32(40, pcm.length, true);
  // Gemini's l16 samples are little-endian already (the laptop version wrote them into WAV as-is).
  return new Blob([header.buffer, pcm as BlobPart], { type: "audio/wav" });
}

async function renderEpisodeAudio(art: ArtifactRow): Promise<Blob> {
  const c = art.content as Rec;
  const speakers: string[] = c.speakers ?? ["Maya"];
  const lines: Rec[] = c.lines ?? [];
  const groups: Rec[][] = [];
  let cur: Rec[] = [];
  let size = 0;
  for (const ln of lines) {
    if (cur.length && size + ln.text.length > TTS_CHUNK_CHARS) {
      groups.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(ln);
    size += ln.text.length;
  }
  if (cur.length) groups.push(cur);
  const parts: Uint8Array[] = [];
  let rate = 24000;
  for (const g of groups) {
    const out = await patiently(() => speak(g as { speaker: string; text: string }[], speakers, VOICES, { tag: "audio" }));
    parts.push(out.pcm);
    rate = out.rate;
  }
  const total = parts.reduce((n, p) => n + p.length, 0);
  const pcm = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    pcm.set(p, off);
    off += p.length;
  }
  return wav(pcm, rate);
}

const audioUrls = new Map<number, string>();

// ---------------------------------------------------------------- the API

export const localApi = {
  subjects: async (): Promise<Subject[]> => {
    await boot();
    const rows = await db.subjects.toArray();
    rows.sort((a, b) => b.created_at.localeCompare(a.created_at));
    return Promise.all(rows.map(subjectOut));
  },
  createSubject: async (name: string): Promise<Subject> => {
    const row: SubjectRow = { name: name.trim(), created_at: now(), ib_course: null, ib_level: null };
    row.id = await db.subjects.add(row);
    return subjectOut(row);
  },
  patchSubject: async (id: number, patch: { name?: string; ib_course?: string; ib_level?: "SL" | "HL" | "" }): Promise<Subject> => {
    const upd: Partial<SubjectRow> = {};
    if (patch.name !== undefined) upd.name = patch.name.trim();
    if (patch.ib_course !== undefined) upd.ib_course = patch.ib_course.trim() || null;
    if (patch.ib_level !== undefined) upd.ib_level = patch.ib_level || null;
    await db.subjects.update(id, upd);
    return subjectOut(await need(db.subjects.get(id), "Subject not found"));
  },
  ibOptions: async (): Promise<IBOptions> => ({
    courses: ib.COURSES,
    command_terms: Object.entries(ib.COMMAND_TERMS).map(([term, [objective, definition]]) => ({ term, objective, definition })),
    summary_formats: Object.fromEntries(Object.entries(SUMMARY_FORMATS).map(([k, v]) => [k, v[0]])),
  }),
  deleteSubject: async (id: number): Promise<void> => {
    await db.threads.where("subject_id").equals(id).delete(); // the subject's tombstone removes them elsewhere
    for (const s of await db.sources.where("subject_id").equals(id).toArray()) await deleteSourceRows(s.id!);
    for (const a of await db.artifacts.where("subject_id").equals(id).toArray()) await localApi.deleteArtifact(a.id!);
    await tombstone("subjects", [(await db.subjects.get(id))?.uid]);
    await db.subjects.delete(id);
  },

  /** Saved conversations of a subject (Ask AI, quick answers, margin threads), newest first. */
  threads: async (subjectId: number): Promise<Thread[]> => {
    const rows = await db.threads.where("subject_id").equals(subjectId).toArray();
    rows.sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""));
    return rows.map((r) => ({
      id: r.uid!,
      kind: r.kind,
      mode: r.mode,
      title: r.title || undefined,
      sourceId: r.source_id ?? undefined,
      anchor: r.anchor,
      turns: r.turns as Thread["turns"],
      busy: false,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  },
  /** Save (create or update) a conversation; empty drafts aren't stored. */
  saveThread: async (subjectId: number, t: Thread): Promise<void> => {
    if (!t.turns.length) return;
    const row: Omit<ThreadRow, "id"> = {
      uid: t.id,
      subject_id: subjectId,
      kind: t.kind,
      mode: t.mode ?? "sources",
      title: t.title ?? "",
      source_id: t.sourceId ?? null,
      anchor: t.anchor ?? null,
      // An answer still streaming when saved is stored as it stands; errors are kept so Retry still works.
      turns: t.turns,
      created_at: t.createdAt ?? now(),
    };
    const cur = await db.threads.where("uid").equals(t.id).first();
    if (cur) await db.threads.update(cur.id!, row);
    else await db.threads.add(row as ThreadRow);
  },
  deleteThread: async (uid: string): Promise<void> => {
    const cur = await db.threads.where("uid").equals(uid).first();
    if (!cur) return;
    await tombstone("threads", [uid]);
    await db.threads.delete(cur.id!);
    // The full-size photos of its questions go with it.
    const imgs = (cur.turns as Thread["turns"]).flatMap((t) => (t.role === "user" ? (t.images ?? []).map((i) => askImageKey(i.id)) : []));
    if (imgs.length) await db.blobs.bulkDelete(imgs);
  },
  saveAskImages,
  transcribeVoice,

  sources: async (subjectId: number): Promise<Source[]> => {
    await boot();
    const rows = await db.sources.where("subject_id").equals(subjectId).sortBy("id");
    return Promise.all(rows.map(sourceOut));
  },
  source: async (id: number): Promise<SourceDetail> => {
    const s = await need(db.sources.get(id), "Source not found");
    return { ...(await sourceOut(s)), text: s.text, pages: s.pages, ai_pages: s.ai_pages ?? [] };
  },
  /** Is the original PDF on this device? (Needed to read pages with AI.) */
  hasPdf: async (id: number): Promise<boolean> => !!(await db.blobs.get(pdfKey(id))),
  /**
   * Read PDF pages with AI (background job, one vision call per page): `from..to`, at most 30 per run.
   * `replace` re-reads pages that already have a reading (the single-page action); a range skips them.
   */
  readPagesWithAI: async (id: number, from: number, to: number = from, opts: { replace?: boolean } = {}): Promise<PageReadStatus> => {
    const src = await need(db.sources.get(id), "Source not found");
    const slides = src.kind === "slides";
    if (src.kind !== "pdf" && !slides) throw new Error("Only PDFs and slides can be read with AI.");
    if (src.status !== "ready") throw new Error("Wait until the source is ready");
    if (slides) {
      if (!(await db.blobs.get(origKey(id)))) throw new Error("This device doesn't have the original slides file. Open the Original view and attach it first.");
    } else if (!(await db.blobs.get(pdfKey(id)))) throw new Error("This device doesn't have the original PDF. Attach it in Page view first.");
    const word = slides ? "slides" : "pages";
    const a = Math.max(1, Math.min(from, to));
    const b = Math.min(src.pages.length, Math.max(from, to));
    if (!Number.isFinite(a) || !Number.isFinite(b) || a > b) throw new Error(`Pick ${word} between 1 and ${src.pages.length}.`);
    const cap = slides ? MAX_AI_SLIDES_PER_RUN : MAX_AI_PAGES_PER_RUN;
    if (b - a + 1 > cap) throw new Error(`Up to ${cap} ${word} at a time.`);
    const replace = opts.replace ?? a === b;
    let list = Array.from({ length: b - a + 1 }, (_, i) => a + i);
    // A range over a deck reads the picture slides that have no reading yet; text slides keep their text (the single-slide re-read overrides).
    if (slides && !replace) {
      const needs = new Set((await pictureSlides(id)) ?? []);
      list = list.filter((n) => needs.has(n) && !src.ai_pages?.some((p) => p.page === n));
      if (!list.length) throw new Error("Every picture slide in that range has already been read with AI.");
    }
    return startPageRead(id, list, replace);
  },
  /** Progress of the latest page-reading run for a source (null if none since the app opened). */
  pageReadStatus: async (id: number): Promise<PageReadStatus | null> => pageReadOut(pageReads.get(id)),
  /** Try again after a failed run: only the pages not yet read. */
  retryPageRead: async (id: number): Promise<PageReadStatus> => {
    const j = pageReads.get(id);
    if (!j || j.state !== "failed" || !j.pending.length) throw new Error("Nothing to retry.");
    return startPageRead(id, [...j.pending], j.replace);
  },
  /** Test seams for the page-reading job and its storage step. */
  _pageRead: {
    hooks: pageReadHooks,
    store: storeAiReading,
    wait: async (id: number) => {
      while (pageReads.get(id)?.state === "running") await new Promise((r) => setTimeout(r, 10));
    },
  },
  /** Title, length and caption availability of a YouTube link (null when unknown or not YouTube). */
  youtubeInfo: async (raw: string) => {
    const id = YOUTUBE_RE.test(raw.trim()) ? videoIdOf(raw.trim()) : null;
    return id ? youtubeInfo(id) : null;
  },
  addText: async (subjectId: number, title: string, text: string) => addParsed(subjectId, "text", parseText(text, title || null)),
  addUrl: async (subjectId: number, raw: string) => {
    let url = raw.trim();
    if (!url.includes("://")) url = "https://" + url;
    if (YOUTUBE_RE.test(url)) return addParsed(subjectId, "video", await transcribeYoutube(url), url);
    return addParsed(subjectId, "url", await parseUrl(url), url);
  },
  addPdf: (subjectId: number, file: File, onUpload?: (f: number) => void) => addUpload(subjectId, "pdf", file, file.name, onUpload),
  /** Any supported document: PDF, PowerPoint, Word, Excel/CSV, EPUB, text, HTML or a photo. */
  addFile: (subjectId: number, file: File, onUpload?: (f: number) => void) => {
    const fmt = formatOf(file.name, file.type);
    if (!fmt) return Promise.reject(new Error(unsupportedReason(file.name, file.type) ?? "Unsupported file."));
    return addUpload(subjectId, fmt === "pdf" ? "pdf" : fmt.kind, file, file.name, onUpload);
  },
  addRecording: (subjectId: number, file: Blob, filename: string, onUpload?: (f: number) => void) =>
    addUpload(subjectId, "audio", file, filename, onUpload),
  addAudio: (subjectId: number, file: Blob, filename: string) => addUpload(subjectId, "audio", file, filename),
  patchSource: async (id: number, patch: { checked?: boolean; title?: string }): Promise<Source> => {
    const upd: Partial<SourceRow> = {};
    if (patch.checked !== undefined) upd.checked = patch.checked;
    if (patch.title) upd.title = patch.title.trim().slice(0, 500);
    await db.sources.update(id, upd);
    return sourceOut(await need(db.sources.get(id), "Source not found"));
  },
  retrySource: async (id: number): Promise<Source> => {
    const s = await need(db.sources.get(id), "Source not found");
    if (s.status !== "failed") throw new Error("Nothing to retry for this source.");
    await db.sources.update(id, { status: "processing", error: null });
    submitSource(id);
    return sourceOut((await db.sources.get(id))!);
  },
  deleteSource: async (id: number): Promise<void> => deleteSourceRows(id),

  /** The original PDF of a source, if this device still has it (page view in Read mode). */
  sourcePdf: async (id: number): Promise<Blob | null> => (await db.blobs.get(pdfKey(id)))?.blob ?? null,
  /** Attach the PDF for a source added earlier (or synced from another device). The page count must match. */
  attachPdf: async (id: number, file: Blob): Promise<void> => {
    const src = await need(db.sources.get(id), "Source not found");
    if (src.kind !== "pdf") throw new Error("This source isn't a PDF.");
    const n = await pdfPageCount(file);
    if (src.pages.length && n !== src.pages.length)
      throw new Error(`That PDF has ${n} pages but this source has ${src.pages.length}. Pick the same file you added.`);
    await db.blobs.put({ key: pdfKey(id), blob: file, name: (file as File).name });
  },

  /** The original file of a non-PDF source (photo, slides, document, recording), if this device kept it. */
  sourceOriginal: async (id: number): Promise<{ blob: Blob; name: string } | null> => {
    const r = await db.blobs.get(origKey(id));
    return r ? { blob: r.blob, name: r.name ?? "original" } : null;
  },
  /** Attach the original file for a source added earlier or synced from another device. */
  attachOriginal: async (id: number, file: Blob): Promise<void> => {
    const src = await need(db.sources.get(id), "Source not found");
    const name = (file as File).name ?? "";
    if (src.kind === "slides") {
      if (PPTX_NAME.test(name)) {
        // Same check as attachPdf: the deck has to be the one this source was made from.
        const r = viewPptxChecked(new Uint8Array(await file.arrayBuffer()));
        if (!r.tooBig) {
          if (!r.slides) throw new Error(`${name} doesn't look like a PowerPoint file (it may be damaged or password-protected).`);
          if (src.pages.length && r.slides.length !== src.pages.length)
            throw new Error(`That file has ${r.slides.length} slides but this source has ${src.pages.length}. Pick the same file you added.`);
        }
      } else if (!/\.odp$/i.test(name)) {
        throw new Error(`${name || "That file"} isn't a PowerPoint (.pptx) file. Pick the deck you added, or save it as .pptx first.`);
      }
    }
    await db.blobs.put({ key: origKey(id), blob: file, name });
    needsCache.delete(id);
    if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("marginalia:original-changed", { detail: { sourceId: id } }));
  },
  /** Slides that are mostly pictures and have no AI reading yet (null when unknown: not a deck, or no .pptx kept on this device). */
  slidesNeedingAI: async (id: number): Promise<number[] | null> => {
    const src = await db.sources.get(id);
    if (!src || src.kind !== "slides" || !src.no_text_layer) return null; // a text deck has nothing to scan
    try {
      const needs = await pictureSlides(id);
      return needs && needs.filter((n) => !src.ai_pages?.some((p) => p.page === n));
    } catch {
      return null;
    }
  },

  artifacts: async (subjectId: number, kind?: ArtifactKind): Promise<ArtifactSummary[]> => {
    await boot();
    let rows = await db.artifacts.where("subject_id").equals(subjectId).toArray();
    if (kind) rows = rows.filter((a) => a.kind === kind);
    rows.sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id! - a.id!);
    return Promise.all(rows.map((a) => artifactOut(a)));
  },
  artifact: async (id: number): Promise<ArtifactDetail> => artifactOut(await need(db.artifacts.get(id)), true),
  generate: async (subjectId: number, req: GenerateRequest): Promise<ArtifactDetail> => {
    const p = await plan(subjectId, req);
    const { kind, subtype: _s, ...params } = req;
    void _s;
    const row: ArtifactRow = {
      subject_id: subjectId, kind, subtype: p.subtype, title: placeholderTitle(kind, p.subtype),
      params: { difficulty: "medium", length: "medium", extended: true, types: ["mcq"], ...params },
      content: {}, passages: [], status: "processing", error: null, created_at: now(),
    };
    row.id = await db.artifacts.add(row);
    await startGeneration(row.id, p);
    return localApi.artifact(row.id);
  },
  retryArtifact: async (id: number): Promise<ArtifactDetail> => {
    const a = await need(db.artifacts.get(id));
    if (a.status !== "failed") throw new Error("Only failed items can be retried.");
    if (a.subtype === "custom") throw new Error("Ask that question again from “Mark my question”.");
    await startGeneration(id);
    return localApi.artifact(id);
  },
  deleteArtifact: async (id: number): Promise<void> => {
    const art = await db.artifacts.get(id);
    if (art?.status === "ready") await tombstone("artifacts", [art.uid]);
    await db.cards.where("deck_id").equals(id).delete();
    await db.attempts.where("quiz_id").equals(id).delete();
    await db.blobs.delete(audioKey(id));
    await db.artifacts.delete(id);
    const url = audioUrls.get(id);
    if (url) URL.revokeObjectURL(url);
    audioUrls.delete(id);
  },

  reviewQueue: async (deckId: number, limit = 50): Promise<{ cards: CardItem[]; next_due_at: string | null }> => {
    const t = now();
    const all = await db.cards.where("deck_id").equals(deckId).toArray();
    const due = all
      .filter((c) => c.due_at <= t)
      .sort((a, b) => Number(a.reps === 0) - Number(b.reps === 0) || a.due_at.localeCompare(b.due_at) || a.id! - b.id!)
      .slice(0, limit);
    const upcoming = all.filter((c) => c.due_at > t).map((c) => c.due_at).sort()[0] ?? null;
    return { cards: due.map((c) => cardOut(c)), next_due_at: upcoming };
  },
  gradeCard: async (cardId: number, grade: Grade): Promise<CardItem> => {
    const c = await need(db.cards.get(cardId), "Card not found");
    const t = Date.now();
    const [state, due] = schedule(c, grade, t);
    const upd = { ...state, due_at: new Date(due).toISOString(), last_reviewed_at: new Date(t).toISOString() };
    await db.cards.update(cardId, upd);
    return cardOut({ ...c, ...upd }, t);
  },
  /** A card the student writes: no citation, new and due now. */
  addCard: async (deckId: number, input: { front: string; back: string }): Promise<CardItem> => {
    const { front, back } = cleanCard(input);
    const deck = await need(db.artifacts.get(deckId), "Deck not found");
    if (deck.kind !== "deck") throw new Error("Cards can only be added to a recall deck.");
    const row: CardRow = {
      deck_id: deckId, front, back, cite: [],
      ease: 2.5, interval_days: 0, reps: 0, lapses: 0, due_at: now(), last_reviewed_at: null,
    };
    const id = await db.cards.add(row);
    return cardOut({ ...row, id });
  },
  /** Change the text only; the schedule (ease, interval, reps, due date) is untouched. */
  updateCard: async (cardId: number, input: { front: string; back: string }): Promise<CardItem> => {
    const { front, back } = cleanCard(input);
    const c = await need(db.cards.get(cardId), "Card not found");
    await db.cards.update(cardId, { front, back });
    return cardOut({ ...c, front, back });
  },
  deleteCard: async (cardId: number): Promise<void> => {
    const c = await db.cards.get(cardId);
    if (!c) return;
    await tombstone("cards", [c.uid]);
    await db.cards.delete(cardId);
  },
  resetDeck: async (deckId: number): Promise<void> => {
    const t = now();
    await db.cards.where("deck_id").equals(deckId).modify({ ease: 2.5, interval_days: 0, reps: 0, lapses: 0, due_at: t, last_reviewed_at: null });
  },

  submitAttempt: async (quizId: number, raw: (number | string | null)[], retryAttemptId?: number): Promise<QuizResult> => {
    const art = await need(db.artifacts.get(quizId));
    const questions: Rec[] = (art.content as Rec).questions ?? [];
    const answers = [...raw, ...Array(questions.length).fill(null)].slice(0, questions.length);
    // markQuiz keeps the locally marked results and flags AI-marked ones it couldn't mark as `pending`.
    const results = await markQuiz(questions, answers, ib.courseLabel(await db.subjects.get(art.subject_id)));
    const score = results.reduce((s, r) => s + r.marks, 0);
    const total = results.reduce((s, r) => s + r.max, 0);
    let attemptId = retryAttemptId;
    if (attemptId != null && (await db.attempts.get(attemptId))) await db.attempts.update(attemptId, { answers, score, total });
    else attemptId = (await db.attempts.add({ quiz_id: quizId, answers, score, total, created_at: now() })) as number;
    return {
      score, total, answers, results, attempt_id: attemptId,
      correct: questions.map((q) => ((q.type ?? "mcq") === "mcq" ? q.answer : (q.accept?.[0] ?? null))),
    };
  },
  markQuestion: async (examId: number, qi: number, answer: string): Promise<MarkResult> => {
    const art = await need(db.artifacts.get(examId));
    const qs: Rec[] = (art.content as Rec).questions ?? [];
    if (qi < 0 || qi >= qs.length) throw new Error("No such question");
    if (!answer.trim()) throw new Error("Write an answer first.");
    const subj = await db.subjects.get(art.subject_id);
    const result = await markAnswer(qs[qi], answer, ib.courseLabel(subj), subj?.ib_course);
    await db.attempts.add({ quiz_id: examId, answers: [{ q: qi, answer, result }], score: result.marks_awarded, total: result.max_marks, created_at: now() });
    return result;
  },
  customQuestion: async (subjectId: number, body: { question: string; marks: number; answer: string; source_ids: number[]; calculator?: "allowed" | "none"; paper?: string }): Promise<ArtifactDetail> => {
    const subject = await need(db.subjects.get(subjectId), "Subject not found");
    const label = ib.courseLabel(subject);
    const passages = await retrieve(subjectId, body.source_ids, body.question, 10);
    if (!passages.length) throw new Error("Check at least one source with text in the Library first.");
    const content = await draftMarkscheme(passages, body.question, body.marks, label, ib.context(subject), { course: subject.ib_course, calculator: body.calculator, paper: body.paper });
    const result = body.answer.trim() ? await markAnswer(content.questions[0], body.answer, label, subject.ib_course) : null;
    const { title, ...rest } = content;
    const id = await db.artifacts.add({
      subject_id: subjectId, kind: "exam", subtype: "custom", title, params: { source_ids: body.source_ids },
      content: rest, passages: passages.map(citation), status: "ready", error: null, created_at: now(),
    });
    if (result)
      await db.attempts.add({ quiz_id: id, answers: [{ q: 0, answer: body.answer, result }], score: result.marks_awarded, total: result.max_marks, created_at: now() });
    return localApi.artifact(id);
  },

  renderAudio: async (episodeId: number): Promise<ArtifactSummary> => {
    const art = await need(db.artifacts.get(episodeId));
    const blob = await renderEpisodeAudio(art);
    await db.blobs.put({ key: audioKey(episodeId), blob });
    return artifactOut(art);
  },
  /** An object URL for the episode's rendered audio (stored on the device). */
  audioSrc: async (episodeId: number): Promise<string> => {
    let url = audioUrls.get(episodeId);
    if (!url) {
      const b = await need(db.blobs.get(audioKey(episodeId)), "No audio rendered yet");
      url = URL.createObjectURL(b.blob);
      audioUrls.set(episodeId, url);
    }
    return url;
  },

  /** Re-embed chunks that still have an older vector, on the device. Resolves when done. */
  reembedStale,
  /** Test seams for the search-progress race and worker-failure handling. */
  _search: {
    hooks: searchHooks,
    setRetryMs: (ms: number) => (fillRetryMs = ms),
    paused: () => searchFillPaused,
    resume: () => {
      searchFillPaused = false;
      fillRetried = false;
      if (fillRetryTimer) clearTimeout(fillRetryTimer);
      fillRetryTimer = null;
    },
  },
  /** Settle or restart interrupted jobs (also a test seam). */
  resumeJobs,
  exportBackup: () => exportAll(),
  importBackup: async (file: Blob) => {
    const res = await importAll(file);
    await resumeJobs();
    void reembedStale();
    return res;
  },
  /** Recall cards due now across every deck (for the daily reminder). */
  dueCards: () => db.cards.where("due_at").belowOrEqual(now()).count(),

  photoAnswer: (files: Blob[], question?: string) => readAnswer(files, question),
  photoQuestion: (files: Blob[]) => readQuestion(files),
  quizPhoto: async (quizId: number, files: Blob[]) => {
    const art = await need(db.artifacts.get(quizId));
    return { answers: await readQuizAnswers(files, (art.content as Rec).questions ?? []) };
  },
};
