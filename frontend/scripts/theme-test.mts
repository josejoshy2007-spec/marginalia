/**
 * Checks for the Dark/Light switch (lib/theme.ts):  npx tsx scripts/theme-test.mts
 */
import assert from "node:assert/strict";
import { normalizeTheme, THEME_BOOTSTRAP, THEME_KEY } from "../lib/theme";

let passed = 0;
const check = (label: string, fn: () => void) => {
  fn();
  passed++;
  console.log(`✓ ${label}`);
};

/** Run the inline <head> script against a fake browser. */
function boot(getItem: () => string | null) {
  const documentElement = { dataset: {} as Record<string, string> };
  new Function("localStorage", "document", THEME_BOOTSTRAP)({ getItem }, { documentElement });
  return documentElement.dataset.theme;
}

check("only \"light\" means light; anything else is the dark default", () => {
  assert.equal(normalizeTheme("light"), "light");
  assert.equal(normalizeTheme("dark"), "dark");
  assert.equal(normalizeTheme("x"), "dark");
  assert.equal(normalizeTheme(undefined), "dark");
  assert.equal(normalizeTheme(null), "dark");
});

check("the storage key is stable", () => assert.equal(THEME_KEY, "marginalia.theme"));

check("before first paint, a saved light theme is applied", () => assert.equal(boot(() => "light"), "light"));

check("with nothing saved (or dark), the page stays dark", () => {
  assert.equal(boot(() => null), undefined);
  assert.equal(boot(() => "dark"), undefined);
});

check("blocked storage (private mode) never breaks the page", () => {
  assert.equal(
    boot(() => {
      throw new Error("SecurityError");
    }),
    undefined,
  );
});

console.log(`\nALL ${passed} THEME CHECKS PASSED`);
