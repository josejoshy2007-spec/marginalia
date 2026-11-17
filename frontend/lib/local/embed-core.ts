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
 * bge-small reads at most 512 tokens (the tokenizer truncates), and on the WASM backend each ~1,800
 * characters costs about 1.5 s. A passage is therefore embedded from its first PASSAGE_CHARS characters
 * only, as one window: no windowing and no averaging.
 */
export const PASSAGE_CHARS = 2000;
export const passageText = (t: string) => t.slice(0, PASSAGE_CHARS);

/** Unit-length 384-d vectors. Queries get BGE's search prefix; passages use their first PASSAGE_CHARS characters. */
export async function embedLocal(texts: string[], kind: "query" | "passage"): Promise<Float32Array[]> {
  const run = await load().catch((e) => {
    const err = new Error(e instanceof Error ? e.message : String(e));
    err.name = "ModelLoadError"; // lets the worker tell its owner to retry on the main thread
    throw err;
  });
  const out: Float32Array[] = [];
  for (let i = 0; i < texts.length; i += BATCH) {
    const batch = texts.slice(i, i + BATCH).map((t) => (kind === "query" ? QUERY_PREFIX + t : passageText(t)));
    const res = await run(batch, { pooling: "cls", normalize: true });
    const dim = res.dims[res.dims.length - 1];
    for (let j = 0; j < batch.length; j++) out.push(Float32Array.from(res.data.subarray(j * dim, (j + 1) * dim)));
    await tick();
  }
  return out;
}
