/**
 * IB-style question sets with markschemes, and examiner-style marking (port of backend exams.py).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { GeminiError, generateJson } from "./gemini";
import { CITE, SELF_CONTAINED, STYLE, cleanCites, focusLine, questionMarks, type Rec } from "./gen";
import {
  COMMAND_TERMS,
  EXAM_MARKS,
  GENERIC_EXAM_PROFILE,
  MARKING_RULES,
  MATHS_TERMS,
  commandTermsBlock,
  examPaper,
  examProfile,
  examProfileRules,
  markingStyleRules,
  normaliseTerm,
  paperMarkingRules,
  paperStyleSection,
  paperTotal,
  UNIT_COUNT,
  type Calculator,
  type CodeLanguage,
  type ExamPaper,
  type ExamProfile,
} from "./ib";
import { passagesPrompt, type Retrieved } from "./search";

const MARKSCHEME = {
  type: "OBJECT",
  properties: {
    type: { type: "STRING", enum: ["points", "markbands", "criteria"] },
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
    // Criterion-marked tasks (English, Spanish writing): the band descriptors of each criterion.
    criteria: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          code: { type: "STRING" },
          descriptors: {
            type: "ARRAY",
            items: {
              type: "OBJECT",
              properties: { marks: { type: "STRING" }, descriptor: { type: "STRING" } },
              required: ["marks", "descriptor"],
            },
          },
        },
        required: ["code", "descriptors"],
      },
    },
    indicative: { type: "ARRAY", items: { type: "STRING" } },
    notes: { type: "STRING" },
  },
  required: ["type"],
};

/** The question-set schema; papers with a shared text or English glosses require those fields (Gemini drops optional ones). */
function examSchema(paper?: ExamPaper) {
  const required = ["command_term", "question", "marks", "markscheme", "cite"];
  const properties: Record<string, unknown> = {
    command_term: { type: "STRING" },
    question: { type: "STRING" },
    marks: { type: "INTEGER" },
    markscheme: MARKSCHEME,
    cite: CITE,
  };
  if (paper?.stem) {
    properties.stem = { type: "STRING" };
    required.push("stem");
  }
  if (paper?.glossed) {
    properties.gloss = { type: "STRING" };
    required.push("gloss");
  }
  return {
    type: "OBJECT",
    properties: {
      title: { type: "STRING" },
      questions: { type: "ARRAY", items: { type: "OBJECT", properties, required } },
    },
    required: ["title", "questions"],
  };
}
const EXAM_SCHEMA = examSchema();

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
    // Criterion-marked tasks: one entry per criterion.
    criteria: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          code: { type: "STRING" },
          awarded: { type: "INTEGER" },
          band: { type: "STRING" },
          comment: { type: "STRING" },
          next: { type: "STRING" },
        },
        required: ["code", "awarded", "comment"],
      },
    },
    // Spanish writing: the language mistakes with corrections.
    mistakes: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: { text: { type: "STRING" }, correction: { type: "STRING" }, note: { type: "STRING" } },
        required: ["text", "correction"],
      },
    },
    band: { type: "STRING" },
    strengths: { type: "STRING" },
    improvements: { type: "STRING" },
    model_answer: { type: "STRING" },
  },
  required: ["marks_awarded", "points", "strengths", "improvements", "model_answer"],
};

export const EXAM_SIZES: Record<string, number> = EXAM_MARKS;

const termDefs = (profile: ExamProfile) =>
  profile.commandTerms.map((t) => `- ${t}: ${COMMAND_TERMS[t]?.[1] ?? MATHS_TERMS[t] ?? ""}`).join("\n");

const EXAMINER = (profile: ExamProfile = GENERIC_EXAM_PROFILE) =>
  "You are an experienced IB senior examiner who writes exam questions and markschemes. " +
  STYLE +
  SELF_CONTAINED +
  " Markers cannot see diagrams the student drew: judge only what the answer says in words, numbers and equations, and never expect a sketch you cannot see." +
  "\n\n" +
  MARKING_RULES +
  (profile.markingStyle === "maths"
    ? markingStyleRules(profile) + "\n\nInstruction words:\n" + termDefs(profile)
    : "\n\nIB command terms:\n" + commandTermsBlock());

