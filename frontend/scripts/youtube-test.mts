/** Offline checks of the YouTube caption parsing (lib/local/youtube.ts):  npx tsx scripts/youtube-test.mts */
import assert from "node:assert/strict";
import { captionTracks, pickTrack, json3ToText, xmlToText, videoTitle, videoIdOf, lengthSecondsOf, needsVideoConfirm, videoCostMessage } from "../lib/local/youtube";

const tracks = [
  { baseUrl: "https://t/de", languageCode: "de" },
  { baseUrl: "https://t/en-asr", languageCode: "en", kind: "asr" },
  { baseUrl: "https://t/en", languageCode: "en" },
];
const html = `<html><head><title>Lecture &amp; Notes - YouTube</title></head><script>var ytInitialPlayerResponse = {"captions":{"playerCaptionsTracklistRenderer":{"captionTracks":${JSON.stringify(tracks)},"x":["]"]}}};</script></html>`;

// track extraction + preference
const found = captionTracks(html);
assert.equal(found.length, 3);
assert.equal(pickTrack(found)?.baseUrl, "https://t/en");
assert.equal(pickTrack([tracks[0], tracks[1]])?.baseUrl, "https://t/en-asr");
assert.equal(pickTrack([tracks[0]])?.baseUrl, "https://t/de");
assert.equal(pickTrack([]), null);

// no tracks
assert.deepEqual(captionTracks("<html>nothing here</html>"), []);

// title
assert.equal(videoTitle(html), "Lecture & Notes");

// json3 grouping (~45 s) with timestamps
const j = {
  events: [
    { tStartMs: 0, segs: [{ utf8: "Hello" }, { utf8: " world" }] },
    { tStartMs: 20000, segs: [{ utf8: "second line" }] },
    { tStartMs: 50000, segs: [{ utf8: "new para" }] },
    { tStartMs: 51000 },
    { tStartMs: 125000, segs: [{ utf8: "\n" }] },
    { tStartMs: 130000, segs: [{ utf8: "late" }] },
  ],
};
assert.equal(json3ToText(j), "(00:00) Hello world second line\n\n(00:50) new para\n\n(02:10) late");

// xml
const xml = `<transcript><text start="1.5" dur="2">Tom &amp;amp; Jerry</text><text start="70" dur="1">next</text></transcript>`;
assert.equal(xmlToText(xml), "(00:01) Tom & Jerry\n\n(01:10) next");

assert.equal(videoIdOf("https://www.youtube.com/watch?v=abcDEF12345&t=3"), "abcDEF12345");
assert.equal(videoIdOf("https://youtu.be/abcDEF12345"), "abcDEF12345");

// cost estimate
assert.equal(lengthSecondsOf('x"lengthSeconds":"3600",y'), 3600);
assert.equal(lengthSecondsOf("nothing"), null);
assert.equal(needsVideoConfirm({ minutes: 60, hasCaptions: true }), false);
assert.equal(needsVideoConfirm({ minutes: 10, hasCaptions: false }), false);
assert.equal(needsVideoConfirm({ minutes: 16, hasCaptions: false }), true);
assert.equal(needsVideoConfirm({ minutes: null, hasCaptions: false }), true);
assert.equal(needsVideoConfirm(null), true);
assert.match(videoCostMessage(60), /about 60 min ≈ 360k tokens, roughly 36% of a free day/);
assert.match(videoCostMessage(null), /whole day's free quota/);
assert.match(videoCostMessage(600), /100%/);

console.log("youtube-test: all passed");
