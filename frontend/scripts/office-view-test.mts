/** Checks lib/office-view.ts on tiny Office files built here:  npx tsx scripts/office-view-test.mts */
import assert from "node:assert/strict";
import { zipSync, strToU8 } from "fflate";
import { viewPptx, viewXlsx, viewCsv, viewDocx, MAX_SHEET_ROWS, LIMITS } from "../lib/office-view";

const png = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
let passed = 0;
const check = (label: string, fn: () => void) => (fn(), passed++, console.log(`ok ${label}`));
const slide = (title: string, body: string, rid?: string) =>
  `<p:sld><p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>${title}</a:t></a:r></a:p></p:txBody></p:sp>` +
  `<p:sp><p:txBody><a:p><a:r><a:t>${body}</a:t></a:r></a:p></p:txBody></p:sp>` +
  (rid ? `<p:pic><p:blipFill><a:blip r:embed="${rid}"/></p:blipFill></p:pic>` : "") +
  `</p:spTree></p:cSld></p:sld>`;
const rel = (items: [string, string][]) =>
  `<Relationships>${items.map(([id, t]) => `<Relationship Id="${id}" Type="x" Target="${t}"/>`).join("")}</Relationships>`;

check("pptx: order from presentation, titles, text, images", () => {
  const z = zipSync({
    "ppt/presentation.xml": strToU8(`<p:presentation><p:sldIdLst><p:sldId id="1" r:id="rB"/><p:sldId id="2" r:id="rA"/></p:sldIdLst></p:presentation>`),
    "ppt/_rels/presentation.xml.rels": strToU8(rel([["rA", "slides/slide1.xml"], ["rB", "slides/slide2.xml"]])),
    "ppt/slides/slide1.xml": strToU8(slide("First file", "A &amp; B")),
    "ppt/slides/slide2.xml": strToU8(slide("Second file", "Hello", "rId2")),
    "ppt/slides/_rels/slide2.xml.rels": strToU8(rel([["rId2", "../media/image1.png"]])),
    "ppt/media/image1.png": png,
  });
  const s = viewPptx(z)!;
  assert.equal(s.length, 2);
  assert.equal(s[0].title, "Second file");
  assert.deepEqual(s[0].paras, ["Hello"]);
  assert.equal(s[0].images[0].mime, "image/png");
  assert.equal(s[1].title, "First file");
  assert.deepEqual(s[1].paras, ["A & B"]);
  assert.equal(viewPptx(zipSync({ "a.xml": strToU8("<a/>") })), null);
});

check("xlsx: sheets, shared strings, row cap", () => {
  const rows = Array.from({ length: 600 }, (_, i) => `<row r="${i + 1}"><c r="A${i + 1}" t="s"><v>0</v></c><c r="C${i + 1}"><v>${i}</v></c></row>`).join("");
  const z = zipSync({
    "xl/workbook.xml": strToU8(`<workbook><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>`),
    "xl/_rels/workbook.xml.rels": strToU8(rel([["rId1", "worksheets/sheet1.xml"]])),
    "xl/sharedStrings.xml": strToU8(`<sst><si><t>Hi</t></si></sst>`),
    "xl/worksheets/sheet1.xml": strToU8(`<worksheet><sheetData>${rows}</sheetData></worksheet>`),
  });
  const [sh] = viewXlsx(z)!;
  assert.equal(sh.name, "Data");
  assert.equal(sh.rows.length, MAX_SHEET_ROWS);
  assert.equal(sh.total, 600);
  assert.deepEqual(sh.rows[1], ["Hi", "", "1"]);
});

check("csv: quotes and tabs", () => {
  const [sh] = viewCsv('a,b\n"x, y","say ""hi"""\n');
  assert.deepEqual(sh.rows, [["a", "b"], ["x, y", 'say "hi"']]);
  assert.deepEqual(viewCsv("a\tb\n1\t2")[0].rows[1], ["1", "2"]);
});

