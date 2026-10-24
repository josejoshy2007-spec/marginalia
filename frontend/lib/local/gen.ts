/**
 * Study-material generators (port of backend generate.py): recall cards, mixed-type quizzes,
 * study sheets, concept maps and audio-episode scripts. Each sees numbered passages and returns
 * JSON whose `cite` arrays (or inline [n] markers) refer to them.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { GeminiError, generateJson } from "./gemini";
import { passagesPrompt, type Retrieved } from "./search";

export type Rec = Record<string, any>;
type Opts = { ctx?: string };

export const STYLE =
  "Write for a student. Plain text or light Markdown only; never LaTeX or $…$ math " +
  "(write CO₂, x², → with Unicode). Use only facts found in the passages.";

export const CITE = { type: "ARRAY", items: { type: "INTEGER" } };

const DECK_SCHEMA = {
  type: "OBJECT",
  properties: {
    title: { type: "STRING" },
    cards: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: { front: { type: "STRING" }, back: { type: "STRING" }, cite: CITE },
        required: ["front", "back", "cite"],
      },
    },
  },
  required: ["title", "cards"],
};

const QUIZ_SCHEMA = {
  type: "OBJECT",
  properties: {
    title: { type: "STRING" },
    questions: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          type: { type: "STRING", enum: ["mcq", "short", "long"] },
          question: { type: "STRING" },
          options: { type: "ARRAY", items: { type: "STRING" } },
          answer: { type: "INTEGER" },
          accept: { type: "ARRAY", items: { type: "STRING" } },
          marks: { type: "INTEGER" },
          points: {
            type: "ARRAY",
            items: {
              type: "OBJECT",
              properties: { text: { type: "STRING" }, marks: { type: "INTEGER" } },
              required: ["text", "marks"],
            },
          },
          explanation: { type: "STRING" },
          cite: CITE,
        },
        // Every field is required: Gemini drops optional fields, which left MCQs without options.
        required: ["type", "question", "options", "answer", "accept", "marks", "points", "explanation", "cite"],
      },
    },
  },
  required: ["title", "questions"],
};

export const QUIZ_TYPES = ["mcq", "short", "long"] as const;

export const SHEET_SCHEMA = {
  type: "OBJECT",
  properties: { title: { type: "STRING" }, body: { type: "STRING" } },
  required: ["title", "body"],
};

const MAP_SCHEMA = {
  type: "OBJECT",
  properties: {
    title: { type: "STRING" },
    nodes: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          id: { type: "STRING" },
          parent: { type: "STRING" },
          label: { type: "STRING" },
          note: { type: "STRING" },
          cite: CITE,
        },
        required: ["id", "parent", "label", "cite"],
      },
    },
  },
  required: ["title", "nodes"],
};

const EPISODE_SCHEMA = {
  type: "OBJECT",
  properties: {
    title: { type: "STRING" },
    summary: { type: "STRING" },
    lines: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: { speaker: { type: "STRING" }, text: { type: "STRING" }, cite: CITE },
        required: ["speaker", "text", "cite"],
      },
    },
  },
  required: ["title", "lines"],
};

export const SHEETS: Record<string, [string, string]> = {
  study_guide: ["Study guide", "a study guide: the key concepts in a logical order, each explained briefly, followed by a short 'Check yourself' list of questions"],
  briefing: ["Briefing", "a one-page briefing: a 2-sentence overview, then the main points and the most important details or numbers, ending with open questions or caveats in the sources"],
  faq: ["FAQ", "an FAQ of 8–12 questions a student would actually ask, each with a concise answer"],
  timeline: ["Timeline", "a chronological timeline of the events, stages or steps in the sources as a list of '**date or stage** — what happened' lines, then a short note on what the sequence shows"],
  key_terms: ["Key terms", "a glossary of the key terms, each with a one-line definition and, where useful, a short example"],
};

export const EPISODE_FORMATS: Record<string, [string, string[], string]> = {
  conversation: ["Talk-through", ["Maya", "Theo"], "a lively two-host conversation. Maya explains, Theo asks the questions a student would ask, pushes for examples and summarises. Natural, warm, not scripted-sounding"],
  brief: ["Quick brief", ["Maya"], "a single narrator giving a tight briefing of only the most important points"],
  debate: ["Debate", ["Maya", "Theo"], "a respectful debate: Maya argues for the main claims or interpretations in the sources, Theo challenges them using limitations, counterpoints or alternative readings found in the sources; they end by agreeing on what is well supported"],
  lecture: ["Mini-lecture", ["Theo"], "a single lecturer teaching the material step by step, with signposting ('first', 'the key idea is'), one or two worked examples, and a recap"],
};

const EPISODE_LENGTHS: Record<string, number> = { short: 450, medium: 1000, long: 1700 };

export const focusLine = (focus?: string | null) => (focus?.trim() ? `\nFocus especially on: ${focus.trim()}` : "");

export function cleanCites(cites: unknown, n: number): number[] {
  if (!Array.isArray(cites)) return [];
  const s = new Set<number>();
  for (const c of cites) if (typeof c === "number" && c >= 1 && c <= n) s.add(Math.trunc(c));
  return [...s].sort((a, b) => a - b);
}

const str = (x: unknown) => (typeof x === "string" ? x.trim() : "");

export async function buildDeck(ps: Retrieved[], count: number, focus: string | null | undefined, o: Opts) {
  const out = await generateJson<Rec>(
    "You write excellent flashcards for active recall. " + STYLE,
    `Passages:\n\n${passagesPrompt(ps)}\n\nWrite ${count} flashcards from these passages. Fronts are ` +
      "specific questions or prompts (not 'What is X?' for everything; mix definitions, causes, processes, " +
      "comparisons and applications). Backs are short, complete answers (1–3 sentences). One idea per card. " +
      "`cite` lists the passage numbers that support the back." + focusLine(focus),
    DECK_SCHEMA,
    o,
  );
  const cards = (out.cards ?? [])
    .filter((c: Rec) => str(c.front) && str(c.back))
    .map((c: Rec) => ({ front: str(c.front), back: str(c.back), cite: cleanCites(c.cite, ps.length) }));
  if (!cards.length) throw new GeminiError("Gemini didn't produce any cards. Try again or check more sources.");
  return { title: out.title || "Flashcards", cards };
}

export function splitCount(count: number, types: string[]): Record<string, number> {
  const ts = QUIZ_TYPES.filter((t) => types.includes(t));
  const use = ts.length ? ts : (["mcq"] as const);
  const n = Math.max(count, use.length);
  const base = Math.floor(n / use.length);
  const extra = n % use.length;
  return Object.fromEntries(use.map((t, i) => [t, base + (i < extra ? 1 : 0)]));
}

export function cleanQuizQuestion(q: Rec, n: number): Rec | null {
  const kind = (QUIZ_TYPES as readonly string[]).includes(q.type) ? q.type : "mcq";
  const text = str(q.question).replace(/\s*(\[\d+\]|\(\d+\s*marks?\))\s*$/, "");
  if (!text) return null;
  const base = { type: kind, question: text, explanation: str(q.explanation), cite: cleanCites(q.cite, n) };
  if (kind === "mcq") {
    const opts = (q.options ?? []).map((o: unknown) => String(o).trim()).filter(Boolean);
    const ans = q.answer;
    if (opts.length < 2 || !Number.isInteger(ans) || ans < 0 || ans >= opts.length) return null;
    return { ...base, options: opts, answer: ans };
  }
  if (kind === "short") {
    const accept = (q.accept ?? []).map((a: unknown) => String(a).trim()).filter(Boolean).slice(0, 8);
    if (!accept.length) return null;
    return { ...base, accept, marks: 1 };
  }
  const points = (q.points ?? [])
    .filter((p: Rec) => str(p.text))
    .map((p: Rec) => ({ text: str(p.text), marks: Math.max(1, Math.trunc(p.marks || 1)) }));
  if (!points.length) return null;
  const marks =
    Number.isInteger(q.marks) && q.marks > 0 ? q.marks : points.reduce((s: number, p: Rec) => s + p.marks, 0);
  return { ...base, points, marks: Math.min(marks, 10) };
}

export const questionMarks = (q: Rec) =>
  ["mcq", "short"].includes(q.type ?? "mcq") ? 1 : Math.trunc(q.marks || 1);

export async function buildQuiz(
  ps: Retrieved[],
  count: number,
  difficulty: string,
  focus: string | null | undefined,
  types: string[] | undefined,
  o: Opts,
) {
  const level =
    {
      easy: "recall of key facts and definitions",
      medium: "understanding: explain, compare, identify causes and consequences",
      hard: "application and analysis: new scenarios, multi-step reasoning, subtle distinctions",
    }[difficulty] ?? "understanding";
  const split = splitCount(count, types ?? ["mcq"]);
  const wanted: string[] = [];
  if (split.mcq)
    wanted.push(
      `- ${split.mcq} multiple-choice (\`type\` "mcq"): exactly 4 \`options\`, one correct; plausible distractors drawn from related ideas in the passages; vary which index is correct; \`answer\` = 0-based index of the correct option.`,
    );
  if (split.short)
    wanted.push(
      `- ${split.short} short-answer (\`type\` "short"): answerable in a word or short phrase (a term, name, value, or 'X because Y' in under ~10 words). \`accept\` lists the correct answer plus acceptable alternative wordings/synonyms/units.`,
    );
  if (split.long)
    wanted.push(
      `- ${split.long} written-explanation (\`type\` "long"): needs 2–5 sentences (explain/describe/compare/evaluate). \`marks\` 2–6; \`points\` is a markscheme of creditworthy points with their marks (may list more points than marks).`,
    );
  const total = Object.values(split).reduce((a, b) => a + b, 0);
  const out = await generateJson<Rec>(
    "You write rigorous quiz questions for students. " + STYLE,
    `Passages:\n\n${passagesPrompt(ps)}\n\nWrite ${total} questions testing ${level}:\n` +
      wanted.join("\n") +
      "\nFill every field of every question; fields that don't apply to its type are [] or 0 (e.g. a short " +
      "answer has `options` [] and `answer` 0). Mix the types through the quiz rather than grouping them. " +
      "`explanation` says why the answer is right (for mcq, also why the most tempting wrong option is wrong). " +
      "`cite` lists supporting passage numbers." +
      focusLine(focus),
    QUIZ_SCHEMA,
    o,
  );
  const questions = (out.questions ?? []).map((x: Rec) => cleanQuizQuestion(x, ps.length)).filter(Boolean);
  if (!questions.length) throw new GeminiError("Gemini didn't produce usable questions. Try again.");
  return { title: out.title || "Quiz", questions };
}

export async function buildSheet(ps: Retrieved[], subtype: string, focus: string | null | undefined, o: Opts) {
  const [label, what] = SHEETS[subtype];
  const out = await generateJson<Rec>(
    "You turn source material into clear study documents. " + STYLE,
    `Passages:\n\n${passagesPrompt(ps)}\n\nWrite ${what}. Format the \`body\` as Markdown with headings (##), ` +
      "short paragraphs and flat bullet lists. Cite passages inline as [n] right after the claims they support." +
      focusLine(focus),
    SHEET_SCHEMA,
    o,
  );
  const body = str(out.body);
  if (!body) throw new GeminiError("Gemini returned an empty sheet. Try again.");
  return { title: out.title || label, body };
}

export async function buildConceptMap(ps: Retrieved[], focus: string | null | undefined, o: Opts) {
  const out = await generateJson<Rec>(
    "You map how ideas in source material relate. " + STYLE,
    `Passages:\n\n${passagesPrompt(ps)}\n\nBuild a concept tree of the material: one root node ` +
      '(parent = ""), 3–7 main branches, and 2–5 sub-nodes under each where the sources support it ' +
      "(max depth 4, max 45 nodes). Labels are 1–6 words. `note` is one short sentence on how the node " +
      "relates to its parent. Ids are short unique strings. `cite` lists supporting passage numbers." +
      focusLine(focus),
    MAP_SCHEMA,
    o,
  );
  const nodes: Rec[] = out.nodes ?? [];
  const ids = new Set(nodes.map((n) => n.id));
  const clean = nodes
    .filter((n) => n.id && n.label)
    .map((n) => {
      const parent = n.parent || "";
      return {
        id: String(n.id),
        parent: ids.has(parent) && parent !== n.id ? String(parent) : "",
        label: str(n.label),
        note: str(n.note),
        cite: cleanCites(n.cite, ps.length),
      };
    });
  if (!clean.length) throw new GeminiError("Gemini didn't produce a concept map. Try again.");
  const roots = clean.filter((n) => !n.parent);
  for (const r of roots.slice(1)) r.parent = roots[0].id; // keep it one tree
  return { title: out.title || "Concept map", nodes: clean };
}

export async function buildEpisode(
  ps: Retrieved[],
  fmt: string,
  length: string,
  focus: string | null | undefined,
  o: Opts,
) {
  const [label, speakers, style] = EPISODE_FORMATS[fmt];
  const words = EPISODE_LENGTHS[length] ?? EPISODE_LENGTHS.medium;
  const out = await generateJson<Rec>(
    "You write audio scripts that teach. They will be read aloud by text-to-speech, so write for the ear: " +
      "short sentences, no lists, no headings, no Markdown, no stage directions, spell out symbols " +
      "('carbon dioxide', not 'CO2'). Use only facts in the passages.",
    `Passages:\n\n${passagesPrompt(ps)}\n\nWrite ${style}. Speakers: ${speakers.join(" and ")} (use exactly these ` +
      `names in \`speaker\`). About ${words} words in total. Open with a hook, not a greeting to 'listeners'. ` +
      "Each line is one speaker turn of 1–4 sentences. `cite` lists the passage numbers a line draws on " +
      "(empty for pure banter). `summary` is one sentence describing the episode." +
      focusLine(focus),
    EPISODE_SCHEMA,
    o,
  );
  const lines: Rec[] = [];
  for (const ln of out.lines ?? []) {
    const text = str(ln.text).replace(/\[\d+(?:\s*,\s*\d+)*\]/g, "").trim();
    if (!text) continue;
    const speaker = speakers.includes(ln.speaker) ? ln.speaker : speakers[lines.length % speakers.length];
    lines.push({ speaker, text, cite: cleanCites(ln.cite, ps.length) });
  }
  if (!lines.length) throw new GeminiError("Gemini didn't produce an episode script. Try again.");
  return { title: out.title || label, summary: str(out.summary), speakers, lines };
}
