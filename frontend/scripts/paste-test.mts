// imagesFromPaste: reads image files from a paste event's clipboardData; text pastes give [].
import assert from "node:assert/strict";
import { imagesFromPaste } from "../lib/photos";

const item = (type: string, file: File | null, kind = file ? "file" : "string") => ({ kind, type, getAsFile: () => file });
const png = new File([new Uint8Array([1, 2, 3])], "image.png", { type: "image/png" });
const jpg = new File([new Uint8Array([4])], "diagram.jpg", { type: "image/jpeg" });

assert.deepEqual(imagesFromPaste({}), []);
assert.deepEqual(imagesFromPaste({ clipboardData: null }), []);
assert.deepEqual(imagesFromPaste({ clipboardData: { items: [item("text/plain", null)] } }), []);

const one = imagesFromPaste({ clipboardData: { items: [item("text/html", null), item("image/png", png)] } });
assert.equal(one.length, 1);
assert.equal(one[0].type, "image/png");
assert.match(one[0].name, /^pasted-screenshot-1\.png$/); // generic "image.png" gets a readable name
assert.equal(one[0].size, 3);

const two = imagesFromPaste({ clipboardData: { items: [item("image/png", png), item("image/jpeg", jpg), item("image/gif", null)] } });
assert.equal(two.length, 2);
assert.equal(two[1].name, "diagram.jpg"); // real names are kept

// Excel/Word/OneNote copy text and a picture together: the text must paste normally, so no images.
const withText = {
  items: [item("image/png", png), item("text/plain", null)],
  getData: (type: string) => (type === "text/plain" ? "Q1\t4 marks" : ""),
};
assert.deepEqual(imagesFromPaste({ clipboardData: withText }), []);

// A real screenshot carries no text, so the image still comes through.
const imageOnly = { items: [item("image/png", png)], getData: () => "" };
assert.equal(imagesFromPaste({ clipboardData: imageOnly }).length, 1);

console.log("paste-test: ok");
