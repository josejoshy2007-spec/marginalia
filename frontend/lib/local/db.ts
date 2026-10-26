/**
 * On-device storage (IndexedDB via Dexie). Mirrors the old Postgres schema so the UI's types
 * (lib/api.ts) are unchanged. Everything lives on the device; nothing is sent anywhere except
 * the passages/questions sent to Gemini with the student's own key.
 */
import Dexie, { type Table } from "dexie";

export type PageSpan = { page: number; start: number; end: number };

/**
 * Fields that let the same row be recognised on every device for Google Drive sync: a global id
 * (local integer ids differ per device) and the time of the last change. Both are filled in by
 * hooks below, so ordinary code never sets them.
 */
export interface Synced {
  uid?: string;
  updated_at?: string;
}

export type SyncedTable = "subjects" | "sources" | "artifacts" | "cards" | "attempts" | "threads";
export const SYNCED_TABLES: SyncedTable[] = ["subjects", "sources", "artifacts", "cards", "attempts", "threads"];
/** Tables that existed when v2 added uid/updated_at (the v2 upgrade must only touch these). */
const V2_TABLES: SyncedTable[] = ["subjects", "sources", "artifacts", "cards", "attempts"];

/** A deleted row, remembered so the deletion reaches other devices. */
export interface TombstoneRow {
  uid: string;
  table: SyncedTable;
  deleted_at: string;
}

export interface SubjectRow extends Synced {
  id?: number;
  name: string;
  created_at: string;
  ib_course?: string | null;
  ib_level?: "SL" | "HL" | null;
}

export interface SourceRow extends Synced {
  id?: number;
  subject_id: number;
  kind: "pdf" | "text" | "url" | "audio" | "video" | "slides" | "doc" | "sheet" | "image";
  title: string;
  url: string | null;
  text: string;
  pages: PageSpan[];
  checked: boolean;
  status: "ready" | "processing" | "failed";
  error?: string | null;
  created_at: string;
}

export interface ChunkRow {
  id?: number;
  source_id: number;
  subject_id: number;
  ord: number;
  text: string;
  char_start: number;
  char_end: number;
  page_start: number | null;
  page_end: number | null;
  token_count: number;
  embedding: Float32Array; // unit length, so dot product = cosine similarity
}

export interface ArtifactRow extends Synced {
  id?: number;
  subject_id: number;
  kind: "deck" | "quiz" | "sheet" | "episode" | "summary" | "exam";
  subtype: string;
  title: string;
  params: Record<string, unknown>;
  content: Record<string, unknown>;
  passages: Citation[];
  status: "ready" | "processing" | "failed";
  error?: string | null;
  created_at: string;
}

export interface Citation {
  source_id: number;
  source_title: string;
  chunk_id: number;
  start: number;
  end: number;
  page: number | null;
  cited_text: string;
  page_label?: string;
}

export interface CardRow extends Synced {
  id?: number;
  deck_id: number;
  front: string;
  back: string;
  cite: number[];
  ease: number;
  interval_days: number;
  reps: number;
  lapses: number;
  due_at: string;
  last_reviewed_at: string | null;
}

/**
 * A saved conversation: an Ask AI chat ("ask"), the bottom bar's quick answers ("sheet"), or a
 * margin note thread beside a source in Read mode ("margin"). `uid` doubles as the UI's thread id.
 */
export interface ThreadRow extends Synced {
  id?: number;
  subject_id: number;
  kind: "ask" | "sheet" | "margin";
  mode: "sources" | "general"; // answered from the checked sources, or general knowledge
  title: string;
  source_id: number | null; // margin threads: the source they sit beside
  anchor: { start: number; end: number; text: string } | null;
  turns: unknown[]; // lib/threads.ts Turn[] (assistant turns carry Citation[])
  created_at: string;
}

export interface AttemptRow extends Synced {
  id?: number;
  quiz_id: number;
  answers: unknown[];
  score: number;
  total: number;
  created_at: string;
}

export interface BlobRow {
  key: string; // e.g. "episode-12"
  blob: Blob;
  name?: string; // original file name of an upload (its extension picks the reader)
}

export interface SettingRow {
  key: string;
  value: unknown;
}

class StudyDB extends Dexie {
  subjects!: Table<SubjectRow, number>;
  sources!: Table<SourceRow, number>;
  chunks!: Table<ChunkRow, number>;
  artifacts!: Table<ArtifactRow, number>;
  cards!: Table<CardRow, number>;
  attempts!: Table<AttemptRow, number>;
  blobs!: Table<BlobRow, string>;
  settings!: Table<SettingRow, string>;
  tombstones!: Table<TombstoneRow, string>;
  threads!: Table<ThreadRow, number>;

  constructor() {
    super("marginalia");
    this.version(1).stores({
      subjects: "++id, created_at",
      sources: "++id, subject_id, status",
      chunks: "++id, source_id, subject_id",
      artifacts: "++id, subject_id, [subject_id+kind], status",
      cards: "++id, deck_id, due_at",
      attempts: "++id, quiz_id",
      blobs: "key",
      settings: "key",
    });
    // v2: Google Drive sync (global uid + updated_at on synced rows, tombstones for deletions).
    this.version(2)
      .stores({
        subjects: "++id, created_at, &uid",
        sources: "++id, subject_id, status, &uid",
        artifacts: "++id, subject_id, [subject_id+kind], status, &uid",
        cards: "++id, deck_id, due_at, &uid",
        attempts: "++id, quiz_id, &uid",
        tombstones: "uid, table",
      })
      .upgrade(async (tx) => {
        for (const t of V2_TABLES)
          await tx.table(t).toCollection().modify((row: Synced & { created_at?: string }) => {
            row.uid ??= newUid();
            row.updated_at ??= row.created_at ?? now();
          });
      });
    // v3: saved conversations (Ask AI, quick answers, margin threads), synced like everything else.
    this.version(3).stores({ threads: "++id, subject_id, &uid" });
    for (const t of SYNCED_TABLES) {
      const table = this.table(t);
      table.hook("creating", (_key, obj: Synced) => {
        obj.uid ??= newUid();
        obj.updated_at ??= now();
        localChanged();
      });
      table.hook("updating", function (mods) {
        localChanged();
        // Sync writes carry their own updated_at; every other change is stamped now.
        if (!("updated_at" in mods)) return { updated_at: now() };
      });
    }
  }
}

export const db = new StudyDB();

export const now = () => new Date().toISOString();

export function newUid(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
}

/** Sync applies remote rows with this set, so its own writes don't count as new local changes. */
export const syncState = { applying: false };

/** Tell the sync engine (if connected) that something changed locally. */
function localChanged() {
  if (syncState.applying || typeof window === "undefined") return;
  queueMicrotask(() => window.dispatchEvent(new Event("marginalia:local-change")));
}

/** Remember deletions so they propagate to other devices. */
export async function tombstone(table: SyncedTable, uids: (string | undefined)[]) {
  const t = now();
  const rows = uids.filter((u): u is string => !!u).map((uid) => ({ uid, table, deleted_at: t }));
  if (rows.length) {
    await db.tombstones.bulkPut(rows);
    localChanged();
  }
}

/** Ask the browser not to evict our data under storage pressure (best effort). */
export async function requestPersistence() {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) await navigator.storage.persist();
  } catch {}
}
