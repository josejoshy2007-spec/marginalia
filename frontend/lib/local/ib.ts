/**
 * IB Diploma conventions added to every generator and the chat when a subject has an IB course
 * (port of backend ib.py). Secondary sources; the subject guide on the IB Programme Resource
 * Centre is the authority.
 */
import type { SubjectRow } from "./db";

/** term -> [objective level 1-3, definition] */
export const COMMAND_TERMS: Record<string, [number, string]> = {
  Classify: [1, "Arrange or order by class or category."],
  Define: [1, "Give the precise meaning of a word, phrase, concept or physical quantity."],
  Draw: [1, "Represent by means of a labelled, accurate diagram or graph."],
  Identify: [1, "Provide an answer from a number of possibilities."],
  Label: [1, "Add labels to a diagram."],
  List: [1, "Give a sequence of brief answers with no explanation."],
  State: [1, "Give a specific name, value or other brief answer without explanation or calculation."],
  Annotate: [2, "Add brief notes to a diagram or graph."],
  Apply: [2, "Use an idea, equation, principle, theory or law in relation to a given problem or issue."],
  Calculate: [2, "Obtain a numerical answer showing the relevant stages in the working."],
  Describe: [2, "Give a detailed account."],
  Distinguish: [2, "Make clear the differences between two or more concepts or items."],
  Estimate: [2, "Obtain an approximate value."],
  Outline: [2, "Give a brief account or summary."],
  Trace: [2, "Follow and record the action of an algorithm."],
  Construct: [2, "Display information in a diagrammatic or logical form."],
  Analyse: [3, "Break down in order to bring out the essential elements or structure."],
  Compare: [3, "Give an account of the similarities between two (or more) items, referring to both (all) of them throughout."],
  "Compare and contrast": [3, "Give an account of similarities and differences between two (or more) items, referring to both (all) of them throughout."],
  Contrast: [3, "Give an account of the differences between two (or more) items, referring to both (all) of them throughout."],
  Deduce: [3, "Reach a conclusion from the information given."],
  Design: [3, "Produce a plan, simulation or model."],
  Determine: [3, "Obtain the only possible answer."],
  Discuss: [3, "Offer a considered and balanced review that includes a range of arguments, factors or hypotheses; opinions or conclusions should be presented clearly and supported by appropriate evidence."],
  Evaluate: [3, "Make an appraisal by weighing up the strengths and limitations."],
  Examine: [3, "Consider an argument or concept in a way that uncovers the assumptions and interrelationships of the issue."],
  Explain: [3, "Give a detailed account including reasons or causes."],
  Justify: [3, "Give valid reasons or evidence to support an answer or conclusion."],
  Predict: [3, "Give an expected result."],
  Suggest: [3, "Propose a solution, hypothesis or other possible answer."],
  "To what extent": [3, "Consider the merits or otherwise of an argument or concept; opinions and conclusions should be presented clearly and supported with appropriate evidence and sound argument."],
};

const LEVEL_NAMES: Record<number, string> = {
  1: "knowledge and understanding",
  2: "application and analysis",
  3: "synthesis and evaluation",
};

export const COURSES = [
  "Biology", "Business Management", "Chemistry", "Computer Science", "Design Technology", "Economics",
  "English A: Language and Literature", "English A: Literature",
  "Environmental Systems and Societies", "Geography", "Global Politics", "History",
  "Mathematics: Analysis and Approaches", "Mathematics: Applications and Interpretation", "Physics",
  "Psychology", "Spanish ab initio", "Spanish B", "Sports, Exercise and Health Science", "Theory of Knowledge",
];

export function courseLabel(subject: SubjectRow | undefined | null): string {
  const course = (subject?.ib_course ?? "").trim();
  if (!course) return "";
  const level = (subject?.ib_level ?? "").trim();
  return `IB ${course}${level ? " " + level : ""}`;
}

export function commandTermsBlock(): string {
  return [1, 2, 3]
    .map((lvl) => {
      const terms = Object.entries(COMMAND_TERMS)
        .filter(([, [lv]]) => lv === lvl)
        .map(([t, [, d]]) => `- ${t}: ${d}`);
      return `Objective ${lvl} (${LEVEL_NAMES[lvl]}):\n${terms.join("\n")}`;
    })
    .join("\n\n");
}

/** System-prompt addendum for a subject with an IB course; "" otherwise. */
export function context(subject: SubjectRow | undefined | null): string {
  const label = courseLabel(subject);
  if (!label) return "";
  return `

The student is studying ${label} in the IB Diploma Programme. Align everything with how the IB teaches and assesses this course:
- Use the course's own terminology and the IB command terms with their official meanings (below). A command term sets the depth: State/Define/List need brief precise answers; Describe/Outline/Distinguish need an account; Explain needs reasons or causes; Discuss/Evaluate/To what extent need a balanced appraisal with a supported conclusion.
- Mark values in square brackets after a question, e.g. [4], indicate how many creditworthy points are expected.
- Prefer precise definitions and key terms exactly as an IB markscheme would credit them, and point out common ways students lose marks.
- Where the sources include exam-style or syllabus content, mirror its structure.

IB command terms:
${commandTermsBlock()}`;
}

export const MARKING_RULES = `You are an experienced IB examiner. Mark exactly as IB examiners do:
- Mark positively: award credit for what is correct; never deduct for errors or omissions. Whole marks only.
- Analytic markschemes: award each listed point (its [n] marks) when the answer conveys it, accepting equivalent wording (OWTTE: "or words to that effect") and valid alternatives not listed if clearly correct. Do not award a point twice. Do not award repetition of the question, or vague answers that don't meet the command term (e.g. a description when "explain" needs reasons).
- Respect the command term: an "explain" point needs the reason/link; a "compare" needs both items referenced; "evaluate/discuss/to what extent" needs weighing and a supported conclusion for the top band.
- Error carried forward (ECF): if a later part correctly uses an earlier wrong value, credit the later method.
- Markbands (extended response): read the whole answer, find the best-fit level descriptor (start low, move up), then place it within the band's range by how securely it meets that level.
- Never award more than the question's total marks.`;
