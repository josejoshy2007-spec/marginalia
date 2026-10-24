/**
 * Build the on-device app as static files in out/ (no server), then add the PWA files:
 * manifest.webmanifest and a service worker that precaches every built file for offline use.
 *   node scripts/build-static.mjs [--base /marginalia]
 * The APK uses base "" (Capacitor serves out/ at the web root); GitHub Pages uses "/<repo>".
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

const i = process.argv.indexOf("--base");
const base = (i > 0 ? process.argv[i + 1] : process.env.NEXT_PUBLIC_BASE_PATH || "").replace(/\/$/, "");
const env = { ...process.env, NEXT_OUTPUT: "export", NEXT_PUBLIC_ENGINE: "local", NEXT_PUBLIC_BASE_PATH: base, NEXT_DIST_DIR: ".next-export" };
// Next 16 also writes export segments under .next/server and fails on stale ones from earlier builds.
rmSync(".next/server", { recursive: true, force: true });
// pdf.js reads PDFs in a worker served next to the app.
copyFileSync("node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs", "public/pdf.worker.min.mjs");
const r = spawnSync(process.execPath, ["node_modules/next/dist/bin/next", "build"], { env, stdio: "inherit" });
if (r.status !== 0) process.exit(r.status ?? 1);

// With output: "export" the static site is written to distDir; publish it as out/.
const out = "out";
rmSync(out, { recursive: true, force: true });
cpSync(".next-export", out, { recursive: true, filter: (p) => !/[\/](cache|types|dev)([\/]|$)/.test(p.slice(".next-export".length)) });
const manifest = {
  id: `${base}/`,
  name: "Marginalia",
  short_name: "Marginalia",
  description: "Study from your own sources, with every answer pinned to the passage it came from.",
  start_url: `${base}/`,
  scope: `${base}/`,
  display: "standalone",
  orientation: "any",
  background_color: "#f5f0e6",
  theme_color: "#1e2427",
  categories: ["education", "productivity"],
  icons: [
    ...[48, 72, 96, 128, 144, 152, 192, 256, 384, 512].map((s) => ({ src: `${base}/icons/icon-${s}.png`, sizes: `${s}x${s}`, type: "image/png", purpose: "any" })),
    ...[192, 512].map((s) => ({ src: `${base}/icons/maskable-${s}.png`, sizes: `${s}x${s}`, type: "image/png", purpose: "maskable" })),
  ],
};
writeFileSync(path.join(out, "manifest.webmanifest"), JSON.stringify(manifest, null, 2));

const files = [];
const walk = (dir) => {
  for (const f of readdirSync(dir)) {
    const p = path.join(dir, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (!/\.(map|txt)$/.test(f) && f !== "sw.js") files.push(p);
  }
};
walk(out);
const hash = createHash("sha256");
for (const f of files) hash.update(readFileSync(f));
const version = hash.digest("hex").slice(0, 12);
const urls = files.map((f) => `${base}/` + path.relative(out, f).split(path.sep).join("/").replace(/(^|\/)index\.html$/, "$1"));
const sw = readFileSync("scripts/sw.template.js", "utf8")
  .replace("__VERSION__", version)
  .replace("__BASE__", base)
  .replace('"__FILES__"', JSON.stringify(urls));
writeFileSync(path.join(out, "sw.js"), sw);
console.log(`PWA: ${urls.length} files precached (version ${version}), base "${base || "/"}"`);
