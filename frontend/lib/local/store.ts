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
import { embed, GeminiError, patiently, speak, streamGenerate } from "./gemini";
import * as ib from "./ib";
import { parseText, parseUrl, parsePdf, ParseError, transcribeRecording, transcribeYoutube, YOUTUBE_RE } from "./parse";
import { citation, forgetSource, passageBlock, retrieve, selectPassages, summaryPassages, type Retrieved } from "./search";
import { getSettings } from "./settings";
import { preview, schedule, type Grade } from "./srs";
import { buildSummary, SUMMARY_FORMATS, SUMMARY_LENGTH } from "./summarize";
import { readAnswer, readQuestion, readQuizAnswers } from "./vision";
import { exportAll, importAll } from "./backup";

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

const changed = () => {
  if (typeof window !== "undefined") window.dispatchEvent(new Event("marginalia:artifacts-changed"));
};

const message = (e: unknown) =>
  e instanceof GeminiError || e instanceof ParseError || e instanceof Error ? e.message : "Something went wrong.";

const uploadKey = (sourceId: number) => `upload-${sourceId}`;
const audioKey = (episodeId: number) => `episode-${episodeId}`;

let booted: Promise<void> | null = null;
/** Once per app start: resume interrupted jobs. */
function boot(): Promise<void> {
  booted ??= (async () => {
    requestPersistence();
    await resumeJobs();
  })();
  return booted;
}

