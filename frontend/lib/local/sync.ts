/**
 * Google Drive sync between the student's devices (Android app, web app, another phone).
 *
 * Drive's hidden appDataFolder holds:
 *   library.json.gz          every subject, ready source (metadata), ready study item, card and
 *                            attempt, plus tombstones; rows refer to each other by `uid`
 *   source-<uid>.json.gz     one per source: its text, pages and indexed chunks with embeddings
 *                            (written once; a source's text never changes)
 *
 * A sync downloads library.json, merges it with this device (per row, the newer `updated_at` wins;
 * a tombstone always wins; rows whose parent is gone are dropped), applies the result here
 * (downloading new sources' content), then uploads the merged library and any new source content.
 * Merging is a union, so devices converge even if two sync at the same moment: the next sync
 * re-adds anything an overlapping upload missed. Sources still processing and items still being
 * generated stay on their device until they're ready.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { db, now, syncState, SYNCED_TABLES, type SyncedTable, type TombstoneRow } from "./db";
import { googleDrive, type Drive, type DriveFile } from "./drive";
import { AuthNeeded, driveToken } from "./google";
import { forgetSource } from "./search";
import { EMBED_DIM, getSettings, saveSettings } from "./settings";
import { localApi } from "./store";

type Rec = Record<string, any> & { uid: string; updated_at: string };
export type Library = { format: 1; synced_at: string } & Record<SyncedTable, Rec[]> & { tombstones: TombstoneRow[] };

const LIBRARY = "library.json.gz";
const contentName = (uid: string) => `source-${uid}.json.gz`;

// ---------------------------------------------------------------- local snapshot (uid references)

const strip = ({ id: _id, ...rest }: Record<string, any>) => rest as Rec;

export async function snapshotLocal(): Promise<Library> {
  const subjects = await db.subjects.toArray();
  const sources = (await db.sources.toArray()).filter((s) => s.status === "ready");
  const artifacts = (await db.artifacts.toArray()).filter((a) => a.status === "ready");
  const subjectUid = new Map(subjects.map((s) => [s.id!, s.uid!]));
  const sourceUid = new Map(sources.map((s) => [s.id!, s.uid!]));
  const artUid = new Map(artifacts.map((a) => [a.id!, a.uid!]));
  const chunkOrd = new Map<number, number>();
  const cited = new Set<number>();
  for (const a of artifacts) for (const p of a.passages) cited.add(p.chunk_id);
  for (const c of await db.chunks.bulkGet([...cited])) if (c) chunkOrd.set(c.id!, c.ord);

  const cards = (await db.cards.toArray()).filter((c) => artUid.has(c.deck_id));
  const attempts = (await db.attempts.toArray()).filter((t) => artUid.has(t.quiz_id));
  return {
    format: 1,
    synced_at: now(),
    subjects: subjects.map((s) => strip(s) as Rec),
    sources: sources
      .filter((s) => subjectUid.has(s.subject_id))
      .map(({ text: _t, pages, subject_id, error: _e, ...s }) => ({
        ...strip(s), subject: subjectUid.get(subject_id), page_count: pages.length,
      }) as Rec),
    artifacts: artifacts
      .filter((a) => subjectUid.has(a.subject_id))
      .map(({ subject_id, passages, params, error: _e, ...a }) => ({
        ...strip(a),
        subject: subjectUid.get(subject_id),
        params: Array.isArray(params.source_ids)
          ? { ...params, source_ids: (params.source_ids as number[]).map((x) => sourceUid.get(x)).filter(Boolean) }
          : params,
        passages: passages.map(({ source_id, chunk_id, ...p }) => ({
          ...p, source: sourceUid.get(source_id) ?? null, chunk_ord: chunkOrd.get(chunk_id) ?? null,
        })),
      }) as Rec),
    cards: cards.map(({ deck_id, ...c }) => ({ ...strip(c), deck: artUid.get(deck_id) }) as Rec),
    attempts: attempts.map(({ quiz_id, ...t }) => ({ ...strip(t), quiz: artUid.get(quiz_id) }) as Rec),
    tombstones: await db.tombstones.toArray(),
  };
}

// ---------------------------------------------------------------- merge (pure)

const PARENT: Partial<Record<SyncedTable, [string, SyncedTable]>> = {
  sources: ["subject", "subjects"],
  artifacts: ["subject", "subjects"],
  cards: ["deck", "artifacts"],
  attempts: ["quiz", "artifacts"],
};

/** Union of two libraries: newer row wins, tombstones win, orphans are dropped. */
export function merge(a: Library, b: Library | null): Library {
  if (!b) return a;
  const tomb = new Map<string, TombstoneRow>();
  for (const t of [...a.tombstones, ...b.tombstones]) {
    const prev = tomb.get(t.uid);
    if (!prev || prev.deleted_at < t.deleted_at) tomb.set(t.uid, t);
  }
  const out = { format: 1, synced_at: now(), tombstones: [...tomb.values()] } as Library;
  for (const table of SYNCED_TABLES) {
    const rows = new Map<string, Rec>();
    for (const r of [...(a[table] ?? []), ...(b[table] ?? [])]) {
      if (!r?.uid || tomb.has(r.uid)) continue;
      const prev = rows.get(r.uid);
      if (!prev || prev.updated_at < r.updated_at) rows.set(r.uid, r);
    }
    out[table] = [...rows.values()];
  }
  // Drop rows whose parent is gone (in dependency order: subjects → sources/artifacts → cards/attempts).
  for (const table of ["sources", "artifacts", "cards", "attempts"] as SyncedTable[]) {
    const [field, parent] = PARENT[table]!;
    const alive = new Set(out[parent].map((r) => r.uid));
    out[table] = out[table].filter((r) => alive.has(r[field]));
  }
  return out;
}

