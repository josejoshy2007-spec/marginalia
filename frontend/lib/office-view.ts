/**
 * Turns kept Office files into a simple structure the Original view can draw (slides, sheets, Word
 * blocks). Pure: zip + regex over XML, no DOM, so it runs in Node tests. Not pixel-perfect on purpose.
 */
import { unzipSync } from "fflate";

export type Img = { name: string; mime: string; data: Uint8Array };
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

export type Run = { text: string; b?: boolean; i?: boolean; u?: boolean; size: number; color?: string };
export type Para = { runs: Run[]; algn: "l" | "ctr" | "r" | "just"; lvl: number; bullet: boolean; size: number };
export type Box = { x: number; y: number; w: number; h: number };
export type Cell = { paras: Para[]; colSpan: number; rowSpan: number; fill?: string; header: boolean };
export type ChartData = {
  kind: "bar" | "column" | "line" | "pie" | "table";
  title: string;
  cats: string[];
  series: { name: string; vals: number[]; color?: string }[];
};
export type El = Box &
  (
    | { t: "text"; paras: Para[]; anchor: "t" | "ctr" | "b"; fill?: string; line?: string; lineW?: number }
    | { t: "img"; img: Img }
    | { t: "table"; cols: number[]; rows: { h: number; cells: Cell[] }[] }
    | { t: "chart"; chart: ChartData }
  );
/** `w`/`h` are the slide size in EMU; `els` is null when the positioned rebuild failed (draw title/paras/images instead). */
export type Slide = { n: number; title: string; paras: string[]; images: Img[]; w: number; h: number; bg?: string; bgBase?: string; els: El[] | null };

type XNode = { n: string; a: Record<string, string>; c: XNode[]; t: string };

