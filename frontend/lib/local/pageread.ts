/**
 * "Read this page with AI": render one PDF page to an image and have Gemini vision transcribe it
 * (text in reading order, maths as LaTeX, tables as Markdown, figures described in brackets). The
 * result is appended to the source by aipages.ts; nothing here touches the database.
 */
import { generateJson } from "./gemini";
import type { openPdf } from "./parse";
import { blobToBase64 } from "./vision";
import { BLANK_PAGE } from "./aipages";

export const READ_WIDTH = 1600; // px; legible equations without a huge upload
type PdfDoc = Awaited<ReturnType<typeof openPdf>>["doc"];

/** Render page `n` of an open pdf.js document to a JPEG about `width` px wide (browser only). */
export async function renderPageJpeg(doc: PdfDoc, n: number, width = READ_WIDTH): Promise<Blob> {
  const page = await doc.getPage(n);
  const base = page.getViewport({ scale: 1 });
  const vp = page.getViewport({ scale: width / base.width });
  const canvas = document.createElement("canvas");
  canvas.width = Math.floor(vp.width);
  canvas.height = Math.floor(vp.height);
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.fillStyle = "#fff"; // JPEG has no transparency
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  await page.render({ canvas, viewport: vp }).promise;
  page.cleanup();
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", 0.85));
  canvas.width = canvas.height = 0;
  if (!blob) throw new Error("Couldn't draw that page.");
  return blob;
}

const SYSTEM =
  "You transcribe one page of a student's textbook, notes or worksheet from an image, faithfully. You never " +
  "invent, complete, correct, translate or summarise anything: if something can't be read, write [illegible].";

const SCHEMA = {
  type: "OBJECT",
  properties: { text: { type: "STRING" }, blank: { type: "BOOLEAN" } },
  required: ["text", "blank"],
};

const PROMPT =
  "Transcribe this page.\n" +
  "- Keep the text in reading order (columns one after the other), paragraphs separated by a blank line, headings on their own line.\n" +
  "- Write ALL maths as LaTeX: $...$ inline and $$...$$ for displayed equations. Write amounts of money in words (\"5 dollars\") so $ only ever means maths.\n" +
  "- Write tables as Markdown tables (a header row, then a | --- | separator row).\n" +
  "- Replace each figure, diagram, graph or photo by one line [Figure: ...] that says what it shows, including its labels, axes, values and any caption text. Describe only what is visible.\n" +
  "- Leave out running headers, footers and bare page numbers.\n" +
  "- If the page has no content, set blank to true and text to an empty string.";

/** Gemini's transcription of a page image. Counted under the `page-read` feature tag. */
export async function readPageImage(jpeg: Blob): Promise<string> {
  const data = await blobToBase64(jpeg);
  const out = await generateJson<{ text?: string; blank?: boolean }>(SYSTEM, PROMPT, SCHEMA, {
    parts: [{ inlineData: { mimeType: "image/jpeg", data } }],
    tag: "page-read",
    thinking: "low",
    geminiOnly: true,
  });
  const text = (out.text ?? "").trim();
  return out.blank || !text ? BLANK_PAGE : text;
}

// ---------------------------------------------------------------- slides (pictures only)

/** One slide ready to send: its pictures (already shrunk, base64) and any text it does have. */
export type SlideInput = { n: number; text: string; images: { mime: string; data: string }[]; unreadable: number };

export const SLIDES_PER_REQUEST = 8;
/** Most image data (decoded bytes) one request carries. */
export const MAX_REQUEST_BYTES = 12 * 1024 * 1024;
/** Pictures under this size are logos and icons, unless a slide has nothing else. */
export const MIN_PICTURE_BYTES = 8 * 1024;
export const MAX_PICTURES_PER_SLIDE = 4;
export const UNREADABLE_FIGURE = "[Figure not readable]";

