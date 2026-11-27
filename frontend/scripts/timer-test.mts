/** Practice timer logic:  npx tsx scripts/timer-test.mts */
import assert from "node:assert/strict";
import { createTimer, start, pause, reset, remaining, elapsed, isDone, isLastMinute, formatClock } from "../lib/timer";

let s = createTimer(5);
assert.equal(remaining(s, 1000), 300000);
s = start(s, 1000);
assert.equal(remaining(s, 61000), 240000);
s = pause(s, 61000);
assert.equal(elapsed(s, 999999), 60000, "paused time does not advance");
s = start(s, 100000);
assert.equal(remaining(s, 160000), 180000);
assert.equal(isLastMinute(s, 160000), false);
assert.equal(isLastMinute(s, 100000 + 200000), true);
assert.equal(isDone(s, 100000 + 240000), true);
assert.equal(remaining(s, 9e9), 0);
assert.equal(start(s, 9e9), s, "cannot restart a finished timer");
assert.equal(isDone(reset(s), 9e9), false);
assert.equal(remaining(reset(s), 0), 300000);
assert.equal(isDone(createTimer(0), 0), false);
assert.equal(formatClock(300000), "5:00");
assert.equal(formatClock(59001), "1:00");
assert.equal(formatClock(1), "0:01");
assert.equal(formatClock(0), "0:00");
console.log("ok timer logic");
