/**
 * End-to-end check of the on-device engine against the real Gemini API, run in Node with an
 * in-memory IndexedDB. Reads GEMINI_API_KEY from backend/.env (never printed).
 *   npx tsx scripts/engine-smoke.mts [--audio] [--only=pdf,chat,quiz]
 */
import "fake-indexeddb/auto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
process.env.NEXT_PUBLIC_BASE_PATH = pathToFileURL(path.join(root, "node_modules/pdfjs-dist/legacy/build")).href;
const key = /^GEMINI_API_KEY=(.*)$/m.exec(readFileSync(path.join(root, "../backend/.env"), "utf8"))?.[1]?.trim();
if (!key) throw new Error("No GEMINI_API_KEY in backend/.env");

const { saveSettings } = await import("../lib/local/settings");
const { localApi: api, streamChat } = await import("../lib/local/store");
const { checkKey } = await import("../lib/local/gemini");

const t0 = Date.now();
const log = (...a: unknown[]) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s]`, ...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(what: string, fn: () => Promise<T | null>, timeoutS = 400): Promise<T> {
  const end = Date.now() + timeoutS * 1000;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await sleep(1500);
  }
}

const TEXT = `Photosynthesis is the process by which green plants, algae and some bacteria convert light energy into chemical energy. It takes place in the chloroplasts, which contain the green pigment chlorophyll.

Chlorophyll absorbs mainly red and blue light and reflects green light, which is why leaves look green. The light-dependent reactions happen in the thylakoid membranes. Water is split (photolysis), releasing oxygen as a by-product, and ATP and NADPH are produced.

The light-independent reactions, also called the Calvin cycle, take place in the stroma. Carbon dioxide is fixed by the enzyme RuBisCO onto ribulose bisphosphate. ATP and NADPH from the light-dependent reactions are used to reduce the fixed carbon to triose phosphate, which is used to make glucose and other organic molecules.

