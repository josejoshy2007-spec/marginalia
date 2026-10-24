import pytest

from app.ingestion.chunker import chunk_text, count_tokens, page_for_offset
from app.ingestion.parse import PageSpan, ParseError, html_to_doc, parse_pdf, parse_text, parse_url
from app.ingestion.pipeline import ingest
from app.models import Chunk, Subject

from .conftest import make_pdf


def _long_text(paragraphs: int = 60) -> str:
    return "\n\n".join(
        f"Paragraph {i}. Photosynthesis converts light energy into chemical energy in chloroplasts. "
        f"The Calvin cycle fixes carbon dioxide into sugars using ATP and NADPH. "
        f"Stomata regulate gas exchange and water loss for leaf number {i}."
        for i in range(paragraphs)
    )


# ---------- chunker ----------

def test_chunks_respect_token_budget_and_offsets():
    text = _long_text()
    chunks = chunk_text(text, max_tokens=200, overlap_tokens=40)
    assert len(chunks) > 3
    for c in chunks:
        assert c.token_count <= 200
        assert text[c.char_start:c.char_end] == c.text  # offsets are exact
        assert c.text == c.text.strip()
    assert [c.ord for c in chunks] == list(range(len(chunks)))


def test_chunks_overlap_and_cover_whole_text():
    text = _long_text()
    chunks = chunk_text(text, max_tokens=200, overlap_tokens=40)
    for a, b in zip(chunks, chunks[1:]):
        assert b.char_start < a.char_end, "consecutive chunks should overlap"
        assert b.char_start > a.char_start, "chunker must make progress"
    assert chunks[0].char_start == 0
    assert chunks[-1].char_end == len(text)


def test_default_budget_is_about_800_tokens():
    text = _long_text(200)
    chunks = chunk_text(text)  # defaults: 800 / 120
    assert all(c.token_count <= 800 for c in chunks)
    assert max(c.token_count for c in chunks) > 600


def test_oversized_sentence_is_split():
    text = " ".join(["word"] * 3000)  # one giant "sentence"
    chunks = chunk_text(text, max_tokens=300, overlap_tokens=30)
    assert len(chunks) > 5
    assert all(c.token_count <= 300 for c in chunks)


def test_short_text_is_single_chunk():
    chunks = chunk_text("Just one sentence.", max_tokens=800, overlap_tokens=120)
    assert len(chunks) == 1 and chunks[0].text == "Just one sentence."


def test_overlap_must_be_smaller_than_chunk():
    with pytest.raises(ValueError):
        chunk_text("abc", max_tokens=100, overlap_tokens=100)


def test_page_assignment():
    pages = [PageSpan(1, 0, 100), PageSpan(2, 102, 200), PageSpan(3, 202, 300)]
    assert page_for_offset(pages, 0) == 1
    assert page_for_offset(pages, 150) == 2
    assert page_for_offset(pages, 299) == 3


def test_count_tokens_nonzero():
    assert count_tokens("hello world") >= 2


# ---------- parsers ----------

def test_parse_pdf_tracks_pages():
    pdf = make_pdf(["Mitochondria are the powerhouse of the cell.", "Ribosomes synthesise proteins."])
    doc = parse_pdf(pdf, title="Bio")
    assert doc.title == "Bio"
    assert [p.page for p in doc.pages] == [1, 2]
    p1, p2 = doc.pages
    assert "Mitochondria" in doc.text[p1.start:p1.end]
    assert "Ribosomes" in doc.text[p2.start:p2.end]


def test_parse_pdf_rejects_garbage():
    with pytest.raises(ParseError):
        parse_pdf(b"not a pdf at all")


def test_parse_text_normalises_and_titles():
    doc = parse_text("  First line here  \r\n\r\n\r\n\r\nSecond   para ")
    assert doc.title == "First line here"
    assert doc.text == "First line here\n\nSecond para"
    with pytest.raises(ParseError):
        parse_text("   \n  ")


def test_html_to_doc_strips_chrome():
    html = """<html><head><title>Cells</title><script>evil()</script></head>
    <body><nav>Menu</nav><article><h1>Cell biology</h1>
    <p>The <a href="/n">nucleus</a>, a <b>membrane</b>-bound organelle, stores DNA.<sup class="reference">[3]</sup></p>
    </article><footer>(c) site</footer></body></html>"""
    doc = html_to_doc(html, "fallback")
    assert doc.title == "Cells"
    assert "The nucleus, a membrane-bound organelle, stores DNA." in doc.text
    assert "[3]" not in doc.text
    assert "evil" not in doc.text and "Menu" not in doc.text and "(c) site" not in doc.text


def test_parse_url_blocks_private_hosts():
    with pytest.raises(ParseError):
        parse_url("http://127.0.0.1:8000/secret")
    with pytest.raises(ParseError):
        parse_url("file:///etc/passwd")


# ---------- pipeline (DB) ----------

def test_ingest_stores_chunks_with_offsets_pages_and_embeddings(db, embedder):
    subj = Subject(name="Biology")
    db.add(subj)
    db.commit()
    pages = [_long_text(15), _long_text(15)]
    doc = parse_pdf(make_pdf(pages), title="Long PDF")
    # make_pdf puts each page on one line; pypdf returns it, so the text is long enough to chunk.
    src = ingest(db, subj.id, "pdf", doc, embedder)

    chunks = db.query(Chunk).filter_by(source_id=src.id).order_by(Chunk.ord).all()
    assert len(chunks) >= 2
    for c in chunks:
        assert src.text[c.char_start:c.char_end] == c.text
        assert c.page_start in (1, 2) and c.page_end in (1, 2)
        assert c.page_start <= c.page_end
        assert len(c.embedding) == 384
    assert chunks[0].page_start == 1
    assert chunks[-1].page_end == 2
    assert src.pages[0]["page"] == 1
