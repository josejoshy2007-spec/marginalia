/**
 * IB syllabus focus + prompt rules:  npx tsx scripts/ib-test.mts
 */
import "fake-indexeddb/auto";
import assert from "node:assert/strict";

const { resolveFocus, context, SYLLABUS, PAPER_STYLE, paperStyleSection } = await import("../lib/local/ib");
const { STYLE, SELF_CONTAINED, focusLine } = await import("../lib/local/gen");

let passed = 0;
const ok = (label: string) => (passed++, console.log(`✓ ${label}`));

for (const f of ["A4", "a.4", "A.4", "topic A.4", "physics A4", "torque A4"]) {
  const r = resolveFocus(f, "Physics", "HL");
  assert.equal(r.topic?.code, "A.4", f);
  const extraWords = f === "physics A4" || f === "torque A4";
  assert.equal(r.query.startsWith(extraWords ? `${f}. Rigid body mechanics. torque` : "Rigid body mechanics. torque"), true, f);
  assert.match(r.prompt, /^IB Physics topic A\.4 Rigid body mechanics \(HL only\): covers .*torque/);
  assert.match(r.prompt, /Write only on this topic/);
  assert.equal(r.note, undefined);
}
ok("A4 / a.4 / topic A.4 / physics A4 / torque A4 resolve to A.4 (HL)");

assert.equal(resolveFocus("B.5 circuits", "Physics", "HL").query.startsWith("B.5 circuits. Current and circuits."), true);
assert.equal(resolveFocus("rigid body mechanics", "Physics", "HL").query.startsWith("Rigid body mechanics. "), true);
assert.equal(resolveFocus("A4", "Physics", "HL").query.startsWith("Rigid body mechanics. "), true);
assert.equal(resolveFocus("Calculus: integration by parts", "Mathematics: Analysis and Approaches", "SL").query.startsWith("Calculus: integration by parts. Calculus. "), true);
ok("a focus with the student's own words keeps them at the start of the retrieval query");

assert.equal(resolveFocus("B.5 circuits", "Physics", "HL").topic?.name, "Current and circuits");
assert.equal(resolveFocus("rigid body mechanics", "Physics", "HL").topic?.code, "A.4");
assert.equal(resolveFocus("doppler effect", "Physics", "SL").topic?.code, "C.5");
ok("code + name and plain topic names");

const z = resolveFocus("Z9", "Physics", "HL");
assert.deepEqual([z.query, z.prompt, z.topic], ["Z9", "Z9", undefined]);
assert.equal(resolveFocus("a 4 mark question", "Physics", "HL").topic, undefined);
assert.equal(resolveFocus("A4", "History", "HL").prompt, "A4");
assert.equal(resolveFocus("", "Physics", "HL").prompt, "");
ok("unknown code, prose, other course and empty focus stay unchanged");

const sl = resolveFocus("A4", "Physics", "SL");
assert.ok(sl.topic && sl.note?.includes("HL-only"));
assert.match(sl.prompt, /HL-only content/);
ok("HL-only topic in an SL subject is used, with a note");

assert.equal(resolveFocus("B3", "Computer Science", "HL").topic?.name, "Object-oriented programming");
assert.equal(resolveFocus("topic 5", "Mathematics: Analysis and Approaches", "SL").topic?.name, "Calculus");
assert.equal(resolveFocus("unit 3", "Economics", "SL").topic?.name, "Macroeconomics");
assert.equal(resolveFocus("A4", "Computer Science", "SL").topic?.name, "Machine learning");
ok("CS, Maths AA and Economics codes");

assert.equal(resolveFocus("what is A4 about", "Physics", "HL", { codesOnly: true }).topic?.code, "A.4");
assert.equal(resolveFocus("explain circuits", "Physics", "HL", { codesOnly: true }).topic, undefined);
ok("codesOnly (chat) ignores plain names");

assert.equal(Object.keys(SYLLABUS).length >= 4, true);
assert.equal(SYLLABUS.Physics.length, 24);
const ctx = context({ ib_course: "Physics", ib_level: "HL" } as never);
assert.match(ctx, /A\.4 Rigid body mechanics \(HL only\)/);
assert.match(ctx, /E\.5 Fusion and stars/);
ok("context() lists the course's topics");

assert.match(focusLine(z.prompt), /^\nFocus especially on: Z9/);
assert.equal(focusLine(resolveFocus("A4", "Physics", "HL").prompt).startsWith("\nIB Physics topic A.4"), true);
ok("focusLine uses a resolved focus as written");

