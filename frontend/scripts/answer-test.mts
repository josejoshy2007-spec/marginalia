/**
 * AI-answer rendering (maths + Markdown), with the kind of answer that showed raw LaTeX before:
 *   npx tsx scripts/answer-test.mts
 */
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as AB from "../components/AnswerBody";
const AnswerBody = ((AB as any).default?.default ?? AB.default) as typeof AB.default;

const cites = [1, 2, 3, 4, 5].map((n) => ({ source_id: 1, chunk_id: n, source_title: "Physics", page: n, cited_text: "x" }));
const html = (body: string, streaming = false) =>
  renderToStaticMarkup(createElement(AnswerBody, { body, citations: cites as never, onCite: () => {}, streaming, variant: "chat" }));
/** Visible text only: KaTeX's MathML/annotation copy of the source is fine, raw $ in the text isn't. */
const visible = (h: string) => h.replace(/<annotation[\s\S]*?<\/annotation>/g, "").replace(/<[^>]+>/g, "");

const ANSWER = String.raw`Here is a breakdown of the **A1 Kinematics** formulas.

---

### 1. Fundamental Quantities
* **Distance vs. Displacement**: displacement ($\Delta s$) is a vector ⟦1⟧.
* **Speed vs. Velocity**:
  * **Average velocity**: ($v = \frac{\Delta s}{\Delta t}$) ⟦3⟧⟦2⟧.
  * **Instantaneous velocity** ($v = \lim_{\Delta t \to 0} \frac{\Delta s}{\Delta t}$).

When velocity is constant, use: $$\text{s} = \text{s}_\text{i} + vt$$ ⟦1⟧

> **IB Exam Warning**: only when velocity is constant ⟦1⟧.

$$
v^2 = u^2 + 2as
$$

| Symbol | Meaning |
|---|---|
| $u$ | initial velocity |

It costs $5 and $10 to print.`;

let passed = 0;
const check = (label: string, fn: () => void) => {
  fn();
  passed++;
  console.log(`✓ ${label}`);
};

const out = html(ANSWER);
check("inline and display maths render with KaTeX (fractions are real fractions)", () => {
  assert.ok(out.includes('class="katex"'), "no KaTeX output");
  assert.ok(out.includes("mfrac"), "fractions not rendered");
  assert.ok((out.match(/class="math-display"/g) ?? []).length >= 2, "display maths ($$…$$ inline and multi-line) not rendered");
});
check("no raw LaTeX is left in the visible text", () => {
  const v = visible(out);
  for (const bad of ["$\\", "\\frac", "\\Delta", "$$", "\\text{"]) assert.ok(!v.includes(bad), `raw "${bad}" visible`);
});
check("maths inside bold and inside table cells renders too", () => {
  assert.match(out, /<strong[^>]*>Average velocity<\/strong>/);
  assert.match(out, /<td[^>]*><span><span class="katex">/);
});
check("--- is a rule, > is a callout, ### is a heading, indented bullets nest", () => {
  assert.ok(out.includes("<hr"));
  assert.ok(out.includes("border-l-2 border-accent"));
  assert.ok(!visible(out).includes("###") && !visible(out).includes("&gt; "));
  assert.match(out, /<ul[^>]*>(?:(?!<\/ul>)[\s\S])*<ul/);
});
check("citation chips still work", () => assert.equal((out.match(/class="cite-marker"/g) ?? []).length, 5));
check("dollar amounts are not mistaken for maths", () => assert.ok(visible(out).includes("It costs $5 and $10 to print.")));
check("half-streamed maths shows as text instead of breaking", () => {
  const partial = html("The speed is $$v = \\frac{d}{", true);
  assert.ok(visible(partial).includes("$$v = \\frac{d}{"));
  assert.ok(html("so $x = 3").includes("so $x = 3"));
});

check("MathText renders inline maths as KaTeX and leaves dollar amounts alone", () => {
  const MathText = ((AB as any).MathText ?? (AB as any).default?.MathText) as typeof AB.MathText;
  const MathBlock = ((AB as any).MathBlock ?? (AB as any).default?.MathBlock) as typeof AB.MathBlock;
  const m = renderToStaticMarkup(createElement(MathText, { text: "Slope is $\\frac{a}{b}$ and it costs $5 and $10." }));
  assert.ok(m.includes('class="katex"') && m.includes("mfrac"), "no KaTeX fraction");
  assert.ok(!visible(m).includes("\\frac"), "raw LaTeX visible");
  assert.ok(visible(m).includes("costs $5 and $10."));
  const b = renderToStaticMarkup(createElement(MathBlock, { text: "Use $$x^2$$\n\n- $y$" }));
  assert.ok(b.includes("math-display") && b.includes("<li"));
});

console.log(`\nALL ${passed} ANSWER CHECKS PASSED`);
