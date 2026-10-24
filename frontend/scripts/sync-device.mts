/**
 * One simulated device for scripts/sync-test.mts: its own in-memory IndexedDB, driven over IPC,
 * syncing through a fake Drive (a folder of files) shared with the other device.
 */
import "fake-indexeddb/auto";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const { db } = await import("../lib/local/db");
const { localApi } = await import("../lib/local/store");
const { syncWith } = await import("../lib/local/sync");
import type { Drive, DriveFile } from "../lib/local/drive";

const dir = process.argv[2];
mkdirSync(dir, { recursive: true });

/** Drive stand-in: one JSON file per Drive file, id = name. */
const drive: Drive = {
  async list() {
    return readdirSync(dir).map((name) => ({ id: name, name, modifiedTime: "" }) as DriveFile);
  },
  async read(id) {
    return JSON.parse(readFileSync(path.join(dir, id), "utf8"));
  },
  async write(name, data) {
    writeFileSync(path.join(dir, name), JSON.stringify(data));
    return { id: name, name, modifiedTime: "" };
  },
  async remove(id) {
    rmSync(path.join(dir, id), { force: true });
  },
  async email() {
    return "test@example.com";
  },
};

const vec = () => {
  const v = Float32Array.from({ length: 768 }, () => Math.random() - 0.5);
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
};

const subjectId = async (name: string) => (await db.subjects.toArray()).find((s) => s.name === name)!.id!;

const commands: Record<string, (a: any) => Promise<unknown>> = {
  async subject({ name }) {
    return (await localApi.createSubject(name)).id;
  },
  async rename({ from, to }) {
    await localApi.patchSubject(await subjectId(from), { name: to });
  },
  /** A ready source with 3 indexed chunks (no Gemini needed). */
  async source({ subject, title }) {
    const text = "Alpha paragraph.\n\nBeta paragraph.\n\nGamma paragraph.";
    const sid = await subjectId(subject);
    const id = await db.sources.add({
      subject_id: sid, kind: "text", title, url: null, text, pages: [], checked: true, status: "ready", error: null, created_at: new Date().toISOString(),
    });
    const parts = ["Alpha paragraph.", "Beta paragraph.", "Gamma paragraph."];
    await db.chunks.bulkAdd(parts.map((p, ord) => {
      const start = text.indexOf(p);
      return { source_id: id, subject_id: sid, ord, text: p, char_start: start, char_end: start + p.length, page_start: null, page_end: null, token_count: 4, embedding: vec() };
    }));
    return id;
  },
  /** A ready deck citing chunk 2 of the source, with two cards and a quiz attempt. */
  async deck({ subject, source, title }) {
    const sid = await subjectId(subject);
    const src = (await db.sources.toArray()).find((s) => s.title === source)!;
    const chunk = (await db.chunks.where("source_id").equals(src.id!).toArray()).find((c) => c.ord === 2)!;
    const id = await db.artifacts.add({
      subject_id: sid, kind: "deck", subtype: "", title, params: { source_ids: [src.id] }, content: {},
      passages: [{ source_id: src.id!, source_title: src.title, chunk_id: chunk.id!, start: chunk.char_start, end: chunk.char_end, page: null, cited_text: chunk.text }],
      status: "ready", error: null, created_at: new Date().toISOString(),
    });
    const t = new Date().toISOString();
    for (const front of ["Q1", "Q2"])
      await db.cards.add({ deck_id: id, front, back: "A", cite: [1], ease: 2.5, interval_days: 0, reps: 0, lapses: 0, due_at: t, last_reviewed_at: null });
    await db.attempts.add({ quiz_id: id, answers: [1], score: 1, total: 1, created_at: t });
    return id;
  },
  async grade({ deck, front, grade }) {
    const d = (await db.artifacts.toArray()).find((a) => a.title === deck)!;
    const card = (await db.cards.where("deck_id").equals(d.id!).toArray()).find((c) => c.front === front)!;
    await localApi.gradeCard(card.id!, grade);
  },
  async deleteDeck({ title }) {
    await localApi.deleteArtifact((await db.artifacts.toArray()).find((a) => a.title === title)!.id!);
  },
  async deleteSubject({ name }) {
    await localApi.deleteSubject(await subjectId(name));
  },
  async sync() {
    return syncWith(drive);
  },
  /** Device-independent view of everything, for comparing devices. */
  async state() {
    const subjects = await db.subjects.toArray();
    const sources = await db.sources.toArray();
    const artifacts = await db.artifacts.toArray();
    const out: any = {};
    for (const s of subjects.sort((a, b) => a.name.localeCompare(b.name))) {
      const srcs = sources.filter((x) => x.subject_id === s.id).sort((x, y) => x.title.localeCompare(y.title));
      const arts = artifacts.filter((x) => x.subject_id === s.id);
      out[s.name] = {
        sources: await Promise.all(srcs.map(async (x) => ({ title: x.title, status: x.status, chunks: await db.chunks.where("source_id").equals(x.id!).count(), textOk: x.text.length > 0 }))),
        decks: await Promise.all(arts.map(async (a) => {
          const p = a.passages[0];
          const chunk = p ? await db.chunks.get(p.chunk_id) : undefined;
          const cards = await db.cards.where("deck_id").equals(a.id!).sortBy("front");
          return {
            title: a.title,
            citation: chunk && chunk.source_id === p.source_id ? chunk.text : "BROKEN",
            paramsOk: (a.params.source_ids as number[]).every((x) => srcs.some((s) => s.id === x)),
            cards: cards.map((c) => `${c.front}:reps${c.reps}`),
            attempts: await db.attempts.where("quiz_id").equals(a.id!).count(),
          };
        })),
      };
    }
    return out;
  },
};

process.on("message", async ({ id, cmd, args }: { id: number; cmd: string; args: any }) => {
  try {
    process.send!({ id, ok: true, value: await commands[cmd](args ?? {}) });
  } catch (e) {
    process.send!({ id, ok: false, error: (e as Error).stack ?? String(e) });
  }
});
process.send!({ ready: true });