assert.match(STYLE, /LaTeX/);
assert.match(STYLE, /\$\$…\$\$/);
assert.doesNotMatch(STYLE, /never LaTeX/i);
assert.match(STYLE, /5 dollars/);
assert.match(SELF_CONTAINED, /Never refer to a figure, diagram, graph, table, page, example or exercise by number/);
ok("STYLE asks for LaTeX; self-contained rule text");

// The rule really reaches the quiz, deck and exam system prompts (captured from the Gemini request).
const sent: string[] = [];
const userPrompts: string[] = [];
globalThis.fetch = (async (_u: string | URL, init?: RequestInit) => {
  const body = JSON.parse(String(init?.body ?? "{}"));
  sent.push(body.systemInstruction?.parts?.[0]?.text ?? "");
  userPrompts.push(JSON.stringify(body.contents ?? ""));
  return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: (globalThis as { __reply?: string }).__reply ?? "{}" }] }, finishReason: "STOP" }] }), { status: 200 });
}) as typeof fetch;
const { db } = await import("../lib/local/db");
const { saveSettings } = await import("../lib/local/settings");
await saveSettings({ geminiKey: "test-key", rpm: 0 } as never).catch(() => {});
const { buildQuiz, buildDeck } = await import("../lib/local/gen");
const { buildExam, draftMarkscheme } = await import("../lib/local/exams");
const ps = [{ chunk: { id: 1, text: "Torque is force times distance.", page_start: 1, ord: 0 }, source: { id: 1, title: "T", kind: "text" }, score: 1 }] as never;
for (const run of [
  () => buildQuiz(ps, 3, "medium", "x", ["mcq"], {}),
  () => buildDeck(ps, 3, "x", {}),
  () => buildExam(ps, "short", false, "x", "IB Physics HL", ""),
  () => draftMarkscheme(ps, "Explain torque.", 3, "IB Physics HL", ""),
]) {
  await run().catch(() => {});
}
const prompts = sent.filter(Boolean);
assert.ok(prompts.length >= 4, `captured ${prompts.length} prompts`);
for (const p of prompts.slice(0, 4)) assert.ok(p.includes("Never refer to a figure"), p.slice(0, 80));
ok(`no-figure rule is in the quiz, deck, exam and markscheme system prompts (${prompts.length} captured)`);


for (const c of ["Physics", "Mathematics: Analysis and Approaches", "Computer Science", "Economics", "English A: Language and Literature", "Spanish ab initio"]) {
  assert.ok(PAPER_STYLE[c] && PAPER_STYLE[c].length > 200, c);
}
ok("PAPER_STYLE exists for each of the student's courses");

const before = userPrompts.length;
await buildExam(ps, "short", false, null, "IB Physics HL", "", { style: "ib", course: "Physics", level: "HL" }).catch(() => {});
await buildExam(ps, "short", false, null, "IB Physics HL", "", { style: "sources", course: "Physics", level: "HL" }).catch(() => {});
await buildExam(ps, "short", false, null, "IB Physics HL", "").catch(() => {});
assert.equal(userPrompts.length - before, 3);
assert.match(userPrompts[before], /Paper style: model the questions on how IB Physics HL papers/);
assert.doesNotMatch(userPrompts[before + 1], /Paper style/);
assert.doesNotMatch(userPrompts[before + 2], /Paper style/);
assert.equal(paperStyleSection("History", "HL"), "");
ok("exam prompt has the paper-style section only when style is 'ib'");

