/**
 * On-device storage (IndexedDB via Dexie). Mirrors the old Postgres schema so the UI's types
 * (lib/api.ts) are unchanged. Everything lives on the device; nothing is sent anywhere except
 * the passages/questions sent to Gemini with the student's own key.
 */
import Dexie, { type Table } from "dexie";

export type PageSpan = { page: number; start: number; end: number };

export interface SubjectRow {
  id?: number;
  name: string;
  created_at: string;
  ib_course?: string | null;
  ib_level?: "SL" | "HL" | null;
}

export interface SourceRow {
  id?: number;
  subject_id: number;
  kind: "pdf" | "text" | "url" | "audio" | "video";
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

export interface ArtifactRow {
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
}

export interface CardRow {
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

export interface AttemptRow {
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
  }
}

export const db = new StudyDB();

export const now = () => new Date().toISOString();

/** Ask the browser not to evict our data under storage pressure (best effort). */
export async function requestPersistence() {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) await navigator.storage.persist();
  } catch {}
}
