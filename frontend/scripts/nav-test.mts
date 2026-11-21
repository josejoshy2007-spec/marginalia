/** Back-stack logic:  npx tsx scripts/nav-test.mts */
import assert from "node:assert/strict";
import { NAV_CAP, canGoBack, createNav, goBack, historyOp, locKey, sanitizeLoc, skipMissing, pushLocation, replaceLocation, type NavLoc } from "../lib/nav-history";

let passed = 0;
const ok = (label: string) => (passed++, console.log(`✓ ${label}`));
const L = (o: Partial<NavLoc> = {}): NavLoc => ({ mode: "library", subjectId: 1, readSourceId: null, askActiveId: null, focus: null, sub: {}, ...o });
const push = (n: ReturnType<typeof createNav<NavLoc>>, l: NavLoc) => pushLocation(n, l, locKey);

let n = createNav<NavLoc>();
assert.equal(canGoBack(n), false);
n = push(n, L());
assert.equal(canGoBack(n), false);
ok("first location is not a back entry");

const same = push(n, L());
assert.equal(same, n);
ok("same location twice is not a navigation");

n = push(n, L({ mode: "ask", askActiveId: "t1" }));
n = push(n, L({ mode: "read", readSourceId: 4, focus: { sourceId: 4, start: 10, end: 20 } }));
assert.equal(n.back.length, 2);
assert.equal(push(n, L({ mode: "read", readSourceId: 4, focus: { sourceId: 4, start: 10, end: 20 } })), n);
ok("citation click pushes once; re-clicking it does not");

n = goBack(n);
assert.deepEqual([n.cur?.mode, n.cur?.askActiveId], ["ask", "t1"]);
ok("Back from Read returns to the same Ask AI conversation");

n = goBack(n);
n = goBack(n);
assert.equal(n.cur?.mode, "library");
assert.equal(canGoBack(n), false);
assert.equal(goBack(n), n);
ok("Back stops at the oldest location");

let m = push(createNav<NavLoc>(), L({ sub: { "practice.tab": "quiz" } }));
m = push(m, L({ sub: { "practice.tab": "quiz", "practice.open": { kind: "quiz", id: 3 } } }));
assert.notEqual(locKey(m.cur!), locKey(m.back[0]));
assert.deepEqual(goBack(m).cur?.sub, { "practice.tab": "quiz" });
ok("sub-views (open artifact) are distinct locations");

assert.equal(locKey(L({ sub: { a: 1, b: 2 } })), locKey(L({ sub: { b: 2, a: 1 } })));
ok("key ignores sub key order");

let c = createNav<NavLoc>();
for (let i = 0; i < NAV_CAP + 30; i++) c = push(c, L({ readSourceId: i }));
assert.equal(c.back.length, NAV_CAP);
assert.equal(c.back[0].readSourceId, 29);
assert.equal(c.cur?.readSourceId, NAV_CAP + 29);
ok("stack is capped, oldest dropped");

const r = replaceLocation(push(createNav<NavLoc>(), L({ subjectId: null })), L({ subjectId: 2 }));
assert.equal(r.back.length, 0);
assert.equal(r.cur?.subjectId, 2);
ok("replace does not grow the stack");

assert.equal(goBack(c, 3).cur?.readSourceId, NAV_CAP + 26);
ok("multi-step back");

let d = createNav<NavLoc>();
for (const id of [1, 2, 3]) d = push(d, L({ subjectId: id, mode: "m" + id }));
d = push(d, L({ subjectId: 3, mode: "x" }));
assert.equal(skipMissing(d, [1, 3]).cur?.mode, "x");
const sk = skipMissing(goBack(d), [1]);
assert.equal(sk.cur?.subjectId, 1);
assert.equal(sk.back.length, 0);
assert.equal(skipMissing(d, []).cur?.subjectId, 1); // all gone: stops at the oldest
ok("Back skips entries of deleted subjects");

const gone = sanitizeLoc(L({ readSourceId: 9, askActiveId: "t9", focus: { sourceId: 9, start: 1, end: 2 } }), { subjectIds: [1], sourceIds: [4], threadIds: ["t1"] });
assert.deepEqual([gone.readSourceId, gone.askActiveId, gone.focus], [null, null, null]);
const kept = sanitizeLoc(L({ readSourceId: 4, askActiveId: "t1", focus: { sourceId: 4, start: 1, end: 2 } }), { subjectIds: [1], sourceIds: [4], threadIds: ["t1"] });
assert.deepEqual([kept.readSourceId, kept.askActiveId, kept.focus?.sourceId], [4, "t1", 4]);
assert.equal(sanitizeLoc(L({ readSourceId: 9 }), { subjectIds: [1] }).readSourceId, 9); // other subject: not loaded, unchecked
ok("missing source/thread ids are dropped");

let h = createNav<NavLoc>();
let entries = 0; // browser entries after the first
for (let i = 0; i < NAV_CAP + 30; i++) {
  const op = historyOp(h);
  h = push(h, L({ readSourceId: i }));
  if (op === "push") entries++;
  assert.equal(entries, h.back.length);
}
assert.equal(historyOp(createNav<NavLoc>()), "replace");
ok("browser entries stay equal to the app stack (first and capped navigations replace)");

console.log(`\n${passed} passed`);
