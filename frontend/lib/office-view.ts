/**
 * Turns kept Office files into a simple structure the Original view can draw (slides, sheets, Word
 * blocks). Pure: zip + regex over XML, no DOM, so it runs in Node tests. Not pixel-perfect on purpose.
 */
import { unzipSync } from "fflate";

export type Img = { name: string; mime: string; data: Uint8Array };
export type Slide = { n: number; title: string; paras: string[]; images: Img[] };
export type Sheet = { name: string; rows: string[][]; total: number };
export type DocBlock =
  | { type: "h"; level: number; text: string }
  | { type: "p"; text: string; list: boolean }
  | { type: "table"; rows: string[][] }
  | { type: "img"; img: Img };

export const MAX_SHEET_ROWS = 500;
export const MAX_ZIP = 300 * 1024 * 1024;
export const LIMITS = { entry: 50 * 1024 * 1024, total: 150 * 1024 * 1024, col: 200, csvScanRows: 100000 };

const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, g: string) => {
    if (g[0] === "#") {
      const n = g[1] === "x" || g[1] === "X" ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENT[g.toLowerCase()] ?? m;
  });
}
const texts = (xml: string, tag: string) =>
  [...xml.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "g"))].map((m) => decode(m[1]));
const blocks = (xml: string, tag: string) =>
  [...xml.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?(?:/>|>([\\s\\S]*?)</${tag}>)`, "g"))].map((m) => m[1] ?? "");
const attr = (tag: string, name: string) => decode(new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1] ?? "");

function resolve(base: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const out: string[] = [];
  for (const p of (base ? base.split("/") : []).concat(target.split("/"))) {
    if (p === "..") out.pop();
    else if (p && p !== ".") out.push(p);
  }
  return out.join("/");
}

function rels(xml: string | undefined, base: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of (xml ?? "").matchAll(/<Relationship\b[^>]*>/g)) {
    const id = attr(m[0], "Id");
    const target = attr(m[0], "Target");
    if (id && target && !/TargetMode="External"/.test(m[0])) out.set(id, resolve(base, target));
  }
  return out;
}

const MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp" };

function open(bytes: Uint8Array): { xml: Record<string, string>; bin: Record<string, Uint8Array> } | null {
  if (bytes.length > MAX_ZIP) return null;
  let all: Record<string, Uint8Array>;
  let total = 0;
  let tooBig = false;
  try {
    all = unzipSync(bytes, {
      filter: (f) => {
        const isXml = /\.(xml|rels)$/i.test(f.name);
        if (!isXml && !/\/media\/[^/]+\.(png|jpe?g|gif|webp|bmp)$/i.test(f.name)) return false;
        if (f.originalSize > LIMITS.entry || total + f.originalSize > LIMITS.total) {
          if (isXml) tooBig = true;
          return false;
        }
        total += f.originalSize;
        return true;
      },
    });
  } catch {
    return null;
  }
  if (tooBig) return null;
  const dec = new TextDecoder();
  const xml: Record<string, string> = {};
  const bin: Record<string, Uint8Array> = {};
  for (const [k, v] of Object.entries(all)) (/\.(xml|rels)$/i.test(k) ? (xml[k] = dec.decode(v)) : (bin[k] = v));
  return { xml, bin };
}

function image(bin: Record<string, Uint8Array>, path: string | undefined): Img | null {
  const data = path ? bin[path] : undefined;
  if (!path || !data) return null;
  const ext = path.split(".").pop()!.toLowerCase();
  return { name: path.split("/").pop()!, mime: MIME[ext] ?? "application/octet-stream", data };
}

// ------------------------------------------------------------------ PowerPoint

/** Slides in presentation order, or null when the file isn't a readable .pptx. */
export function viewPptx(bytes: Uint8Array): Slide[] | null {
  const z = open(bytes);
  const pres = z?.xml["ppt/presentation.xml"];
  if (!z || !pres) return null;
  const presRels = rels(z.xml["ppt/_rels/presentation.xml.rels"], "ppt");
  let paths = [...pres.matchAll(/<p:sldId\b[^>]*>/g)].map((m) => presRels.get(attr(m[0], "r:id"))).filter((p): p is string => !!p && !!z.xml[p]);
  if (!paths.length)
    paths = Object.keys(z.xml)
      .filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k))
      .sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]));
  return paths.map((path, i) => {
    const xml = z.xml[path];
    const dir = path.slice(0, path.lastIndexOf("/"));
    const rl = rels(z.xml[`${dir}/_rels/${path.slice(path.lastIndexOf("/") + 1)}.rels`], dir);
    const lines = (sp: string) =>
      blocks(sp, "a:p")
        .map((p) => texts(p.replace(/<a:br\b[^>]*\/>/g, "<a:t>\n</a:t>"), "a:t").join(""))
        .filter((l) => l.trim());
    let title = "";
    const paras: string[] = [];
    for (const m of xml.matchAll(/<p:sp\b[\s\S]*?<\/p:sp>/g)) {
      const isTitle = /<p:ph\b[^>]*type="(?:title|ctrTitle)"/.test(m[0]);
      const ls = lines(m[0]);
      if (isTitle && !title) title = ls.join(" ");
      else paras.push(...ls);
    }
    const images: Img[] = [];
    for (const m of xml.matchAll(/<a:blip\b[^>]*r:embed="([^"]*)"/g)) {
      const img = image(z.bin, rl.get(decode(m[1])));
      if (img) images.push(img);
    }
    return { n: i + 1, title, paras, images };
  });
}

// ------------------------------------------------------------------ Excel / CSV

function colIndex(ref: string): number {
  let n = 0;
  for (const ch of ref.replace(/\d+/g, "")) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** Sheets of an .xlsx (rows capped at MAX_SHEET_ROWS; `total` is the real count), or null. */
export function viewXlsx(bytes: Uint8Array): Sheet[] | null {
  const z = open(bytes);
  const wb = z?.xml["xl/workbook.xml"];
  if (!z || !wb) return null;
  const shared = blocks(z.xml["xl/sharedStrings.xml"] ?? "", "si").map((si) => texts(si, "t").join(""));
  const wbRels = rels(z.xml["xl/_rels/workbook.xml.rels"], "xl");
  return [...wb.matchAll(/<sheet\b[^>]*>/g)].map((m) => {
    const xml = z.xml[wbRels.get(attr(m[0], "r:id")) ?? ""] ?? "";
    const rows: string[][] = [];
    let total = 0;
    for (const row of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      total++;
      if (rows.length >= MAX_SHEET_ROWS) continue;
      const cells: string[] = [];
      for (const c of row[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const ref = attr(c[1], "r");
        const type = attr(c[1], "t");
        const inner = c[2] ?? "";
        const v = texts(inner, "v")[0] ?? "";
        const ci = ref ? colIndex(ref) : cells.length;
        if (ci > LIMITS.col) continue;
        cells[ci] =
          type === "s" ? (shared[Number(v)] ?? "") : type === "inlineStr" ? texts(inner, "t").join("") : type === "b" ? (v === "1" ? "TRUE" : "FALSE") : v;
      }
      const out = Array.from(cells, (c) => c ?? "");
      while (out.length && out[out.length - 1] === "") out.pop();
      rows.push(out);
    }
    return { name: attr(m[0], "name"), rows, total };
  });
}

/** One sheet from CSV/TSV text. */
export function viewCsv(text: string): Sheet[] {
  const sep = (text.split("\n", 1)[0].match(/\t/g)?.length ?? 0) > (text.split("\n", 1)[0].match(/,/g)?.length ?? 0) ? "\t" : ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const endRow = () => {
    row.push(cell);
    cell = "";
    if (row.some((c) => c.trim())) rows.push(row);
    row = [];
  };
  for (let i = 0; i < text.length && rows.length < LIMITS.csvScanRows; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') (cell += '"', i++);
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) (row.push(cell), (cell = ""));
    else if (ch === "\n") endRow();
    else if (ch !== "\r") cell += ch;
  }
  if (cell || row.length) endRow();
  return [{ name: "", rows: rows.slice(0, MAX_SHEET_ROWS), total: rows.length }];
}

// ------------------------------------------------------------------ Word

/** Headings, paragraphs, lists, tables and inline images of a .docx, or null. */
export function viewDocx(bytes: Uint8Array): DocBlock[] | null {
  const z = open(bytes);
  const doc = z?.xml["word/document.xml"];
  if (!z || !doc) return null;
  const rl = rels(z.xml["word/_rels/document.xml.rels"], "word");
  const body = doc.slice(Math.max(0, doc.indexOf("<w:body")));
  const paraText = (p: string) =>
    texts(p.replace(/<w:tab\b[^>]*\/>/g, "<w:t>\t</w:t>").replace(/<w:(?:br|cr)\b[^>]*\/>/g, "<w:t>\n</w:t>"), "w:t").join("");
  const out: DocBlock[] = [];
  for (const m of body.matchAll(/<w:tbl>[\s\S]*?<\/w:tbl>|<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g)) {
    const x = m[0];
    if (x.startsWith("<w:tbl")) {
      const rows = blocks(x, "w:tr").map((tr) => blocks(tr, "w:tc").map((tc) => blocks(tc, "w:p").map(paraText).filter(Boolean).join("\n")));
      if (rows.length) out.push({ type: "table", rows });
      continue;
    }
    const style = /<w:pStyle\b[^>]*w:val="([^"]*)"/.exec(x)?.[1] ?? "";
    const text = paraText(x);
    const heading = /^(?:Heading|Title)\s*(\d?)/i.exec(style);
    if (text.trim()) {
      if (heading) out.push({ type: "h", level: heading[1] ? Math.min(6, Number(heading[1])) : 1, text });
      else out.push({ type: "p", text, list: /<w:numPr>/.test(x) || /^List/i.test(style) });
    }
    for (const b of x.matchAll(/<a:blip\b[^>]*r:embed="([^"]*)"/g)) {
      const img = image(z.bin, rl.get(decode(b[1])));
      if (img) out.push({ type: "img", img });
    }
  }
  return out;
}
