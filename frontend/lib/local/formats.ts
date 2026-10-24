/**
 * Reading other file types into one text + page spans, like PDFs:
 *   PowerPoint .pptx / OpenDocument .odp   one "page" per slide (speaker notes included)
 *   Word .docx / OpenDocument .odt         one text; headings become their own paragraphs
 *   Excel .xlsx / OpenDocument .ods / .csv one "page" per sheet, rows as "a | b | c" lines
 *   EPUB                                   one "page" per chapter, in reading order
 *   .txt / .md / .html                     as text
 *   photos / scans (.jpg .png .webp .heic) transcribed by Gemini (uses quota)
 * Office files are zip archives of XML; only the XML parts are unzipped (images are skipped), and
 * the XML is read with small regex helpers so this also runs in Node tests (no DOMParser there).
 */
import { unzipSync } from "fflate";
import type { PageSpan, SourceRow } from "./db";
import { GeminiError, generateJson } from "./gemini";
import { normalize, ParseError, type ParsedDoc } from "./parse";
import { blobToBase64 } from "./vision";

export type FileKind = Extract<SourceRow["kind"], "pdf" | "slides" | "doc" | "sheet" | "image">;
type Format = { kind: FileKind; read: (file: Blob, name: string) => Promise<ParsedDoc> };

const ext = (name: string) => name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
const stem = (name: string) => name.replace(/\.[^.]+$/, "").replace(/_/g, " ").trim() || "Untitled";

const LEGACY: Record<string, string> = {
  ppt: "an old-style PowerPoint (.ppt)",
  doc: "an old-style Word file (.doc)",
  xls: "an old-style Excel file (.xls)",
  pps: "an old-style PowerPoint show (.pps)",
};
const LEGACY_FIX: Record<string, string> = { ppt: ".pptx", pps: ".pptx", doc: ".docx", xls: ".xlsx" };

/** What kind of source a file becomes, or null if unsupported. PDFs go through parsePdf. */
export function formatOf(name: string, type = ""): Format | "pdf" | null {
  const e = ext(name);
  if (e === "pdf" || type === "application/pdf") return "pdf";
  if (e === "pptx" || e === "ppsx" || e === "potx" || e === "odp") return { kind: "slides", read: e === "odp" ? readOdf : readPptx };
  if (e === "docx" || e === "dotx" || e === "odt") return { kind: "doc", read: e === "odt" ? readOdf : readDocx };
  if (e === "xlsx" || e === "xlsm" || e === "ods") return { kind: "sheet", read: e === "ods" ? readOdf : readXlsx };
  if (e === "csv" || e === "tsv") return { kind: "sheet", read: readCsv };
  if (e === "epub") return { kind: "doc", read: readEpub };
  if (["txt", "md", "markdown", "text", "rtf"].includes(e) || type.startsWith("text/plain")) return { kind: "doc", read: readPlain };
  if (e === "html" || e === "htm" || type === "text/html") return { kind: "doc", read: readHtmlFile };
  if (["jpg", "jpeg", "png", "webp", "heic", "heif", "gif", "bmp"].includes(e) || type.startsWith("image/"))
    return { kind: "image", read: readImage };
  return null;
}

/** A friendly reason a file can't be added (or null if it can). */
export function unsupportedReason(name: string, type = ""): string | null {
  if (formatOf(name, type)) return null;
  const e = ext(name);
  if (LEGACY[e]) return `${name} is ${LEGACY[e]}. Open it in PowerPoint/Word/Excel (or Google Slides/Docs/Sheets), save it as ${LEGACY_FIX[e]}, and add that.`;
  if (["key", "pages", "numbers"].includes(e)) return `${name} is an Apple iWork file. Export it as PowerPoint, Word or Excel (or PDF) and add that.`;
  if (type.startsWith("audio/") || type.startsWith("video/")) return `${name} is a recording: add it under "Lecture audio".`;
  return `${name} can't be read. Supported: PDF, PowerPoint, Word, Excel/CSV, EPUB, text and photos.`;
}

// ---------------------------------------------------------------- helpers

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
export function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, g: string) => {
    if (g[0] === "#") {
      const n = g[1] === "x" || g[1] === "X" ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[g.toLowerCase()] ?? m;
  });
}

/** Concatenated text of every <tag>…</tag> inside `xml` (e.g. "a:t"), in order. */
function texts(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "g");
  return [...xml.matchAll(re)].map((m) => decode(m[1]));
}