The rate of photosynthesis is limited by light intensity, carbon dioxide concentration and temperature. At low light intensity, light is the limiting factor. Above about 40 °C, enzymes such as RuBisCO begin to denature, so the rate falls sharply.`;

/** A minimal two-page PDF (pdf.js rebuilds the xref table if the offsets are off). */
function tinyPdf(): Blob {
  const page = (txt: string) => `BT /F1 12 Tf 72 720 Td (${txt}) Tj ET`;
  const s1 = page("Cellular respiration releases energy from glucose in the mitochondria.");
  const s2 = page("Aerobic respiration needs oxygen and produces carbon dioxide and water.");
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 5 0 R /Resources << /Font << /F1 7 0 R >> >> >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 6 0 R /Resources << /Font << /F1 7 0 R >> >> >>",
    `<< /Length ${s1.length} >>\nstream\n${s1}\nendstream`,
    `<< /Length ${s2.length} >>\nstream\n${s2}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offs: number[] = [];
  objs.forEach((o, i) => {
    offs.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Blob([out], { type: "application/pdf" });
}

async function ready(subjectId: number, id: number) {
  return until(`source ${id}`, async () => {
    const s = (await api.sources(subjectId)).find((x) => x.id === id)!;
    if (s.status === "failed") throw new Error(`source failed: ${s.error}`);
    return s.status === "ready" ? s : null;
  });
}

async function made(subjectId: number, req: Parameters<typeof api.generate>[1]) {
  const a = await api.generate(subjectId, req);
  return until(`${req.kind}`, async () => {
    const d = await api.artifact(a.id);
    if (d.status === "failed") throw new Error(`${req.kind} failed: ${d.error}`);
    return d.status === "ready" ? d : null;
  }, 600);
}

const failures: string[] = [];
const onlyArg = process.argv.find((a) => a.startsWith("--only="));
const only = onlyArg ? onlyArg.slice(7).split(",") : null;
async function step(name: string, fn: () => Promise<void>) {
  if (only && !only.includes(name)) return;
  try {
    await fn();
  } catch (e) {
    failures.push(name);
    log(`✗ ${name}:`, (e as Error).message);
  }
}

log("key check:", (await checkKey(key)) ?? "ok");
await saveSettings({ geminiKey: key });
const subj = await api.createSubject("Smoke Biology");
await api.patchSubject(subj.id, { ib_course: "Biology", ib_level: "HL" });

const text = await api.addText(subj.id, "Photosynthesis notes", TEXT);
const src = await ready(subj.id, text.id);
log(`✓ text source indexed: ${src.chunk_count} chunk(s)`);

let pdfId = 0;
await step("pdf", async () => {
  const pdf = new File([tinyPdf()], "respiration.pdf", { type: "application/pdf" });
  const p = await api.addPdf(subj.id, pdf);
  const s = await ready(subj.id, p.id);
  const d = await api.source(p.id);
  pdfId = p.id;
  log(`✓ pdf indexed: ${s.page_count} pages, ${s.chunk_count} chunk(s), text: ${JSON.stringify(d.text.slice(0, 60))}…`);
  const ok = d.pages.every((pg) => pg.end <= d.text.length);
  if (!ok) throw new Error("page spans out of range");
});

const ids = (await api.sources(subj.id)).filter((s) => s.status === "ready").map((s) => s.id);

await step("chat", async () => {
  let body = "";
  let cites = 0;
  let err = "";
  await streamChat(subj.id, { message: "Why do leaves look green, and where does the Calvin cycle happen?", source_ids: ids }, (e) => {
    if (e.type === "text") body += e.text;
    if (e.type === "cite") cites++;
    if (e.type === "error") err = e.message;
  });
  if (err) throw new Error(err);
  if (!cites) throw new Error("no citations");
  log(`✓ chat: ${body.length} chars, ${cites} citation(s): ${JSON.stringify(body.slice(0, 100))}…`);
});

await step("deck", async () => {
  const d = await made(subj.id, { kind: "deck", source_ids: ids, count: 5 });
  log(`✓ deck "${d.title}": ${d.cards?.length} cards`);
  const q = await api.reviewQueue(d.id);
  const g = await api.gradeCard(q.cards[0].id, "good");
  log(`  graded good → due ${g.due_at.slice(0, 10)}, next ${JSON.stringify(g.next)}`);
});

await step("quiz", async () => {
  const d = await made(subj.id, { kind: "quiz", source_ids: ids, count: 3, types: ["mcq", "short", "long"] });
  const qs = d.content.questions!;
  log(`✓ quiz "${d.title}": ${qs.map((q) => q.type).join(", ")}`);
  const answers = qs.map((q) => (q.type === "mcq" ? q.answer! : q.type === "short" ? q.accept![0] : "Chlorophyll absorbs red and blue light."));
  const r = await api.submitAttempt(d.id, answers);
  log(`  marked ${r.score}/${r.total}: ${r.results.map((x) => `${x.type} ${x.marks}/${x.max}`).join(", ")}`);
});

await step("exam", async () => {
  const d = await made(subj.id, { kind: "exam", subtype: "short", source_ids: ids, extended: false });
  const qs = d.content.questions as unknown as { command_term: string; marks: number; question: string }[];
  log(`✓ exam "${d.title}": ${qs.map((q) => `${q.command_term} [${q.marks}]`).join(", ")}`);
  const m = await api.markQuestion(d.id, 0, "It is the green pigment in chloroplasts that absorbs light.");
  log(`  marked q1: ${m.marks_awarded}/${m.max_marks}`);
});

await step("summary", async () => {
  const d = await made(subj.id, { kind: "summary", subtype: "cornell", length: "short", source_ids: ids });
  log(`✓ summary "${d.title}": ${d.content.body?.length} chars`);
});

await step("concept map", async () => {
  const d = await made(subj.id, { kind: "sheet", subtype: "concept_map", source_ids: ids });
  log(`✓ concept map: ${d.content.nodes?.length} nodes`);
});

let episodeId = 0;
await step("episode", async () => {
  const d = await made(subj.id, { kind: "episode", subtype: "brief", length: "short", source_ids: ids });
  episodeId = d.id;
  log(`✓ episode "${d.title}": ${d.content.lines?.length} lines`);
});

if (process.argv.includes("--audio") && episodeId)
  await step("studio audio", async () => {
    const a = await api.renderAudio(episodeId);
    log(`✓ studio audio rendered: has_audio=${a.has_audio}`);
  });

await step("custom question", async () => {
  const d = await api.customQuestion(subj.id, {
    question: "Explain why the rate of photosynthesis falls above 40 °C.",
    marks: 3,
    answer: "Because enzymes like RuBisCO denature at high temperature so the rate goes down.",
    source_ids: ids,
  });
  const r = d.marked?.["0"]?.result;
  log(`✓ custom question marked ${r?.marks_awarded}/${r?.max_marks}`);
});

await step("backup round trip", async () => {
  const blob = await api.exportBackup();
  const r = await api.importBackup(blob);
  log(`✓ backup ${Math.round(blob.size / 1024)} KB → imported ${JSON.stringify(r)}`);
});

if (pdfId) await api.deleteSource(pdfId);
log(failures.length ? `FAILED: ${failures.join(", ")}` : "ALL PASSED");
process.exit(failures.length ? 1 : 0);
