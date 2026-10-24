"""Turn raw inputs (PDF bytes, pasted text, a URL) into one text string plus page spans."""

import io
import ipaddress
import re
import socket
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlparse

import httpx
from bs4 import BeautifulSoup
from pypdf import PdfReader


@dataclass
class PageSpan:
    page: int  # 1-indexed
    start: int
    end: int


@dataclass
class ParsedDoc:
    title: str
    text: str
    pages: list[PageSpan] = field(default_factory=list)


class ParseError(ValueError):
    pass


_WS_RUN = re.compile(r"[ \t\f\v]+")
_BLANK_LINES = re.compile(r"\n{3,}")


def normalize(text: str) -> str:
    text = text.replace("\r\n", "\n").replace("\r", "\n").replace("\x00", "")
    text = "\n".join(_WS_RUN.sub(" ", line).strip() for line in text.split("\n"))
    return _BLANK_LINES.sub("\n\n", text).strip()


def parse_text(text: str, title: str | None = None) -> ParsedDoc:
    body = normalize(text)
    if not body:
        raise ParseError("The pasted text is empty.")
    if not title:
        first = body.split("\n", 1)[0]
        title = first[:80] + ("…" if len(first) > 80 else "")
    return ParsedDoc(title=title, text=body)


def parse_pdf(
    data: bytes | Path,
    title: str | None = None,
    on_progress: Callable[[int, int], None] | None = None,
) -> ParsedDoc:
    """Extract text per page. `data` may be bytes or a path (large files are read lazily from disk)."""
    try:
        reader = PdfReader(str(data) if isinstance(data, Path) else io.BytesIO(data))
        total = len(reader.pages)
    except Exception as exc:  # pypdf raises a variety of errors on bad input
        raise ParseError(f"Could not read PDF: {exc}") from exc

    parts: list[str] = []
    pages: list[PageSpan] = []
    cursor = 0
    for i, page in enumerate(reader.pages, start=1):
        try:
            page_text = normalize(page.extract_text() or "")
        except Exception:  # one damaged page shouldn't sink a 900-page textbook
            page_text = ""
        if on_progress and (i % 5 == 0 or i == total):
            on_progress(i, total)
        if parts:
            parts.append("\n\n")
            cursor += 2
        start = cursor
        parts.append(page_text)
        cursor += len(page_text)
        pages.append(PageSpan(page=i, start=start, end=cursor))

    text = "".join(parts)
    if not text.strip():
        raise ParseError("No extractable text in this PDF (it may be scanned images).")
    if not title:
        meta_title = (reader.metadata.title if reader.metadata else None) or ""
        title = meta_title.strip() or "Untitled PDF"
    return ParsedDoc(title=title, text=text, pages=pages)


def _check_public_host(url: str) -> None:
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise ParseError("Only http(s) URLs are supported.")
    try:
        infos = socket.getaddrinfo(parsed.hostname, None)
    except socket.gaierror as exc:
        raise ParseError(f"Could not resolve {parsed.hostname}") from exc
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved:
            raise ParseError("URLs pointing at private or local addresses are not allowed.")


def html_to_doc(html: str, fallback_title: str) -> ParsedDoc:
    soup = BeautifulSoup(html, "html.parser")
    for tag in soup(["script", "style", "noscript", "nav", "header", "footer", "aside", "form", "svg"]):
        tag.decompose()
    # Footnote markers like [12] and "[edit]" links are noise for study text.
    for tag in soup.select("sup.reference, .mw-editsection, .noprint"):
        tag.decompose()
    for br in soup.find_all("br"):
        br.replace_with("\n")
    title = (soup.title.string.strip() if soup.title and soup.title.string else "") or fallback_title
    root = soup.find("article") or soup.find("main") or soup.body or soup
    blocks = []
    for el in root.find_all(["h1", "h2", "h3", "h4", "p", "li", "pre", "blockquote", "td"]):
        # Skip containers whose text we'll already capture via a nested block element.
        if el.find(["p", "li", "pre", "blockquote"]):
            continue
        # Join inline children without inserting spaces, so "organisms, such" stays intact.
        t = _WS_RUN.sub(" ", el.get_text("")).strip()
        if t:
            blocks.append(t)
    text = normalize("\n\n".join(blocks) if blocks else root.get_text("\n"))
    if not text:
        raise ParseError("No readable text found at that URL.")
    return ParsedDoc(title=title[:300], text=text)


def parse_url(url: str, client: httpx.Client | None = None) -> ParsedDoc:
    _check_public_host(url)
    own = client is None
    client = client or httpx.Client(follow_redirects=True, timeout=20.0,
                                    headers={"User-Agent": "StudyApp/0.1 (+source ingestion)"})
    try:
        resp = client.get(url)
        resp.raise_for_status()
    except httpx.HTTPError as exc:
        raise ParseError(f"Could not fetch URL: {exc}") from exc
    finally:
        if own:
            client.close()

    ctype = resp.headers.get("content-type", "")
    if "pdf" in ctype or url.lower().endswith(".pdf"):
        return parse_pdf(resp.content, title=None)
    if "html" in ctype or "<html" in resp.text[:500].lower():
        return html_to_doc(resp.text, fallback_title=url)
    return parse_text(resp.text, title=url)