// ---------------------------------------------------------------- apply to this device

const b64 = (v: Float32Array) => {
  const bytes = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
const unb64 = (s: string) => {
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Float32Array(bytes.buffer);
};

type Content = {
  text: string;
  pages: { page: number; start: number; end: number }[];
  chunks: { ord: number; text: string; char_start: number; char_end: number; page_start: number | null; page_end: number | null; token_count: number; e: string }[];
};

async function sourceContent(id: number): Promise<Content> {
  const s = (await db.sources.get(id))!;
  const chunks = await db.chunks.where("source_id").equals(id).sortBy("ord");
  return {
    text: s.text,
    pages: s.pages,
    chunks: chunks.map((c) => ({
      ord: c.ord, text: c.text, char_start: c.char_start, char_end: c.char_end,
      page_start: c.page_start, page_end: c.page_end, token_count: c.token_count, e: b64(c.embedding),
    })),
  };
}

const uidMap = async (table: SyncedTable) =>
  new Map((await db.table(table).toArray()).map((r: any) => [r.uid as string, r]));

export type ApplyResult = { added: number; updated: number; removed: number; missing: string[] };

/** Make this device match `lib`. `fetchContent` returns a source's content file (null if absent). */
export async function applyLibrary(lib: Library, local: Library, fetchContent: (uid: string) => Promise<Content | null>): Promise<ApplyResult> {
  const res: ApplyResult = { added: 0, updated: 0, removed: 0, missing: [] };
  syncState.applying = true;
  try {
    await db.tombstones.bulkPut(lib.tombstones);
    const newer = (cur: any, r: Rec) => !cur.updated_at || cur.updated_at < r.updated_at;

    // subjects
    let subjects = await uidMap("subjects");
    for (const r of lib.subjects) {
      const cur = subjects.get(r.uid);
      const row = { uid: r.uid, updated_at: r.updated_at, name: r.name, created_at: r.created_at, ib_course: r.ib_course ?? null, ib_level: r.ib_level ?? null };
      if (!cur) (await db.subjects.add(row), res.added++);
      else if (newer(cur, r)) (await db.subjects.update(cur.id, row), res.updated++);
    }
    subjects = await uidMap("subjects");

    // sources (new ones need their content file)
    let sources = await uidMap("sources");
    for (const r of lib.sources) {
      const cur = sources.get(r.uid);
      const subject = subjects.get(r.subject);
      if (!subject) continue;
      const meta = { uid: r.uid, updated_at: r.updated_at, subject_id: subject.id, kind: r.kind, title: r.title, url: r.url ?? null, checked: r.checked ?? true, created_at: r.created_at };
      if (cur) {
        if (newer(cur, r)) (await db.sources.update(cur.id, meta), res.updated++);
        continue;
      }
      const content = await fetchContent(r.uid);
      if (!content) {
        res.missing.push(r.uid);
        continue;
      }
      const usable = content.chunks.length > 0 && unb64(content.chunks[0].e).length === EMBED_DIM;
      const id = await db.sources.add({ ...meta, text: content.text, pages: content.pages, status: usable ? "ready" : "processing", error: null });
      if (usable)
        await db.chunks.bulkAdd(
          content.chunks.map((c) => ({
            source_id: id, subject_id: subject.id, ord: c.ord, text: c.text, char_start: c.char_start, char_end: c.char_end,
            page_start: c.page_start, page_end: c.page_end, token_count: c.token_count, embedding: unb64(c.e),
          })),
        );
      res.added++;
    }
    sources = await uidMap("sources");

    // study items
    const chunkIds = new Map<string, number>(); // `${sourceId}:${ord}` → chunk id, filled lazily
    const chunkId = async (sourceId: number, ord: number | null) => {
      if (ord == null || sourceId < 0) return -1;
      const key = `${sourceId}:${ord}`;
      if (!chunkIds.has(key)) {
        for (const c of await db.chunks.where("source_id").equals(sourceId).toArray()) chunkIds.set(`${sourceId}:${c.ord}`, c.id!);
        if (!chunkIds.has(key)) chunkIds.set(key, -1);
      }
      return chunkIds.get(key)!;
    };
    let artifacts = await uidMap("artifacts");
    for (const r of lib.artifacts) {
      const cur = artifacts.get(r.uid);
      const subject = subjects.get(r.subject);
      if (!subject || (cur && !newer(cur, r))) continue;
      const passages = [];
      for (const p of r.passages ?? []) {
        const { source, chunk_ord, ...rest } = p;
        const sid = sources.get(source)?.id ?? -1;
        passages.push({ ...rest, source_id: sid, chunk_id: await chunkId(sid, chunk_ord) });
      }
      const params = Array.isArray(r.params?.source_ids)
        ? { ...r.params, source_ids: r.params.source_ids.map((u: string) => sources.get(u)?.id).filter((x: unknown) => x != null) }
        : (r.params ?? {});
      const row = {
        uid: r.uid, updated_at: r.updated_at, subject_id: subject.id, kind: r.kind, subtype: r.subtype ?? "", title: r.title,
        params, content: r.content ?? {}, passages, status: "ready" as const, error: null, created_at: r.created_at,
      };
      if (!cur) (await db.artifacts.add(row), res.added++);
      else (await db.artifacts.update(cur.id, row), res.updated++);
    }
    artifacts = await uidMap("artifacts");

    const cards = await uidMap("cards");
    for (const r of lib.cards) {
      const cur = cards.get(r.uid);
      const deck = artifacts.get(r.deck);
      if (!deck || (cur && !newer(cur, r))) continue;
      const { deck: _d, ...rest } = r;
      if (!cur) (await db.cards.add({ ...rest, deck_id: deck.id } as any), res.added++);
      else (await db.cards.update(cur.id, { ...rest, deck_id: deck.id }), res.updated++);
    }
    const attempts = await uidMap("attempts");
    for (const r of lib.attempts) {
      const cur = attempts.get(r.uid);
      const quiz = artifacts.get(r.quiz);
      if (!quiz || (cur && !newer(cur, r))) continue;
      const { quiz: _q, ...rest } = r;
      if (!cur) (await db.attempts.add({ ...rest, quiz_id: quiz.id } as any), res.added++);
      else (await db.attempts.update(cur.id, { ...rest, quiz_id: quiz.id }), res.updated++);
    }

    // Removals: rows that were in this device's snapshot but aren't in the merged library
    // (deleted on another device, or their parent was). Children go with their parents.
    const keep = (t: SyncedTable) => new Set(lib[t].map((r) => r.uid));
    for (const [table, del] of [
      ["artifacts", localApi.deleteArtifact],
      ["sources", localApi.deleteSource],
      ["subjects", localApi.deleteSubject],
    ] as [SyncedTable, (id: number) => Promise<void>][]) {
      const alive = keep(table);
      const current = await uidMap(table);
      for (const r of local[table]) {
        const row = current.get(r.uid);
        if (row && !alive.has(r.uid)) (await del(row.id), res.removed++);
      }
    }
  } finally {
    syncState.applying = false;
  }
  for (const s of await db.sources.toArray()) forgetSource(s.id!);
  return res;
}

// ---------------------------------------------------------------- one sync

export type SyncStatus =
  | { state: "off" }
  | { state: "idle"; lastSyncAt: string | null; email: string | null }
  | { state: "syncing"; stage: string }
  | { state: "auth"; message: string }
  | { state: "error"; message: string };

let status: SyncStatus = { state: "off" };
export const syncStatus = () => status;
function setStatus(s: SyncStatus) {
  status = s;
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("marginalia:sync-status", { detail: s }));
}

