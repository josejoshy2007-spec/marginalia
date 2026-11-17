/**
 * Local embeddings for search and indexing: zero API calls. In the browser the model runs in a Web
 * Worker (so the UI stays responsive); if the worker can't start it runs on the main thread in small
 * batches that yield between runs. Tests can swap in a fake with setEmbedder().
 */
import { embedLocal } from "./embed-core";

export type Embedder = (texts: string[], kind: "query" | "passage") => Promise<Float32Array[]>;

let override: Embedder | null = null;
/** Test seam: replace the model. Pass null to restore the real one. */
export function setEmbedder(e: Embedder | null) {
  override = e;
}

type WorkerReply = { id?: number; ready?: boolean; vectors?: Float32Array[]; error?: string; loadFailed?: boolean };
type WorkerLike = {
  postMessage(m: unknown): void;
  terminate(): void;
  onmessage: ((e: MessageEvent<WorkerReply>) => void) | null;
  onerror: ((e: unknown) => void) | null;
  onmessageerror: ((e: unknown) => void) | null;
};

/** How long a worker may stay silent before it is declared dead. The first call includes loading the model. */
export type EmbedTimeouts = { first: number; passage: number; query: number; ready: number };
/** `ready`: the worker script must announce itself within this long, or it never started (e.g. blocked bootstrap). */
const DEFAULT_TIMEOUTS: EmbedTimeouts = { first: 180_000, passage: 120_000, query: 20_000, ready: 10_000 };
let timeouts = DEFAULT_TIMEOUTS;
let workerFactory: (() => WorkerLike) | null = null;
let mainEmbedder: Embedder = embedLocal;

let worker: WorkerLike | null = null;
let workerBroken = false;
let workerLoaded = false; // a request has succeeded, so the model is loaded and queries should be quick
let readyTimer: ReturnType<typeof setTimeout> | null = null;
let nextId = 0;
const pending = new Map<number, { resolve: (v: Float32Array[]) => void; reject: (e: Error) => void }>();

class WorkerFailure extends Error {}

function failAll(msg: string) {
  for (const p of pending.values()) p.reject(new WorkerFailure(msg));
  pending.clear();
}

/** Give up on the worker: stop it, remember that, and let every waiting call fall back to the main thread. */
function clearReadyTimer() {
  if (readyTimer) clearTimeout(readyTimer);
  readyTimer = null;
}

function breakWorker(msg: string) {
  workerBroken = true;
  clearReadyTimer();
  const w = worker;
  worker = null;
  try {
    w?.terminate();
  } catch {
    /* already gone */
  }
  failAll(msg);
}

/** Test seams: a fake worker, short timeouts, a fake main-thread fallback. Call with no arguments to restore. */
export function configureEmbedderForTests(o: { worker?: () => WorkerLike; timeouts?: Partial<EmbedTimeouts>; main?: Embedder } = {}) {
  const w = worker;
  worker = null;
  clearReadyTimer();
  try {
    w?.terminate();
  } catch {
    /* ignore */
  }
  failAll("reset");
  workerFactory = o.worker ?? null;
  timeouts = { ...DEFAULT_TIMEOUTS, ...o.timeouts };
  mainEmbedder = o.main ?? embedLocal;
  workerBroken = false;
  workerLoaded = false;
}

function getWorker(): WorkerLike | null {
  if (workerBroken) return null;
  if (worker) return worker;
  if (!workerFactory && (typeof Worker === "undefined" || typeof window === "undefined")) return null;
  try {
    const w = workerFactory ? workerFactory() : (new Worker(new URL("./embed.worker.ts", import.meta.url), { type: "module" }) as unknown as WorkerLike);
    w.onmessage = (e) => {
      if (worker !== w) return; // a reply from a worker we already gave up on
      clearReadyTimer(); // any message proves the script is running
      if (e.data.ready || e.data.id === undefined) return;
      const p = pending.get(e.data.id);
      if (!p) return;
      pending.delete(e.data.id);
      if (e.data.loadFailed) {
        // The model could not be loaded in the worker: try the main thread once before giving up.
        p.reject(new WorkerFailure(e.data.error ?? "model load failed"));
        breakWorker("worker model load failed");
      } else if (e.data.error) p.reject(new Error(e.data.error));
      else {
        workerLoaded = true;
        p.resolve(e.data.vectors!);
      }
    };
    w.onerror = () => worker === w && breakWorker("worker error");
    w.onmessageerror = () => worker === w && breakWorker("worker messageerror");
    worker = w;
    clearReadyTimer();
    readyTimer = setTimeout(() => worker === w && breakWorker("worker did not start"), timeouts.ready);
    return w;
  } catch {
    workerBroken = true;
    return null;
  }
}

function viaWorker(w: WorkerLike, texts: string[], kind: "query" | "passage"): Promise<Float32Array[]> {
  const ms = !workerLoaded ? timeouts.first : kind === "query" ? timeouts.query : timeouts.passage;
  return new Promise<Float32Array[]>((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      if (!pending.has(id)) return;
      pending.delete(id);
      reject(new WorkerFailure("worker timeout"));
      if (worker === w) breakWorker("worker timeout");
    }, ms);
    pending.set(id, {
      resolve: (v) => (clearTimeout(timer), resolve(v)),
      reject: (e) => (clearTimeout(timer), reject(e)),
    });
    try {
      w.postMessage({ id, texts, kind });
    } catch {
      clearTimeout(timer);
      pending.delete(id);
      reject(new WorkerFailure("worker postMessage"));
      if (worker === w) breakWorker("worker postMessage");
    }
  });
}

export const embedder: Embedder = async (texts, kind) => {
  if (override) return override(texts, kind);
  if (!texts.length) return [];
  const w = getWorker();
  if (w) {
    try {
      return await viaWorker(w, texts, kind);
    } catch (e) {
      if (!(e instanceof WorkerFailure)) throw e; // a real model error: don't retry elsewhere
    }
  }
  return mainEmbedder(texts, kind);
};

export const embedQuery = async (text: string) => (await embedder([text], "query"))[0];
/** `allowMain: false` (background work): when the worker is unavailable, throw instead of running the model on the UI thread. */
export async function embedPassages(texts: string[], opts: { allowMain?: boolean } = {}): Promise<Float32Array[]> {
  if (opts.allowMain === false && !override && texts.length && !getWorker()) throw new Error("embedding worker unavailable");
  if (opts.allowMain === false && !override && texts.length) {
    const w = getWorker();
    if (w) return viaWorker(w, texts, "passage"); // a WorkerFailure here also stops the caller; no main-thread fallback
  }
  return embedder(texts, "passage");
}
