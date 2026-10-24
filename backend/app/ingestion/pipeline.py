from collections.abc import Callable

from sqlalchemy.orm import Session

from ..config import get_settings
from ..embeddings import Embedder
from ..models import Chunk, Source
from .chunker import chunk_text
from .parse import ParsedDoc

# Small batches: a 32×512-token batch needs a ~400 MB attention buffer, too much on a busy 8 GB laptop.
EMBED_BATCH = 8


def ingest(
    db: Session,
    subject_id: int,
    kind: str,
    doc: ParsedDoc,
    embedder: Embedder,
    url: str | None = None,
) -> Source:
    """Store a parsed document as a Source with embedded, offset-tracked chunks."""
    source = Source(subject_id=subject_id, kind=kind, title=doc.title, url=url, text="", pages=[], status="ready")
    db.add(source)
    db.flush()
    store_chunks(db, source, doc, embedder)
    db.commit()
    db.refresh(source)
    return source


def store_chunks(
    db: Session,
    source: Source,
    doc: ParsedDoc,
    embedder: Embedder,
    on_progress: Callable[[float], None] | None = None,
) -> None:
    """Set the source's text/pages from `doc` and (re)build its chunks and embeddings. Caller commits."""
    s = get_settings()
    source.text = doc.text
    source.pages = [{"page": p.page, "start": p.start, "end": p.end} for p in doc.pages]
    source.chunks.clear()
    db.flush()

    spans = chunk_text(doc.text, s.chunk_tokens, s.chunk_overlap_tokens, doc.pages)
    for i in range(0, len(spans), EMBED_BATCH):
        batch = spans[i : i + EMBED_BATCH]
        vectors = embedder.embed_passages([c.text for c in batch])
        for c, vec in zip(batch, vectors):
            db.add(
                Chunk(
                    source_id=source.id,
                    ord=c.ord,
                    text=c.text,
                    char_start=c.char_start,
                    char_end=c.char_end,
                    page_start=c.page_start,
                    page_end=c.page_end,
                    token_count=c.token_count,
                    embedding=vec,
                )
            )
        if on_progress:
            on_progress(min(1.0, (i + len(batch)) / len(spans)))
