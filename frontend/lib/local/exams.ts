/**
 * IB-style question sets with markschemes, and examiner-style marking (port of backend exams.py).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { GeminiError, generateJson } from "./gemini";
import { CITE, STYLE, cleanCites, focusLine, questionMarks, type Rec } from "./gen";
import { COMMAND_TERMS, MARKING_RULES, commandTermsBlock } from "./ib";
import { passagesPrompt, type Retrieved } from "./search";

const MARKSCHEME = {
  type: "OBJECT",
  properties: {
    type: { type: "STRING", enum: ["points", "markbands"] },
    points: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: { text: { type: "STRING" }, marks: { type: "INTEGER" } },
        required: ["text", "marks"],
      },
    },
    markbands: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: { marks: { type: "STRING" }, descriptor: { type: "STRING" } },
        required: ["marks", "descriptor"],
      },
    },
    indicative: { type: "ARRAY", items: { type: "STRING" } },
    notes: { type: "STRING" },
  },
  required: ["type"],
};

const EXAM_SCHEMA = {
  type: "OBJECT",
  properties: {
    title: { type: "STRING" },
    questions: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          command_term: { type: "STRING" },
          question: { type: "STRING" },
          marks: { type: "INTEGER" },
          markscheme: MARKSCHEME,
          cite: CITE,
        },
        required: ["command_term", "question", "marks", "markscheme", "cite"],
      },
    },
  },
  required: ["title", "questions"],
};

const MARK_SCHEMA = {
  type: "OBJECT",
  properties: {
    marks_awarded: { type: "INTEGER" },
    points: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: { index: { type: "INTEGER" }, awarded: { type: "INTEGER" }, comment: { type: "STRING" } },
        required: ["index", "awarded", "comment"],
      },
    },
    band: { type: "STRING" },
    strengths: { type: "STRING" },
    improvements: { type: "STRING" },
    model_answer: { type: "STRING" },
  },
  required: ["marks_awarded", "points", "strengths", "improvements", "model_answer"],
};

export const EXAM_SIZES: Record<string, number> = { short: 15, section: 30, paper: 50 };

const EXAMINER = () =>
  "You are an experienced IB senior examiner who writes exam questions and markschemes. " +
  STYLE +
  "\n\n" +
  MARKING_RULES +
  "\n\nIB command terms:\n" +
  commandTermsBlock();

const str = (x: unknown) => (typeof x === "string" ? x.trim() : "");

function knownTerm(term: string): string {
  term = (term || "").trim();
  const hit = Object.keys(COMMAND_TERMS).find((t) => t.toLowerCase() === term.toLowerCase());
  return hit ?? (term ? term[0].toUpperCase() + term.slice(1).toLowerCase() : term);
}

export function cleanQuestion(q: Rec, n: number): Rec | null {
  const marks = q.marks;
  const text = str(q.question);
  const ms = q.markscheme ?? {};
  if (!text || !Number.isInteger(marks) || marks < 1) return null;
  const points = (ms.points ?? [])
    .filter((p: Rec) => str(p.text))
    .map((p: Rec) => ({ text: str(p.text), marks: Math.max(1, Math.trunc(p.marks || 1)) }));
  const bands = (ms.markbands ?? [])
    .filter((b: Rec) => str(b.descriptor))
    .map((b: Rec) => ({ marks: String(b.marks).trim(), descriptor: str(b.descriptor) }));
  const kind = ms.type === "markbands" && bands.length ? "markbands" : "points";
  if (kind === "points" && !points.length) return null;
  const term = knownTerm(q.command_term ?? "");
  return {
    command_term: term,
    objective: COMMAND_TERMS[term]?.[0] ?? 2,
    question: text,
    marks: Math.min(marks, 20),
    markscheme: {
      type: kind,
      points,
      markbands: bands,
      indicative: (ms.indicative ?? []).map((x: unknown) => String(x).trim()).filter(Boolean),
      notes: str(ms.notes),
    },
    cite: cleanCites(q.cite, n),
  };
}

export async function buildExam(
  ps: Retrieved[],
  size: string,
  extended: boolean,
  focus: string | null | undefined,
  courseLabel: string,
  ctx: string,
) {
  const total = EXAM_SIZES[size] ?? EXAM_SIZES.short;
  const who = courseLabel || "an IB Diploma course";
  const extendedRule = extended
    ? "- End with one extended-response item (Discuss/Evaluate/To what extent, 6–9 marks) marked with " +
      'markbands (`type` "markbands": 3–4 bands from low to high, mark ranges like "1–3", descriptors about ' +
      "knowledge, application, balance and a supported conclusion) plus `indicative` content points.\n"
    : "- No extended-response items.\n";
  const out = await generateJson<Rec>(
    EXAMINER(),
    `Passages:\n\n${passagesPrompt(ps)}\n\nWrite an exam-style question set for ${who} worth about ` +
      `${total} marks in total, testing only content in the passages. Build it like a real IB paper section:\n` +
      "- Start with short objective-1 items (State/Define/Identify/List, 1–2 marks), then objective-2/3 " +
      "structured items (Outline/Describe/Explain/Distinguish/Compare/Analyse/Suggest/Trace/Calculate, " +
      "2–6 marks).\n" +
      extendedRule +
      "- Each question begins with its command term, and the number of creditworthy points fits the marks " +
      "(a [3] Explain needs linked reasons, not three facts). Put marks only in `marks`, not in the text.\n" +
      '- Analytic markschemes (`type` "points") list each creditworthy point with its marks; there may be ' +
      'more points than marks ("award [1] for any of…"), and `marks` caps the total. Use `notes` for ' +
      "accept/reject/OWTTE guidance.\n" +
      "- Give a question a short scenario or stem when the IB would, inside `question`.\n" +
      "`cite` lists the passage numbers each question is based on." +
      focusLine(focus),
    EXAM_SCHEMA,
    { ctx },
  );
  const questions = (out.questions ?? []).map((x: Rec) => cleanQuestion(x, ps.length)).filter(Boolean) as Rec[];
  if (!questions.length) throw new GeminiError("Gemini didn't produce usable questions. Try again.");
  return {
    title: out.title || "Exam practice",
    questions,
    total: questions.reduce((s, q) => s + q.marks, 0),
  };
}

export async function draftMarkscheme(
  ps: Retrieved[],
  question: string,
  marks: number,
  courseLabel: string,
  ctx: string,
) {
  const out = await generateJson<Rec>(
    EXAMINER(),
    `Passages:\n\n${passagesPrompt(ps)}\n\nWrite the markscheme for this ${courseLabel || "IB"} ` +
      `question worth [${marks}], using the passages as the content source (accurate general subject ` +
      `knowledge only where they are silent):\n\n<question>\n${question}\n</question>\n\n` +
      "Return a single-item `questions` array: copy the question text, identify its command term, set " +
      `\`marks\` to ${marks}, and use markbands only for an extended Discuss/Evaluate/To-what-extent item.`,
    EXAM_SCHEMA,
    { ctx },
  );
  const qs = (out.questions ?? []).map((x: Rec) => cleanQuestion(x, ps.length)).filter(Boolean) as Rec[];
  if (!qs.length) throw new GeminiError("Couldn't build a markscheme for that question. Try rephrasing it.");
  const q = { ...qs[0], question: question.trim(), marks };
  return { title: question.trim().split("\n")[0].slice(0, 80), questions: [q], total: marks };
}

function schemeText(q: Rec): string {
  const ms = q.markscheme;
  let text: string;
  if (ms.type === "markbands") {
    text = "Markbands:\n" + ms.markbands.map((b: Rec) => `- [${b.marks}] ${b.descriptor}`).join("\n");
    if (ms.indicative?.length)
      text += "\nIndicative content (not exhaustive):\n" + ms.indicative.map((x: string) => `- ${x}`).join("\n");
  } else {
    text =
      "Markscheme points (award each when conveyed):\n" +
      ms.points.map((p: Rec, i: number) => `${i}. ${p.text} [${p.marks}]`).join("\n");
  }
  if (ms.notes) text += `\nNotes: ${ms.notes}`;
  return text;
}

export async function markAnswer(question: Rec, answer: string, courseLabel: string) {
  const term = question.command_term ?? "";
  const out = await generateJson<Rec>(
    MARKING_RULES + "\nGive feedback a student can act on, in the second person, briefly.",
    `Course: ${courseLabel || "IB Diploma"}\nQuestion [${question.marks}]: ${question.question}\n` +
      `Command term: ${term} (${COMMAND_TERMS[term]?.[1] ?? ""})\n\n${schemeText(question)}\n\n` +
      `Student answer:\n<answer>\n${answer.trim()}\n</answer>\n\n` +
      "Mark it. For analytic schemes, return one `points` entry per markscheme point (its index, marks " +
      "awarded from 0 to its value, and a short comment pinpointing what earned or missed it). For markbands, " +
      "set `band` to the chosen band's mark range, set `marks_awarded`, explain the placement in " +
      "`strengths`/`improvements`, and leave `points` empty. `model_answer` is a concise answer that would " +
      "earn full marks.",
    MARK_SCHEMA,
  );
  const max = question.marks;
  const ms = question.markscheme;
  let points: { index: number; awarded: number; comment: string }[] = [];
  let awarded: number;
  if (ms.type === "points") {
    const byIndex = new Map<number, Rec>();
    for (const p of out.points ?? []) if (Number.isInteger(p.index)) byIndex.set(p.index, p);
    points = ms.points.map((p: Rec, i: number) => {
      const got = byIndex.get(i) ?? {};
      return { index: i, awarded: Math.max(0, Math.min(p.marks, Math.trunc(got.awarded || 0))), comment: str(got.comment) };
    });
    awarded = Math.min(max, points.reduce((s, p) => s + p.awarded, 0));
  } else {
    awarded = Math.max(0, Math.min(max, Math.trunc(out.marks_awarded || 0)));
  }
  if (!answer.trim()) {
    awarded = 0;
    points = points.map((p) => ({ ...p, awarded: 0 }));
  }
  return {
    marks_awarded: awarded,
    max_marks: max,
    points,
    band: str(out.band),
    strengths: str(out.strengths),
    improvements: str(out.improvements),
    model_answer: str(out.model_answer),
  };
}

// ---------------------------------------------------------------- mixed-type quiz marking

const QUIZ_MARK_SCHEMA = {
  type: "OBJECT",
  properties: {
    results: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          index: { type: "INTEGER" },
          marks_awarded: { type: "INTEGER" },
          points_awarded: { type: "ARRAY", items: { type: "INTEGER" } },
          comment: { type: "STRING" },
        },
        required: ["index", "marks_awarded", "comment"],
      },
    },
  },
  required: ["results"],
};

const norm = (t: string) =>
  (t || "")
    .toLowerCase()
    .replace(/[^\w\s.%-]/g, " ")
    .replace(/\b(the|a|an)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[ .]+|[ .]+$/g, "");

export type QuizMark = { type: string; marks: number; max: number; correct: boolean; feedback: string; points: number[] };

/** MCQ and exact short answers are marked here; the rest go to Gemini in one request. */
export async function markQuiz(questions: Rec[], answers: unknown[], courseLabel: string): Promise<QuizMark[]> {
  const results: QuizMark[] = [];
  const pending: number[] = [];
  questions.forEach((q, i) => {
    const kind = q.type ?? "mcq";
    const a = answers[i];
    const top = questionMarks(q);
    if (kind === "mcq") {
      const ok = a === q.answer;
      results.push({ type: kind, marks: ok ? 1 : 0, max: 1, correct: ok, feedback: "", points: [] });
      return;
    }
    const text = typeof a === "string" ? a.trim() : "";
    if (!text) {
      results.push({ type: kind, marks: 0, max: top, correct: false, feedback: "No answer given.", points: [] });
      return;
    }
    if (kind === "short" && (q.accept ?? []).some((x: string) => norm(x) === norm(text))) {
      results.push({ type: kind, marks: 1, max: 1, correct: true, feedback: "", points: [] });
      return;
    }
    results.push({ type: kind, marks: 0, max: top, correct: false, feedback: "", points: [] });
    pending.push(i);
  });
  if (!pending.length) return results;

  const items = pending.map((i) => {
    const q = questions[i];
    const a = String(answers[i]).trim();
    if (q.type === "short")
      return `<item index="${i}" type="short" marks="1">\nQuestion: ${q.question}\nAccepted answers: ${q.accept.join(" | ")}\nStudent answer: ${a}\n</item>`;
    const scheme = q.points.map((pt: Rec, j: number) => `${j}. ${pt.text} [${pt.marks}]`).join("\n");
    return `<item index="${i}" type="long" marks="${q.marks}">\nQuestion: ${q.question}\nMarkscheme points:\n${scheme}\nStudent answer: ${a}\n</item>`;
  });
  const out = await generateJson<Rec>(
    MARKING_RULES +
      "\nFor short answers: award the mark if the student's answer means the same as an accepted answer " +
      "(synonyms, equivalent units, minor misspellings that don't change the meaning are fine); a different or " +
      "vaguer concept gets 0. Feedback is one short sentence in the second person.",
    `Course: ${courseLabel || "general"}\nMark each item.\n\n` +
      items.join("\n\n") +
      "\n\nReturn one result per item: its `index`, `marks_awarded`, for long items `points_awarded` (marks " +
      "per markscheme point, in order), and a `comment` saying what earned or missed marks.",
    QUIZ_MARK_SCHEMA,
  );
  const byIndex = new Map<number, Rec>();
  for (const r of out.results ?? []) if (Number.isInteger(r.index)) byIndex.set(r.index, r);
  for (const i of pending) {
    const q = questions[i];
    const res = results[i];
    const got = byIndex.get(i) ?? {};
    let marks: number;
    if (q.type === "long") {
      const raw: unknown[] = got.points_awarded ?? [];
      const pts = q.points.map((pt: Rec, j: number) =>
        Math.max(0, Math.min(pt.marks, Number.isInteger(raw[j]) ? (raw[j] as number) : 0)),
      );
      marks = raw.length
        ? Math.min(res.max, pts.reduce((s: number, x: number) => s + x, 0))
        : Math.max(0, Math.min(res.max, Math.trunc(got.marks_awarded || 0)));
      res.points = pts;
    } else {
      marks = Math.trunc(got.marks_awarded || 0) >= 1 ? 1 : 0;
    }
    res.marks = marks;
    res.correct = marks === res.max;
    res.feedback = str(got.comment);
  }
  return results;
}
