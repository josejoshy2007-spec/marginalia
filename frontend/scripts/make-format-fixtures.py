"""Write sample PowerPoint/Word/Excel/OpenDocument/EPUB/CSV files for scripts/formats-test.mts.

    cd backend && uv run --no-project --with python-pptx --with python-docx --with openpyxl \
        --with odfpy --with ebooklib python ../frontend/scripts/make-format-fixtures.py <out-dir>
"""

import sys
from pathlib import Path

out = Path(sys.argv[1])
out.mkdir(parents=True, exist_ok=True)

# PowerPoint: 3 slides, a table, speaker notes; slide files saved out of display order is handled via presentation.xml
from pptx import Presentation
from pptx.util import Inches

prs = Presentation()
s1 = prs.slides.add_slide(prs.slide_layouts[0])
s1.shapes.title.text = "Cell Biology"
s1.placeholders[1].text = "Unit 1 & overview"
s2 = prs.slides.add_slide(prs.slide_layouts[1])
s2.shapes.title.text = "Organelles"
body = s2.placeholders[1].text_frame
body.text = "Mitochondria produce ATP"
body.add_paragraph().text = "Ribosomes synthesise proteins"
s2.notes_slide.notes_text_frame.text = "Mention the double membrane."
s3 = prs.slides.add_slide(prs.slide_layouts[5])
s3.shapes.title.text = "Comparison"
table = s3.shapes.add_table(2, 2, Inches(1), Inches(2), Inches(6), Inches(1)).table
table.cell(0, 0).text, table.cell(0, 1).text = "Prokaryote", "Eukaryote"
table.cell(1, 0).text, table.cell(1, 1).text = "No nucleus", "Nucleus"
prs.save(out / "cells.pptx")

# Word: headings, paragraphs, a table, special characters
from docx import Document

doc = Document()
doc.add_heading("Photosynthesis", 1)
doc.add_paragraph("Light-dependent reactions happen in the thylakoids.")
doc.add_paragraph("CO₂ + H₂O → glucose < energy > & oxygen")
t = doc.add_table(rows=2, cols=2)
t.cell(0, 0).text, t.cell(0, 1).text = "Stage", "Location"
t.cell(1, 0).text, t.cell(1, 1).text = "Calvin cycle", "Stroma"
doc.save(out / "notes.docx")

# Excel: two sheets, shared + inline strings, numbers, booleans, a gap column
from openpyxl import Workbook

wb = Workbook()
ws = wb.active
ws.title = "Results"
ws.append(["Trial", "Temp (°C)", "Rate"])
ws.append([1, 25, 0.42])
ws.append([2, 35, 0.61])
ws["E2"] = "outlier?"
ws2 = wb.create_sheet("Notes")
ws2["A1"] = "Rate peaks near 35 °C"
ws2["A2"] = True
wb.save(out / "data.xlsx")

# OpenDocument presentation / text / spreadsheet
from odf.opendocument import OpenDocumentPresentation, OpenDocumentSpreadsheet, OpenDocumentText
from odf.draw import Frame, Page, TextBox
from odf.style import MasterPage, PageLayout
from odf.table import Table, TableCell, TableRow
from odf.text import H, P

odp = OpenDocumentPresentation()
layout = PageLayout(name="PL")
odp.automaticstyles.addElement(layout)
master = MasterPage(name="Default", pagelayoutname=layout)
odp.masterstyles.addElement(master)
for title in ["Waves", "Interference"]:
    page = Page(masterpagename=master, name=title)
    frame = Frame(width="20cm", height="3cm", x="1cm", y="1cm")
    box = TextBox()
    box.addElement(P(text=f"{title} slide text"))
    frame.addElement(box)
    page.addElement(frame)
    odp.presentation.addElement(page)
odp.save(str(out / "waves.odp"))

odt = OpenDocumentText()
odt.text.addElement(H(outlinelevel=1, text="Economics"))
odt.text.addElement(P(text="Demand falls when price rises."))
odt.save(str(out / "econ.odt"))

ods = OpenDocumentSpreadsheet()
table = Table(name="Prices")
for row in [["Item", "Price"], ["Bread", "2.50"]]:
    tr = TableRow()
    for value in row:
        cell = TableCell()
        cell.addElement(P(text=value))
        tr.addElement(cell)
    table.addElement(tr)
ods.spreadsheet.addElement(table)
ods.save(str(out / "prices.ods"))

# EPUB: two chapters in spine order
from ebooklib import epub

book = epub.EpubBook()
book.set_identifier("t1")
book.set_title("Short History")
book.set_language("en")
c1 = epub.EpubHtml(title="One", file_name="ch1.xhtml", content="<h1>Chapter One</h1><p>The Treaty of Versailles was signed in 1919.</p>")
c2 = epub.EpubHtml(title="Two", file_name="ch2.xhtml", content="<h1>Chapter Two</h1><p>The League of Nations followed.</p>")
book.add_item(c1)
book.add_item(c2)
book.toc = (c1, c2)
book.spine = ["nav", c1, c2]
book.add_item(epub.EpubNcx())
book.add_item(epub.EpubNav())
epub.write_epub(str(out / "history.epub"), book)

(out / "scores.csv").write_text('Name,Score,Comment\nAna,7,"Good, clear"\nBen,5,"Said ""maybe"""\n', encoding="utf-8")
(out / "readme.md").write_text("# Revision plan\n\nWeek 1: cells\n", encoding="utf-8")
(out / "old.ppt").write_bytes(b"\xd0\xcf\x11\xe0 not really")
print("fixtures written to", out)
