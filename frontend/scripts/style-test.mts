/**
 * Static checks that the "Nebula Amber" design (docs/superpowers/specs/2026-11-06-ui-overhaul-design.md)
 * is what the CSS and components actually say:  npx tsx scripts/style-test.mts
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";

const root = path.resolve(import.meta.dirname, "..");
const css = readFileSync(path.join(root, "app/globals.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
let passed = 0;
const check = (label: string, fn: () => void) => {
  fn();
  passed++;
  console.log(`✓ ${label}`);
};

/** The declarations inside the first block whose selector matches exactly. */
function block(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  assert.ok(start >= 0, `no "${selector} {" block in globals.css`);
  const body = css.slice(css.indexOf("{", start) + 1, css.indexOf("}", start));
  return Object.fromEntries(
    body
      .split(";")
      .map((d) => d.trim())
      .filter((d) => d.includes(":"))
      .map((d) => [d.slice(0, d.indexOf(":")).trim(), d.slice(d.indexOf(":") + 1).trim()]),
  );
}

const DARK = {
  "--paper": "#0e1016", "--rail": "#0b0d12", "--card": "#161925", "--sunken": "#1c2030", "--line": "#252a3a",
  "--ink": "#e7e9f2", "--ink-soft": "#c9ccd8", "--muted": "#8a90a6", "--accent": "#f2b13c", "--accent-soft": "#3a2e15",
  "--on-accent": "#0e1016", "--moss": "#4cc38a", "--danger": "#ff6b6b", "--danger-soft": "#3a1c20",
  "--hl-anchor": "#4a3a16", "--hl-anchor-active": "#6b5216", "--hl-focus": "#7a5a10",
};
const LIGHT = {
  "--paper": "#f4f5f8", "--rail": "#eceef3", "--card": "#ffffff", "--sunken": "#e8eaf0", "--line": "#d9dce5",
  "--ink": "#12141c", "--ink-soft": "#2a2e3b", "--muted": "#626a80", "--accent": "#9a6200", "--accent-soft": "#fdf3e1",
  "--on-accent": "#ffffff", "--moss": "#1a7a4c", "--danger": "#c52a2a", "--danger-soft": "#fbe1e1",
  "--hl-anchor": "#fde9b8", "--hl-anchor-active": "#fbd77a", "--hl-focus": "#f9c95c",
};

check("dark is the default palette (on :root)", () => {
  const r = block(":root");
  for (const [k, v] of Object.entries(DARK)) assert.equal(r[k]?.toLowerCase(), v, k);
});

check("light palette lives under :root[data-theme=\"light\"]", () => {
  const r = block(':root[data-theme="light"]');
  for (const [k, v] of Object.entries(LIGHT)) assert.equal(r[k]?.toLowerCase(), v, k);
});

check("the OS colour scheme no longer switches the palette", () => {
  assert.ok(!css.includes("prefers-color-scheme"), "remove the @media (prefers-color-scheme) palette");
});

check("Tailwind radius scale is 4px and on-accent is a colour", () => {
  const t = block("@theme inline");
  for (const k of ["--radius-xs", "--radius-sm", "--radius-md", "--radius-lg", "--radius-xl", "--radius-2xl", "--radius-3xl"])
    assert.equal(t[k], "4px", k);
  assert.equal(t["--color-on-accent"], "var(--on-accent)");
});

check("shared primitives: amber primary, 4px corners, no pills", () => {
  const p = block(".btn-primary");
  assert.equal(p.background, "var(--accent)");
  assert.equal(p.color, "var(--on-accent)");
  for (const sel of [".btn-primary", ".btn-ghost", ".field", ".cite-marker"]) assert.equal(block(sel)["border-radius"], "4px", sel);
  assert.ok(!/border-radius:\s*999px/.test(css), "no 999px pills in globals.css");
});

check("the focus ring is a base style, so utilities like outline-none (text boxes) still win", () => {
  const base = css.indexOf("@layer base");
  assert.ok(base >= 0, "no @layer base block");
  const fv = css.indexOf("button:focus-visible");
  assert.ok(fv > base, "the button/input :focus-visible ring must sit inside @layer base");
});

check("form controls (checkboxes, radios) use the amber accent, not browser blue", () => {
  assert.equal(block(":root")["accent-color"], "var(--accent)");
});

check("the floating-sheet shadow is themed: strong on dark, light on light", () => {
  assert.ok(block(":root")["--shadow-float"], "dark --shadow-float missing");
  assert.ok(block(':root[data-theme="light"]')["--shadow-float"], "light --shadow-float missing");
  assert.notEqual(block(":root")["--shadow-float"], block(':root[data-theme="light"]')["--shadow-float"]);
});

check("headings are weighted and keyboard focus is visible", () => {
  const d = block(".font-display");
  assert.equal(d["font-weight"], "600");
  assert.equal(d["letter-spacing"], "-0.02em");
  assert.match(css, /:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--accent\)/);
});

// Task 3 gates: what tokens can't fix, the components must not contain.
if (process.argv.includes("--components")) {
  const files: string[] = [];
  const walk = (d: string) => {
    for (const f of readdirSync(d, { withFileTypes: true }))
      f.isDirectory() ? walk(path.join(d, f.name)) : f.name.endsWith(".tsx") && files.push(path.join(d, f.name));
  };
  walk(path.join(root, "components"));
  walk(path.join(root, "lib"));
  const src = files.map((f) => [path.relative(root, f), readFileSync(f, "utf8")] as const);
  const offenders = (re: RegExp, allow?: RegExp) =>
    src.flatMap(([f, s]) => s.split("\n").map((l, i) => [f, i + 1, l] as const)).filter(([, , l]) => re.test(l) && !(allow && allow.test(l))).map(([f, n]) => `${f}:${n}`);

  check("no warm hard-coded shadows", () => assert.deepEqual(offenders(/rgba\(40,30,20/), []));
  check("no ink-filled controls (primary actions are amber)", () => assert.deepEqual(offenders(/\bbg-ink\b(?!\/)/), []));
  check("text on fills uses on-accent, not paper", () => assert.deepEqual(offenders(/\btext-paper\b/), []));
  check("no pills: rounded-full only on small dots and progress bars", () =>
    assert.deepEqual(offenders(/\brounded-full\b/, /\b(h-1|h-1\.5|h-2|w-1\.5|w-2)\b|progress|aria-hidden/), []));
  check("eyebrow labels use 11px / 0.12em tracking", () => assert.deepEqual(offenders(/tracking-\[0\.1[3-9]em\]/), []));
  check("small text on tinted chips is full strength (no faded accent text)", () =>
    assert.deepEqual(offenders(/\btext-accent\/\d+/), []));
  check("floating sheets use the themed shadow token, not a fixed black shadow", () =>
    assert.deepEqual(offenders(/shadow-\[[^\]]*rgba\(0,0,0/), []));
  check("no bubbly arbitrary radii (rounded-[…])", () => assert.deepEqual(offenders(/\brounded-\[/), []));
  check("text on coloured fills uses on-accent (white fails on amber/green in dark)", () =>
    assert.deepEqual(offenders(/\b(text-white|bg-white)\b/), []));
  check("cards are flat: no small drop shadows (dialogs may keep shadow-xl)", () =>
    assert.deepEqual(offenders(/\bshadow-(sm|md)\b/), []));
  check("overlays darken with black, not ink (ink is light in dark mode)", () => assert.deepEqual(offenders(/\bbg-ink\/\d+/), []));
}

console.log(`\nALL ${passed} STYLE CHECKS PASSED`);
