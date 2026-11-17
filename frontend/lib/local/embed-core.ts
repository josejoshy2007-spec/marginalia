/**
 * The on-device embedding model (BAAI/bge-small-en-v1.5, 384-d, int8) run through transformers.js on
 * onnxruntime-web (WASM, single thread). Everything is served from this app: the model files from
 * `${BASE}/models/`, the WASM runtime from `${BASE}/ort/`. No Hugging Face, no CDN, no API calls.
 * This file runs in a Web Worker in the browser (embed.worker.ts) and directly in Node (tests).
 */
export const MODEL_ID = "bge-small-en-v1.5";
export const QUERY_PREFIX = "Represent this sentence for searching relevant passages: ";
const BATCH = 8;

type Extractor = (texts: string[], opts: { pooling: "cls"; normalize: boolean }) => Promise<{ data: Float32Array; dims: number[] }>;

const isNode = typeof process !== "undefined" && !!process.versions?.node && typeof window === "undefined" && typeof WorkerGlobalScope === "undefined";
declare const WorkerGlobalScope: unknown;

export type CoreConfig = { modelPath: string; wasmPaths?: string };
let override: Partial<CoreConfig> = {};
/** Where the model files and WASM runtime are served from (defaults: the app's own /models and /ort). */
export function configureCore(c: Partial<CoreConfig>) {
  override = { ...override, ...c };
}
function resolveConfig(): CoreConfig {
  const base = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
  return {
    // In Node (tests) read the bundled files straight from public/; in the browser use the app's own URL.
    modelPath: isNode ? `${process.cwd()}/public/models/` : `${base}/models/`,
    wasmPaths: isNode ? undefined : `${base}/ort/`,
    ...override,
  };
}

let loading: Promise<Extractor> | null = null;
function load(): Promise<Extractor> {
  loading ??= (async () => {
    const tf = await import("@huggingface/transformers");
    tf.env.allowRemoteModels = false;
    tf.env.allowLocalModels = true;
    tf.env.useBrowserCache = false; // the service worker already keeps these files
    const config = resolveConfig();
    tf.env.localModelPath = config.modelPath;
    const wasm = tf.env.backends.onnx.wasm;
    if (wasm && config.wasmPaths) wasm.wasmPaths = config.wasmPaths;
    if (wasm) {
      wasm.numThreads = 1; // no SharedArrayBuffer / cross-origin isolation needed
      wasm.proxy = false;
    }
    const p = await tf.pipeline("feature-extraction", MODEL_ID, { dtype: "q8", device: isNode ? "cpu" : "wasm" });
    return p as unknown as Extractor;
  })();
  loading.catch(() => (loading = null)); // a failed load can be retried
  return loading;
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/**
 * bge-small reads at most 512 tokens, but chunks run ~800 cl100k tokens (~1,000 wordpieces). A passage is
 * therefore split into overlapping windows of ~1,800 characters (about 400-450 wordpieces for English, so
 * nothing is truncated), each embedded on its own, and the passage vector is the normalised mean.
 */
export const WINDOW_CHARS = 1800;
const WINDOW_STEP = 1600; // 200 characters of overlap

export function windows(text: string): string[] {
  if (text.length <= WINDOW_CHARS) return [text];
  const out: string[] = [];
  for (let start = 0; ; start += WINDOW_STEP) {
    let end = start + WINDOW_CHARS;
    if (end >= text.length) {
      end = text.length;
      out.push(text.slice(Math.max(0, end - WINDOW_CHARS), end)); // the last window ends exactly at the end
      break;
    }
    out.push(text.slice(start, end));
  }
  return out;
}

function meanUnit(vs: Float32Array[]): Float32Array {
  if (vs.length === 1) return vs[0];
  const m = new Float32Array(vs[0].length);
  for (const v of vs) for (let k = 0; k < m.length; k++) m[k] += v[k];
  let n = 0;
  for (let k = 0; k < m.length; k++) n += m[k] * m[k];
  n = Math.sqrt(n) || 1;
  for (let k = 0; k < m.length; k++) m[k] /= n;
  return m;
}

async function embedWindows(run: Extractor, texts: string[]): Promise<Float32Array[]> {
  const flat: string[] = [];
  const owner: number[] = [];
  texts.forEach((t, i) => {
    for (const w of windows(t)) {
      flat.push(w);
      owner.push(i);
    }
  });
  const vecs: Float32Array[] = [];
  for (let i = 0; i < flat.length; i += BATCH) {
    const batch = flat.slice(i, i + BATCH);
    const res = await run(batch, { pooling: "cls", normalize: true });
    const dim = res.dims[res.dims.length - 1];
    for (let j = 0; j < batch.length; j++) vecs.push(Float32Array.from(res.data.subarray(j * dim, (j + 1) * dim)));
    await tick();
  }
  const groups: Float32Array[][] = texts.map(() => []);
  vecs.forEach((v, k) => groups[owner[k]].push(v));
  return groups.map(meanUnit);
}

/** Unit-length 384-d vectors. Queries get BGE's search prefix (one window); passages are windowed and averaged. */
export async function embedLocal(texts: string[], kind: "query" | "passage"): Promise<Float32Array[]> {
  const run = await load().catch((e) => {
    const err = new Error(e instanceof Error ? e.message : String(e));
    err.name = "ModelLoadError"; // lets the worker tell its owner to retry on the main thread
    throw err;
  });
  if (kind === "passage") return embedWindows(run, texts);
  const out: Float32Array[] = [];
  for (let i = 0; i < texts.length; i += BATCH) {
    const batch = texts.slice(i, i + BATCH).map((t) => (kind === "query" ? QUERY_PREFIX + t : t));
    const res = await run(batch, { pooling: "cls", normalize: true });
    const dim = res.dims[res.dims.length - 1];
    for (let j = 0; j < batch.length; j++) out.push(Float32Array.from(res.data.subarray(j * dim, (j + 1) * dim)));
    await tick();
  }
  return out;
}
