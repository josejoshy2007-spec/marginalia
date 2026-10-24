"""Token-bounded chunking that keeps exact character offsets into the source text.

Text is first split into small "units" (sentences, or word runs for very long
sentences), each carrying its char span and token count. Units are then packed
greedily into chunks of at most `max_tokens`, and each new chunk starts with the
trailing units of the previous one totalling roughly `overlap_tokens`.

Every chunk's text is exactly `source_text[char_start:char_end]`, which is what
lets citations map back to a highlightable passage.
"""

import bisect
import re
from dataclasses import dataclass
from functools import lru_cache

import tiktoken

from .parse import PageSpan


@lru_cache
def _encoding():
    # cl100k is a close-enough proxy for sizing; the exact tokenizer doesn't matter here.
    return tiktoken.get_encoding("cl100k_base")


def count_tokens(text: str) -> int:
    return len(_encoding().encode(text, disallowed_special=()))


@dataclass
class ChunkSpan:
    ord: int
    text: str
    char_start: int
    char_end: int
    token_count: int
    page_start: int | None = None
    page_end: int | None = None


@dataclass
class _Unit:
    start: int
    end: int
    tokens: int


# A sentence-ish unit: runs up to and including terminal punctuation or a paragraph break.
_SENTENCE = re.compile(r"[^\n.!?]*(?:[.!?]+[\"')\]]*|\n+|$)")
_WORDS = re.compile(r"\S+\s*")


def _units(text: str, max_tokens: int) -> list[_Unit]:
    units: list[_Unit] = []
    for m in _SENTENCE.finditer(text):
        if m.start() == m.end():
            continue
        start, end = m.start(), m.end()
        seg = text[start:end]
        tok = count_tokens(seg)
        if tok <= max_tokens:
            units.append(_Unit(start, end, tok))
            continue
        # Oversized sentence: fall back to word runs, then to hard slices.
        for w in _WORDS.finditer(seg):
            ws, we = start + w.start(), start + w.end()
            wt = count_tokens(text[ws:we])
            if wt <= max_tokens:
                units.append(_Unit(ws, we, wt))
            else:
                step = max(1, len(text[ws:we]) * max_tokens // (wt + 1))
                for s in range(ws, we, step):
                    e = min(we, s + step)
                    units.append(_Unit(s, e, count_tokens(text[s:e])))
    # Ensure units are contiguous and sorted (regex skips empty matches only).
    units.sort(key=lambda u: u.start)
    return units


def chunk_text(
    text: str,
    max_tokens: int = 800,
    overlap_tokens: int = 120,
    pages: list[PageSpan] | None = None,
) -> list[ChunkSpan]:
    if overlap_tokens >= max_tokens:
        raise ValueError("overlap_tokens must be smaller than max_tokens")
    units = _units(text, max_tokens)
    chunks: list[ChunkSpan] = []
    i = 0
    while i < len(units):
        total = 0
        j = i
        while j < len(units) and total + units[j].tokens <= max_tokens:
            total += units[j].tokens
            j += 1
        if j == i:  # single unit can't exceed max_tokens by construction, but be safe
            j = i + 1
        start, end = units[i].start, units[j - 1].end
        # Trim surrounding whitespace while keeping offsets exact.
        while start < end and text[start].isspace():
            start += 1
        while end > start and text[end - 1].isspace():
            end -= 1
        if end > start:
            body = text[start:end]
            chunks.append(ChunkSpan(len(chunks), body, start, end, count_tokens(body)))
        if j >= len(units):
            break
        # Step back over trailing units for overlap, but always make progress.
        k, back = j, 0
        while k - 1 > i and back + units[k - 1].tokens <= overlap_tokens:
            k -= 1
            back += units[k].tokens
        i = k
    if pages:
        assign_pages(chunks, pages)
    return chunks


def page_for_offset(pages: list[PageSpan], offset: int) -> int | None:
    if not pages:
        return None
    starts = [p.start for p in pages]
    idx = bisect.bisect_right(starts, offset) - 1
    return pages[max(idx, 0)].page


def assign_pages(chunks: list[ChunkSpan], pages: list[PageSpan]) -> None:
    for c in chunks:
        c.page_start = page_for_offset(pages, c.char_start)
        c.page_end = page_for_offset(pages, max(c.char_start, c.char_end - 1))