/** Tiny tolerant XML tree (no DOM). Throws on absurd nesting so the caller can fall back. */
function parseXml(xml: string): XNode {
  const root: XNode = { n: "#", a: {}, c: [], t: "" };
  const stack = [root];
  const re = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<![^>]*>|<\/([^\s>]+)\s*>|<([^\s/>]+)((?:\s+[^\s=>/]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  for (const m of xml.matchAll(re)) {
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) top.t += m[1];
    else if (m[2] !== undefined) {
      while (stack.length > 1 && stack[stack.length - 1].n !== m[2]) stack.pop();
      if (stack.length > 1) stack.pop();
    } else if (m[3] !== undefined) {
      const a: Record<string, string> = {};
      for (const at of m[4].matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) a[at[1]] = decode(at[2] ?? at[3] ?? "");
      const node: XNode = { n: m[3], a, c: [], t: "" };
      top.c.push(node);
      if (!m[5]) {
        if (stack.length > 200) throw new Error("xml too deep");
        stack.push(node);
      }
    } else if (m[6] !== undefined) top.t += decode(m[6]);
  }
  return root;
}
const kid = (n: XNode | undefined, name: string) => n?.c.find((x) => x.n === name);
const kidsOf = (n: XNode | undefined, name: string) => (n ? n.c.filter((x) => x.n === name) : []);
const at = (n: XNode | undefined, ...names: string[]) => names.reduce<XNode | undefined>((cur, nm) => kid(cur, nm), n);
function descend(n: XNode | undefined, name: string, out: XNode[] = []): XNode[] {
  for (const c of n?.c ?? []) {
    if (c.n === name) out.push(c);
    descend(c, name, out);
  }
  return out;
}
const hex = (v: string | undefined) => (v && /^[0-9a-f]{6}$/i.test(v) ? `#${v}` : undefined);
const num = (v: string | undefined) => (v !== undefined && v !== "" && Number.isFinite(Number(v)) ? Number(v) : undefined);

/** Resolves the colour of a node that holds an `a:solidFill` (or of a colour node itself) to `#rrggbb`. */
type Palette = (host: XNode | undefined) => string | undefined;
type Colours = { host: Palette; node: (n: XNode | undefined) => string | undefined };

function lightness(rgb: [number, number, number], f: (l: number) => number): [number, number, number] {
  const [r, g, b] = rgb.map((v) => v / 255);
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const l = (mx + mn) / 2;
  const d = mx - mn;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  let h = 0;
  if (d) h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h = (h * 60 + 360) % 360;
  const l2 = Math.min(1, Math.max(0, f(l)));
  const c = (1 - Math.abs(2 * l2 - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l2 - c / 2;
  const [r1, g1, b1] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [(r1 + m) * 255, (g1 + m) * 255, (b1 + m) * 255];
}

const clrChild = (n: XNode | undefined) => n?.c.find((c) => /^a:(srgb|scheme|sys)Clr$/.test(c.n));

function makeColours(theme: XNode | undefined, master: XNode | undefined): Colours {
  const scheme = at(theme, "a:themeElements", "a:clrScheme");
  const themeClr = (name: string) => {
    const c = kid(scheme, `a:${name}`)?.c[0];
    return c?.n === "a:srgbClr" ? c.a.val : c?.n === "a:sysClr" ? c.a.lastClr : undefined;
  };
  const cm = kid(master, "p:clrMap");
  const map: Record<string, string> = { bg1: "lt1", tx1: "dk1", bg2: "lt2", tx2: "dk2" };
  const resolveName = (n: string | undefined) => (!n || n === "phClr" ? undefined : themeClr(cm?.a[n] ?? map[n] ?? n));
  const node = (n: XNode | undefined): string | undefined => {
    if (!n) return undefined;
    const raw =
      n.n === "a:srgbClr" ? n.a.val : n.n === "a:schemeClr" ? resolveName(n.a.val) : n.n === "a:sysClr" ? (n.a.lastClr ?? (n.a.val === "window" ? "FFFFFF" : n.a.val === "windowText" ? "000000" : undefined)) : undefined;
    if (!raw || !/^[0-9a-f]{6}$/i.test(raw)) return undefined;
    let rgb: [number, number, number] = [0, 2, 4].map((i) => parseInt(raw.slice(i, i + 2), 16)) as [number, number, number];
    for (const m of n.c) {
      const v = (num(m.a.val) ?? 100000) / 100000;
      if (m.n === "a:lumMod") rgb = lightness(rgb, (l) => l * v);
      else if (m.n === "a:lumOff") rgb = lightness(rgb, (l) => l + v);
      else if (m.n === "a:tint") rgb = rgb.map((c) => c * v + 255 * (1 - v)) as [number, number, number];
      else if (m.n === "a:shade") rgb = rgb.map((c) => c * v) as [number, number, number];
    }
    return hex(rgb.map((c) => Math.round(Math.min(255, Math.max(0, c))).toString(16).padStart(2, "0")).join(""));
  };
  return { node, host: (h) => node(clrChild(kid(h, "a:solidFill"))) };
}

type Xf = { x: number; y: number; cx: number; cy: number };
function xfOf(x: XNode | undefined): Xf | undefined {
  const off = kid(x, "a:off");
  const ext = kid(x, "a:ext");
  const [ox, oy, cx, cy] = [num(off?.a.x), num(off?.a.y), num(ext?.a.cx), num(ext?.a.cy)];
  return ox === undefined || oy === undefined || cx === undefined || cy === undefined ? undefined : { x: ox, y: oy, cx, cy };
}
/** Per-axis map from a group's child space to slide EMU: X = s*x + o. */
type Tx = { sx: number; sy: number; ox: number; oy: number };

const phOf = (sp: XNode) => at(sp, "p:nvSpPr", "p:nvPr", "p:ph");
const phClass = (t: string | undefined) => (t === "title" || t === "ctrTitle" ? "title" : !t || t === "body" || t === "subTitle" || t === "obj" ? "body" : t);
function matchPh(root: XNode | undefined, ph: XNode, useIdx: boolean): XNode | undefined {
  const cands = descend(at(root, "p:cSld", "p:spTree"), "p:sp").filter((s) => phOf(s));
  if (useIdx && ph.a.idx !== undefined) {
    const byIdx = cands.find((s) => phOf(s)!.a.idx === ph.a.idx);
    if (byIdx) return byIdx;
  }
  return cands.find((s) => phClass(phOf(s)!.a.type) === phClass(ph.a.type));
}

type Deck = { w: number; h: number; layout?: XNode; master?: XNode };
type TextCtx = { def?: string; col: Palette; cls: string; sub: boolean; lvlNodes: (lvl: number) => (XNode | undefined)[]; scale: number };

function defaultSize(cls: string): number {
  return cls === "title" ? 40 : cls === "body" ? 24 : 18;
}

function parseParas(tx: XNode | undefined, ctx: TextCtx): Para[] {
  const out: Para[] = [];
  for (const p of kidsOf(tx, "a:p")) {
    const pPr = kid(p, "a:pPr");
    const lvl = Math.max(0, Math.min(8, num(pPr?.a.lvl) ?? 0));
    const styles = ctx.lvlNodes(lvl);
    const pick = <T,>(f: (n: XNode | undefined) => T | undefined): T | undefined => {
      for (const s of [pPr, ...styles]) {
        const v = f(s);
        if (v !== undefined) return v;
      }
      return undefined;
    };
    const inherited = pick((s) => num(kid(s, "a:defRPr")?.a.sz));
    const sizeOf = (r: XNode | undefined) => {
      const sz = num(r?.a.sz) ?? inherited;
      const pt = sz !== undefined ? sz / 100 : Math.max(12, defaultSize(ctx.cls) - lvl * 2);
      return Math.max(4, Math.round(pt * ctx.scale * 10) / 10);
    };
    const algnRaw = pick((s) => s?.a.algn);
    const algn: Para["algn"] = algnRaw === "ctr" || algnRaw === "r" || algnRaw === "just" ? algnRaw : "l";
    const bullet =
      pick((s) => (kid(s, "a:buNone") ? false : kid(s, "a:buChar") || kid(s, "a:buAutoNum") ? true : undefined)) ?? (ctx.cls === "body" && !ctx.sub);
    const runs: Run[] = [];
    for (const r of p.c) {
      if (r.n === "a:br") runs.push({ text: "\n", size: sizeOf(kid(r, "a:rPr")) });
      else if (r.n === "a:r" || r.n === "a:fld") {
        const rPr = kid(r, "a:rPr");
        const text = kid(r, "a:t")?.t ?? "";
        if (!text) continue;
        const flag = (k: string) => (rPr?.a[k] === "1" || rPr?.a[k] === "true" ? true : undefined);
        runs.push({
          text,
          b: flag("b"),
          i: flag("i"),
          u: rPr?.a.u && rPr.a.u !== "none" ? true : undefined,
          size: sizeOf(rPr),
          color: ctx.col(rPr) ?? ctx.def,
        });
      }
    }
    const size = runs[0]?.size ?? sizeOf(kid(p, "a:endParaRPr"));
    out.push({ runs, algn, lvl, bullet: bullet && runs.length > 0, size });
  }
  while (out.length && !out[out.length - 1].runs.length) out.pop();
  return out;
}
const hasText = (ps: Para[]) => ps.some((p) => p.runs.some((r) => r.text.trim()));

function chartOf(xml: string): ChartData | null {
  const root = parseXml(xml);
  const chart = at(root.c.find((n) => n.n === "c:chartSpace"), "c:chart");
  if (!chart) return null;
  const title = descend(kid(chart, "c:title"), "a:t").map((t) => t.t).join("");
  const plot = kid(chart, "c:plotArea");
  const typeNode = plot?.c.find((n) => /^c:(bar|bar3D|line|line3D|area|area3D|pie|pie3D|doughnut|scatter|radar|ofPie)Chart$/.test(n.n));
  if (!typeNode) return null;
  const tn = typeNode.n.slice(2).replace("3D", "");
  const kind: ChartData["kind"] =
    tn === "barChart"
      ? kid(typeNode, "c:barDir")?.a.val === "bar"
        ? "bar"
        : "column"
      : tn === "lineChart" || tn === "areaChart"
        ? "line"
        : tn === "pieChart" || tn === "doughnutChart"
          ? "pie"
          : "table";
  const pts = (n: XNode | undefined) => {
    const arr: string[] = [];
    for (const p of descend(n, "c:pt")) {
      const i = num(p.a.idx);
      if (i !== undefined && i >= 0 && i < 5000) arr[i] = kid(p, "c:v")?.t ?? "";
    }
    return Array.from(arr, (v) => v ?? "");
  };
  const sers = kidsOf(typeNode, "c:ser").slice(0, 12);
  const cats = pts(kid(sers[0], "c:cat") ?? kid(sers[0], "c:xVal")).slice(0, 200);
  const series = sers.map((s, i) => ({
    name: descend(kid(s, "c:tx"), "c:v").map((v) => v.t).join("") || `Series ${i + 1}`,
    vals: pts(kid(s, "c:val") ?? kid(s, "c:yVal"))
      .slice(0, 200)
      .map((v) => (Number.isFinite(parseFloat(v)) ? parseFloat(v) : 0)),
    color: hex(at(s, "c:spPr", "a:solidFill", "a:srgbClr")?.a.val),
  }));
  if (!series.length) return null;
  return { kind, title, cats, series };
}

type Walk = {
  col: Palette;
  cn: (n: XNode | undefined) => string | undefined;
  deck: Deck;
  rl: Map<string, string>;
  z: { xml: Record<string, string>; bin: Record<string, Uint8Array> };
  out: El[];
};

function walkTree(tree: XNode, T: Tx, w: Walk): void {
  const { deck, out } = w;
  const box = (xf: Xf): Box => ({ x: (T.ox + T.sx * xf.x) / deck.w, y: (T.oy + T.sy * xf.y) / deck.h, w: (T.sx * xf.cx) / deck.w, h: (T.sy * xf.cy) / deck.h });
  for (const ch of tree.c) {
    if (ch.n === "mc:AlternateContent") {
      const choice = kid(ch, "mc:Choice");
      const sub: Walk = { ...w, out: [] };
      if (choice) walkTree(choice, T, sub);
      const fb = kid(ch, "mc:Fallback");
      if (fb && (!sub.out.length || descend(choice, "a14:m").length)) walkTree(fb, T, w);
      else out.push(...sub.out);
    } else if (ch.n === "p:grpSp") {
      const g = at(ch, "p:grpSpPr", "a:xfrm");
      const xf = xfOf(g);
      const chOff = kid(g, "a:chOff");
      const chExt = kid(g, "a:chExt");
      const [cox, coy, ccx, ccy] = [num(chOff?.a.x), num(chOff?.a.y), num(chExt?.a.cx), num(chExt?.a.cy)];
      if (!xf || cox === undefined || coy === undefined || !ccx || !ccy) walkTree(ch, T, w);
      else {
        const kx = xf.cx / ccx;
        const ky = xf.cy / ccy;
        walkTree(ch, { sx: T.sx * kx, sy: T.sy * ky, ox: T.ox + T.sx * (xf.x - cox * kx), oy: T.oy + T.sy * (xf.y - coy * ky) }, w);
      }
    } else if (ch.n === "p:sp") addSp(ch, w, box);
    else if (ch.n === "p:pic") {
      const ph = at(ch, "p:nvPicPr", "p:nvPr", "p:ph");
      const xf =
        xfOf(at(ch, "p:spPr", "a:xfrm")) ??
        (ph ? (xfOf(at(matchPh(deck.layout, ph, true), "p:spPr", "a:xfrm")) ?? xfOf(at(matchPh(deck.master, ph, false), "p:spPr", "a:xfrm"))) : undefined);
      const img = image(w.z.bin, w.rl.get(at(ch, "p:blipFill", "a:blip")?.a["r:embed"] ?? ""));
      if (xf && img) out.push({ t: "img", img, ...box(xf) });
    } else if (ch.n === "p:graphicFrame") addFrame(ch, w, box);
  }
}

function addSp(sp: XNode, w: Walk, box: (xf: Xf) => Box): void {
  const ph = phOf(sp);
  const type = ph?.a.type;
  if (type === "dt" || type === "ftr" || type === "sldNum") return;
  const spPr = kid(sp, "p:spPr");
  const lay = ph ? matchPh(w.deck.layout, ph, true) : undefined;
  const mas = ph ? matchPh(w.deck.master, ph, false) : undefined;
  const cls = ph ? phClass(type) : "other";
  const xf = xfOf(kid(spPr, "a:xfrm")) ?? xfOf(at(lay, "p:spPr", "a:xfrm")) ?? xfOf(at(mas, "p:spPr", "a:xfrm"));
  const b: Box = xf ? box(xf) : cls === "title" ? { x: 0.05, y: 0.04, w: 0.9, h: 0.2 } : { x: 0.05, y: 0.28, w: 0.9, h: 0.62 };
  const spImg = image(w.z.bin, w.rl.get(at(spPr, "a:blipFill", "a:blip")?.a["r:embed"] ?? ""));
  if (spImg && xf) w.out.push({ t: "img", img: spImg, ...b });
  const st = kid(sp, "p:style");
  const tx = kid(sp, "p:txBody");
  const bodyPr = kid(tx, "a:bodyPr");
  const anc = bodyPr?.a.anchor ?? at(lay, "p:txBody", "a:bodyPr")?.a.anchor ?? at(mas, "p:txBody", "a:bodyPr")?.a.anchor;
  const anchor = anc === "ctr" || anc === "b" ? anc : "t";
  const fs = num(kid(bodyPr, "a:normAutofit")?.a.fontScale);
  const style = cls === "title" ? "p:titleStyle" : cls === "body" ? "p:bodyStyle" : "p:otherStyle";
  const txStyle = at(w.deck.master, "p:txStyles", style);
  const lst = [kid(tx, "a:lstStyle"), at(lay, "p:txBody", "a:lstStyle"), at(mas, "p:txBody", "a:lstStyle"), txStyle];
  const paras = parseParas(tx, {
    def: w.cn(clrChild(kid(st, "a:fontRef"))),
    col: w.col,
    cls,
    sub: type === "subTitle",
    scale: fs ? fs / 100000 : 1,
    lvlNodes: (l) => lst.map((s) => kid(s, `a:lvl${l + 1}pPr`)),
  });
  const ln = kid(spPr, "a:ln");
  // Fill and outline: explicit in spPr, else from the shape style (p:style fillRef / lnRef) unless spPr says none.
  const refClr = (ref: XNode | undefined) => (ref && num(ref.a.idx) !== 0 ? w.cn(clrChild(ref)) : undefined);
  const grad = kid(kid(spPr, "a:gradFill"), "a:gsLst")?.c.find((g) => g.n === "a:gs");
  const fill = w.col(spPr) ?? (grad ? w.cn(clrChild(grad)) : undefined) ?? (kid(spPr, "a:noFill") || kid(spPr, "a:blipFill") || grad ? undefined : refClr(kid(st, "a:fillRef")));
  const line = w.col(ln) ?? (kid(ln, "a:noFill") || kid(ln, "a:gradFill") ? undefined : refClr(kid(st, "a:lnRef")));
  if (!hasText(paras) && !fill && !line) return;
  w.out.push({ t: "text", paras, anchor, fill, line, lineW: line ? Math.max(0.5, (num(ln?.a.w) ?? 12700) / 12700) : undefined, ...b });
}

function addFrame(fr: XNode, w: Walk, box: (xf: Xf) => Box): void {
  const xf = xfOf(kid(fr, "p:xfrm"));
  const gd = at(fr, "a:graphic", "a:graphicData");
  if (!xf || !gd) return;
  const b = box(xf);
  const tbl = kid(gd, "a:tbl");
  if (tbl) {
    const cols = kidsOf(kid(tbl, "a:tblGrid"), "a:gridCol").map((g) => Math.max(1, num(g.a.w) ?? 1));
    const trs = kidsOf(tbl, "a:tr").slice(0, 500);
    if (!cols.length || !trs.length) return;
    const first = kid(tbl, "a:tblPr")?.a.firstRow === "1";
    const ctx: TextCtx = { col: w.col, cls: "other", sub: true, scale: 1, lvlNodes: () => [] };
    const hs = trs.map((r) => Math.max(1, num(r.a.h) ?? 1));
    const cs = cols.reduce((a, c) => a + c, 0);
    const hsum = hs.reduce((a, c) => a + c, 0);
    const rows = trs.map((tr, ri) => ({
      h: hs[ri] / hsum,
      cells: kidsOf(tr, "a:tc")
        .filter((tc) => tc.a.hMerge !== "1" && tc.a.vMerge !== "1")
        .map<Cell>((tc) => ({
          paras: parseParas(kid(tc, "a:txBody"), ctx),
          colSpan: Math.max(1, num(tc.a.gridSpan) ?? 1),
          rowSpan: Math.max(1, num(tc.a.rowSpan) ?? 1),
          fill: w.col(kid(tc, "a:tcPr")),
          header: first && ri === 0,
        })),
    }));
    w.out.push({ t: "table", cols: cols.map((c) => c / cs), rows, ...b });
    return;
  }
  const cid = kid(gd, "c:chart")?.a["r:id"];
  if (cid) {
    const p = w.rl.get(cid);
    const chart = p && w.z.xml[p] ? chartOf(w.z.xml[p]) : null;
    if (chart) w.out.push({ t: "chart", chart, ...b });
    return;
  }
  const ids = kid(gd, "dgm:relIds");
  if (ids) {
    const dataPath = w.rl.get(ids.a["r:dm"] ?? "");
    const dataXml = dataPath ? w.z.xml[dataPath] : undefined;
    const data = dataXml ? parseXml(dataXml) : undefined;
    const ext = data ? descend(data, "dsp:dataModelExt")[0] : undefined;
    const drawPath = ext ? w.rl.get(ext.a.relId ?? "") : undefined;
    const drawXml = drawPath ? w.z.xml[drawPath] : undefined;
    const sps = drawXml ? descend(parseXml(drawXml), "dsp:sp") : [];
    let made = 0;
    for (const sp of sps) {
      const sx = xfOf(at(sp, "dsp:spPr", "a:xfrm"));
      if (!sx || !xf.cx || !xf.cy) continue;
      const tx = kid(sp, "dsp:txBody");
      const paras = parseParas(tx, { col: w.col, cls: "other", sub: true, scale: 1, lvlNodes: () => [] });
      if (!hasText(paras)) continue;
      const anc = kid(tx, "a:bodyPr")?.a.anchor;
      w.out.push({
        t: "text",
        paras,
        anchor: anc === "t" || anc === "b" ? anc : "ctr",
        fill: w.col(kid(sp, "dsp:spPr")) ?? "rgba(128,128,128,0.2)",
        line: w.col(at(sp, "dsp:spPr", "a:ln")),
        x: b.x + (sx.x / xf.cx) * b.w,
        y: b.y + (sx.y / xf.cy) * b.h,
        w: (sx.cx / xf.cx) * b.w,
        h: (sx.cy / xf.cy) * b.h,
      });
      made++;
    }
    if (made || !data) return;
    const lines = descend(data, "dgm:pt")
      .filter((p) => !p.a.type || p.a.type === "node")
      .map((p) => descend(kid(p, "dgm:t"), "a:t").map((t) => t.t).join(""))
      .filter((s) => s.trim());
    if (!lines.length) return;
    w.out.push({
      t: "text",
      anchor: "t",
      paras: lines.map((s) => ({ runs: [{ text: s, size: 18 }], algn: "l" as const, lvl: 0, bullet: true, size: 18 })),
      ...b,
    });
  }
}

/** Slides in presentation order, or null when the file isn't a readable .pptx. */
export function viewPptx(bytes: Uint8Array): Slide[] | null {
  const z = open(bytes);
  const pres = z?.xml["ppt/presentation.xml"];
  if (!z || !pres) return null;
  const sz = /<p:sldSz\b[^>]*>/.exec(pres)?.[0] ?? "";
  const sw = Number(attr(sz, "cx"));
  const sh = Number(attr(sz, "cy"));
  const okSize = sw > 0 && sh > 0;
  const W = okSize ? sw : 12192000;
  const H = okSize ? sh : 6858000;
  const presRels = rels(z.xml["ppt/_rels/presentation.xml.rels"], "ppt");
  let paths = [...pres.matchAll(/<p:sldId\b[^>]*>/g)].map((m) => presRels.get(attr(m[0], "r:id"))).filter((p): p is string => !!p && !!z.xml[p]);
  if (!paths.length)
    paths = Object.keys(z.xml)
      .filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k))
      .sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]));
  const cache = new Map<string, XNode | undefined>();
  const tree = (p: string | undefined) => {
    if (!p || !z.xml[p]) return undefined;
    if (!cache.has(p)) {
      try {
        cache.set(p, parseXml(z.xml[p]).c.find((n) => n.n[0] !== "#"));
      } catch {
        cache.set(p, undefined);
      }
    }
    return cache.get(p);
  };
  const relsFor = (path: string) => {
    const dir = path.slice(0, path.lastIndexOf("/"));
    return rels(z.xml[`${dir}/_rels/${path.slice(path.lastIndexOf("/") + 1)}.rels`], dir);
  };
  type Bg = { css: string; base?: string; img?: Img };
  const bgOf = (r: XNode | undefined, rpath: string | undefined, c: Colours): Bg | undefined => {
    const bg = at(r, "p:cSld", "p:bg");
    const pr = kid(bg, "p:bgPr");
    const solid = c.host(pr);
    if (solid) return { css: solid, base: solid };
    const gs = kidsOf(at(pr, "a:gradFill", "a:gsLst"), "a:gs")
      .map((g) => ({ clr: c.node(clrChild(g)), pos: num(g.a.pos) }))
      .filter((g): g is { clr: string; pos: number | undefined } => !!g.clr);
    if (gs.length) {
      if (gs.length === 1) return { css: gs[0].clr, base: gs[0].clr };
      const ang = num(at(pr, "a:gradFill", "a:lin")?.a.ang) ?? 5400000;
      const stops = gs.map((g, k) => `${g.clr} ${Math.min(100, Math.max(0, (g.pos ?? (k / (gs.length - 1)) * 100000) / 1000)).toFixed(1)}%`);
      const deg = (((((ang / 60000) % 360) + 360) % 360) + 90) % 360;
      return { css: `linear-gradient(${deg.toFixed(1)}deg, ${stops.join(", ")})`, base: gs[0].clr };
    }
    const blip = at(pr, "a:blipFill", "a:blip")?.a["r:embed"];
    const img = blip && rpath ? image(z.bin, relsFor(rpath).get(blip)) : null;
    if (img) return { css: "#ffffff", img };
    const ref = c.node(clrChild(kid(bg, "p:bgRef")));
    return ref ? { css: ref, base: ref } : undefined;
  };
  return paths.map((path, i) => {
    const xml = z.xml[path];
    const rl = relsFor(path);
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
    let els: El[] | null = null;
    let bg: Bg | undefined;
    try {
      const root = tree(path);
      const layoutPath = [...rl.values()].find((p) => /slideLayouts\/slideLayout\d+\.xml$/.test(p));
      const layout = tree(layoutPath);
      const masterPath = layoutPath ? [...relsFor(layoutPath).values()].find((p) => /slideMasters\/slideMaster\d+\.xml$/.test(p)) : undefined;
      const master = tree(masterPath);
      const spTree = at(root, "p:cSld", "p:spTree");
      if (!root || !spTree) throw new Error("no spTree");
      const themePath = masterPath ? [...relsFor(masterPath).values()].find((p) => /theme\/theme\d+\.xml$/.test(p)) : undefined;
      const colours = makeColours(tree(themePath), master);
      bg = bgOf(root, path, colours) ?? bgOf(layout, layoutPath, colours) ?? bgOf(master, masterPath, colours);
      const out: El[] = [];
      if (bg?.img) out.push({ t: "img", img: bg.img, x: 0, y: 0, w: 1, h: 1 });
      walkTree(spTree, { sx: 1, sy: 1, ox: 0, oy: 0 }, { col: colours.host, cn: colours.node, deck: { w: W, h: H, layout, master }, rl, z, out });
      // Pictures the walk could not place (no usable position) go in a strip along the bottom.
      const placed = new Set(out.flatMap((e) => (e.t === "img" ? [e.img.data] : [])));
      images
        .filter((im) => !placed.has(im.data))
        .slice(0, 5)
        .forEach((img, k) => out.push({ t: "img", img, x: 0.02 + k * 0.17, y: 0.82, w: 0.16, h: 0.16 }));
      els = out.length || (!paras.length && !images.length && !title) ? out : null;
    } catch {
      els = null;
    }
    return { n: i + 1, title, paras, images, w: W, h: H, bg: bg?.css, bgBase: bg?.base, els };
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