/** Run one full sync against `drive`. Exported separately so tests can pass a fake Drive. */
export async function syncWith(drive: Drive, onStage: (s: string) => void = () => {}): Promise<ApplyResult> {
  onStage("Checking Google Drive");
  const files = new Map<string, DriveFile>((await drive.list()).map((f) => [f.name, f]));
  const libFile = files.get(LIBRARY);
  const remote = libFile ? ((await drive.read(libFile.id)) as Library) : null;
  if (remote && remote.format !== 1) throw new Error("This library was synced by a newer version of Marginalia. Update the app first.");

  const local = await snapshotLocal();
  const merged = merge(local, remote);
  onStage("Bringing in changes");
  const result = await applyLibrary(merged, local, async (uid) => {
    const f = files.get(contentName(uid));
    return f ? ((await drive.read(f.id)) as Content) : null;
  });

  // Upload content for sources Drive doesn't have yet; remove content of deleted sources.
  const mine = await uidMap("sources");
  const toUpload = merged.sources.filter((r) => !files.has(contentName(r.uid)) && mine.get(r.uid)?.status === "ready");
  for (let i = 0; i < toUpload.length; i++) {
    onStage(`Uploading sources (${i + 1}/${toUpload.length})`);
    await drive.write(contentName(toUpload[i].uid), await sourceContent(mine.get(toUpload[i].uid).id));
  }
  for (const t of merged.tombstones) {
    const f = t.table === "sources" ? files.get(contentName(t.uid)) : undefined;
    if (f) await drive.remove(f.id);
  }
  // Sources whose content was missing stay out of the library until a device that has them uploads it.
  onStage("Saving to Google Drive");
  await drive.write(LIBRARY, merged, libFile?.id);
  return result;
}

