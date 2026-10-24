/**
 * Turning inputs into one text string plus page spans, on the device (port of backend
 * ingestion/parse.py). PDFs are read with pdf.js straight from the file in 1 MB ranges, so a
 * 300 MB textbook never sits in memory whole. Web pages are fetched natively in the Android app
 * (no CORS there) or read by Gemini's url_context tool in a browser. Lecture recordings and
 * YouTube videos are transcribed by Gemini (this replaces the laptop's Whisper).
 */
import type { PageSpan } from "./db";
import { GeminiError, generateJson, generateText, patiently, uploadFile } from "./gemini";

export type ParsedDoc = { title: string; text: string; pages: PageSpan[] };
export class ParseError extends Error {}
type Progress = (f: number, stage: string) => void;

export const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

/** Normalise once at parse time; never again later, or citation offsets drift. */
export function normalize(text: string): string {
  text = text.replace(/\r\n?/g, "\n").replace(/\x00/g, "");
  text = text
    .split("\n")
    .map((l) => l.replace(/[ \t\f\v]+/g, " ").trim())
    .join("\n");
  return text.replace(/\n{3,}/g, "\n\n").trim();
}

export function parseText(text: string, title?: string | null): ParsedDoc {
  const body = normalize(text);
  if (!body) throw new ParseError("The pasted text is empty.");
  if (!title) {
    const first = body.split("\n", 1)[0];
    title = first.slice(0, 80) + (first.length > 80 ? "…" : "");
  }
  return { title, text: body, pages: [] };
}

// ---------------------------------------------------------------- PDF

const yieldToUI = () => new Promise((r) => setTimeout(r, 0));

export async function parsePdf(file: Blob, onProgress?: Progress): Promise<ParsedDoc> {
  // The legacy build runs on older Android WebViews (and Node) too.
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = `${BASE_PATH}/pdf.worker.min.mjs`;
  const head = new Uint8Array(await file.slice(0, 1 << 16).arrayBuffer());
  if (String.fromCharCode(...head.subarray(0, 4)) !== "%PDF") throw new ParseError("That file isn't a PDF.");

  // Serve pdf.js byte ranges straight from the file instead of loading it all.
  const transport = new pdfjs.PDFDataRangeTransport(file.size, head);
  transport.requestDataRange = (begin: number, end: number) => {
    file
      .slice(begin, end)
      .arrayBuffer()
      .then((buf) => transport.onDataRange(begin, new Uint8Array(buf)));
  };
  let doc;
  const task = pdfjs.getDocument({ range: transport, rangeChunkSize: 1 << 20, disableAutoFetch: true, disableStream: true })
      
  try {
    doc = await task.promise;
  } catch (e) {
    throw new ParseError(`Could not read PDF: ${(e as Error).message}`);
  }

  const parts: string[] = [];
  const pages: PageSpan[] = [];
  let cursor = 0;
  const total = doc.numPages;
  for (let i = 1; i <= total; i++) {
    let pageText = "";
    try {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      let raw = "";
      for (const item of content.items as { str?: string; hasEOL?: boolean }[]) {
        raw += item.str ?? "";
        if (item.hasEOL) raw += "\n";
      }
      pageText = normalize(raw);
      page.cleanup();
    } catch {
      pageText = ""; // one damaged page shouldn't sink a 900-page textbook
    }
    if (parts.length) {
      parts.push("\n\n");
      cursor += 2;
    }
    const start = cursor;
    parts.push(pageText);
    cursor += pageText.length;
    pages.push({ page: i, start, end: cursor });
    if (i % 5 === 0 || i === total) {
      onProgress?.(i / total, `Reading pages (${i}/${total})`);
      await yieldToUI();
    }
  }
  let title = "";
  try {
    const meta = await doc.getMetadata();
    title = String((meta.info as { Title?: string })?.Title ?? "").trim();
  } catch {}
  await task.destroy();
  const text = parts.join("");
  if (!text.trim()) throw new ParseError("No extractable text in this PDF (it may be scanned images).");
  return { title: title || "Untitled PDF", text, pages };
}

// ---------------------------------------------------------------- web pages

