/**
 * Marking calibration: runs the real markAnswer on items you own and compares with the official mark.
 *   npm run calibrate -- ../calibration
 * Key: GEMINI_API_KEY env var, else backend/.env (never printed). Uses Gemini quota (one call per item).
 */
import "fake-indexeddb/auto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

type Item = {
  course: string;
  level?: string;
  question: string;
  marks: number;
  markscheme_points: (string | { text: string; marks?: number })[];
  student_answer: string;
  official_mark: number;
};

const root = path.resolve(import.meta.dirname, "..");
const dir = path.resolve(process.argv[2] ?? path.join(root, "../calibration"));
if (!existsSync(dir)) throw new Error(`Folder not found: ${dir}`);

let key = process.env.GEMINI_API_KEY?.trim();
if (!key) {
  const envFile = path.join(root, "../backend/.env");
  if (existsSync(envFile)) key = /^GEMINI_API_KEY=(.*)$/m.exec(readFileSync(envFile, "utf8"))?.[1]?.trim();
}
if (!key) throw new Error("Set GEMINI_API_KEY or put it in backend/.env");

const { saveSettings } = await import("../lib/local/settings");
const { markAnswer } = await import("../lib/local/exams");
const { COMMAND_TERMS } = await import("../lib/local/ib");
await saveSettings({ geminiKey: key } as never);

const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
if (!files.length) throw new Error(`No .json files in ${dir}`);

const rows: { ai: number; official: number }[] = [];
for (const file of files) {
  const raw = JSON.parse(readFileSync(path.join(dir, file), "utf8"));
  const items: Item[] = Array.isArray(raw) ? raw : [raw];
  for (const [i, it] of items.entries()) {
    const name = Array.isArray(raw) ? `${file}#${i + 1}` : file;
    try {
      const points = it.markscheme_points.map((p) =>
        typeof p === "string" ? { text: p, marks: 1 } : { text: p.text, marks: p.marks ?? 1 },
      );
      const first = it.question.trim().split(/\s+/)[0]?.replace(/[^A-Za-z]/g, "") ?? "";
      const term = Object.keys(COMMAND_TERMS).find((t) => t.toLowerCase() === first.toLowerCase()) ?? first;
      const question = {
        command_term: term,
        question: it.question,
        marks: it.marks,
        markscheme: { type: "points", points, markbands: [], indicative: [], notes: "" },
      };
      const res = await markAnswer(question, it.student_answer, `IB ${it.course}${it.level ? " " + it.level : ""}`);
      rows.push({ ai: res.marks_awarded, official: it.official_mark });
      console.log(`${name.padEnd(36)} AI ${String(res.marks_awarded).padStart(2)} / official ${String(it.official_mark).padStart(2)} (of ${it.marks})`);
    } catch (e) {
      console.log(`${name.padEnd(36)} FAILED: ${(e as Error).message}`);
    }
  }
}

if (rows.length) {
  const errs = rows.map((r) => Math.abs(r.ai - r.official));
  const mae = errs.reduce((s, x) => s + x, 0) / rows.length;
  const exact = errs.filter((x) => x === 0).length / rows.length;
  console.log(`\n${rows.length} item(s): mean absolute error ${mae.toFixed(2)} marks, exact match ${(exact * 100).toFixed(0)}%`);
}
process.exit(0);
