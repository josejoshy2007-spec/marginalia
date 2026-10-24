"""Grounded answering with Gemini (REST, streamed via SSE) -> UI events.

Gemini has no document-citation feature, so retrieved chunks are numbered in the prompt
and the model is told to cite them as [n]. `CiteParser` turns those markers in the stream
into `cite` events. A citation therefore points at the whole chunk, not an exact sentence.
"""

import json
import logging
import re
import threading
import time
from collections import deque
from collections.abc import Callable, Iterator
from contextlib import closing
from typing import Any

import httpx

from .chat import ChatRequest
from .config import get_settings
from .retrieval import Retrieved

log = logging.getLogger(__name__)

GEMINI_SYSTEM = """You are a study companion working only from the student's own sources, which are given as numbered passages.

Ground every factual statement in those passages and cite them by number in square brackets right after the claim, e.g. "Chlorophyll absorbs red and blue light [2]." Use only the passage numbers you were given; cite several like [1][3]. If the passages don't cover something, say so plainly instead of filling the gap from general knowledge; you may then offer a clearly-labelled general explanation.

Requests are either questions or generation requests (quizzes, summaries, flashcards, outlines). For generation requests, produce the artefact directly from the passages, still citing them.

When the student has highlighted a passage, treat it as the focus of their question.

Write for a student: clear, compact, no filler. Use short paragraphs or flat lists; light Markdown (bold, italics, headings) is fine. Never use LaTeX or $…$ math: write formulas in plain text with Unicode where needed (CO₂, H₂O, x², →)."""


def chunk_citation(r: Retrieved) -> dict[str, Any]:
    return {
        "source_id": r.source.id,
        "source_title": r.source.title,
        "chunk_id": r.chunk.id,
        "start": r.chunk.char_start,
        "end": r.chunk.char_end,
        "page": r.chunk.page_start,
        "cited_text": r.chunk.text[:240],
    }


def build_gemini_body(req: ChatRequest, retrieved: list[Retrieved], ctx: str = "") -> dict[str, Any]:
    contents: list[dict[str, Any]] = []
    for t in req.history:
        if not t.content.strip():
            continue
        role = "model" if t.role == "assistant" else "user"
        if not contents and role != "user":
            continue
        contents.append({"role": role, "parts": [{"text": t.content}]})

    passages = []
    for i, r in enumerate(retrieved, start=1):
        c, s = r.chunk, r.source
        where = f", p. {c.page_start}" if c.page_start else ""
        passages.append(f'<passage n="{i}" source="{s.title}{where}">\n{c.text}\n</passage>')
    question = req.message
    if req.selection:
        question = f"I highlighted this passage:\n<highlight>\n{req.selection.text}\n</highlight>\n\n{req.message}"
    prompt = "Passages:\n\n" + "\n\n".join(passages) + "\n\n" + question
    contents.append({"role": "user", "parts": [{"text": prompt}]})

    return {
        "systemInstruction": {"parts": [{"text": GEMINI_SYSTEM + ctx}]},
        "contents": contents,
        "generationConfig": {"maxOutputTokens": get_settings().gemini_max_tokens},
    }


_MARKER = re.compile(r"\[(\d{1,3}(?:\s*[,;]\s*\d{1,3})*)\]")
_PARTIAL = re.compile(r"\[[\d,;\s]{0,20}$")


class CiteParser:
    """Turns streamed text containing [n] markers into text/cite events, safe across chunk splits."""

    def __init__(self, retrieved: list[Retrieved]):
        self.retrieved = retrieved
        self.buf = ""

    def _events(self, text: str) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        last = 0
        for m in _MARKER.finditer(text):
            nums = [int(n) for n in re.split(r"\s*[,;]\s*", m.group(1))]
            cites = [chunk_citation(self.retrieved[n - 1]) for n in nums if 1 <= n <= len(self.retrieved)]
            if not cites:
                continue  # not a passage reference (e.g. "[1990]"); leave it as text
            if m.start() > last:
                out.append({"type": "text", "text": text[last:m.start()]})
            out.append({"type": "cite", "citations": cites})
            last = m.end()
        if last < len(text):
            out.append({"type": "text", "text": text[last:]})
        return out

    def feed(self, text: str) -> list[dict[str, Any]]:
        self.buf += text
        hold = _PARTIAL.search(self.buf)
        cut = hold.start() if hold else len(self.buf)
        ready, self.buf = self.buf[:cut], self.buf[cut:]
        return self._events(ready) if ready else []

    def flush(self) -> list[dict[str, Any]]:
        rest, self.buf = self.buf, ""
        return self._events(rest) if rest else []


