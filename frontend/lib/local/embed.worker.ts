/// <reference lib="webworker" />
// Runs the embedding model off the UI thread. Protocol: {id, texts, kind} → {id, vectors} | {id, error}.
import { embedLocal } from "./embed-core";

type Req = { id: number; texts: string[]; kind: "query" | "passage" };
const ctx = self as unknown as DedicatedWorkerGlobalScope;
// Handshake: tells the page this script really started (a blocked bootstrap never gets here).
ctx.postMessage({ ready: true });
ctx.onmessage = async (e: MessageEvent<Req>) => {
  const { id, texts, kind } = e.data;
  try {
    const vectors = await embedLocal(texts, kind);
    ctx.postMessage({ id, vectors }, vectors.map((v) => v.buffer));
  } catch (err) {
    ctx.postMessage({ id, error: err instanceof Error ? err.message : String(err), loadFailed: err instanceof Error && err.name === "ModelLoadError" });
  }
};