export const YOUTUBE_RE = /^https?:\/\/(www\.|m\.)?(youtube\.com\/(watch\?v=|shorts\/|live\/)|youtu\.be\/)[\w-]{6,}/;

export function htmlToDoc(html: string, fallbackTitle: string): ParsedDoc {
  const dom = new DOMParser().parseFromString(html, "text/html");
  dom.querySelectorAll("script,style,noscript,nav,header,footer,aside,form,svg,sup.reference,.mw-editsection,.noprint")
    .forEach((el) => el.remove());
  dom.querySelectorAll("br").forEach((br) => br.replaceWith("\n"));
  const title = dom.title?.trim() || fallbackTitle;
  const root = dom.querySelector("article") ?? dom.querySelector("main") ?? dom.body;
  const blocks: string[] = [];
  root?.querySelectorAll("h1,h2,h3,h4,p,li,pre,blockquote,td").forEach((el) => {
    if (el.querySelector("p,li,pre,blockquote")) return;
    const t = (el.textContent ?? "").replace(/[ \t\f\v\n]+/g, " ").trim();
    if (t) blocks.push(t);
  });
  const text = normalize(blocks.length ? blocks.join("\n\n") : (root?.textContent ?? ""));
  if (!text) throw new ParseError("No readable text found at that URL.");
  return { title: title.slice(0, 300), text, pages: [] };
}