def _error_message(status: int, body: str) -> str:
    try:
        msg = json.loads(body)["error"]["message"]
    except Exception:
        msg = body[:200]
    if status in (400, 401, 403) and "key" in msg.lower():
        return "Gemini API key missing or invalid. Set GEMINI_API_KEY in backend/.env and restart the API."
    if status == 429:
        delay, daily = quota_info(body)
        if daily:
            return "Gemini's free daily quota is used up (main and fallback model). It resets at midnight Pacific time."
        wait = f" Try again in about {int(delay) + 1}s." if delay else " Wait a minute and retry."
        return "Gemini's free per-minute limit was reached." + wait
    if status in RETRY_STATUSES:
        return "Gemini is overloaded right now (Google says demand is high). Try again in a minute."
    if status == 404:
        return f"Gemini model not found. Check GEMINI_MODEL in backend/.env. ({msg})"
    return f"Gemini API error ({status}): {msg}"


RETRIES = 2
RETRY_STATUSES = {500, 503}  # "model overloaded" / transient server errors
BACKOFF = 2.0


def quota_info(body: str) -> tuple[float | None, bool]:
    """From a 429 body: (seconds Google says to wait, whether a per-day quota was hit)."""
    try:
        details = json.loads(body)["error"].get("details") or []
    except Exception:
        return None, False
    delay, daily = None, False
    for d in details:
        kind = d.get("@type", "")
        if kind.endswith("RetryInfo"):
            m = re.match(r"([\d.]+)s", d.get("retryDelay", ""))
            delay = float(m.group(1)) if m else None
        elif kind.endswith("QuotaFailure"):
            daily = any("PerDay" in (v.get("quotaId") or "") for v in d.get("violations") or [])
    return delay, daily


class Pacer:
    """Keeps this process under `rpm` requests per minute so the free tier rarely answers 429."""

    def __init__(self, clock: Callable[[], float] = time.monotonic):
        self.clock = clock
        self.sent: deque[float] = deque()
        self.lock = threading.Lock()

    def wait_needed(self, rpm: int) -> float:
        """Reserve a slot. Returns 0 if one was free now, else seconds until the next slot (nothing reserved)."""
        if rpm <= 0:
            return 0.0
        with self.lock:
            now = self.clock()
            while self.sent and now - self.sent[0] >= 60:
                self.sent.popleft()
            if len(self.sent) < rpm:
                self.sent.append(now)
                return 0.0
            return 60 - (now - self.sent[0])


PACER = Pacer()


def _acquire_slot(rpm: int, max_wait: float, sleep: Callable[[float], None]) -> float | None:
    """Wait for a request slot. Returns None when acquired, or the wait that was too long."""
    waited = 0.0
    while (need := PACER.wait_needed(rpm)) > 0:
        if waited + need > max_wait:
            return need
        sleep(need + 0.05)
        waited += need
    return None


class GeminiError(Exception):
    """A user-facing failure message from the Gemini API (quota, overload, bad key, …)."""


def text_models() -> list[str]:
    s = get_settings()
    return [s.gemini_model] + [m for m in [s.gemini_fallback_model] if m and m != s.gemini_model]


