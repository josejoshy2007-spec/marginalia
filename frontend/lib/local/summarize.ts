/**
 * Summaries: one pass for small inputs, map-reduce for whole textbooks (port of backend
 * summarize.py). Passages are numbered globally so [n] citations survive the combining pass.
 */
import { GeminiError, generateJson, patiently } from "./gemini";
import { SHEET_SCHEMA, STYLE, focusLine, type Rec } from "./gen";
import { passageBlock, type Retrieved } from "./search";

export const SUMMARY_FORMATS: Record<string, [string, string]> = {
  key_points: ["Key points", "a structured summary: '##' headings per topic with concise bullet points; bold the key terms"],
  cornell: ["Cornell notes", "Cornell notes: for each topic a '## Topic' heading, then '**Cues**' (3–6 short recall questions as a bullet list), then '**Notes**' (bullets answering them); finish with a '## Summary' paragraph of 3–5 sentences"],
  ib_revision: ["IB revision notes", "IB revision notes: for each topic a '## Topic' heading with '**Key terms**' (precise, markscheme-ready definitions), '**Key ideas**' (bullets), '**Exam angles**' (2–3 likely questions using IB command terms with marks in brackets, e.g. 'Explain why … [4]') and '**Common mistakes**'"],
  narrative: ["Narrative", "a flowing prose summary in well-organised paragraphs with a few '##' headings, as a textbook chapter summary would read"],
};
const LENGTHS: Record<string, number> = { brief: 300, standard: 800, detailed: 2000 };
export const SUMMARY_LENGTH: Record<string, string> = { short: "brief", medium: "standard", long: "detailed" };

const MAP_BATCH_TOKENS = 40_000;
const SINGLE_PASS_TOKENS = 60_000;

type Numbered = [number, Retrieved][];

function batches(ps: Retrieved[]): Numbered[] {
  const out: Numbered[] = [];
  let cur: Numbered = [];
  let size = 0;
  ps.forEach((r, i) => {
    if (cur.length && size + r.chunk.token_count > MAP_BATCH_TOKENS) {
      out.push(cur);
      cur = [];
      size = 0;
    }
    cur.push([i + 1, r]);
    size += r.chunk.token_count;
  });
  if (cur.length) out.push(cur);
  return out;
}

const numbered = (b: Numbered) => b.map(([n, r]) => passageBlock(n, r)).join("\n\n");

export async function buildSummary(
  ps: Retrieved[],
  fmt: string,
  length: string,
  focus: string | null | undefined,
  onProgress: (f: number, stage: string) => void,
  ctx: string,
) {
  const [label, what] = SUMMARY_FORMATS[fmt];
  const words = LENGTHS[length] ?? LENGTHS.standard;
  const system = "You summarise study material faithfully and clearly. " + STYLE;
  const total = ps.reduce((s, r) => s + r.chunk.token_count, 0);
  const fl = focusLine(focus);

  if (total <= SINGLE_PASS_TOKENS) {
    onProgress(0.15, "Summarising");
    const out = await generateJson<Rec>(
      system,
      `Passages:\n\n${numbered(ps.map((r, i) => [i + 1, r]))}\n\nWrite ${what}. About ${words} words. ` +
        "Cover the material in proportion to its importance. Cite passages inline as [n] right after the " +
        "claims they support. Put the whole summary in `body` (Markdown); `title` names the material." +
        fl,
      SHEET_SCHEMA,
      { ctx },
    );
    return finish(out, label, 1);
  }

  const groups = batches(ps);
  const notes: string[] = [];
  for (let i = 1; i <= groups.length; i++) {
    onProgress((i - 1) / (groups.length + 1), `Reading part ${i} of ${groups.length}`);
    const partWords = Math.max(250, Math.floor((words * 2.5) / groups.length));
    // Big books send ~40k tokens per request; wait out per-minute token limits instead of failing.
    const out = await patiently(() =>
      generateJson<Rec>(
        system,
        `Passages:\n\n${numbered(groups[i - 1])}\n\nThese passages are part ${i} of ${groups.length} of the material. ` +
          `Write dense, well-organised notes (about ${partWords} words) on everything important in them, ` +
          "keeping key terms, definitions, data and examples. Cite passages inline as [n] using the numbers " +
          "shown. Put the notes in `body`; `title` names this part's topic." +
          fl,
        SHEET_SCHEMA,
        { ctx },
      ),
    );
    notes.push(`### Part ${i}: ${out.title || ""}\n${(out.body || "").trim()}`);
  }
  onProgress(groups.length / (groups.length + 1), "Combining the parts");
  const out = await patiently(() =>
    generateJson<Rec>(
      system,
      "Below are notes on consecutive parts of the material, with citations like [12].\n\n" +
        notes.join("\n\n") +
        `\n\nCombine them into ${what}. About ${words} words. Merge overlapping points, keep the material's ` +
        "order, and keep citation numbers exactly as given (never invent new ones). Put the whole summary in " +
        "`body` (Markdown); `title` names the material." +
        fl,
      SHEET_SCHEMA,
      { ctx },
    ),
  );
  return finish(out, label, groups.length);
}

function finish(out: Rec, label: string, parts: number) {
  const body = (out.body || "").trim();
  if (!body) throw new GeminiError("Gemini returned an empty summary. Try again.");
  return { title: out.title || label, body, parts };
}