let running: Promise<ApplyResult | null> | null = null;

/** Sync now. `interactive` (from a tap) may show Google sign-in; background syncs never do. */
export function syncNow(interactive = false): Promise<ApplyResult | null> {
  // From a tap, ask for the token before anything else so a browser lets Google's window open.
  const tapToken = interactive ? driveToken(true) : null;
  tapToken?.catch(() => {});
  running ??= (async () => {
    const s = await getSettings();
    if (!s.syncOn) return null;
    try {
      setStatus({ state: "syncing", stage: "Signing in" });
      const drive = googleDrive(await (tapToken ?? driveToken(false)));
      const email = s.syncEmail || (await drive.email());
      const res = await syncWith(drive, (stage) => setStatus({ state: "syncing", stage }));
      const lastSyncAt = now();
      await saveSettings({ lastSyncAt, syncEmail: email ?? "" });
      setStatus({ state: "idle", lastSyncAt, email });
      if (res.added || res.updated || res.removed) {
        window.dispatchEvent(new Event("marginalia:library-changed"));
        window.dispatchEvent(new Event("marginalia:artifacts-changed"));
      }
      return res;
    } catch (e) {
      if (e instanceof AuthNeeded) setStatus({ state: "auth", message: e.message });
      else setStatus({ state: "error", message: (e as Error).message || "Sync failed." });
      if (interactive) throw e;
      return null;
    } finally {
      running = null;
    }
  })();
  return running;
}

/** Turn sync on from a tap: signs in, then does a first sync. */
export async function connect(): Promise<ApplyResult | null> {
  await driveToken(true); // opens Google's sign-in right away, inside the tap
  await saveSettings({ syncOn: true });
  return syncNow(true);
}

export async function disconnect() {
  const { signOut } = await import("./google");
  await signOut();
  await saveSettings({ syncOn: false, syncEmail: "", lastSyncAt: "" });
  setStatus({ state: "off" });
}

// ---------------------------------------------------------------- automatic syncing

let started = false;

/** Sync on start, a little after local changes, when the app comes back to the front, and when back online. */
export async function startAutoSync() {
  if (started || typeof window === "undefined") return;
  started = true;
  const s = await getSettings();
  setStatus(s.syncOn ? { state: "idle", lastSyncAt: s.lastSyncAt || null, email: s.syncEmail || null } : { state: "off" });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const soon = (ms: number) => {
    clearTimeout(timer);
    timer = setTimeout(() => syncNow(false), ms);
  };
  window.addEventListener("marginalia:local-change", () => soon(20_000));
  window.addEventListener("online", () => soon(2_000));
  document.addEventListener("visibilitychange", async () => {
    if (document.visibilityState !== "visible") return;
    const last = (await getSettings()).lastSyncAt;
    if (!last || Date.now() - Date.parse(last) > 2 * 60_000) soon(1_000);
  });
  if (s.syncOn) soon(1_500);
}
