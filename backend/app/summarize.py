"""Summaries of a subject's sources: one pass for small inputs, map-reduce for whole textbooks.

Passages are numbered globally (1..N) in every request, so `[n]` citations written in the map
step survive the combining step and resolve against Artifact.passages like any other artifact.
"""

from collections.abc import Callable
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from .embeddings import Embedder
from .gemini import GeminiError
from .generate import SHEET_SCHEMA, STYLE, _focus_line, generate_json
from .models import Chunk, Source
from .retrieval import Retrieved, retrieve

FORMATS = {
    "key_points": ("Key points", "a structured summary: '##' headings per topic with concise bullet points; "
                   "bold the key terms"),
    "cornell": ("Cornell notes", "Cornell notes: for each topic a '## Topic' heading, then '**Cues**' (3–6 "
                "short recall questions as a bullet list), then '**Notes**' (bullets answering them); finish with "
                "a '## Summary' paragraph of 3–5 sentences"),
    "ib_revision": ("IB revision notes", "IB revision notes: for each topic a '## Topic' heading with "
                    "'**Key terms**' (precise, markscheme-ready definitions), '**Key ideas**' (bullets), "
                    "'**Exam angles**' (2–3 likely questions using IB command terms with marks in brackets, e.g. "
                    "'Explain why … [4]') and '**Common mistakes**'"),
    "narrative": ("Narrative", "a flowing prose summary in well-organised paragraphs with a few '##' headings, "
                  "as a textbook chapter summary would read"),
}
LENGTHS = {"brief": 300, "standard": 800, "detailed": 2000}  # target words

MAP_BATCH_TOKENS = 40_000  # per map request (~50 chunks)
SINGLE_PASS_TOKENS = 60_000  # below this, one request does it all
MAX_CHUNKS = 700  # ~1000-page textbook; beyond that ask for a page range


def summary_passages(
    db: Session,
    subject_id: int,
    source_ids: list[int],
    embedder: Embedder,
    focus: str | None = None,
    page_from: int | None = None,
    page_to: int | None = None,
) -> list[Retrieved]:
    """Chunks to summarise: all of the chosen sources (optionally a page range) in reading order,
    or, with a focus topic, the passages most related to it."""
    if not source_ids:
        return []
    if focus and focus.strip():
        hits = retrieve(db, subject_id, source_ids, embedder.embed_query(focus), k=30)
        return sorted(hits, key=lambda r: (r.source.id, r.chunk.ord))
    stmt = (
        select(Chunk, Source)
        .join(Source, Chunk.source_id == Source.id)
        .where(Source.subject_id == subject_id, Source.id.in_(source_ids))
    )
    if page_from:
        stmt = stmt.where(Chunk.page_end >= page_from)
    if page_to:
        stmt = stmt.where(Chunk.page_start <= page_to)
    rows = db.execute(stmt.order_by(Source.id, Chunk.ord).limit(MAX_CHUNKS + 1)).all()
    if len(rows) > MAX_CHUNKS:
        raise GeminiError("That's more than about 1,000 pages at once. Pick a page range (e.g. one chapter).")
    return [Retrieved(c, src, 0.0) for c, src in rows]


def batches(passages: list[Retrieved], limit: int | None = None) -> list[list[tuple[int, Retrieved]]]:
    """Split into consecutive groups under `limit` tokens (default MAP_BATCH_TOKENS), keeping global numbers."""
    limit = limit or MAP_BATCH_TOKENS
    out: list[list[tuple[int, Retrieved]]] = []
    cur: list[tuple[int, Retrieved]] = []
    size = 0
    for n, r in enumerate(passages, start=1):
        if cur and size + r.chunk.token_count > limit:
            out.append(cur)
            cur, size = [], 0
        cur.append((n, r))
        size += r.chunk.token_count
    if cur:
        out.append(cur)
    return out


def numbered(batch: list[tuple[int, Retrieved]]) -> str:
    parts = []
    for n, r in batch:
        where = f", p. {r.chunk.page_start}" if r.chunk.page_start else ""
        parts.append(f'<passage n="{n}" source="{r.source.title}{where}">\n{r.chunk.text}\n</passage>')
    return "\n\n".join(parts)


def build_summary(
    passages: list[Retrieved],
    fmt: str,
    length: str,
    focus: str | None,
    on_progress: Callable[[float, str], None] = lambda f, s: None,
    **kw: Any,
) -> dict[str, Any]:
    """Summarise in one pass, or map-reduce: notes per ~40k-token batch, then one combining pass."""
    label, what = FORMATS[fmt]
    words = LENGTHS.get(length, LENGTHS["standard"])
    system = "You summarise study material faithfully and clearly. " + STYLE
    total = sum(r.chunk.token_count for r in passages)
    focus_line = _focus_line(focus)

    if total <= SINGLE_PASS_TOKENS:
        on_progress(0.15, "Summarising")
        out = generate_json(
            system,
            f"Passages:\n\n{numbered(list(enumerate(passages, start=1)))}\n\nWrite {what}. About {words} words. "
            "Cover the material in proportion to its importance. Cite passages inline as [n] right after the "
            "claims they support. Put the whole summary in `body` (Markdown); `title` names the material."
            + focus_line,
            SHEET_SCHEMA, **kw,
        )
        return _finish(out, label, parts=1)

    groups = batches(passages)
    notes = []
    for i, group in enumerate(groups, start=1):
        on_progress((i - 1) / (len(groups) + 1), f"Reading part {i} of {len(groups)}")
        part_words = max(250, int(words * 2.5 / len(groups)))
        out = generate_json(
            system,
            f"Passages:\n\n{numbered(group)}\n\nThese passages are part {i} of {len(groups)} of the material. "
            f"Write dense, well-organised notes (about {part_words} words) on everything important in them, "
            "keeping key terms, definitions, data and examples. Cite passages inline as [n] using the numbers "
            "shown. Put the notes in `body`; `title` names this part's topic." + focus_line,
            SHEET_SCHEMA, **kw,
        )
        notes.append(f"### Part {i}: {out.get('title') or ''}\n{(out.get('body') or '').strip()}")
    on_progress(len(groups) / (len(groups) + 1), "Combining the parts")
    out = generate_json(
        system,
        "Below are notes on consecutive parts of the material, with citations like [12].\n\n"
        + "\n\n".join(notes)
        + f"\n\nCombine them into {what}. About {words} words. Merge overlapping points, keep the material's "
        "order, and keep citation numbers exactly as given (never invent new ones). Put the whole summary in "
        "`body` (Markdown); `title` names the material." + focus_line,
        SHEET_SCHEMA, **kw,
    )
    return _finish(out, label, parts=len(groups))


def _finish(out: dict[str, Any], label: str, parts: int) -> dict[str, Any]:
    body = (out.get("body") or "").strip()
    if not body:
        raise GeminiError("Gemini returned an empty summary. Try again.")
    return {"title": out.get("title") or label, "body": body, "parts": parts}