check("docx: headings, paragraphs, lists, tables, images", () => {
  const z = zipSync({
    "word/document.xml": strToU8(
      `<w:document><w:body>` +
        `<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>Intro</w:t></w:r></w:p>` +
        `<w:p><w:r><w:t>Plain</w:t></w:r></w:p>` +
        `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/></w:numPr></w:pPr><w:r><w:t>Item</w:t></w:r></w:p>` +
        `<w:tbl><w:tr><w:tc><w:p><w:r><w:t>c1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>c2</w:t></w:r></w:p></w:tc></w:tr></w:tbl>` +
        `<w:p><w:r><w:drawing><a:blip r:embed="rId5"/></w:drawing></w:r></w:p>` +
        `</w:body></w:document>`,
    ),
    "word/_rels/document.xml.rels": strToU8(rel([["rId5", "media/p.png"]])),
    "word/media/p.png": png,
  });
  const b = viewDocx(z)!;
  assert.deepEqual(b[0], { type: "h", level: 2, text: "Intro" });
  assert.deepEqual(b[1], { type: "p", text: "Plain", list: false });
  assert.deepEqual(b[2], { type: "p", text: "Item", list: true });
  assert.deepEqual(b[3], { type: "table", rows: [["c1", "c2"]] });
  assert.equal(b[4].type, "img");
  assert.equal(viewDocx(new Uint8Array([1, 2, 3])), null);
});

check("zip limits: oversized entries skipped", () => {
  const big = strToU8("x".repeat(5000));
  const z = zipSync({
    "ppt/presentation.xml": strToU8(`<p:presentation/>`),
    "ppt/media/big.png": big,
    "ppt/media/small.png": png,
  });
  assert.ok(viewPptx(z));
  const saved = { ...LIMITS };
  LIMITS.entry = 1000;
  const kept = viewPptx(zipSync({ "ppt/presentation.xml": strToU8("<p:presentation/>"), "ppt/slides/slide1.xml": strToU8(slide("T", "b", "r1")), "ppt/slides/_rels/slide1.xml.rels": strToU8(rel([["r1", "../media/big.png"]])), "ppt/media/big.png": big }))!;
  assert.equal(kept[0].images.length, 0);
  assert.equal(viewPptx(zipSync({ "ppt/presentation.xml": strToU8("<p:presentation>" + "y".repeat(5000) + "</p:presentation>") })), null);
  Object.assign(LIMITS, saved, { total: 3000 });
  const kept2 = viewPptx(zipSync({ "ppt/presentation.xml": strToU8("<p:presentation/>"), "ppt/slides/slide1.xml": strToU8(slide("T", "b", "r1")), "ppt/slides/_rels/slide1.xml.rels": strToU8(rel([["r1", "../media/big.png"]])), "ppt/media/big.png": big }))!;
  assert.equal(kept2[0].images.length, 0);
  Object.assign(LIMITS, saved);
});

check("xlsx: far column ignored, trailing empties trimmed", () => {
  const z = zipSync({
    "xl/workbook.xml": strToU8(`<workbook><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>`),
    "xl/_rels/workbook.xml.rels": strToU8(rel([["rId1", "worksheets/sheet1.xml"]])),
    "xl/worksheets/sheet1.xml": strToU8(`<worksheet><sheetData><row r="1"><c r="A1"><v>1</v></c><c r="XFD1"><v>9</v></c><c r="C1"><v></v></c></row></sheetData></worksheet>`),
  });
  const [sh] = viewXlsx(z)!;
  assert.deepEqual(sh.rows[0], ["1"]);
});

// ---- positioned rebuild
const NS = `xmlns:a="a" xmlns:p="p" xmlns:r="r" xmlns:c="c" xmlns:dgm="dgm" xmlns:dsp="dsp"`;
const xfrm = (x: number, y: number, cx: number, cy: number, tag = "a:xfrm") => `<${tag}><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></${tag}>`;
const para = (t: string, rpr = "") => `<a:p><a:r><a:rPr ${rpr}/><a:t>${t}</a:t></a:r></a:p>`;
const deck = (spTree: string, extra: Record<string, Uint8Array> = {}, slideRels: [string, string][] = []) =>
  zipSync({
    "ppt/presentation.xml": strToU8(`<p:presentation ${NS}><p:sldIdLst><p:sldId id="1" r:id="rS"/></p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/></p:presentation>`),
    "ppt/_rels/presentation.xml.rels": strToU8(rel([["rS", "slides/slide1.xml"]])),
    "ppt/slides/slide1.xml": strToU8(`<p:sld ${NS}><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="112233"/></a:solidFill></p:bgPr></p:bg><p:spTree>${spTree}</p:spTree></p:cSld></p:sld>`),
    "ppt/slides/_rels/slide1.xml.rels": strToU8(rel(slideRels)),
    ...extra,
  });
