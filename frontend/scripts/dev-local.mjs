// Run the on-device version in dev (port 3001) next to the laptop/server version on port 3000.
import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";

// WASM runtime for the on-device embedding model (served from public/ort, never a CDN).
mkdirSync("public/ort", { recursive: true });
for (const f of ["ort-wasm-simd-threaded.jsep.mjs", "ort-wasm-simd-threaded.jsep.wasm"])
  copyFileSync(`node_modules/@huggingface/transformers/dist/${f}`, `public/ort/${f}`);

const env = { ...process.env, NEXT_PUBLIC_ENGINE: "local", NEXT_DIST_DIR: ".next-local" };
const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "-p", "3001"], { env, stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 0));