// Params round-trip: stored on the artifact and re-sent by Retry.
const { localApi } = await import("../lib/local/store");
const subj = await localApi.createSubject("Physics");
await localApi.patchSubject(subj.id, { ib_course: "Physics", ib_level: "HL" });
const src = await localApi.addText(subj.id, "Torque", "Torque is force times perpendicular distance. ".repeat(30));
for (let i = 0; i < 100 && (await db.sources.get(src.id))?.status === "processing"; i++) await new Promise((r) => setTimeout(r, 50));
const art = await localApi.generate(subj.id, { kind: "exam", subtype: "short", source_ids: [src.id], style: "ib", extended: false });
assert.equal(art.params.style, "ib");
const waitSettled = async (id: number) => {
  for (let i = 0; i < 100; i++) {
    const a = await localApi.artifact(id);
    if (a.status !== "processing") return a;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("generation did not settle");
};
await waitSettled(art.id);
assert.equal((await localApi.artifact(art.id)).params.style, "ib");
const n = userPrompts.length;
await localApi.retryArtifact(art.id);
await waitSettled(art.id);
assert.match(userPrompts.slice(n).join(" "), /Paper style: model the questions on how IB Physics HL papers/);
assert.equal((await localApi.artifact(art.id)).params.style, "ib");
ok("style round-trips through stored params and Retry");

// ---------------------------------------------------------------- per-course exam profiles
const { examProfile, parseIbLabel, splitMarkLabel, EXAM_PROFILE } = await import("../lib/local/ib");
const { cleanQuestion, markAnswer } = await import("../lib/local/exams");
const MAA = "Mathematics: Analysis and Approaches";
for (const c of [MAA, "Mathematics: Applications and Interpretation", "Physics", "Chemistry", "Biology", "Computer Science", "Economics", "English A: Language and Literature", "Spanish ab initio"])
  assert.ok(EXAM_PROFILE[c], c);
assert.equal(examProfile("History").allowsExtended, true);
assert.equal(examProfile(MAA).allowsExtended, false);
assert.equal(examProfile("Physics").allowsExtended, false);
assert.deepEqual(parseIbLabel("IB Mathematics: Analysis and Approaches HL"), { course: MAA, level: "HL" });
ok("every listed course has a profile; fallback is generic; labels parse");

{
  const base = userPrompts.length;
  await buildExam(ps, "short", true, null, "IB Mathematics: AA HL", "", { style: "ib", course: MAA, level: "HL", calculator: "none" }).catch(() => {});
  const m = userPrompts[base];
  assert.match(m, /M1 \(method\)/);
  assert.match(m, /A1 \(accuracy/);
  assert.match(m, /AG/);
  assert.match(m, /\(FT\)/);
  assert.match(m, /Hence/);
  assert.match(m, /NOT allowed \(Paper 1 style\)/);
  assert.match(m, /Never use markbands/);
  assert.doesNotMatch(m, /End with one extended-response item/);
  assert.doesNotMatch(m, /objective-1 items/);
  assert.match(sent[sent.length - 1], /Mathematics marking \(IB conventions\)/);
  const e0 = userPrompts.length;
  await buildExam(ps, "short", true, null, "IB Economics HL", "", { style: "ib", course: "Economics", level: "HL" }).catch(() => {});
  assert.match(userPrompts[e0], /End with one extended-response item/);
  assert.match(userPrompts[e0], /markbands/);
  assert.doesNotMatch(sent[sent.length - 1], /Mathematics marking/);
  const c0 = userPrompts.length;
  await buildExam(ps, "short", false, null, "IB Mathematics: AA HL", "", { course: MAA, calculator: "allowed" }).catch(() => {});
  assert.match(userPrompts[c0], /Calculator: allowed \(Paper 2 style\)/);
}
ok("Maths AA prompt has M/A guidance, calculator mode, no extended/markband item (even if requested); Economics keeps markbands");

{
  const prof = examProfile(MAA);
  const mk = (term: string, text: string, scheme: object = { type: "points", points: [{ text: "M1 method", marks: 1 }, { text: "AG", marks: 0 }] }) =>
    cleanQuestion({ command_term: term, question: text, marks: 5, markscheme: scheme, cite: [1] }, 1, prof);
  assert.equal(mk("solve", "Solve the equation $x^2=4$.")?.command_term, "Solve");
  assert.equal(mk("Show that", "Show that $x=2$.")?.command_term, "Show that");
  assert.equal(mk("Hence find", "Hence find $y$.")?.command_term, "Hence find");
  assert.equal(mk("", "Hence find the value of $y$.")?.command_term, "Hence find");
  assert.equal(mk("Evaluate", "Evaluate the significance of logs.")?.command_term, "Find");
  assert.equal(mk("Explain", "Explain why $x>0$.")?.command_term, "Explain");
  const q = mk("Find", "Find $x$.", { type: "markbands", markbands: [{ marks: "1-3", descriptor: "d" }], points: [{ text: "A1 x=2", marks: 1 }] });
  assert.equal(q?.markscheme.type, "points");
  assert.equal(q?.objective, 0);
  assert.equal(mk("Find", "Find $x$.")?.markscheme.points[1].marks, 0);
  const eco = cleanQuestion({ command_term: "evaluate", question: "Evaluate the policy.", marks: 10, markscheme: { type: "markbands", markbands: [{ marks: "1-3", descriptor: "d" }], points: [] }, cite: [1] }, 1, examProfile("Economics"));
  assert.equal(eco?.markscheme.type, "markbands");
  assert.equal(eco?.objective, 3);
  assert.deepEqual(splitMarkLabel("M1 (FT) set up"), { label: "M1 (FT)", rest: "set up" });
  assert.deepEqual(splitMarkLabel("AG"), { label: "AG", rest: "" });
  assert.equal(splitMarkLabel("Method for x").label, "");
}
ok("maths command terms stay Solve/Show that/Hence (not Explain/Evaluate); markbands coerced to M/A points; Economics unchanged; M/A label split");

{
  const b = sent.length;
  await markAnswer({ command_term: "Find", marks: 3, question: "Find x.", markscheme: { type: "points", points: [{ text: "M1 method", marks: 1 }, { text: "A1 x=2", marks: 1 }] } }, "x=2", "IB Mathematics: AA HL", MAA).catch(() => {});
  assert.match(sent[b], /follow-through/i);
  assert.match(sent[b], /Award M1 for a correct method even if an arithmetic slip/);
  const b2 = sent.length;
  await markAnswer({ command_term: "Explain", marks: 3, question: "Explain.", markscheme: { type: "points", points: [{ text: "reason", marks: 3 }] } }, "x", "IB Economics HL", "Economics").catch(() => {});
  assert.doesNotMatch(sent[b2], /Mathematics marking/);
}
ok("markAnswer uses M/A rules for maths only");

{
  const subjM = await localApi.createSubject("Maths");
  await localApi.patchSubject(subjM.id, { ib_course: MAA, ib_level: "HL" });
  const srcM = await localApi.addText(subjM.id, "Logs", "A logarithm is the inverse of an exponential. ".repeat(30));
  for (let i = 0; i < 100 && (await db.sources.get(srcM.id))?.status === "processing"; i++) await new Promise((r) => setTimeout(r, 50));
  const a = await localApi.generate(subjM.id, { kind: "exam", subtype: "short", source_ids: [srcM.id], style: "ib", extended: true, calculator: "none" });
  assert.equal(a.params.calculator, "none");
  await waitSettled(a.id);
  assert.equal((await localApi.artifact(a.id)).params.calculator, "none");
  const k = userPrompts.length;
  await localApi.retryArtifact(a.id);
  await waitSettled(a.id);
  assert.match(userPrompts.slice(k).join(" "), /NOT allowed \(Paper 1 style\)/);
  assert.equal((await localApi.artifact(a.id)).params.calculator, "none");
}
ok("calculator param round-trips through stored params and Retry");

// ---------------------------------------------------------------- per-subject paper styles
const { examPaper, hasPaperChoice, paperTotal, sizeLabel, paperMarkingRules } = await import("../lib/local/ib");
const { splitFences } = await import("../lib/exam-text");
const g = globalThis as { __reply?: string };
const promptOf = async (course: string, label: string, opts: Record<string, unknown>, size = "short") => {
  const i = userPrompts.length;
  await buildExam(ps, size, false, null, label, "", { style: "ib", course, level: "HL", ...opts }).catch(() => {});
  return userPrompts[i] ?? "";
};

for (const c of ["Physics", "Computer Science", "Economics", "English A: Language and Literature", "Spanish ab initio"]) {
  assert.ok(hasPaperChoice(examProfile(c)), c);
  for (const p of examProfile(c).papers!) assert.ok(p.rules.length > 200 && p.tag && p.hint, `${c} ${p.id}`);
}
assert.equal(hasPaperChoice(examProfile(MAA)), false);
assert.equal(hasPaperChoice(examProfile("History")), false);
ok("papers exist for the five courses with several paper styles; maths and other courses have none");

{
  const p1 = await promptOf("Physics", "IB Physics HL", { paper: "p1" });
  const p2 = await promptOf("Physics", "IB Physics HL", { paper: "p2" });
  assert.match(p1, /multiple-choice/);
  assert.match(p1, /four options/);
  assert.match(p2, /context stem/);
  assert.match(p2, /\(a\), \(b\), \(c\)/);
  for (const m of [p1, p2]) {
    assert.match(m, /substitution, the answer with its unit and a sensible number of significant figures/);
    assert.match(m, /ECF/);
    assert.match(m, /linked physics\s+reasoning/);
    assert.match(m, /small Markdown table/);
    assert.match(m, /Never use markbands/);
    assert.doesNotMatch(m, /Paper style: model the questions/);
  }
  assert.doesNotMatch(p1, /context stem inside/);
  assert.match(sent[sent.length - 1], /Never refer to a figure/);
}
ok("Physics HL: Paper 1 (MCQ + data items) and Paper 2 (structured, context stem) rules; substitution/unit/s.f., ECF, linked reasoning, data in words or tables, no markbands");

{
  const th = await promptOf("Computer Science", "IB Computer Science HL", { paper: "theory" });
  assert.match(th, /Paper 1 style \(theory\)/);
  assert.match(th, /Identify\/State \[1-2\]/);
  assert.match(th, /extended\s+Discuss \/ Evaluate \/ To what extent item of 8 marks with markbands/);
  const pj = await promptOf("Computer Science", "IB Computer Science HL", { paper: "programming", language: "java" });
  assert.match(pj, /Trace: give a short algorithm in a fenced code block/);
  assert.match(pj, /Identify the output/);
  assert.match(pj, /Construct an algorithm \/ Write code/);
  assert.match(pj, /Programming language: Java\./);
  assert.match(pj, /```java/);
  assert.match(pj, /no essays and no markbands/);
  const py = await promptOf("Computer Science", "IB Computer Science HL", { paper: "programming", language: "python" });
  assert.match(py, /Programming language: Python 3\./);
  assert.doesNotMatch(th, /Programming language:/);
  // Code marking rules reach the marker.
  const b = sent.length;
  g.__reply = JSON.stringify({ marks_awarded: 0, points: [], strengths: "", improvements: "", model_answer: "" });
  await markAnswer({ command_term: "Construct", marks: 4, paper: "programming", question: "Construct a loop.", markscheme: { type: "points", points: [{ text: "loop bounds", marks: 2 }, { text: "output", marks: 2 }] } }, "for i in range(3) print(i)", "IB Computer Science HL", "Computer Science");
  assert.match(sent[b], /one mark per correct construct/);
  assert.match(sent[b], /loop bounds, condition, assignment, return or output/);
  assert.match(sent[b], /Accept any working equivalent/);
  assert.match(sent[b], /Ignore small\s+syntax slips/);
  const b2 = sent.length;
  await markAnswer({ command_term: "Explain", marks: 3, paper: "theory", question: "Explain.", markscheme: { type: "points", points: [{ text: "x", marks: 3 }] } }, "x", "IB Computer Science HL", "Computer Science");
  assert.doesNotMatch(sent[b2], /Programming marking/);
  g.__reply = undefined;
}
ok("CS HL: theory (mark splits + markband Discuss) vs programming (trace, output, construct; Java/Python; code marking rules per construct, equivalents, syntax slips)");

{
  assert.deepEqual(splitFences("Trace this:\n```python\nx = 1\nprint(x)\n```\nWhat is printed?").map((p) => [p.code, p.lang]), [[false, ""], [true, "python"], [false, ""]]);
  assert.equal(splitFences("```java\nint a;\n```")[0].text, "int a;");
  assert.equal(splitFences("no code").length, 1);
  assert.equal(splitFences("a\n```\nunclosed")[1].code, true);
}
ok("fenced code blocks are split out of question text for monospaced rendering");

{
  const p1 = await promptOf("Economics", "IB Economics SL", { paper: "p1", level: "SL" });
  assert.match(p1, /TWO items on the same theme/);
  assert.match(p1, /Item \(a\), 10 marks/);
  assert.match(p1, /Item \(b\), 15 marks/);
  assert.match(p1, /real-world examples/);
  assert.match(p1, /definitions of key terms, an accurate\s+diagram/);
  assert.match(p1, /described in words: axes, curves, the shift, the new equilibrium/);
  assert.match(p1, /made of 1 question of 25 marks each/);
  const p2 = await promptOf("Economics", "IB Economics SL", { paper: "p2", level: "SL" }, "section");
  assert.match(p2, /Fictional extract, written for this practice question/);
  assert.match(p2, /Define \.\.\.\S* a key term/);
  assert.match(p2, /Calculate \.\.\.\S* \[2\].*Show your working/);
  assert.match(p2, /Draw and explain/);
  assert.match(p2, /Using\s+information from the text\/data and your knowledge of economics, evaluate \.\.\.\S* \[15\]/);
  assert.match(p2, /made of 2 data sets of 23 marks each \(about 46 marks/);
  assert.match(p2, /must say it is fictional/);
  assert.equal(paperTotal("paper", examPaper(examProfile("Economics"), "p1")), 75);
  assert.equal(sizeLabel("short", examPaper(examProfile("Economics"), "p2")), "1 data set (23)");
  assert.equal(sizeLabel("short"), "~15 marks");
  // The stem is forced to say it is fictional, and later items inherit the extract for marking.
  const eco = examProfile("Economics");
  const paper = examPaper(eco, "p2")!;
  const cq = cleanQuestion({ command_term: "Define", question: "Define inflation.", marks: 2, cite: [1], stem: "Prices rose in Freedonia.", markscheme: { type: "points", points: [{ text: "x", marks: 2 }] } }, 1, eco, { paper });
  assert.match(cq!.stem, /^Fictional extract, written for this practice question/);
  assert.equal(cq!.paper, "p2");
  g.__reply = JSON.stringify({ title: "t", questions: [
    { command_term: "Define", question: "Define GDP.", marks: 2, cite: [1], stem: "Fictional extract: Freedonia grew.", markscheme: { type: "points", points: [{ text: "x", marks: 2 }] } },
    { command_term: "Calculate", question: "Calculate growth. Show your working.", marks: 2, cite: [1], stem: "", markscheme: { type: "points", points: [{ text: "x", marks: 2 }] } },
  ] });
  const built = await buildExam(ps, "short", true, null, "IB Economics SL", "", { style: "ib", course: "Economics", level: "SL", paper: "p2" });
  assert.equal(built.questions[1].stem, built.questions[0].stem);
  assert.match(built.questions[0].stem, /Fictional/);
  g.__reply = undefined;
}
ok("Economics: Paper 1 (a)[10]+(b)[15] markbands with described diagrams; Paper 2 data response with a labelled-fictional stem, Define/Calculate/Draw/Evaluate; size labels and stem sharing");

{
  const eng = examProfile("English A: Language and Literature");
  const e1 = await promptOf("English A: Language and Literature", "IB English A: Language and Literature SL", { paper: "p1", level: "SL" });
  for (const t of ["A \\(Understanding & interpretation, 5\\)", "B \\(Analysis & evaluation, 5\\)", "C \\(Focus & organisation, 5\\)", "D \\(Language, 5\\)"]) assert.match(e1, new RegExp(t));
  assert.match(e1, /never recall items/);
  assert.match(e1, /quoted word for word from one passage/);
  assert.match(e1, /How does the writer/);
  const e2 = await promptOf("English A: Language and Literature", "IB English A: Language and Literature SL", { paper: "p2", level: "SL" });
  assert.match(e2, /comparative essay/);
  assert.match(e2, /Knowledge, understanding & interpretation, 10/);
  // Criteria are canonical whatever the model returns, and the task is out of their sum.
  const paper = examPaper(eng, "p1")!;
  const cq = cleanQuestion({ command_term: "analyse", question: "How does the writer persuade?", marks: 3, cite: [1], stem: "An excerpt.", markscheme: { type: "criteria", criteria: [{ code: "a", descriptors: [{ marks: "1-2", descriptor: "limited" }] }], points: [] } }, 1, eng, { paper });
  assert.equal(cq!.marks, 20);
  assert.equal(cq!.markscheme.type, "criteria");
  assert.deepEqual(cq!.markscheme.criteria.map((c: { code: string; max: number }) => [c.code, c.max]), [["A", 5], ["B", 5], ["C", 5], ["D", 5]]);
  assert.equal(cq!.markscheme.criteria[0].descriptors.length, 1);
  assert.equal(cq!.command_term, "Analyse");
  // Marking: per-criterion marks, capped, summed.
  const b = sent.length;
  g.__reply = JSON.stringify({ marks_awarded: 99, points: [], criteria: [
    { code: "A", awarded: 4, band: "4", comment: "secure", next: "more on tone" },
    { code: "B", awarded: 9, band: "5", comment: "x", next: "" },
    { code: "C", awarded: 3, comment: "y" },
  ], strengths: "s", improvements: "i", model_answer: "m" });
  const r = await markAnswer(cq!, "The writer uses ...", "IB English A: Language and Literature SL", "English A: Language and Literature");
  assert.match(sent[b], /criterion-marked, not point-marked/);
  assert.match(userPrompts[userPrompts.length - 1], /Return one `criteria` entry per criterion/);
  assert.match(userPrompts[userPrompts.length - 1], /Criterion A Understanding & interpretation \[0-5\]/);
  assert.deepEqual(r.criteria.map((c) => [c.code, c.awarded, c.max]), [["A", 4, 5], ["B", 5, 5], ["C", 3, 5], ["D", 0, 5]]);
  assert.equal(r.marks_awarded, 12);
  assert.equal(r.max_marks, 20);
  assert.equal(r.criteria[0].next, "more on tone");
  assert.deepEqual(r.mistakes, []);
  const blank = await markAnswer(cq!, "  ", "IB English", "English A: Language and Literature");
  assert.equal(blank.marks_awarded, 0);
  assert.ok(blank.criteria.every((c) => c.awarded === 0));
  g.__reply = undefined;
}
ok("English A: Paper 1 criteria A-D (5 each) and Paper 2 criteria; excerpt + guiding question; criteria forced canonical; per-criterion marking capped and summed");

{
  const sw = await promptOf("Spanish ab initio", "IB Spanish ab initio SL", { paper: "writing", level: "SL" });
  assert.match(sw, /Write EVERYTHING the student reads in simple Spanish/);
  assert.match(sw, /Write the questions, instructions and bullet points in SPANISH/);
  assert.match(sw, /entre 70 y 150 palabras/);
  assert.match(sw, /A Language \(12\), B Message \(12\), C Conceptual understanding \(6\)/);
  assert.match(sw, /`gloss`/);
  const sr = await promptOf("Spanish ab initio", "IB Spanish ab initio SL", { paper: "reading", level: "SL" });
  assert.match(sr, /SPANISH/);
  assert.match(sr, /verdadero o falso/);
  assert.match(sr, /Relaciona/);
  assert.match(sr, /¿Qué palabra del texto significa/);
  assert.match(sr, /YOU WRITE for this task/);
  const spa = examProfile("Spanish ab initio");
  const paper = examPaper(spa, "writing")!;
  const cq = cleanQuestion({ command_term: "Escribe", question: "Escribe un correo a tu amigo.", marks: 30, cite: [1], gloss: "Write an email to your friend.", markscheme: { type: "criteria", criteria: [], points: [] } }, 1, spa, { paper });
  assert.equal(cq!.command_term, "Escribe");
  assert.equal(cq!.gloss, "Write an email to your friend.");
  assert.equal(cq!.marks, 30);
  assert.deepEqual(cq!.markscheme.criteria.map((c: { code: string }) => c.code), ["A", "B", "C"]);
  const b = sent.length;
  g.__reply = JSON.stringify({ marks_awarded: 0, points: [], criteria: [{ code: "A", awarded: 7, band: "7-8", comment: "ok" }, { code: "B", awarded: 8, comment: "ok" }, { code: "C", awarded: 4, comment: "ok" }], mistakes: [{ text: "yo soy 15 años", correction: "tengo 15 años", note: "age uses tener" }, { text: "", correction: "x" }], strengths: "", improvements: "", model_answer: "" });
  const r = await markAnswer(cq!, "Hola, yo soy 15 años.", "IB Spanish ab initio SL", "Spanish ab initio");
  assert.match(sent[b], /A Language \(vocabulary, grammar, accuracy, range at ab initio level\)/);
  assert.match(userPrompts[userPrompts.length - 1], /List the language mistakes in `mistakes`/);
  assert.equal(r.marks_awarded, 19);
  assert.equal(r.max_marks, 30);
  assert.deepEqual(r.mistakes, [{ text: "yo soy 15 años", correction: "tengo 15 años", note: "age uses tener" }]);
  const b2 = sent.length;
  await markAnswer({ command_term: "Indica", marks: 2, paper: "reading", question: "¿Verdadero o falso?", markscheme: { type: "points", points: [{ text: "Falso", marks: 1 }, { text: "porque ...", marks: 1 }] } }, "falso", "IB Spanish", "Spanish ab initio");
  assert.match(sent[b2], /Accept minor\s+spelling, accent and grammar slips/);
  g.__reply = undefined;
}
ok("Spanish ab initio: writing (Spanish instructions + English gloss, 70-150 words, criteria A-C, mistakes list) and reading (text written for the task, T/F, matching, which word)");

{
  // Old results (no criteria / mistakes / paper / stem) still read back and render defaults.
  const sj = await localApi.createSubject("Old");
  const art = await db.artifacts.add({
    subject_id: sj.id, kind: "exam", subtype: "short", title: "Old exam", params: { style: "ib" } as never,
    content: { questions: [{ command_term: "Explain", objective: 2, question: "Explain x.", marks: 3, markscheme: { type: "points", points: [{ text: "a", marks: 3 }], markbands: [], indicative: [], notes: "" }, cite: [] }] },
    passages: [], status: "ready", error: null, created_at: new Date().toISOString(),
  } as never) as number;
  await db.attempts.add({ quiz_id: art, answers: [{ q: 0, answer: "ans", result: { marks_awarded: 2, max_marks: 3, points: [{ index: 0, awarded: 2, comment: "c" }], band: "", strengths: "", improvements: "", model_answer: "" } }], score: 2, total: 3, created_at: new Date().toISOString() } as never);
  const d = await localApi.artifact(art);
  const res = d.marked!["0"].result!;
  assert.equal(res.marks_awarded, 2);
  assert.equal((res.criteria ?? []).length, 0);
  assert.equal((res.mistakes ?? []).length, 0);
  assert.equal((d.content.questions![0] as { paper?: string }).paper, undefined);
  assert.equal(paperMarkingRules(examProfile("Physics"), undefined), "");
  const fresh = await markAnswer({ command_term: "Explain", marks: 2, question: "Explain.", markscheme: { type: "points", points: [{ text: "a", marks: 2 }] } }, "x", "IB Physics", "Physics");
  assert.deepEqual([fresh.criteria, fresh.mistakes], [[], []]);
}
ok("old exam results without criteria, mistakes or paper still read back; point questions return empty criteria");

{
  const sjp = await localApi.createSubject("Econ");
  await localApi.patchSubject(sjp.id, { ib_course: "Economics", ib_level: "SL" });
  const srcp = await localApi.addText(sjp.id, "Markets", "Demand and supply set the price in a market. ".repeat(30));
  for (let i = 0; i < 100 && (await db.sources.get(srcp.id))?.status === "processing"; i++) await new Promise((r) => setTimeout(r, 50));
  const a = await localApi.generate(sjp.id, { kind: "exam", subtype: "short", source_ids: [srcp.id], style: "ib", paper: "p2" });
  assert.equal(a.params.paper, "p2");
  await waitSettled(a.id);
  assert.equal((await localApi.artifact(a.id)).params.paper, "p2");
  const k = userPrompts.length;
  await localApi.retryArtifact(a.id);
  await waitSettled(a.id);
  assert.match(userPrompts.slice(k).join(" "), /Paper 2 style \(data response\)/);
  assert.equal((await localApi.artifact(a.id)).params.paper, "p2");
  // CS: paper + language round-trip.
  const sjc = await localApi.createSubject("CS");
  await localApi.patchSubject(sjc.id, { ib_course: "Computer Science", ib_level: "HL" });
  const srcc = await localApi.addText(sjc.id, "Loops", "A loop repeats a block of code while a condition holds. ".repeat(30));
  for (let i = 0; i < 100 && (await db.sources.get(srcc.id))?.status === "processing"; i++) await new Promise((r) => setTimeout(r, 50));
  const c = await localApi.generate(sjc.id, { kind: "exam", subtype: "short", source_ids: [srcc.id], style: "ib", paper: "programming", language: "java" });
  assert.deepEqual([c.params.paper, c.params.language], ["programming", "java"]);
  await waitSettled(c.id);
  const k2 = userPrompts.length;
  await localApi.retryArtifact(c.id);
  await waitSettled(c.id);
  assert.match(userPrompts.slice(k2).join(" "), /Programming language: Java\./);
  const after = await localApi.artifact(c.id);
  assert.deepEqual([after.params.paper, after.params.language], ["programming", "java"]);
}
ok("paper and language params round-trip through stored params and Retry");

// "Mark my question" with no paper: the typed marks stand and the course's general marking style applies.
{
  const reply = { questions: [{ command_term: "Explain", question: "Q", marks: 3, markscheme: { type: "points", points: [{ text: "a", marks: 3 }], markbands: [], indicative: [], notes: "" }, cite: [] }] };
  (globalThis as { __reply?: string }).__reply = JSON.stringify(reply);
  const custom = async (course: string, level: "SL" | "HL", text: string, marks: number, paper?: string) => {
    const sj = await localApi.createSubject(course);
    await localApi.patchSubject(sj.id, { ib_course: course, ib_level: level });
    const sc = await localApi.addText(sj.id, "Notes", (text + " ").repeat(30));
    for (let i = 0; i < 100 && (await db.sources.get(sc.id))?.status === "processing"; i++) await new Promise((r) => setTimeout(r, 50));
    const b = sent.length;
    const made = await localApi.customQuestion(sj.id, { question: "Explain: " + text, marks, answer: "", source_ids: [sc.id], ...(paper ? { paper } : {}) });
    const q = (made.content.questions as Array<{ marks: number; paper?: string }>)[0];
    return { q, system: sent[b] ?? "", user: userPrompts[b] ?? "" };
  };
  const eng = await custom("English A: Language and Literature", "SL", "The writer uses imagery to persuade readers.", 5);
  assert.equal(eng.q.marks, 5, "English A with no paper keeps the typed marks");
  assert.equal(eng.q.paper, undefined);
  assert.doesNotMatch(eng.user, /Criterion A/);
  const maths = await custom(MAA, "HL", "A logarithm is the inverse of an exponential.", 7);
  assert.equal(maths.q.marks, 7);
  assert.match(maths.system, /Award M1 for a correct method/, "course marking style applies without a paper");
  assert.equal(maths.q.paper, undefined);
  const phys = await custom("Physics", "HL", "Torque is force times perpendicular distance.", 4);
  assert.equal(phys.q.marks, 4);
  assert.doesNotMatch(phys.user, /multiple choice/i);
  // A criterion-marked paper still replaces the typed marks.
  const crit = await custom("English A: Language and Literature", "SL", "The writer uses imagery to persuade readers.", 5, "p1");
  assert.notEqual(crit.q.marks, 5, "a criterion paper uses the criteria total");
  (globalThis as { __reply?: string }).__reply = undefined;
}
ok("custom question with no paper keeps typed marks and uses the course's marking style; criterion papers still set the total");

console.log(`\n${passed} checks passed`);
process.exit(0);