def send_resilient(
    http: httpx.Client,
    models: list[str],
    action: str,
    body: dict[str, Any],
    sleep: Callable[[float], None] = time.sleep,
    params: dict[str, str] | None = None,
    endpoint: str | None = None,
) -> httpx.Response:
    """POST `body` to models/{model}:{action}, with free-tier pacing, retries and model fallback.

    With `endpoint` (e.g. "interactions") the request goes to {base}/{endpoint} instead and the
    model is sent in the body, as the Interactions API expects.

    Tries each model in turn: retries 500/503 with backoff and short per-minute 429s after
    Google's suggested delay; moves to the next model when one stays overloaded or its
    (per-model) quota is used up. Returns an open streaming 200 response the caller must
    close, or raises GeminiError with a message fit to show the student.
    """
    s = get_settings()
    if not s.gemini_api_key:
        raise GeminiError("No Gemini API key configured. Set GEMINI_API_KEY in backend/.env and restart the API.")
    resp: httpx.Response | None = None
    for mi, model in enumerate(models):
        base = s.gemini_base_url.rstrip("/")
        request = http.build_request(
            "POST", f"{base}/{endpoint}" if endpoint else f"{base}/models/{model}:{action}",
            params=params, headers={"x-goog-api-key": s.gemini_api_key},
            json={**body, "model": model} if endpoint else body,
        )
        for attempt in range(RETRIES + 1):
            too_long = _acquire_slot(s.gemini_rpm, s.gemini_max_quota_wait, sleep)
            if too_long is not None:
                raise GeminiError("You're going faster than Gemini's free tier allows "
                                  f"({s.gemini_rpm}/min). Try again in about {int(too_long) + 1}s.")
            resp = http.send(request, stream=True)
            if resp.status_code == 429 and attempt < RETRIES:
                resp.read()
                delay, daily = quota_info(resp.text)
                if not daily and delay is not None and delay <= s.gemini_max_quota_wait:
                    resp.close()
                    sleep(delay + 0.5)
                    continue
                break
            if resp.status_code in RETRY_STATUSES and attempt < RETRIES:
                resp.close()
                sleep(BACKOFF * (attempt + 1))
                continue
            break
        if resp.status_code in RETRY_STATUSES | {429} and mi < len(models) - 1:
            log.warning("Gemini model %s unavailable (%s); falling back to %s", model, resp.status_code, models[mi + 1])
            resp.close()
            continue
        break
    assert resp is not None
    if resp.status_code != 200:
        resp.read()
        resp.close()
        raise GeminiError(_error_message(resp.status_code, resp.text))
    return resp


def stream_gemini(
    req: ChatRequest,
    retrieved: list[Retrieved],
    http: httpx.Client | None = None,
    sleep: Callable[[float], None] = time.sleep,
    ctx: str = "",
) -> Iterator[dict[str, Any]]:
    """Stream an answer. `ctx` = extra system instructions (the subject's IB course conventions)."""
    s = get_settings()
    yield {
        "type": "sources",
        "sources": [
            {"source_id": r.source.id, "chunk_id": r.chunk.id, "title": r.source.title,
             "page": r.chunk.page_start, "distance": round(r.distance, 4)}
            for r in retrieved
        ],
    }
    if not retrieved:
        yield {"type": "text", "text": "None of the checked sources contain anything I can use yet. "
                                       "Check at least one ready source in the Library and ask again."}
        yield {"type": "done"}
        return
    own = http is None
    http = http or httpx.Client(timeout=httpx.Timeout(120.0, connect=15.0))
    parser = CiteParser(retrieved)
    finish = None
    try:
        try:
            resp = send_resilient(http, text_models(), "streamGenerateContent",
                                  build_gemini_body(req, retrieved, ctx), sleep=sleep, params={"alt": "sse"})
        except GeminiError as exc:
            yield {"type": "error", "message": str(exc)}
            return
        with closing(resp):
            for line in resp.iter_lines():
                if not line.startswith("data:"):
                    continue
                data = json.loads(line[5:].strip())
                block = (data.get("promptFeedback") or {}).get("blockReason")
                if block:
                    yield {"type": "error", "message": f"Gemini blocked this request ({block})."}
                    return
                for cand in data.get("candidates") or []:
                    for part in (cand.get("content") or {}).get("parts") or []:
                        if part.get("text") and not part.get("thought"):
                            yield from parser.feed(part["text"])
                    finish = cand.get("finishReason") or finish
        yield from parser.flush()
    except httpx.HTTPError as exc:
        log.exception("Gemini request failed")
        yield {"type": "error", "message": f"Could not reach the Gemini API ({exc.__class__.__name__})."}
        return
    finally:
        if own:
            http.close()

    if finish == "MAX_TOKENS":
        yield {"type": "text", "text": "\n\n_(answer cut off at the length limit)_"}
    elif finish in ("SAFETY", "RECITATION", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII"):
        yield {"type": "error", "message": f"Gemini stopped the answer ({finish})."}
        return
    yield {"type": "done"}