/** Width and height from the header of a PNG, JPEG, GIF or BMP (null for anything else), without decoding the picture. */
export function imageSize(d: Uint8Array): { w: number; h: number } | null {
  const u16 = (o: number) => (d[o] << 8) | d[o + 1];
  if (d.length > 24 && d[0] === 0x89 && d[1] === 0x50) return { w: ((d[16] << 24) | (d[17] << 16) | (d[18] << 8) | d[19]) >>> 0, h: ((d[20] << 24) | (d[21] << 16) | (d[22] << 8) | d[23]) >>> 0 };
  if (d.length > 10 && d[0] === 0x47 && d[1] === 0x49) return { w: d[6] | (d[7] << 8), h: d[8] | (d[9] << 8) };
  if (d.length > 26 && d[0] === 0x42 && d[1] === 0x4d) {
    const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
    return { w: Math.abs(dv.getInt32(18, true)), h: Math.abs(dv.getInt32(22, true)) };
  }
  if (d.length > 4 && d[0] === 0xff && d[1] === 0xd8) {
    let o = 2;
    while (o + 9 < d.length) {
      if (d[o] !== 0xff) return null;
      const m = d[o + 1];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { h: u16(o + 5), w: u16(o + 7) };
      o += 2 + u16(o + 2);
    }
  }
  return null;
}

/** Target size for a picture: its long side at most `max` px, aspect kept; null when it already fits (or its size is unknown). */
export function fitSize(size: { w: number; h: number } | null, max = READ_WIDTH): { w: number; h: number } | null {
  if (!size || !size.w || !size.h) return null;
  const k = max / Math.max(size.w, size.h);
  return k >= 1 ? null : { w: Math.max(1, Math.round(size.w * k)), h: Math.max(1, Math.round(size.h * k)) };
}

/** Shrink a picture from a deck to a JPEG at most `READ_WIDTH` px on its long side (browser only). Null if the browser can't decode it. */
export async function shrinkPicture(img: { mime: string; data: Uint8Array }): Promise<{ mime: string; data: string } | null> {
  try {
    // Ask the decoder for the small size up front, so a huge PNG is never held at full size (phones).
    const target = fitSize(imageSize(img.data));
    const source = new Blob([img.data as BlobPart], { type: img.mime });
    const bitmap = await (target ? createImageBitmap(source, { resizeWidth: target.w, resizeHeight: target.h, resizeQuality: "high" }) : createImageBitmap(source));
    const k = Math.min(1, READ_WIDTH / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * k));
    canvas.height = Math.max(1, Math.round(bitmap.height * k));
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close?.();
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", 0.85));
    canvas.width = canvas.height = 0;
    return blob ? { mime: "image/jpeg", data: await blobToBase64(blob) } : null;
  } catch {
    return null;
  }
}

/** Decoded size of a base64 string. */
export const base64Bytes = (b64: string) => Math.floor((b64.length * 3) / 4);

/** Pictures that are slide content: unique, not a logo (under 8 KB) and not layout artwork repeated on most slides. */
export function contentPictures<T extends { data: Uint8Array }>(images: T[], repeats: Map<Uint8Array, number>, slideCount: number): T[] {
  const repeated = (im: T) => slideCount >= 4 && (repeats.get(im.data) ?? 0) > slideCount / 2;
  return images.filter((im, i) => images.findIndex((x) => x.data === im.data) === i && im.data.length >= MIN_PICTURE_BYTES && !repeated(im));
}

/**
 * Which pictures of a slide to send: in slide order, the content pictures, or (if there are none) whatever is left, so a
 * lone small picture is still read. At most 4, the largest if there are more.
 */
export function pickPictures<T extends { data: Uint8Array }>(images: T[], repeats: Map<Uint8Array, number>, slideCount: number): T[] {
  const unique = images.filter((im, i) => images.findIndex((x) => x.data === im.data) === i);
  const repeated = (im: T) => slideCount >= 4 && (repeats.get(im.data) ?? 0) > slideCount / 2;
  let keep = contentPictures(images, repeats, slideCount);
  if (!keep.length) keep = unique.filter((im) => !repeated(im));
  if (!keep.length) keep = unique;
  if (keep.length > MAX_PICTURES_PER_SLIDE) {
    const big = new Set([...keep].sort((a, b) => b.data.length - a.data.length).slice(0, MAX_PICTURES_PER_SLIDE));
    keep = keep.filter((im) => big.has(im));
  }
  return keep;
}