const textSp = (x: number, y: number, cx: number, cy: number, body: string) =>
  `<p:sp><p:nvSpPr><p:nvPr/></p:nvSpPr><p:spPr>${xfrm(x, y, cx, cy)}</p:spPr><p:txBody><a:bodyPr/>${body}</p:txBody></p:sp>`;
const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;

check("positioned: xfrm to fractions, size, runs, background", () => {
  const [s] = viewPptx(deck(textSp(914400, 685800, 4572000, 1371600, para("Hi", `sz="3200" b="1"`))))!;
  assert.equal(s.w, 9144000);
  assert.equal(s.bg, "#112233");
  const e = s.els![0];
  assert.equal(e.t, "text");
  assert.ok(near(e.x, 0.1) && near(e.y, 0.1) && near(e.w, 0.5) && near(e.h, 0.2), JSON.stringify(e));
  if (e.t === "text") {
    assert.equal(e.paras[0].runs[0].size, 32);
    assert.equal(e.paras[0].runs[0].b, true);
  }
});

check("positioned: placeholder inherits xfrm from layout", () => {
  const z = deck(
    `<p:sp><p:nvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/>${para("Body")}</p:txBody></p:sp>`,
    {
      "ppt/slideLayouts/slideLayout1.xml": strToU8(
        `<p:sldLayout ${NS}><p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr>${xfrm(457200, 1371600, 8229600, 3429000)}</p:spPr></p:sp></p:spTree></p:cSld></p:sldLayout>`,
      ),
    },
    [["rL", "../slideLayouts/slideLayout1.xml"]],
  );
  const e = viewPptx(z)![0].els![0];
  assert.ok(near(e.x, 0.05) && near(e.y, 0.2) && near(e.w, 0.9) && near(e.h, 0.5), JSON.stringify(e));
  if (e.t === "text") assert.equal(e.paras[0].bullet, true);
});