/** Every <tag …>…</tag> block (non-nested use: paragraphs, rows, cells). */
function blocks(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?(?:/>|>([\\s\\S]*?)</${tag}>)`, "g");
  return [...xml.matchAll(re)].map((m) => m[1] ?? "");
}

const attr = (tag: string, name: string) => decode(new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1] ?? "");

/** Join per-page texts with blank lines, recording each page's character span. */
function paged(title: string, parts: string[]): ParsedDoc {
  const pages: PageSpan[] = [];
  let text = "";
  parts.forEach((raw, i) => {
    const t = normalize(raw);
    if (i > 0) text += "\n\n";
    pages.push({ page: i + 1, start: text.length, end: text.length + t.length });
    text += t;
  });
  if (!text.trim()) throw new ParseError("No readable text in that file.");
  return { title, text, pages };
}

const MAX_ZIP = 300 * 1024 * 1024;

async function unzipXml(file: Blob, name: string): Promise<Record<string, string>> {
  if (file.size > MAX_ZIP) throw new ParseError(`${name} is over 300 MB. Save a copy without videos/large images, or as PDF.`);
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(new Uint8Array(await file.arrayBuffer()), {
      filter: (f) => /\.(xml|rels|opf|xhtml|html|htm|ncx)$/i.test(f.name),
    });
  } catch {
    throw new ParseError(`${name} isn't a valid file (it may be damaged, or password-protected).`);
  }
  const dec = new TextDecoder();
  return Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, dec.decode(v)]));
}

/** id → target from a .rels file, resolved against `base` (the folder of the part that owns it). */
function rels(xml: string | undefined, base: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of (xml ?? "").matchAll(/<Relationship\b[^>]*>/g)) {
    const id = attr(m[0], "Id");
    const target = attr(m[0], "Target");
    if (id && target) out.set(id, resolve(base, target));
  }
  return out;
}

function resolve(base: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const parts = (base ? base.split("/") : []).concat(target.split("/"));
  const out: string[] = [];
  for (const p of parts) {
    if (p === "..") out.pop();
    else if (p && p !== ".") out.push(p);
  }
  return out.join("/");
}

const coreTitle = (files: Record<string, string>) => texts(files["docProps/core.xml"] ?? "", "dc:title")[0]?.trim() || "";

// ---------------------------------------------------------------- PowerPoint

/** Paragraphs of a DrawingML part (slides, notes): one line per <a:p>, line breaks kept. */
function drawingText(xml: string): string {
  return blocks(xml, "a:p")
    .map((p) => p.replace(/<a:br\b[^>]*\/>/g, "<a:t>\n</a:t>"))
    .map((p) => texts(p, "a:t").join(""))
    .filter((l) => l.trim())
    .join("\n");
}

async function readPptx(file: Blob, name: string): Promise<ParsedDoc> {
  const f = await unzipXml(file, name);
  const pres = f["ppt/presentation.xml"];
  if (!pres) throw new ParseError(`${name} doesn't look like a PowerPoint file.`);
  const presRels = rels(f["ppt/_rels/presentation.xml.rels"], "ppt");
  // Slide order comes from the presentation's slide list (file names can be out of order).
  let slides = [...pres.matchAll(/<p:sldId\b[^>]*>/g)].map((m) => presRels.get(attr(m[0], "r:id"))).filter((p): p is string => !!p && !!f[p]);
  if (!slides.length)
    slides = Object.keys(f)
      .filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k))
      .sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]));
  const parts = slides.map((path) => {
    const body = drawingText(f[path]);
    const dir = path.slice(0, path.lastIndexOf("/"));
    const file = path.slice(path.lastIndexOf("/") + 1);
    const notesPath = [...rels(f[`${dir}/_rels/${file}.rels`], dir).values()].find((t) => t.includes("notesSlides/"));
    // Notes slides repeat the slide number placeholder; keep only real note paragraphs.
    const notes = notesPath && f[notesPath] ? drawingText(f[notesPath]).split("\n").filter((l) => !/^\d+$/.test(l.trim())).join("\n") : "";
    return notes.trim() ? `${body}\n\nSpeaker notes:\n${notes}` : body;
  });
  return paged(coreTitle(f) || stem(name), parts);
}

// ---------------------------------------------------------------- Word

async function readDocx(file: Blob, name: string): Promise<ParsedDoc> {
  const f = await unzipXml(file, name);
  const doc = f["word/document.xml"];
  if (!doc) throw new ParseError(`${name} doesn't look like a Word file.`);
  const body = doc.slice(doc.indexOf("<w:body"));
  const paras = blocks(body, "w:p").map((p) =>
    texts(p.replace(/<w:tab\b[^>]*\/>/g, "<w:t>\t</w:t>").replace(/<w:(?:br|cr)\b[^>]*\/>/g, "<w:t>\n</w:t>"), "w:t").join(""),
  );
  const text = normalize(paras.filter((p) => p.trim()).join("\n\n"));
  if (!text) throw new ParseError("No readable text in that file.");
  return { title: coreTitle(f) || stem(name), text, pages: [] };
}

