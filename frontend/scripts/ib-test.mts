/**
 * IB syllabus focus + prompt rules:  npx tsx scripts/ib-test.mts
 */
import "fake-indexeddb/auto";
import assert from "node:assert/strict";

const { resolveFocus, context, SYLLABUS } = await import("../lib/local/ib");
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
globalThis.fetch = (async (_u: string | URL, init?: RequestInit) => {
  const body = JSON.parse(String(init?.body ?? "{}"));
  sent.push(body.systemInstruction?.parts?.[0]?.text ?? "");
  return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "{}" }] }, finishReason: "STOP" }] }), { status: 200 });
}) as typeof fetch;
const { db } = await import("../lib/local/db");
const { saveSettings } = await import("../lib/local/settings");
await saveSettings({ geminiKey: "test-key" } as never).catch(() => {});
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

console.log(`\n${passed} checks passed`);
process.exit(0);