check("positioned: table keeps 2x3 grid and a merged cell", () => {
  const tc = (t: string, a = "") => `<a:tc ${a}><a:txBody><a:bodyPr/>${para(t)}</a:txBody><a:tcPr/></a:tc>`;
  const frame =
    `<p:graphicFrame><p:xfrm><a:off x="0" y="0"/><a:ext cx="9144000" cy="3429000"/></p:xfrm><a:graphic><a:graphicData><a:tbl><a:tblPr firstRow="1"/><a:tblGrid><a:gridCol w="3000000"/><a:gridCol w="3000000"/><a:gridCol w="3144000"/></a:tblGrid>` +
    `<a:tr h="1000000">${tc("Wide", `gridSpan="2"`)}${tc("", `hMerge="1"`)}${tc("C")}</a:tr>` +
    `<a:tr h="1000000">${tc("a")}${tc("b")}${tc("c")}</a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
  const e = viewPptx(deck(frame))![0].els![0];
  assert.equal(e.t, "table");
  if (e.t !== "table") return;
  assert.equal(e.cols.length, 3);
  assert.equal(e.rows.length, 2);
  assert.equal(e.rows[0].cells.length, 2);
  assert.equal(e.rows[0].cells[0].colSpan, 2);
  assert.equal(e.rows[0].cells[0].header, true);
  assert.equal(e.rows[1].cells.length, 3);
  assert.equal(e.rows[1].cells[2].paras[0].runs[0].text, "c");
});

check("positioned: group child mapped through chOff/chExt", () => {
  const grp = `<p:grpSp><p:grpSpPr><a:xfrm><a:off x="4572000" y="0"/><a:ext cx="4572000" cy="3429000"/><a:chOff x="100" y="100"/><a:chExt cx="1000" cy="1000"/></a:xfrm></p:grpSpPr>${textSp(600, 100, 500, 500, para("In"))}</p:grpSp>`;
  const e = viewPptx(deck(grp))![0].els![0];
  // x: 4572000 + (600-100)*4572 = 6858000 -> 0.75; w 500*4572 -> 0.25; y 0; h 500*3429 / 6858000 = 0.25
  assert.ok(near(e.x, 0.75) && near(e.y, 0) && near(e.w, 0.25) && near(e.h, 0.25), JSON.stringify(e));
});

check("positioned: SmartArt reads the drawing part, falls back to data text", () => {
  const frame = `<p:graphicFrame><p:xfrm><a:off x="1000000" y="1000000"/><a:ext cx="4000000" cy="2000000"/></p:xfrm><a:graphic><a:graphicData><dgm:relIds r:dm="rD" r:lo="rX" r:qs="rX" r:cs="rX"/></a:graphicData></a:graphic></p:graphicFrame>`;
  const node = (t: string, type: string) => `<dgm:pt type="${type}"><dgm:t><a:p><a:r><a:t>${t}</a:t></a:r></a:p></dgm:t></dgm:pt>`;
  const data = (ext: string) => `<dgm:dataModel ${NS}><dgm:ptLst>${node("Alpha", "node")}${node("Beta", "node")}${node("skip", "pres")}</dgm:ptLst>${ext}</dgm:dataModel>`;
  const drawn = deck(
    frame,
    {
      "ppt/diagrams/data1.xml": strToU8(data(`<dgm:extLst><a:ext><dsp:dataModelExt relId="rW"/></a:ext></dgm:extLst>`)),
      "ppt/diagrams/drawing1.xml": strToU8(`<dsp:drawing ${NS}><dsp:spTree><dsp:sp><dsp:spPr>${xfrm(0, 0, 2000000, 1000000)}</dsp:spPr><dsp:txBody><a:bodyPr/>${para("Drawn", `sz="2000"`)}</dsp:txBody></dsp:sp></dsp:spTree></dsp:drawing>`),
    },
    [["rD", "../diagrams/data1.xml"], ["rW", "../diagrams/drawing1.xml"]],
  );
  const e = viewPptx(drawn)![0].els![0];
  assert.equal(e.t, "text");
  if (e.t === "text") assert.equal(e.paras[0].runs[0].text, "Drawn");
  // placed inside the frame: x = frame x, w = half the frame width
  assert.ok(near(e.x, 1000000 / 9144000) && near(e.w, 2000000 / 9144000), JSON.stringify(e));
  const fb = deck(frame, { "ppt/diagrams/data1.xml": strToU8(data("")) }, [["rD", "../diagrams/data1.xml"]]);
  const els = viewPptx(fb)![0].els!;
  assert.equal(els.length, 1);
  if (els[0].t === "text") assert.deepEqual(els[0].paras.map((p) => p.runs[0].text), ["Alpha", "Beta"]);
});

check("positioned: chart categories, series and values", () => {
  const frame = `<p:graphicFrame><p:xfrm><a:off x="0" y="0"/><a:ext cx="4000000" cy="3000000"/></p:xfrm><a:graphic><a:graphicData><c:chart r:id="rC"/></a:graphicData></a:graphic></p:graphicFrame>`;
  const pt = (i: number, v: string | number) => `<c:pt idx="${i}"><c:v>${v}</c:v></c:pt>`;
  const chart =
    `<c:chartSpace ${NS}><c:chart><c:title><c:tx><c:rich><a:p><a:r><a:t>Sales</a:t></a:r></a:p></c:rich></c:tx></c:title><c:plotArea><c:barChart><c:barDir val="col"/><c:ser>` +
    `<c:tx><c:strRef><c:strCache>${pt(0, 2024)}</c:strCache></c:strRef></c:tx>` +
    `<c:cat><c:strRef><c:strCache><c:ptCount val="3"/>${pt(0, "A")}${pt(1, "B")}${pt(2, "C")}</c:strCache></c:strRef></c:cat>` +
    `<c:val><c:numRef><c:numCache>${pt(0, 1.5)}${pt(1, 2)}${pt(2, 4)}</c:numCache></c:numRef></c:val></c:ser></c:barChart></c:plotArea></c:chart></c:chartSpace>`;
  const e = viewPptx(deck(frame, { "ppt/charts/chart1.xml": strToU8(chart) }, [["rC", "../charts/chart1.xml"]]))![0].els![0];
  assert.equal(e.t, "chart");
  if (e.t !== "chart") return;
  assert.equal(e.chart.kind, "column");
  assert.equal(e.chart.title, "Sales");
  assert.deepEqual(e.chart.cats, ["A", "B", "C"]);
  assert.equal(e.chart.series[0].name, "2024");
  assert.deepEqual(e.chart.series[0].vals, [1.5, 2, 4]);
});

check("positioned: slide with no spTree falls back (els null), legacy text kept", () => {
  const z = zipSync({
    "ppt/presentation.xml": strToU8(`<p:presentation/>`),
    "ppt/slides/slide1.xml": strToU8(`<p:sld><p:sp><p:txBody><a:p><a:r><a:t>Plain</a:t></a:r></a:p></p:txBody></p:sp></p:sld>`),
  });
  const [s] = viewPptx(z)!;
  assert.equal(s.els, null);
  assert.deepEqual(s.paras, ["Plain"]);
  assert.equal(s.w, 12192000);
});

check("positioned: all-unsupported slide falls back; unplaced picture is kept", () => {
  const wrapped = `<p:custom><p:sp><p:txBody><a:p><a:r><a:t>Hidden text</a:t></a:r></a:p></p:txBody></p:sp></p:custom>`;
  const [s] = viewPptx(deck(wrapped))!;
  assert.equal(s.els, null);
  assert.deepEqual(s.paras, ["Hidden text"]);
  const pic = `<p:pic><p:blipFill><a:blip r:embed="rI"/></p:blipFill><p:spPr/></p:pic>`;
  const [s2] = viewPptx(deck(pic, { "ppt/media/i.png": png }, [["rI", "../media/i.png"]]))!;
  assert.equal(s2.els!.length, 1);
  assert.equal(s2.els![0].t, "img");
});

check("positioned: AlternateContent uses the Fallback for equations; sp blipFill is an image", () => {
  const ac =
    `<mc:AlternateContent><mc:Choice Requires="a14"><p:sp><p:nvSpPr><p:nvPr/></p:nvSpPr><p:spPr>${xfrm(0, 0, 100, 100)}</p:spPr><p:txBody><a:p><a14:m><m:oMath/></a14:m></a:p></p:txBody></p:sp></mc:Choice>` +
    `<mc:Fallback><p:sp><p:nvSpPr><p:nvPr/></p:nvSpPr><p:spPr>${xfrm(914400, 914400, 1828800, 914400)}<a:blipFill><a:blip r:embed="rE"/></a:blipFill></p:spPr></p:sp></mc:Fallback></mc:AlternateContent>`;
  const els = viewPptx(deck(ac, { "ppt/media/eq.png": png }, [["rE", "../media/eq.png"]]))![0].els!;
  assert.equal(els.length, 1);
  assert.equal(els[0].t, "img");
  assert.ok(near(els[0].x, 0.1) && near(els[0].w, 0.2), JSON.stringify(els[0]));
});

check("positioned: picture placeholder inherits its position from the layout", () => {
  const pic = `<p:pic><p:nvPicPr><p:cNvPr id="4" name="P"/><p:cNvPicPr/><p:nvPr><p:ph type="pic" idx="2"/></p:nvPr></p:nvPicPr><p:blipFill><a:blip r:embed="rI"/></p:blipFill><p:spPr/></p:pic>`;
  const z = deck(
    pic,
    {
      "ppt/media/i.png": png,
      "ppt/slideLayouts/slideLayout1.xml": strToU8(
        `<p:sldLayout ${NS}><p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph type="pic" idx="2"/></p:nvPr></p:nvSpPr><p:spPr>${xfrm(4572000, 0, 4572000, 3429000)}</p:spPr></p:sp></p:spTree></p:cSld></p:sldLayout>`,
      ),
    },
    [["rI", "../media/i.png"], ["rL", "../slideLayouts/slideLayout1.xml"]],
  );
  const e = viewPptx(z)![0].els![0];
  assert.equal(e.t, "img");
  assert.ok(near(e.x, 0.5) && near(e.w, 0.5) && near(e.h, 0.5), JSON.stringify(e));
});

check("positioned: theme colours via clrMap, lumMod and bgRef", () => {
  const clr = (n: string, v: string) => `<a:${n}><a:srgbClr val="${v}"/></a:${n}>`;
  const theme =
    `<a:theme ${NS}><a:themeElements><a:clrScheme name="t"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>` +
    `${clr("dk2", "44546A")}${clr("lt2", "E7E6E6")}${clr("accent1", "4472C4")}</a:clrScheme></a:themeElements></a:theme>`;
  const master = `<p:sldMaster ${NS}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree/></p:cSld><p:clrMap bg1="dk1" tx1="lt1" bg2="dk2" tx2="lt2"/></p:sldMaster>`;
  const run = (c: string) => `<a:p><a:r><a:rPr><a:solidFill>${c}</a:solidFill></a:rPr><a:t>x</a:t></a:r></a:p>`;
  const sp =
    textSp(0, 0, 100, 100, run(`<a:schemeClr val="tx1"/>`)) +
    textSp(0, 0, 100, 100, run(`<a:schemeClr val="accent1"><a:lumMod val="50000"/></a:schemeClr>`)) +
    `<p:sp><p:nvSpPr><p:nvPr/></p:nvSpPr><p:spPr>${xfrm(0, 0, 100, 100)}<a:solidFill><a:schemeClr val="accent1"/></a:solidFill></p:spPr></p:sp>`;
  const z = zipSync({
    "ppt/presentation.xml": strToU8(`<p:presentation ${NS}><p:sldIdLst><p:sldId id="1" r:id="rS"/></p:sldIdLst></p:presentation>`),
    "ppt/_rels/presentation.xml.rels": strToU8(rel([["rS", "slides/slide1.xml"]])),
    "ppt/slides/slide1.xml": strToU8(`<p:sld ${NS}><p:cSld><p:spTree>${sp}</p:spTree></p:cSld></p:sld>`),
    "ppt/slides/_rels/slide1.xml.rels": strToU8(rel([["rL", "../slideLayouts/slideLayout1.xml"]])),
    "ppt/slideLayouts/slideLayout1.xml": strToU8(`<p:sldLayout ${NS}><p:cSld><p:spTree/></p:cSld></p:sldLayout>`),
    "ppt/slideLayouts/_rels/slideLayout1.xml.rels": strToU8(rel([["rM", "../slideMasters/slideMaster1.xml"]])),
    "ppt/slideMasters/slideMaster1.xml": strToU8(master),
    "ppt/slideMasters/_rels/slideMaster1.xml.rels": strToU8(rel([["rT", "../theme/theme1.xml"]])),
    "ppt/theme/theme1.xml": strToU8(theme),
  });
  const [s] = viewPptx(z)!;
  assert.equal(s.bg, "#000000"); // bg1 -> dk1 through the master's clrMap
  const els = s.els!;
  const text = (i: number) => (els[i].t === "text" ? (els[i] as Extract<(typeof els)[number], { t: "text" }>) : null)!;
  assert.equal(text(0).paras[0].runs[0].color, "#ffffff"); // tx1 -> lt1
  const dark = text(1).paras[0].runs[0].color!;
  assert.match(dark, /^#[0-9a-f]{6}$/);
  [0x1f, 0x38, 0x64].forEach((v, k) => assert.ok(Math.abs(parseInt(dark.slice(1 + 2 * k, 3 + 2 * k), 16) - v) <= 4, dark));
  assert.equal(text(2).fill, "#4472c4");
});

const themed = (slideXml: string, extra: Record<string, Uint8Array> = {}, slideRels: [string, string][] = []) =>
  zipSync({
    "ppt/presentation.xml": strToU8(`<p:presentation ${NS}><p:sldIdLst><p:sldId id="1" r:id="rS"/></p:sldIdLst></p:presentation>`),
    "ppt/_rels/presentation.xml.rels": strToU8(rel([["rS", "slides/slide1.xml"]])),
    "ppt/slides/slide1.xml": strToU8(slideXml),
    "ppt/slides/_rels/slide1.xml.rels": strToU8(rel([["rL", "../slideLayouts/slideLayout1.xml"], ...slideRels])),
    "ppt/slideLayouts/slideLayout1.xml": strToU8(`<p:sldLayout ${NS}><p:cSld><p:spTree/></p:cSld></p:sldLayout>`),
    "ppt/slideLayouts/_rels/slideLayout1.xml.rels": strToU8(rel([["rM", "../slideMasters/slideMaster1.xml"]])),
    "ppt/slideMasters/slideMaster1.xml": strToU8(`<p:sldMaster ${NS}><p:cSld><p:spTree/></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2"/></p:sldMaster>`),
    "ppt/slideMasters/_rels/slideMaster1.xml.rels": strToU8(rel([["rT", "../theme/theme1.xml"]])),
    "ppt/theme/theme1.xml": strToU8(
      `<a:theme ${NS}><a:themeElements><a:clrScheme name="t"><a:dk1><a:srgbClr val="000000"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2><a:accent1><a:srgbClr val="4472C4"/></a:accent1></a:clrScheme></a:themeElements></a:theme>`,
    ),
    ...extra,
  });

