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

console.log(`${passed} passed`);