const SLIDES_SYSTEM =
  "You transcribe slides of a student's lesson presentation (often programming or computer science) from images, " +
  "faithfully. You never invent, complete, correct, translate or summarise anything: if something can't be read, write [illegible].";

const SLIDES_SCHEMA = {
  type: "OBJECT",
  properties: {
    slides: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: { slide: { type: "INTEGER" }, text: { type: "STRING" }, blank: { type: "BOOLEAN" } },
        required: ["slide", "text", "blank"],
      },
    },
  },
  required: ["slides"],
};

const SLIDES_PROMPT =
  "Each slide above is introduced by its label (\"Slide n\") and followed by its picture(s). Transcribe EVERY slide, one entry per label, `slide` = its number.\n" +
  "- Keep the text in reading order, headings on their own line, paragraphs and bullet points as Markdown lists.\n" +
  "- Program code goes in fenced code blocks (```python, ```java or ``` if unsure) with the original indentation and line breaks kept exactly. Do not fix or complete the code.\n" +
  "- Write ALL maths as LaTeX: $...$ inline and $$...$$ for displayed equations. Write amounts of money in words (\"5 dollars\") so $ only ever means maths.\n" +
  "- Write tables as Markdown tables (a header row, then a | --- | separator row).\n" +
  "- Replace each diagram, flowchart, graph, screenshot of output or photo by one line [Figure: ...] that says what it shows, including its labels, arrows, values and any caption text. Describe only what is visible.\n" +
  "- If a slide lists text extracted from the file (its title, body text, speaker notes), include that text in the slide's transcription too, once, with the speaker notes after a line \"Speaker notes:\". Use it to check the spelling of what the pictures show.\n" +
  "- If a slide has no content, set blank to true and text to an empty string.";

/**
 * Gemini's transcription of a batch of slides: slide number to text. The model sometimes numbers a batch 1..8 instead of
 * 9..16: when none of its numbers fit but the count does, the entries are taken in order. A slide with no entry is missing here.
 */
export async function readSlideBatch(batch: SlideInput[]): Promise<Map<number, string>> {
  const parts: Record<string, unknown>[] = [];
  for (const s of batch) {
    parts.push({ text: `Slide ${s.n}${s.text.trim() ? `\nText extracted from this slide:\n${s.text.trim()}` : ""}` });
    for (const im of s.images) parts.push({ inlineData: { mimeType: im.mime, data: im.data } });
  }
  const numbers = batch.map((s) => s.n).join(", ");
  const out = await generateJson<{ slides?: { slide?: number; text?: string; blank?: boolean }[] }>(
    SLIDES_SYSTEM,
    `${SLIDES_PROMPT}\n- This request has ${batch.length} slide${batch.length === 1 ? "" : "s"}, numbered exactly ${numbers}. Return exactly one entry for each of those numbers, in that order, using those numbers (not 1, 2, 3...).`,
    SLIDES_SCHEMA,
    { parts, tag: "page-read", thinking: "low", geminiOnly: true },
  );
  return matchSlides(batch.map((s) => s.n), out.slides ?? []);
}

/**
 * Pure: pair the model's entries with the slide numbers asked for.
 *  - every returned number is one we asked for (no repeats): by number (a gap just leaves that slide missing);
 *  - otherwise, if the count is right (the model renumbered the batch 1..n): by order;
 *  - otherwise nothing is matched, and every slide stays pending. A reading is never filed under a guessed slide.
 */
export function matchSlides(wanted: number[], entries: { slide?: number; text?: string; blank?: boolean }[]): Map<number, string> {
  const want = new Set(wanted);
  const clean = (r: { text?: string; blank?: boolean }) => {
    const text = (r.text ?? "").trim();
    return r.blank || !text ? BLANK_PAGE : text;
  };
  const res = new Map<number, string>();
  const numbers = entries.map((r) => r.slide);
  const fits = numbers.every((n) => typeof n === "number" && want.has(n)) && new Set(numbers).size === numbers.length;
  if (fits) for (const r of entries) res.set(r.slide!, clean(r));
  else if (entries.length === wanted.length) wanted.forEach((n, i) => res.set(n, clean(entries[i])));
  return res;
}