const str = (x: unknown) => (typeof x === "string" ? x.trim() : "");

function knownTerm(term: string): string {
  term = (term || "").trim();
  const hit = Object.keys(COMMAND_TERMS).find((t) => t.toLowerCase() === term.toLowerCase());
  return hit ?? (term ? term[0].toUpperCase() + term.slice(1).toLowerCase() : term);
}

export function cleanQuestion(
  q: Rec,
  n: number,
  profile: ExamProfile = GENERIC_EXAM_PROFILE,
  opts: { paper?: ExamPaper } = {},
): Rec | null {
  const maths = profile.markingStyle === "maths";
  const paper = opts.paper;
  const criteria = paper?.criteria;
  const marks = q.marks;
  const text = str(q.question);
  const ms = q.markscheme ?? {};
  if (!text || !Number.isInteger(marks) || marks < 1) return null;
  const points = (ms.points ?? [])
    .filter((p: Rec) => str(p.text))
    // Maths markschemes have AG lines worth 0.
    .map((p: Rec) => ({ text: str(p.text), marks: Math.max(maths ? 0 : 1, Math.trunc(Number.isFinite(p.marks) ? p.marks : 1)) }));
  const bands = (ms.markbands ?? [])
    .filter((b: Rec) => str(b.descriptor))
    .map((b: Rec) => ({ marks: String(b.marks).trim(), descriptor: str(b.descriptor) }));
  const allowsExtended = paper ? paper.allowsExtended : profile.allowsExtended;
  const kind = criteria ? "criteria" : ms.type === "markbands" && bands.length && allowsExtended ? "markbands" : "points";
  if (kind === "points" && !points.length) return null;
  // Criterion-marked tasks always carry the course's own criteria and maxima; the model supplies the band descriptors.
  const criteriaOut = criteria
    ? criteria.map((c) => {
        const raw = (ms.criteria ?? []).find((x: Rec) => str(x.code).toUpperCase() === c.code) ?? {};
        const descriptors = (raw.descriptors ?? [])
          .filter((d: Rec) => str(d.descriptor))
          .map((d: Rec) => ({ marks: String(d.marks).trim(), descriptor: str(d.descriptor) }));
        return { code: c.code, name: c.name, max: c.max, descriptors };
      })
    : [];
  let term: string;
  if (profile === GENERIC_EXAM_PROFILE) term = knownTerm(q.command_term ?? "");
  else term = normaliseTerm(q.command_term ?? "", text, profile) || (maths ? "Find" : knownTerm(q.command_term ?? ""));
  let stem = paper?.stem ? str(q.stem) : "";
  if (stem && paper?.stem?.fictional && !/fictional|ficticio/i.test(stem))
    stem = "Fictional extract, written for this practice question.\n\n" + stem;
  return {
    command_term: term,
    objective: profile.objectiveLabels ? (COMMAND_TERMS[term]?.[0] ?? 2) : 0,
    question: text,
    // A criterion-marked task is always out of the sum of its criteria.
    marks: criteria ? criteria.reduce((s, c) => s + c.max, 0) : Math.min(marks, 20),
    ...(paper ? { paper: paper.id } : {}),
    ...(stem ? { stem } : {}),
    ...(paper?.glossed && str(q.gloss) ? { gloss: str(q.gloss) } : {}),
    markscheme: {
      type: kind,
      points,
      markbands: bands,
      criteria: criteriaOut,
      indicative: (ms.indicative ?? []).map((x: unknown) => String(x).trim()).filter(Boolean),
      notes: str(ms.notes),
    },
    cite: cleanCites(q.cite, n),
  };
}

/** Items of a paper that share a text (`stem`) inherit it from the first item of their unit, so each can be marked on its own. */
function shareStems(questions: Rec[], paper?: ExamPaper): Rec[] {
  if (!paper?.stem?.shared) return questions;
  let cur = "";
  return questions.map((q) => {
    if (q.stem) cur = q.stem;
    else if (cur) return { ...q, stem: cur };
    return q;
  });
}

