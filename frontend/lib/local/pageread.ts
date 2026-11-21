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