check("positioned: p:style fill, line and font colour; text-less styled shape renders", () => {
  const style = `<p:style><a:lnRef idx="2"><a:schemeClr val="accent1"><a:shade val="50000"/></a:schemeClr></a:lnRef><a:fillRef idx="1"><a:schemeClr val="accent1"/></a:fillRef><a:effectRef idx="0"/><a:fontRef idx="minor"><a:schemeClr val="lt1"/></a:fontRef></p:style>`;
  const sp = (body: string, spPr = "") =>
    `<p:sp><p:nvSpPr><p:nvPr/></p:nvSpPr><p:spPr>${xfrm(0, 0, 100, 100)}${spPr}</p:spPr>${style}${body}</p:sp>`;
  const xml = `<p:sld ${NS}><p:cSld><p:spTree>${sp("")}${sp(`<p:txBody><a:bodyPr/>${para("Hi")}</p:txBody>`)}${sp("", "<a:noFill/><a:ln><a:noFill/></a:ln>")}</p:spTree></p:cSld></p:sld>`;
  const els = viewPptx(themed(xml))![0].els!;
  assert.equal(els.length, 2); // the noFill/no-line, text-less shape is dropped
  const [a, b] = els;
  assert.ok(a.t === "text" && b.t === "text");
  if (a.t === "text" && b.t === "text") {
    assert.equal(a.fill, "#4472c4");
    assert.match(a.line!, /^#[0-9a-f]{6}$/);
    assert.notEqual(a.line, "#4472c4"); // shaded
    assert.equal(b.paras[0].runs[0].color, "#ffffff"); // fontRef lt1
  }
});

check("positioned: gradient background becomes a linear-gradient; picture background is a full-slide image", () => {
  const gs = (pos: number, v: string) => `<a:gs pos="${pos}"><a:srgbClr val="${v}"/></a:gs>`;
  const grad = `<p:sld ${NS}><p:cSld><p:bg><p:bgPr><a:gradFill><a:gsLst>${gs(0, "FF0000")}${gs(100000, "0000FF")}</a:gsLst><a:lin ang="5400000"/></a:gradFill></p:bgPr></p:bg><p:spTree/></p:cSld></p:sld>`;
  const [g] = viewPptx(themed(grad))!;
  assert.equal(g.bg, "linear-gradient(180.0deg, #ff0000 0.0%, #0000ff 100.0%)");
  assert.equal(g.bgBase, "#ff0000");
  const pic = `<p:sld ${NS}><p:cSld><p:bg><p:bgPr><a:blipFill><a:blip r:embed="rB"/></a:blipFill></p:bgPr></p:bg><p:spTree/></p:cSld></p:sld>`;
  const [p] = viewPptx(themed(pic, { "ppt/media/bg.png": png }, [["rB", "../media/bg.png"]]))!;
  assert.equal(p.els!.length, 1);
  const e = p.els![0];
  assert.ok(e.t === "img" && e.x === 0 && e.w === 1 && e.h === 1);
});

console.log(`${passed} passed`);