export async function buildExam(
  ps: Retrieved[],
  size: string,
  extended: boolean,
  focus: string | null | undefined,
  courseLabel: string,
  ctx: string,
  opts: {
    style?: string;
    course?: string | null;
    level?: string | null;
    calculator?: Calculator | null;
    paper?: string | null;
    language?: CodeLanguage | null;
  } = {},
) {
  const profile = examProfile(opts.course);
  const maths = profile.markingStyle === "maths";
  const paper = examPaper(profile, opts.paper);
  extended = extended && (paper ? paper.allowsExtended : profile.allowsExtended);
  // A chosen paper replaces the general "Like IB papers" section: its rules are the style.
  const styleSection = opts.style === "ib" && !paper ? paperStyleSection(opts.course, opts.level) : "";
  const total = paperTotal(size, paper);
  const who = courseLabel || "an IB Diploma course";
  const extendedRule = extended
    ? "- End with one extended-response item (Discuss/Evaluate/To what extent, 6–9 marks) marked with " +
      'markbands (`type` "markbands": 3–4 bands from low to high, mark ranges like "1–3", descriptors about ' +
      "knowledge, application, balance and a supported conclusion) plus `indicative` content points.\n"
    : "- No extended-response items.\n";
  const structure = paper
    ? "- Each question begins with its command term (or, for Spanish, its Spanish instruction verb). Put the total marks only in `marks`; " +
      "parts of a structured item may show their own marks in brackets.\n" +
      '- `type` "points" markschemes list each creditworthy point with its marks (`marks` caps the total); use `notes` for accept/reject/OWTTE guidance.\n'
    : maths
      ? "- Start with short Section A style items (1–7 marks), then longer multi-part Section B style items.\n" +
        "- Each question begins with its instruction word (Find, Solve, Show that, ...). Put marks only in `marks`, not in the text.\n"
      : "- Start with short objective-1 items (State/Define/Identify/List, 1–2 marks), then objective-2/3 " +
        "structured items (Outline/Describe/Explain/Distinguish/Compare/Analyse/Suggest/Trace/Calculate, " +
        "2–6 marks).\n" +
        extendedRule +
        "- Each question begins with its command term, and the number of creditworthy points fits the marks " +
        "(a [3] Explain needs linked reasons, not three facts). Put marks only in `marks`, not in the text.\n" +
        '- Analytic markschemes (`type` "points") list each creditworthy point with its marks; there may be ' +
        'more points than marks ("award [1] for any of…"), and `marks` caps the total. Use `notes` for ' +
        "accept/reject/OWTTE guidance.\n" +
        "- Give a question a short scenario or stem when the IB would, inside `question`.\n";
  const size_ = paper?.unit
    ? `made of ${UNIT_COUNT[size] ?? 1} ${paper.unit.name}${(UNIT_COUNT[size] ?? 1) > 1 ? "s" : ""} of ${paper.unit.marks} marks each (about ${total} marks in total)`
    : `worth about ${total} marks in total`;
  const out = await generateJson<Rec>(
    EXAMINER(profile),
    `Passages:\n\n${passagesPrompt(ps)}\n\nWrite an exam-style question set for ${who} ${size_}, testing only content in the passages. Build it like a real IB paper section:\n` +
      structure +
      "`cite` lists the passage numbers each question is based on." +
      examProfileRules(profile, { calculator: opts.calculator, paper: paper?.id, language: opts.language }) +
      styleSection +
      focusLine(focus),
    examSchema(paper),
    { ctx, tag: "exam" },
  );
  const questions = shareStems(
    (out.questions ?? []).map((x: Rec) => cleanQuestion(x, ps.length, profile, { paper })).filter(Boolean) as Rec[],
    paper,
  );
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
  opts: { course?: string | null; calculator?: Calculator | null; paper?: string | null } = {},
) {
  const profile = examProfile(opts.course);
  const maths = profile.markingStyle === "maths";
  const paper = examPaper(profile, opts.paper);
  // A criterion-marked task is out of the sum of its criteria, whatever marks were typed.
  if (paper?.criteria) marks = paper.criteria.reduce((s, c) => s + c.max, 0);
  const out = await generateJson<Rec>(
    EXAMINER(profile),
    `Passages:\n\n${passagesPrompt(ps)}\n\nWrite the markscheme for this ${courseLabel || "IB"} ` +
      `question worth [${marks}], using the passages as the content source (accurate general subject ` +
      `knowledge only where they are silent):\n\n<question>\n${question}\n</question>\n\n` +
      "Return a single-item `questions` array: copy the question text, identify its command term, set " +
      `\`marks\` to ${marks}, and ` +
      (paper?.criteria
        ? 'write the markscheme as `type` "criteria" with band descriptors for each criterion (and `indicative` content); `points` stays empty.'
        : maths
          ? "write the markscheme as M1/A1/R1/AG lines (lines sum to the marks; AG is 0), never markbands."
          : (paper ? paper.allowsExtended : profile.allowsExtended)
            ? "use markbands only for an extended Discuss/Evaluate/To-what-extent item."
            : "use an analytic points markscheme (no markbands).") +
      examProfileRules(profile, { calculator: opts.calculator }) +
      paperMarkingRules(profile, paper?.id),
    EXAM_SCHEMA,
    { ctx, geminiOnly: true, tag: "markscheme", thinking: "medium" },
  );
  const qs = (out.questions ?? []).map((x: Rec) => cleanQuestion(x, ps.length, profile, { paper })).filter(Boolean) as Rec[];
  if (!qs.length) throw new GeminiError("Couldn't build a markscheme for that question. Try rephrasing it.");
  const q = { ...qs[0], question: question.trim(), marks };
  return { title: question.trim().split("\n")[0].slice(0, 80), questions: [q], total: marks };
}

