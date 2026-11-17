/**
 * Summaries: one pass for small inputs, map-reduce for whole textbooks (port of backend
 * summarize.py). Passages are numbered globally so [n] citations survive the combining pass.
 */
import { GeminiError, generateJson, patiently } from "./gemini";

/** Pause between map batches so ~180k-token requests stay under the free tier's tokens-per-minute limit. */
export const mapGap = { ms: 60_000 };
const wait = (ms: number) => (ms > 0 ? new Promise<void>((r) => setTimeout(r, ms)) : Promise.resolve());
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

const MAP_BATCH_TOKENS = 180_000;
const SINGLE_PASS_TOKENS = 200_000;

type Numbered = [number, Retrieved][];

const CJK = /[぀-ヿ㐀-䶿一-鿿가-힯豈-﫿]/g;
/** Token estimate for a text: CJK characters (Han, Kana, Hangul) count 1 each, everything else chars/4. */
export function estimateTokens(text: string): number {
  const cjk = text.match(CJK)?.length ?? 0;
  return cjk + Math.ceil((text.length - cjk) / 4);
}
/** The larger of the stored count (chars/4 proxy) and the CJK-aware estimate, so CJK books are not underestimated. */
export const chunkTokens = (r: Retrieved) => Math.max(r.chunk.token_count, estimateTokens(r.chunk.text));
const numberedTokens = (b: Numbered) => b.reduce((n, [, r]) => n + chunkTokens(r), 0);

function batches(ps: Retrieved[]): Numbered[] {
  const out: Numbered[] = [];
  let cur: Numbered = [];
  let size = 0;
  ps.forEach((r, i) => {
    if (cur.length && size + chunkTokens(r) > MAP_BATCH_TOKENS) {
      out.push(cur);
      cur = [];
      size = 0;
    }
    cur.push([i + 1, r]);
    size += chunkTokens(r);
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
  const total = ps.reduce((s, r) => s + chunkTokens(r), 0);
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
      { ctx, tag: "summary", inputTokens: total, thinking: "low" },
    );
    return finish(out, label, 1);
  }

  const groups = batches(ps);
  const notes: string[] = [];
  for (let i = 1; i <= groups.length; i++) {
    if (i > 1) {
      onProgress((i - 1) / (groups.length + 1), "Pausing so the free token limit can reset");
      await wait(mapGap.ms);
    }
    onProgress((i - 1) / (groups.length + 1), `Reading part ${i} of ${groups.length}`);
    const partWords = Math.max(250, Math.floor((words * 2.5) / groups.length));
    // Big books send ~180k tokens per request; wait out per-minute token limits instead of failing.
    const partTokens = numberedTokens(groups[i - 1]);
    const out = await patiently(() =>
      generateJson<Rec>(
        system,
        `Passages:\n\n${numbered(groups[i - 1])}\n\nThese passages are part ${i} of ${groups.length} of the material. ` +
          `Write dense, well-organised notes (about ${partWords} words) on everything important in them, ` +
          "keeping key terms, definitions, data and examples. Cite passages inline as [n] using the numbers " +
          "shown. Put the notes in `body`; `title` names this part's topic." +
          fl,
        SHEET_SCHEMA,
        { ctx, tag: "summary", inputTokens: partTokens, thinking: "low" },
      ),
      2,
      undefined,
      partTokens,
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
      { ctx, tag: "summary", thinking: "low" },
    ),
  );
  return finish(out, label, groups.length);
}

function finish(out: Rec, label: string, parts: number) {
  const body = (out.body || "").trim();
  if (!body) throw new GeminiError("Gemini returned an empty summary. Try again.");
  return { title: out.title || label, body, parts };
}