// ---------------------------------------------------------------- Excel / CSV

const MAX_ROWS = 3000; // per sheet; huge data dumps aren't useful study text

function colIndex(ref: string): number {
  let n = 0;
  for (const ch of ref.replace(/\d+/g, "")) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function rowsToText(rows: string[][]): string {
  const width = Math.max(0, ...rows.map((r) => r.length));
  return rows
    .map((r) => Array.from({ length: width }, (_, i) => (r[i] ?? "").replace(/\s+/g, " ").trim()))
    .filter((r) => r.some((c) => c))
    .map((r) => {
      while (r.length && !r[r.length - 1]) r.pop();
      return r.join(" | ");
    })
    .join("\n");
}

async function readXlsx(file: Blob, name: string): Promise<ParsedDoc> {
  const f = await unzipXml(file, name);
  const wb = f["xl/workbook.xml"];
  if (!wb) throw new ParseError(`${name} doesn't look like an Excel file.`);
  const shared = blocks(f["xl/sharedStrings.xml"] ?? "", "si").map((si) => texts(si, "t").join(""));
  const wbRels = rels(f["xl/_rels/workbook.xml.rels"], "xl");
  const sheets = [...wb.matchAll(/<sheet\b[^>]*>/g)].map((m) => ({ name: attr(m[0], "name"), path: wbRels.get(attr(m[0], "r:id")) }));
  const parts = sheets.map(({ name: sheetName, path }) => {
    const xml = (path && f[path]) || "";
    const rows: string[][] = [];
    let truncated = false;
    for (const row of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      if (rows.length >= MAX_ROWS) {
        truncated = true;
        break;
      }
      const cells: string[] = [];
      for (const c of row[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const ref = attr(c[1], "r");
        const type = attr(c[1], "t");
        const inner = c[2] ?? "";
        const v = texts(inner, "v")[0] ?? "";
        const value =
          type === "s" ? (shared[Number(v)] ?? "") : type === "inlineStr" ? texts(inner, "t").join("") : type === "b" ? (v === "1" ? "TRUE" : "FALSE") : v;
        cells[ref ? colIndex(ref) : cells.length] = value;
      }
      rows.push(cells);
    }
    const body = rowsToText(rows);
    return `## ${sheetName}\n${body}${truncated ? `\n(first ${MAX_ROWS} rows only)` : ""}`;
  });
  return paged(coreTitle(f) || stem(name), parts);
}

function parseCsv(text: string, sep: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') (cell += '"', i++);
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) (row.push(cell), (cell = ""));
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      if (rows.length >= MAX_ROWS) break;
    } else cell += ch;
  }
  if (cell || row.length) (row.push(cell), rows.push(row));
  return rows;
}

async function readCsv(file: Blob, name: string): Promise<ParsedDoc> {
  const raw = await file.text();
  const first = raw.split("\n", 1)[0];
  const sep = ext(name) === "tsv" || (first.split("\t").length > first.split(",").length) ? "\t" : first.split(";").length > first.split(",").length ? ";" : ",";
  return paged(stem(name), [`## ${stem(name)}\n${rowsToText(parseCsv(raw, sep))}`]);
}

// ---------------------------------------------------------------- OpenDocument (odp / odt / ods)

/** Text of ODF paragraphs/headings in a fragment, one per line. */
function odfText(xml: string): string {
  return [...xml.matchAll(/<text:(p|h)\b[^>]*?(?:\/>|>([\s\S]*?)<\/text:\1>)/g)]
    .map((m) => decode((m[2] ?? "").replace(/<text:line-break\s*\/>/g, "\n").replace(/<text:tab\s*\/>/g, "\t").replace(/<text:s\s*\/>/g, " ").replace(/<[^>]+>/g, "")))
    .filter((l) => l.trim())
    .join("\n");
}

