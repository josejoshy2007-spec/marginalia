/** Original view helpers:  npx tsx scripts/original-test.mts */
import assert from "node:assert/strict";
import { leadingTimestamp, timestampAt, youtubeEmbedUrl, youtubeId } from "../lib/original";

let passed = 0;
const ok = (label: string) => (passed++, console.log(`✓ ${label}`));

assert.equal(leadingTimestamp("(02:05) Hello"), 125);
assert.equal(leadingTimestamp("  (0:07) x"), 7);
assert.equal(leadingTimestamp("(1:02:03) long"), 3723);
ok("mm:ss and h:mm:ss");

assert.equal(leadingTimestamp("Hello (02:05)"), null);
assert.equal(leadingTimestamp("(02:75) bad"), null);
assert.equal(leadingTimestamp(""), null);
ok("only at the start, seconds validated");

const t = "(00:10) first para.\n\n(01:30) second para with more.\n\nNo stamp here.";
assert.equal(timestampAt(t, t.indexOf("(01:30)")), 90);
assert.equal(timestampAt(t, t.indexOf("with more")), 90);
assert.equal(timestampAt(t, 0), 10);
assert.equal(timestampAt("plain text", 3), null);
ok("timestampAt falls back to the paragraph's stamp");

const t2 = "(00:10) alpha one. alpha two.\n\n(01:30) beta one. beta two.\n\n(02:45) gamma one. gamma two.";
assert.equal(timestampAt(t2, t2.indexOf("gamma two")), 165);
assert.equal(timestampAt(t2, t2.indexOf("beta two")), 90);
assert.notEqual(timestampAt(t2, t2.indexOf("gamma one")), 90);
ok("a later paragraph's offset gives that paragraph's stamp");

assert.equal(youtubeId("https://www.youtube.com/watch?v=abcDEF12345"), "abcDEF12345");
assert.equal(youtubeId("https://youtu.be/abcDEF12345"), "abcDEF12345");
assert.equal(youtubeId("https://example.com/watch?v=abcDEF12345"), null);
assert.equal(youtubeEmbedUrl("abc", 61.9), "https://www.youtube-nocookie.com/embed/abc?start=61");
assert.equal(youtubeEmbedUrl("abc"), "https://www.youtube-nocookie.com/embed/abc");
ok("youtube ids and embed urls");

console.log(`\n${passed} groups passed`);
