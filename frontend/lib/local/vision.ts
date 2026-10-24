/**
 * Reading photos of handwritten work with Gemini (port of backend vision.py). Answers are
 * transcribed verbatim, mistakes included, because the text is then marked.
 */
import { GeminiError, generateJson } from "./gemini";
import type { Rec } from "./gen";

const MAX_IMAGES = 6;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

const TEXT_SCHEMA = {
  type: "OBJECT",
  properties: { text: { type: "STRING" }, found: { type: "BOOLEAN" }, marks: { type: "INTEGER" } },
  required: ["text", "found"],
};

const QUIZ_SCHEMA = {
  type: "OBJECT",
  properties: {
    answers: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: { question: { type: "INTEGER" }, choice: { type: "STRING" }, text: { type: "STRING" } },
        required: ["question"],
      },
    },
  },
  required: ["answers"],
};

const READER =
  "You read photos of students' handwritten schoolwork and transcribe them exactly. You never correct, " +
  "improve, complete or summarise what is written.";

export async function blobToBase64(b: Blob): Promise<string> {
  const buf = new Uint8Array(await b.arrayBuffer());
  let s = "";
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(s);
}

async function imageParts(files: Blob[]) {
  if (!files.length) throw new GeminiError("Add at least one photo.");
  if (files.length > MAX_IMAGES) throw new GeminiError(`Up to ${MAX_IMAGES} photos at a time.`);
  return Promise.all(
    files.map(async (f) => {
      if (f.size > MAX_IMAGE_BYTES) throw new GeminiError("Each photo must be under 10 MB.");
      const mime = f.type.startsWith("image/") ? f.type : "image/jpeg";
      return { inlineData: { mimeType: mime, data: await blobToBase64(f) } };
    }),
  );
}

export async function readAnswer(files: Blob[], question?: string) {
  const which = question?.trim()
    ? "The photo(s) may contain answers to several questions. Transcribe only the answer to this " +
      `question:\n<question>\n${question.trim()}\n</question>\nThe student may have copied the question ` +
      "in shorter or different words, or written only a number, so pick the answer whose topic best matches " +
      "it; don't include the question line itself. Set `found` to false only if no answer on the page is " +
      "about this question's topic (then transcribe everything legible)."
    : "Transcribe all of the student's writing. Set `found` to false only if there is no handwriting.";
  const out = await generateJson<Rec>(
    READER,
    "Transcribe the student's handwritten answer from the photo(s), in order across photos.\n" +
      which +
      "\nRules: copy the words exactly as written, keeping spelling mistakes, grammar, abbreviations and " +
      "numbering; keep line breaks and bullet points; leave out text that is clearly crossed out; write " +
      "[illegible] for words you cannot read; write equations and code as plain text. Do not add anything.",
    TEXT_SCHEMA,
    { parts: await imageParts(files) },
  );
  const text = (out.text || "").trim();
  if (!text) throw new GeminiError("Couldn't find any handwriting in that photo. Try a sharper, well-lit photo.");
  return { text, found: out.found !== false };
}

export async function readQuestion(files: Blob[]) {
  const out = await generateJson<Rec>(
    READER,
    "Transcribe the exam question in the photo exactly, including any stem, data or scenario it needs " +
      "and part labels like (a). If the mark value is shown (e.g. [4] or (4 marks)), put the number in " +
      "`marks` and leave it out of `text`. If several questions are shown, transcribe the first complete one.",
    TEXT_SCHEMA,
    { parts: await imageParts(files) },
  );
  const text = (out.text || "").trim();
  if (!text) throw new GeminiError("Couldn't find a question in that photo. Try a sharper, well-lit photo.");
  const m = out.marks;
  return { text, marks: Number.isInteger(m) && m > 0 && m <= 30 ? (m as number) : null };
}

export async function readQuizAnswers(files: Blob[], questions: Rec[]): Promise<(number | string | null)[]> {
  const lines = questions.map((q, i) =>
    (q.type ?? "mcq") === "mcq"
      ? `${i + 1}. multiple choice (letters A–${String.fromCharCode(64 + q.options.length)}): ${q.question}`
      : `${i + 1}. written answer: ${q.question}`,
  );
  const out = await generateJson<Rec>(
    READER,
    "The photo(s) show a student's answers to this quiz:\n" +
      lines.join("\n") +
      "\n\nFor each question they answered, return its number and either the letter they chose (`choice`) or, " +
      "for written questions, their answer transcribed exactly as written (`text`: keep spelling and " +
      "grammar, leave out crossed-out text, [illegible] for unreadable words). Match answers to questions by " +
      "the numbers they wrote; if they changed an answer, use the final one. Skip questions with no answer.",
    QUIZ_SCHEMA,
    { parts: await imageParts(files) },
  );
  const answers: (number | string | null)[] = questions.map((q) => ((q.type ?? "mcq") === "mcq" ? -1 : null));
  for (const a of out.answers ?? []) {
    const qn = a.question;
    if (!Number.isInteger(qn) || qn < 1 || qn > questions.length) continue;
    const q = questions[qn - 1];
    if ((q.type ?? "mcq") === "mcq") {
      const c = String(a.choice ?? "").trim().toUpperCase().slice(0, 1);
      if (c >= "A" && c <= "Z" && c.charCodeAt(0) - 65 < q.options.length) answers[qn - 1] = c.charCodeAt(0) - 65;
    } else if ((a.text ?? "").trim()) answers[qn - 1] = a.text.trim();
  }
  if (answers.every((a) => a === -1 || a === null))
    throw new GeminiError('Couldn\'t read any answers in that photo. Number them like "1 B" or "3. …" and try again.');
  return answers;
}