async function isNative(): Promise<boolean> {
  try {
    const { Capacitor } = await import("@capacitor/core");
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
}

export async function parseUrl(url: string, onProgress?: Progress): Promise<ParsedDoc> {
  if (!/^https?:\/\//.test(url)) throw new ParseError("Only http(s) URLs are supported.");
  if (await isNative()) {
    const { CapacitorHttp } = await import("@capacitor/core");
    const res = await CapacitorHttp.get({ url, responseType: "text", headers: { "User-Agent": "Marginalia/1.0" } });
    if (res.status >= 400) throw new ParseError(`Could not fetch that page (${res.status}).`);
    const ctype = String(res.headers["Content-Type"] ?? res.headers["content-type"] ?? "");
    if (ctype.includes("pdf")) throw new ParseError("That link is a PDF: download it and add it as a PDF instead.");
    const body = typeof res.data === "string" ? res.data : JSON.stringify(res.data);
    return ctype.includes("html") || /<html/i.test(body.slice(0, 500)) ? htmlToDoc(body, url) : parseText(body, url);
  }
  // In a browser, pages can't be fetched across origins; let Gemini read the page instead.
  onProgress?.(0.2, "Gemini is reading the page");
  const { text } = await generateText(
    "You extract the readable main content of web pages for a student's study notes, word for word.",
    `Read ${url} and return its main article text exactly as written (no summary, no commentary), as plain ` +
      "paragraphs separated by blank lines, with headings on their own lines. Skip menus, ads, cookie notices " +
      "and footers. The first line must be the page title.",
    { tools: [{ url_context: {} }] },
  );
  const [first, ...rest] = normalize(text).split("\n");
  const body = rest.join("\n").trim();
  if (!body) throw new ParseError("Gemini couldn't read that page. Copy its text and paste it instead.");
  return { title: first.replace(/^#+\s*/, "").slice(0, 300) || url, text: normalize(body), pages: [] };
}

// ---------------------------------------------------------------- recordings & YouTube

const TRANSCRIBE_SYSTEM =
  "You transcribe lectures and talks for students' notes. Produce a faithful, readable transcript: " +
  "remove filler words and false starts, keep all content, split into paragraphs at topic changes. Do not summarise.";
const END = "[END OF RECORDING]";
const WINDOW_MIN = 20;
export const MAX_RECORDING_MIN = 180;

/** Recording length in seconds from the media element (NaN/Infinity for some webm recordings). */
function mediaDuration(blob: Blob): Promise<number> {
  return new Promise((resolve) => {
    const el = document.createElement(blob.type.startsWith("video") ? "video" : "audio");
    const url = URL.createObjectURL(blob);
    const done = (d: number) => {
      URL.revokeObjectURL(url);
      resolve(d);
    };
    el.preload = "metadata";
    el.onloadedmetadata = () => done(el.duration);
    el.onerror = () => done(NaN);
    setTimeout(() => done(NaN), 15_000);
    el.src = url;
  });
}

function geminiMime(blob: Blob, filename: string): string {
  const t = (blob.type || "").split(";")[0];
  if (t === "audio/webm") return "video/webm"; // Gemini reads webm as a (sound-only) video
  if (t === "audio/x-m4a" || t === "audio/m4a") return "audio/mp4";
  if (t) return t;
  const ext = filename.split(".").pop()?.toLowerCase();
  return (
    { mp3: "audio/mp3", wav: "audio/wav", m4a: "audio/mp4", aac: "audio/aac", ogg: "audio/ogg", flac: "audio/flac", mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm" }[
      ext ?? ""
    ] ?? "audio/mpeg"
  );
}

const mmss = (s: number) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/**
 * Transcribe a recording with Gemini: upload once via the Files API, then transcribe it in
 * 20-minute windows (one request each) so a 2-hour lecture fits the output limit.
 */
export async function transcribeRecording(blob: Blob, filename: string, onProgress?: Progress): Promise<ParsedDoc> {
  const duration = await mediaDuration(blob);
  const known = Number.isFinite(duration) && duration > 0;
  if (known && duration > MAX_RECORDING_MIN * 60)
    throw new ParseError(`Recordings up to ${MAX_RECORDING_MIN / 60} hours are supported.`);
  const mime = geminiMime(blob, filename);
  const uri = await uploadFile(blob, mime, filename, (f, stage) => onProgress?.(f * 0.3, stage));
  const windows = known ? Math.max(1, Math.ceil(duration / 60 / WINDOW_MIN)) : MAX_RECORDING_MIN / WINDOW_MIN;
  const paras: string[] = [];
  for (let w = 0; w < windows; w++) {
    const from = w * WINDOW_MIN * 60;
    const to = known ? Math.min(duration, from + WINDOW_MIN * 60) : from + WINDOW_MIN * 60;
    onProgress?.(0.3 + (0.6 * w) / windows, known ? `Transcribing ${mmss(from)}–${mmss(to)} of ${mmss(duration)}` : `Transcribing from ${mmss(from)}`);
    const { text } = await patiently(() =>
      generateText(
        TRANSCRIBE_SYSTEM,
        `Transcribe only the part of this recording from ${mmss(from)} to ${mmss(to)}. Start each paragraph ` +
          "with its start time in brackets, like (12:05). Output only the transcript." +
          (known ? "" : ` If the recording ends before ${mmss(to)}, finish with the line ${END}. If there is no audio after ${mmss(from)}, output only ${END}.`),
        { parts: [{ fileData: { fileUri: uri, mimeType: mime } }] },
      ),
    );
    const clean = text.replace(END, "").trim();
    if (clean) paras.push(clean);
    if (!known && text.includes(END)) break;
  }
  const body = normalize(paras.join("\n\n"));
  if (!body) throw new GeminiError("Gemini couldn't hear any speech to transcribe.");
  return { title: filename.replace(/\.[^.]+$/, "").replace(/_/g, " ").trim() || "Lecture recording", text: body, pages: [] };
}

const TRANSCRIPT_SCHEMA = {
  type: "OBJECT",
  properties: { title: { type: "STRING" }, transcript: { type: "STRING" } },
  required: ["title", "transcript"],
};

export async function transcribeYoutube(url: string): Promise<ParsedDoc> {
  const out = await generateJson<{ title?: string; transcript?: string }>(
    TRANSCRIBE_SYSTEM + " Add short '## Section' headings where the topic clearly shifts.",
    "Transcribe the spoken content of this video. `title` is the video's topic in a few words.",
    TRANSCRIPT_SCHEMA,
    { parts: [{ fileData: { fileUri: url } }] },
  );
  const text = (out.transcript ?? "").trim();
  if (!text) throw new GeminiError("Gemini couldn't hear any speech to transcribe.");
  return parseText(text, (out.title || "YouTube video").trim().slice(0, 300));
}