function schemeText(q: Rec): string {
  const ms = q.markscheme;
  let text: string;
  if (ms.type === "criteria") {
    text =
      "Criteria (mark each separately, best-fit band):\n" +
      (ms.criteria ?? [])
        .map(
          (c: Rec) =>
            `Criterion ${c.code} ${c.name} [0-${c.max}]` +
            (c.descriptors?.length ? ":\n" + c.descriptors.map((d: Rec) => `  - [${d.marks}] ${d.descriptor}`).join("\n") : ""),
        )
        .join("\n");
    if (ms.indicative?.length)
      text += "\nIndicative content (possible, not required):\n" + ms.indicative.map((x: string) => `- ${x}`).join("\n");
  } else if (ms.type === "markbands") {
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

export async function markAnswer(question: Rec, answer: string, courseLabel: string, course?: string | null) {
  const term = question.command_term ?? "";
  const profile = examProfile(course);
  const maths = profile.markingStyle === "maths";
  const ms = question.markscheme;
  const criteria = ms.type === "criteria";
  const paper = examPaper(profile, question.paper);
  const out = await generateJson<Rec>(
    MARKING_RULES +
      markingStyleRules(profile) +
      paperMarkingRules(profile, question.paper) +
      "\nYou cannot see diagrams or sketches: never expect one in an answer; judge what the words, numbers and equations say.\nGive feedback a student can act on, in the second person, briefly.",
    `Course: ${courseLabel || "IB Diploma"}\n` +
      (paper ? `Paper: ${paper.tag}\n` : "") +
      (question.stem ? `Text the question refers to:\n<text>\n${question.stem}\n</text>\n` : "") +
      `Question [${question.marks}]: ${question.question}\n` +
      `Command term: ${term} (${COMMAND_TERMS[term]?.[1] ?? MATHS_TERMS[term] ?? ""})\n\n${schemeText(question)}\n\n` +
      `Student answer:\n<answer>\n${answer.trim()}\n</answer>\n\n` +
      (criteria
        ? "Mark it by criteria. Return one `criteria` entry per criterion (its `code`, the marks `awarded` from 0 to its maximum, the `band` " +
          "range you placed it in, a short `comment` saying why, and `next`: what would reach the next band). Leave `points` empty and set " +
          "`marks_awarded` to the sum. " +
          (paper?.id === "writing" ? "List the language mistakes in `mistakes` (the student's words, the corrected Spanish, a short English note). " : "") +
          "`strengths` and `improvements` summarise the whole answer. `model_answer` is a concise model that would earn top marks"
        : "Mark it. For analytic schemes, return one `points` entry per markscheme point (its index, marks " +
          "awarded from 0 to its value, and a short comment pinpointing what earned or missed it" +
          (maths ? ", referring to the line's label, e.g. \"M1 earned: correct substitution\"" : "") + "). For markbands, " +
          "set `band` to the chosen band's mark range, set `marks_awarded`, explain the placement in " +
          "`strengths`/`improvements`, and leave `points` empty. `model_answer` is a concise answer that would " +
          "earn full marks") +
      ".",
    MARK_SCHEMA,
    { geminiOnly: true, tag: "exam-mark", thinking: "medium" },
  );
  const max = question.marks;
  let points: { index: number; awarded: number; comment: string }[] = [];
  let crit: { code: string; name: string; awarded: number; max: number; band: string; comment: string; next: string }[] = [];
  let awarded: number;
  if (ms.type === "points") {
    const byIndex = new Map<number, Rec>();
    for (const p of out.points ?? []) if (Number.isInteger(p.index)) byIndex.set(p.index, p);
    points = ms.points.map((p: Rec, i: number) => {
      const got = byIndex.get(i) ?? {};
      return { index: i, awarded: Math.max(0, Math.min(p.marks, Math.trunc(got.awarded || 0))), comment: str(got.comment) };
    });
    awarded = Math.min(max, points.reduce((s, p) => s + p.awarded, 0));
  } else if (criteria) {
    // Each criterion is capped at its own maximum; the total is their sum.
    crit = (ms.criteria ?? []).map((c: Rec) => {
      const got = (out.criteria ?? []).find((x: Rec) => str(x.code).toUpperCase() === c.code) ?? {};
      return {
        code: c.code,
        name: c.name,
        awarded: Math.max(0, Math.min(c.max, Math.trunc(got.awarded || 0))),
        max: c.max,
        band: str(got.band),
        comment: str(got.comment),
        next: str(got.next),
      };
    });
    awarded = Math.min(max, crit.reduce((s, c) => s + c.awarded, 0));
  } else {
    awarded = Math.max(0, Math.min(max, Math.trunc(out.marks_awarded || 0)));
  }
  if (!answer.trim()) {
    awarded = 0;
    points = points.map((p) => ({ ...p, awarded: 0 }));
    crit = crit.map((c) => ({ ...c, awarded: 0 }));
  }
  const mistakes = ((out.mistakes ?? []) as Rec[])
    .filter((m) => str(m.text) && str(m.correction))
    .slice(0, 8)
    .map((m) => ({ text: str(m.text), correction: str(m.correction), note: str(m.note) }));
  return {
    marks_awarded: awarded,
    max_marks: max,
    points,
    // Per-criterion marks (English, Spanish writing); empty for point- and band-marked questions.
    criteria: crit,
    mistakes,
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

export type QuizMark = { type: string; marks: number; max: number; correct: boolean; feedback: string; points: number[]; pending?: boolean; error?: string };

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
  let out: Rec;
  try {
    out = await generateJson<Rec>(
    MARKING_RULES +
      "\nYou cannot see diagrams or sketches: never expect one in an answer; judge what the words, numbers and equations say." +
      "\nFor short answers: award the mark if the student's answer means the same as an accepted answer " +
      "(synonyms, equivalent units, minor misspellings that don't change the meaning are fine); a different or " +
      "vaguer concept gets 0. Feedback is one short sentence in the second person.",
    `Course: ${courseLabel || "general"}\nMark each item.\n\n` +
      items.join("\n\n") +
      "\n\nReturn one result per item: its `index`, `marks_awarded`, for long items `points_awarded` (marks " +
      "per markscheme point, in order), and a `comment` saying what earned or missed marks.",
    QUIZ_MARK_SCHEMA,
    { geminiOnly: true, tag: "quiz-mark", thinking: "low" },
    );
  } catch (e) {
    // Keep the locally marked results; flag the AI-marked ones so the UI can retry just those.
    const error = e instanceof Error ? e.message : "Couldn't reach the marker.";
    for (const i of pending) Object.assign(results[i], { pending: true, error });
    return results;
  }
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