async function readOdf(file: Blob, name: string): Promise<ParsedDoc> {
  const f = await unzipXml(file, name);
  const content = f["content.xml"];
  if (!content) throw new ParseError(`${name} doesn't look like an OpenDocument file.`);
  const title = texts(f["meta.xml"] ?? "", "dc:title")[0]?.trim() || stem(name);
  const pages = [...content.matchAll(/<draw:page\b[^>]*>([\s\S]*?)<\/draw:page>/g)];
  if (pages.length) return paged(title, pages.map((p) => odfText(p[1])));
  const tables = [...content.matchAll(/<table:table\b([^>]*)>([\s\S]*?)<\/table:table>/g)];
  if (tables.length && ext(name) === "ods")
    return paged(
      title,
      tables.map((t) => {
        const rows = [...t[2].matchAll(/<table:table-row\b[^>]*>([\s\S]*?)<\/table:table-row>/g)]
          .slice(0, MAX_ROWS)
          .map((r) => [...r[1].matchAll(/<table:table-cell\b[^>]*?(?:\/>|>([\s\S]*?)<\/table:table-cell>)/g)].map((c) => odfText(c[1] ?? "").replace(/\n/g, " ")));
        return `## ${attr(t[1], "table:name")}\n${rowsToText(rows)}`;
      }),
    );
  const text = normalize(odfText(content.slice(content.indexOf("<office:body"))).replace(/\n/g, "\n\n"));
  if (!text) throw new ParseError("No readable text in that file.");
  return { title, text, pages: [] };
}

// ---------------------------------------------------------------- EPUB, plain text, HTML

/** HTML → plain text without a DOM: block tags become paragraph breaks. */
export function htmlText(html: string): string {
  const body = html.replace(/^[\s\S]*?<body[^>]*>/i, "").replace(/<\/body>[\s\S]*$/i, "");
  return decode(
    body
      .replace(/<(script|style|nav|header|footer|aside)\b[\s\S]*?<\/\1>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|h[1-6]|li|tr|blockquote|pre|section|article|table|ul|ol|dt|dd|figcaption)>/gi, "\n\n")
      .replace(/<(td|th)\b[^>]*>/gi, " | ")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n");
}

async function readEpub(file: Blob, name: string): Promise<ParsedDoc> {
  const f = await unzipXml(file, name);
  const rootPath = attr(/<rootfile\b[^>]*>/.exec(f["META-INF/container.xml"] ?? "")?.[0] ?? "", "full-path");
  const opf = f[rootPath];
  if (!opf) throw new ParseError(`${name} doesn't look like an EPUB book.`);
  const base = rootPath.includes("/") ? rootPath.slice(0, rootPath.lastIndexOf("/")) : "";
  const manifest = new Map([...opf.matchAll(/<item\b[^>]*>/g)].map((m) => [attr(m[0], "id"), resolve(base, attr(m[0], "href"))]));
  const order = [...opf.matchAll(/<itemref\b[^>]*>/g)].map((m) => manifest.get(attr(m[0], "idref"))).filter((p): p is string => !!p && !!f[p]);
  const parts = order.map((p) => htmlText(f[p])).filter((t) => t.trim());
  const title = texts(opf, "dc:title")[0]?.trim() || stem(name);
  return paged(title, parts);
}

async function readPlain(file: Blob, name: string): Promise<ParsedDoc> {
  let raw = await file.text();
  if (ext(name) === "rtf") raw = raw.replace(/\\par[d]?/g, "\n").replace(/\{\\\*[^{}]*\}|\\[a-z]+-?\d* ?|[{}]/gi, "");
  const text = normalize(raw);
  if (!text) throw new ParseError("That file is empty.");
  return { title: stem(name), text, pages: [] };
}

async function readHtmlFile(file: Blob, name: string): Promise<ParsedDoc> {
  const raw = await file.text();
  const title = decode(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(raw)?.[1] ?? "").trim() || stem(name);
  const text = normalize(htmlText(raw));
  if (!text) throw new ParseError("No readable text in that file.");
  return { title, text, pages: [] };
}

// ---------------------------------------------------------------- photos of notes / slides / pages

const IMAGE_SCHEMA = {
  type: "OBJECT",
  properties: { title: { type: "STRING" }, text: { type: "STRING" } },
  required: ["title", "text"],
};

async function readImage(file: Blob, name: string): Promise<ParsedDoc> {
  if (file.size > 15 * 1024 * 1024) throw new ParseError("Photos up to 15 MB are supported.");
  const mime = file.type.startsWith("image/") ? file.type : "image/jpeg";
  const out = await generateJson<{ title?: string; text?: string }>(
    "You turn photos of study material (book pages, handwritten or typed notes, slides, whiteboards) into faithful text for a student's notes.",
    "Transcribe all the text in this image in reading order, keeping headings, lists and line breaks. For diagrams, graphs " +
      "or tables, add a short [Diagram: …] / [Table: …] description of what they show (tables as 'a | b | c' rows). " +
      "Do not add facts that aren't in the image. `title` is a short topic title.",
    IMAGE_SCHEMA,
    { parts: [{ inlineData: { mimeType: mime, data: await blobToBase64(file) } }] },
  );
  const text = normalize(out.text ?? "");
  if (!text) throw new GeminiError("Couldn't find any text in that photo. Try a sharper, well-lit photo.");
  return { title: (out.title || stem(name)).slice(0, 300), text, pages: [] };
}
