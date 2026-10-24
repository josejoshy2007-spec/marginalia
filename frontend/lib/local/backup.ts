/**
 * Backups: everything on the device as one JSON file, and importing one (from this app on another
 * device, or from the laptop version's GET /export). Imports are added alongside existing
 * subjects with fresh ids. Sources that arrive without search vectors (the laptop's are a
 * different size) are re-indexed with Gemini in the background.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { db, now, type ArtifactRow, type Citation, type SourceRow } from "./db";
import { EMBED_DIM } from "./settings";

export const BACKUP_VERSION = 1;

function f32ToB64(v: Float32Array): string {
  const bytes = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function b64ToF32(b64: string): Float32Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}

export async function exportAll(): Promise<Blob> {
  const sources = await db.sources.toArray();
  const parts: string[] = [];
  // Built piecewise so a big library doesn't need one giant JSON.stringify.
  parts.push(`{"app":"marginalia","version":${BACKUP_VERSION},"exported_at":${JSON.stringify(now())},`);
  parts.push(`"subjects":${JSON.stringify(await db.subjects.toArray())},`);
  parts.push(`"sources":[`);
  sources.forEach((s, i) => parts.push((i ? "," : "") + JSON.stringify(s)));
  parts.push(`],"chunks":[`);
  let first = true;
  await db.chunks.each((c) => {
    parts.push((first ? "" : ",") + JSON.stringify({ ...c, embedding: f32ToB64(c.embedding) }));
    first = false;
  });
  parts.push(`],"artifacts":${JSON.stringify(await db.artifacts.toArray())},`);
  parts.push(`"cards":${JSON.stringify(await db.cards.toArray())},`);
  parts.push(`"attempts":${JSON.stringify(await db.attempts.toArray())}}`);
  return new Blob(parts, { type: "application/json" });
}

export type ImportResult = { subjects: number; sources: number; reindex: number; artifacts: number };

/** Add a backup's contents. Returns counts; sources needing indexing are left "processing". */
export async function importAll(file: Blob): Promise<ImportResult> {
  let data: any;
  try {
    data = JSON.parse(await file.text());
  } catch {
    throw new Error("That file isn't a Marginalia backup.");
  }
  if (data?.app !== "marginalia" || !Array.isArray(data.subjects)) throw new Error("That file isn't a Marginalia backup.");

  const subjectIds = new Map<number, number>();
  const sourceIds = new Map<number, number>();
  const artifactIds = new Map<number, number>();
  const chunksBySource = new Map<number, any[]>();
  for (const c of data.chunks ?? []) {
    if (!chunksBySource.has(c.source_id)) chunksBySource.set(c.source_id, []);
    chunksBySource.get(c.source_id)!.push(c);
  }
  let reindex = 0;

  await db.transaction("rw", [db.subjects, db.sources, db.chunks, db.artifacts, db.cards, db.attempts], async () => {
    for (const s of data.subjects) {
      const id = await db.subjects.add({
        name: s.name, created_at: s.created_at ?? now(), ib_course: s.ib_course ?? null, ib_level: s.ib_level ?? null,
      });
      subjectIds.set(s.id, id);
    }
    for (const s of data.sources ?? []) {
      const subject = subjectIds.get(s.subject_id);
      if (subject == null || !s.text) continue; // failed/unfinished sources have nothing to keep
      const chunks = (chunksBySource.get(s.id) ?? []).filter((c) => typeof c.embedding === "string");
      const usable = chunks.length > 0 && b64ToF32(chunks[0].embedding).length === EMBED_DIM;
      const row: SourceRow = {
        subject_id: subject, kind: s.kind, title: s.title, url: s.url ?? null, text: s.text, pages: s.pages ?? [],
        checked: s.checked ?? true, status: usable ? "ready" : "processing", error: null, created_at: s.created_at ?? now(),
      };
      const id = await db.sources.add(row);
      sourceIds.set(s.id, id);
      if (usable)
        await db.chunks.bulkAdd(
          chunks.map((c) => ({
            source_id: id, subject_id: subject, ord: c.ord, text: c.text, char_start: c.char_start, char_end: c.char_end,
            page_start: c.page_start ?? null, page_end: c.page_end ?? null, token_count: c.token_count,
            embedding: b64ToF32(c.embedding),
          })),
        );
      else reindex++;
    }
    for (const a of data.artifacts ?? []) {
      const subject = subjectIds.get(a.subject_id);
      if (subject == null || (a.status && a.status !== "ready")) continue;
      const passages: Citation[] = (a.passages ?? []).map((p: Citation) => ({ ...p, source_id: sourceIds.get(p.source_id) ?? -1 }));
      const params = { ...(a.params ?? {}) };
      if (Array.isArray(params.source_ids)) params.source_ids = params.source_ids.map((x: number) => sourceIds.get(x)).filter((x: unknown) => x != null);
      const row: ArtifactRow = {
        subject_id: subject, kind: a.kind, subtype: a.subtype ?? "", title: a.title, params, content: a.content ?? {},
        passages, status: "ready", error: null, created_at: a.created_at ?? now(),
      };
      artifactIds.set(a.id, await db.artifacts.add(row));
    }
    for (const c of data.cards ?? []) {
      const deck = artifactIds.get(c.deck_id);
      if (deck == null) continue;
      await db.cards.add({
        deck_id: deck, front: c.front, back: c.back, cite: c.cite ?? [], ease: c.ease ?? 2.5,
        interval_days: c.interval_days ?? 0, reps: c.reps ?? 0, lapses: c.lapses ?? 0,
        due_at: new Date(c.due_at ?? Date.now()).toISOString(),
        last_reviewed_at: c.last_reviewed_at ? new Date(c.last_reviewed_at).toISOString() : null,
      });
    }
    for (const t of data.attempts ?? []) {
      const quiz = artifactIds.get(t.quiz_id);
      if (quiz == null) continue;
      await db.attempts.add({ quiz_id: quiz, answers: t.answers ?? [], score: t.score ?? 0, total: t.total ?? 0, created_at: t.created_at ?? now() });
    }
  });
  return { subjects: subjectIds.size, sources: sourceIds.size, reindex, artifacts: artifactIds.size };
}