/** Restart jobs for rows left "processing" (app closed mid-job, or an imported backup). */
async function resumeJobs() {
  {
    for (const s of await db.sources.where("status").equals("processing").toArray()) {
      if (sourceProgress.has(s.id!)) continue;
      const hasFile = !!(await db.blobs.get(uploadKey(s.id!)));
      if (s.text || hasFile) submitSource(s.id!);
      else await db.sources.update(s.id!, { status: "failed", error: "Interrupted. Please add it again." });
    }
    for (const a of await db.artifacts.where("status").equals("processing").toArray()) {
      if (genProgress.has(a.id!)) continue;
      if (a.subtype === "custom") await db.artifacts.update(a.id!, { status: "failed", error: "Interrupted." });
      else startGeneration(a.id!).catch(async (e) => db.artifacts.update(a.id!, { status: "failed", error: message(e) }));
    }
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
  };
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

const EMBED_BATCH = 100;

/** (Re)build chunks + embeddings for a source, resuming after the chunks already stored. */
async function indexSource(src: SourceRow, report: (f: number, stage: string) => void) {
  const spans = chunkText(src.text, 800, 120, src.pages);
  let done = await db.chunks.where("source_id").equals(src.id!).count();
  if (done > spans.length) {
    await db.chunks.where("source_id").equals(src.id!).delete();
    done = 0;
  }
  for (let i = done; i < spans.length; i += EMBED_BATCH) {
    const batch = spans.slice(i, i + EMBED_BATCH);
    report(i / spans.length, `Indexing for search (${i}/${spans.length})`);
    const vecs = await patiently(
      () => embed(batch.map((c) => c.text), "RETRIEVAL_DOCUMENT"),
      10,
      () => report(i / spans.length, "Waiting for Gemini's per-minute limit"),
    );
    if (!(await db.sources.get(src.id!))) return; // deleted meanwhile
    await db.chunks.bulkAdd(
      batch.map((c, j) => ({
        source_id: src.id!,
        subject_id: src.subject_id,
        ord: c.ord,
        text: c.text,
        char_start: c.char_start,
        char_end: c.char_end,
        page_start: c.page_start,
        page_end: c.page_end,
        token_count: c.token_count,
        embedding: vecs[j],
      })),
    );
  }
  forgetSource(src.id!);
}

function submitSource(id: number) {
  sourceProgress.set(id, { progress: 0, stage: "Queued" });
  const run = async () => {
    const report = (f: number, stage: string) => sourceProgress.set(id, { progress: Math.round(f * 1000) / 1000, stage });
    try {
      let src = await db.sources.get(id);
      if (!src) return;
      const share = src.kind === "pdf" ? 0.5 : src.kind === "audio" ? 0.9 : 0;
      if (!src.text) {
        const file = (await db.blobs.get(uploadKey(id)))?.blob;
        if (!file) throw new Error("The uploaded file is gone. Please add it again.");
        const doc =
          src.kind === "pdf"
            ? await parsePdf(file, (f, s) => report(f * share, s))
            : await transcribeRecording(file, src.title, (f, s) => report(f * share, s));
        const title = src.kind === "pdf" && doc.title !== "Untitled PDF" ? doc.title : src.title;
        await db.sources.update(id, { text: doc.text, pages: doc.pages, title: title.slice(0, 500) });
        src = (await db.sources.get(id))!;
      }
      await indexSource(src, (f, s) => report(share + f * (1 - share), s));
      if (!(await db.sources.get(id))) return;
      await db.sources.update(id, { status: "ready", error: null });
      await db.blobs.delete(uploadKey(id));
    } catch (e) {
      if (await db.sources.get(id)) await db.sources.update(id, { status: "failed", error: message(e) });
    } finally {
      sourceProgress.delete(id);
    }
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

async function addUpload(subjectId: number, kind: "pdf" | "audio", file: Blob, filename: string, onUpload?: (f: number) => void) {
  const title = filename.replace(/\.[^.]+$/, "").replace(/_/g, " ").trim() || (kind === "pdf" ? "Untitled PDF" : "Lecture recording");
  if (kind === "pdf") {
    const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
    if (String.fromCharCode(...head) !== "%PDF") throw new Error("That file isn't a PDF");
  }
  if (!file.size) throw new Error("That file is empty.");
  onUpload?.(0.05);
  const src = await newSource(subjectId, { kind, title });
  // Keep a copy so the job survives the app being closed and failures can be retried.
  await db.blobs.put({ key: uploadKey(src.id!), blob: file });
  onUpload?.(1);
  submitSource(src.id!);
  return sourceOut(src);
}

async function deleteSourceRows(id: number) {
  const src = await db.sources.get(id);
  if (src?.status === "ready") await tombstone("sources", [src.uid]);
  await db.chunks.where("source_id").equals(id).delete();
  await db.blobs.delete(uploadKey(id));
  await db.sources.delete(id);
  forgetSource(id);
}

// ---------------------------------------------------------------- generation

const PASSAGE_BUDGET: Record<string, number> = { deck: 20, quiz: 20, sheet: 24, episode: 18, exam: 24 };

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
  let subtype = req.subtype ?? "";
  if (req.kind === "summary") {
    subtype = subtype || "key_points";
    if (!SUMMARY_FORMATS[subtype]) throw new Error(`Unknown summary format '${subtype}'`);
    const passages = await summaryPassages(subjectId, req.source_ids, req.focus, req.page_from, req.page_to);
    if (!passages.length) throw new Error("Nothing to summarise: check a ready source (and a page range that exists).");
    const length = SUMMARY_LENGTH[req.length ?? "medium"];
    return { subtype, passages, produce: (r) => buildSummary(passages, subtype, length, req.focus, r, ctx) };
  }
  if (req.kind === "sheet" && !SHEETS[subtype] && subtype !== "concept_map") throw new Error(`Unknown sheet type '${subtype}'`);
  if (req.kind === "episode") {
    subtype = subtype || "conversation";
    if (!EPISODE_FORMATS[subtype]) throw new Error(`Unknown episode format '${subtype}'`);
  }
  if (req.kind === "exam") subtype = EXAM_SIZES[subtype] ? subtype : "short";
  const passages = await selectPassages(subjectId, req.source_ids, req.focus, PASSAGE_BUDGET[req.kind]);
  if (!passages.length) throw new Error("Check at least one source with text in the Library first.");
  const o = { ctx };
  const produce = async (r: (f: number, s: string) => void): Promise<Rec> => {
    switch (req.kind) {
      case "deck":
        r(0.1, "Writing the cards");
        return buildDeck(passages, req.count ?? 15, req.focus, o);
      case "quiz":
        r(0.1, "Writing the questions");
        return buildQuiz(passages, req.count ?? 8, req.difficulty ?? "medium", req.focus, req.types, o);
      case "sheet":
        if (subtype === "concept_map") {
          r(0.1, "Mapping the ideas");
          return buildConceptMap(passages, req.focus, o);
        }
        r(0.1, "Writing the sheet");
        return buildSheet(passages, subtype, req.focus, o);
      case "exam":
        r(0.1, "Writing questions and markschemes");
        return buildExam(passages, subtype, req.extended ?? true, req.focus, label, ctx);
      default:
        r(0.1, "Writing the script");
        return buildEpisode(passages, subtype, req.length ?? "medium", req.focus, o);
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
      changed();
    }
  });
}

// ---------------------------------------------------------------- chat

const SYSTEM = `You are a study companion working only from the student's own sources, which are given as numbered passages.

Ground every factual statement in those passages and cite them by number in square brackets right after the claim, e.g. "Chlorophyll absorbs red and blue light [2]." Use only the passage numbers you were given; cite several like [1][3]. If the passages don't cover something, say so plainly instead of filling the gap from general knowledge; you may then offer a clearly-labelled general explanation.

Requests are either questions or generation requests (quizzes, summaries, flashcards, outlines). For generation requests, produce the artefact directly from the passages, still citing them.

When the student has highlighted a passage, treat it as the focus of their question.

Write for a student: clear, compact, no filler. Use short paragraphs or flat lists; light Markdown (bold, italics, headings) is fine. Never use LaTeX or $…$ math: write formulas in plain text with Unicode where needed (CO₂, H₂O, x², →).`;

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

export async function streamChat(
  subjectId: number,
  payload: ChatPayload,
  onEvent: (e: StreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  await boot();
  const subject = await db.subjects.get(subjectId);
  const s = await getSettings();
  const ids = [...payload.source_ids];
  if (payload.selection && !ids.includes(payload.selection.source_id)) ids.push(payload.selection.source_id);
  let hits: Retrieved[];
  try {
    const query = payload.selection ? `${payload.selection.text}\n\n${payload.message}` : payload.message;
    hits = await retrieve(subjectId, ids, query, s.retrievalK);
  } catch (e) {
    onEvent({ type: "error", message: message(e) });
    return;
  }
  onEvent({
    type: "sources",
    sources: hits.map((r) => ({ source_id: r.source.id!, chunk_id: r.chunk.id!, title: r.source.title, page: r.chunk.page_start })),
  });
  if (!hits.length) {
    onEvent({ type: "text", text: "None of the checked sources contain anything I can use yet. Check at least one ready source in the Library and ask again." });
    onEvent({ type: "done" });
    return;
  }
  const contents: Rec[] = [];
  for (const t of payload.history ?? []) {
    if (!t.content.trim()) continue;
    const role = t.role === "assistant" ? "model" : "user";
    if (!contents.length && role !== "user") continue;
    contents.push({ role, parts: [{ text: t.content }] });
  }
  const question = payload.selection
    ? `I highlighted this passage:\n<highlight>\n${payload.selection.text}\n</highlight>\n\n${payload.message}`
    : payload.message;
  contents.push({ role: "user", parts: [{ text: "Passages:\n\n" + hits.map((r, i) => passageBlock(i + 1, r)).join("\n\n") + "\n\n" + question }] });
  const body = {
    systemInstruction: { parts: [{ text: SYSTEM + ib.context(subject) }] },
    contents,
    generationConfig: { maxOutputTokens: s.maxTokens },
  };
  const parser = new CiteParser(hits);
  let finish: string | null = null;
  try {
    for await (const piece of streamGenerate(body, signal)) {
      if (piece.text) parser.feed(piece.text).forEach(onEvent);
      if ("finish" in piece) finish = piece.finish ?? null;
    }
    parser.flush().forEach(onEvent);
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    onEvent({ type: "error", message: e instanceof GeminiError ? e.message : "The connection to Gemini dropped. Try again." });
    return;
  }
  if (finish === "MAX_TOKENS") onEvent({ type: "text", text: "\n\n_(answer cut off at the length limit)_" });
  else if (finish && ["SAFETY", "RECITATION", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII"].includes(finish)) {
    onEvent({ type: "error", message: `Gemini stopped the answer (${finish}).` });
    return;
  }
  onEvent({ type: "done" });
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
    const out = await patiently(() => speak(g as { speaker: string; text: string }[], speakers, VOICES), 3);
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
    for (const s of await db.sources.where("subject_id").equals(id).toArray()) await deleteSourceRows(s.id!);
    for (const a of await db.artifacts.where("subject_id").equals(id).toArray()) await localApi.deleteArtifact(a.id!);
    await tombstone("subjects", [(await db.subjects.get(id))?.uid]);
    await db.subjects.delete(id);
  },

  sources: async (subjectId: number): Promise<Source[]> => {
    await boot();
    const rows = await db.sources.where("subject_id").equals(subjectId).sortBy("id");
    return Promise.all(rows.map(sourceOut));
  },
  source: async (id: number): Promise<SourceDetail> => {
    const s = await need(db.sources.get(id), "Source not found");
    return { ...(await sourceOut(s)), text: s.text, pages: s.pages };
  },
  addText: async (subjectId: number, title: string, text: string) => addParsed(subjectId, "text", parseText(text, title || null)),
  addUrl: async (subjectId: number, raw: string) => {
    let url = raw.trim();
    if (!url.includes("://")) url = "https://" + url;
    if (YOUTUBE_RE.test(url)) return addParsed(subjectId, "video", await transcribeYoutube(url), url);
    return addParsed(subjectId, "url", await parseUrl(url), url);
  },
  addPdf: (subjectId: number, file: File, onUpload?: (f: number) => void) => addUpload(subjectId, "pdf", file, file.name, onUpload),
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
  resetDeck: async (deckId: number): Promise<void> => {
    const t = now();
    await db.cards.where("deck_id").equals(deckId).modify({ ease: 2.5, interval_days: 0, reps: 0, lapses: 0, due_at: t, last_reviewed_at: null });
  },

  submitAttempt: async (quizId: number, raw: (number | string | null)[]): Promise<QuizResult> => {
    const art = await need(db.artifacts.get(quizId));
    const questions: Rec[] = (art.content as Rec).questions ?? [];
    const answers = [...raw, ...Array(questions.length).fill(null)].slice(0, questions.length);
    let results;
    try {
      results = await markQuiz(questions, answers, ib.courseLabel(await db.subjects.get(art.subject_id)));
    } catch (e) {
      throw new Error(`Couldn't mark the written answers: ${message(e)}`);
    }
    const score = results.reduce((s, r) => s + r.marks, 0);
    const total = results.reduce((s, r) => s + r.max, 0);
    await db.attempts.add({ quiz_id: quizId, answers, score, total, created_at: now() });
    return {
      score, total, answers, results,
      correct: questions.map((q) => ((q.type ?? "mcq") === "mcq" ? q.answer : (q.accept?.[0] ?? null))),
    };
  },
  markQuestion: async (examId: number, qi: number, answer: string): Promise<MarkResult> => {
    const art = await need(db.artifacts.get(examId));
    const qs: Rec[] = (art.content as Rec).questions ?? [];
    if (qi < 0 || qi >= qs.length) throw new Error("No such question");
    if (!answer.trim()) throw new Error("Write an answer first.");
    const result = await markAnswer(qs[qi], answer, ib.courseLabel(await db.subjects.get(art.subject_id)));
    await db.attempts.add({ quiz_id: examId, answers: [{ q: qi, answer, result }], score: result.marks_awarded, total: result.max_marks, created_at: now() });
    return result;
  },
  customQuestion: async (subjectId: number, body: { question: string; marks: number; answer: string; source_ids: number[] }): Promise<ArtifactDetail> => {
    const subject = await need(db.subjects.get(subjectId), "Subject not found");
    const label = ib.courseLabel(subject);
    const passages = await retrieve(subjectId, body.source_ids, body.question, 10);
    if (!passages.length) throw new Error("Check at least one source with text in the Library first.");
    const content = await draftMarkscheme(passages, body.question, body.marks, label, ib.context(subject));
    const result = body.answer.trim() ? await markAnswer(content.questions[0], body.answer, label) : null;
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

  exportBackup: () => exportAll(),
  importBackup: async (file: Blob) => {
    const res = await importAll(file);
    await resumeJobs();
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
