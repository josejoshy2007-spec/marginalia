"""Study material generated from sources with Gemini: card decks, quizzes, study sheets,
concept maps, audio episodes (script + speech), plus lecture/YouTube transcription.

Every generator sees numbered passages and returns JSON whose `cite` arrays (or inline [n]
markers in Markdown) refer to them. The passages are stored on the Artifact so citations
keep resolving to exact source spans later.
"""

import base64
import json
import logging
import re
import time
import wave
from collections.abc import Callable
from pathlib import Path
from typing import Any

import httpx
from sqlalchemy import select
from sqlalchemy.orm import Session

from .config import get_settings
from .embeddings import Embedder
from .gemini import GeminiError, chunk_citation, send_resilient, text_models
from .ingestion.parse import ParsedDoc, parse_text
from .models import Artifact, Card, Chunk, Source
from .retrieval import Retrieved, retrieve

log = logging.getLogger(__name__)

NETWORK_RETRIES = 2  # extra attempts when the connection drops mid-request

STYLE = (
    "Write for a student. Plain text or light Markdown only; never LaTeX or $…$ math "
    "(write CO₂, x², → with Unicode). Use only facts found in the passages."
)

# ---------------------------------------------------------------- passages


def select_passages(
    db: Session,
    subject_id: int,
    source_ids: list[int],
    embedder: Embedder,
    focus: str | None,
    budget: int,
) -> list[Retrieved]:
    """Pick the chunks a generator will see.

    With a focus topic: the most similar chunks. Without one: chunks spread evenly through
    each checked source, so a deck or episode covers the whole material, not just its start.
    """
    if not source_ids:
        return []
    if focus and focus.strip():
        return retrieve(db, subject_id, source_ids, embedder.embed_query(focus), k=budget)

    sources = db.scalars(
        select(Source).where(Source.subject_id == subject_id, Source.id.in_(source_ids)).order_by(Source.id)
    ).all()
    if not sources:
        return []
    per_source = max(1, budget // len(sources))
    picked: list[Retrieved] = []
    for src in sources:
        chunks = db.scalars(select(Chunk).where(Chunk.source_id == src.id).order_by(Chunk.ord)).all()
        if not chunks:
            continue
        if len(chunks) <= per_source:
            chosen = chunks
        else:
            step = len(chunks) / per_source
            chosen = [chunks[int(i * step)] for i in range(per_source)]
        picked.extend(Retrieved(c, src, 0.0) for c in chosen)
    return picked[:budget]


def passages_prompt(passages: list[Retrieved]) -> str:
    out = []
    for i, r in enumerate(passages, start=1):
        where = f", p. {r.chunk.page_start}" if r.chunk.page_start else ""
        out.append(f'<passage n="{i}" source="{r.source.title}{where}">\n{r.chunk.text}\n</passage>')
    return "\n\n".join(out)


# ---------------------------------------------------------------- Gemini JSON calls


def _client(timeout: float = 300.0) -> httpx.Client:
    return httpx.Client(timeout=httpx.Timeout(timeout, connect=15.0))


def _response_json(resp: httpx.Response) -> dict[str, Any]:
    try:
        resp.read()
        return resp.json()
    finally:
        resp.close()


def _candidate_text(data: dict[str, Any]) -> tuple[str, str | None]:
    block = (data.get("promptFeedback") or {}).get("blockReason")
    if block:
        raise GeminiError(f"Gemini blocked this request ({block}).")
    cands = data.get("candidates") or []
    if not cands:
        raise GeminiError("Gemini returned no answer.")
    parts = (cands[0].get("content") or {}).get("parts") or []
    text = "".join(p.get("text", "") for p in parts if not p.get("thought"))
    return text, cands[0].get("finishReason")


def generate_json(
    system: str,
    prompt: str,
    schema: dict[str, Any],
    http: httpx.Client | None = None,
    sleep: Callable[[float], None] | None = None,
    parts: list[dict[str, Any]] | None = None,
    ctx: str = "",
) -> dict[str, Any]:
    """One structured-output call. Raises GeminiError with a student-facing message on failure.

    `ctx` is appended to the system prompt (the subject's IB course conventions, if any).
    """
    s = get_settings()
    body = {
        "systemInstruction": {"parts": [{"text": system + ctx}]},
        "contents": [{"role": "user", "parts": (parts or []) + [{"text": prompt}]}],
        "generationConfig": {
            "maxOutputTokens": s.gemini_max_tokens,
            "responseMimeType": "application/json",
            "responseSchema": schema,
        },
    }
    own = http is None
    http = http or _client()
    kwargs = {"sleep": sleep} if sleep else {}
    try:
        # Dropped connections (RemoteProtocolError, timeouts) are common on school networks and
        # long answers; this call isn't streamed to the user, so simply retry the whole request.
        for attempt in range(NETWORK_RETRIES + 1):
            try:
                data = _response_json(send_resilient(http, text_models(), "generateContent", body, **kwargs))
                break
            except httpx.TransportError as exc:
                if attempt == NETWORK_RETRIES:
                    raise GeminiError(
                        f"The connection to Gemini kept dropping ({exc.__class__.__name__}). Try again in a moment."
                    ) from exc
                log.warning("Gemini connection dropped (%s); retrying", exc.__class__.__name__)
                (sleep or time.sleep)(2.0 * (attempt + 1))
    except httpx.HTTPError as exc:
        raise GeminiError(f"Could not reach the Gemini API ({exc.__class__.__name__}).") from exc
    finally:
        if own:
            http.close()
    text, finish = _candidate_text(data)
    if finish == "MAX_TOKENS":
        raise GeminiError("The result was too long for the output limit. Ask for fewer items or a shorter length.")
    try:
        return json.loads(text)
    except json.JSONDecodeError as exc:
        raise GeminiError("Gemini returned malformed output. Please try again.") from exc


# ---------------------------------------------------------------- schemas

_CITE = {"type": "ARRAY", "items": {"type": "INTEGER"}}

DECK_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "title": {"type": "STRING"},
        "cards": {"type": "ARRAY", "items": {
            "type": "OBJECT",
            "properties": {"front": {"type": "STRING"}, "back": {"type": "STRING"}, "cite": _CITE},
            "required": ["front", "back", "cite"],
        }},
    },
    "required": ["title", "cards"],
}

QUIZ_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "title": {"type": "STRING"},
        "questions": {"type": "ARRAY", "items": {
            "type": "OBJECT",
            "properties": {
                "type": {"type": "STRING", "enum": ["mcq", "short", "long"]},
                "question": {"type": "STRING"},
                "options": {"type": "ARRAY", "items": {"type": "STRING"}},  # mcq
                "answer": {"type": "INTEGER"},  # mcq: 0-based correct option
                "accept": {"type": "ARRAY", "items": {"type": "STRING"}},  # short: acceptable answers
                "marks": {"type": "INTEGER"},  # long: total marks
                "points": {"type": "ARRAY", "items": {  # long: markscheme points
                    "type": "OBJECT",
                    "properties": {"text": {"type": "STRING"}, "marks": {"type": "INTEGER"}},
                    "required": ["text", "marks"],
                }},
                "explanation": {"type": "STRING"},
                "cite": _CITE,
            },
            # Every field is required: Gemini's structured output tends to drop optional fields, which left
            # multiple-choice questions without options. Fields that don't apply hold [] or 0.
            "required": ["type", "question", "options", "answer", "accept", "marks", "points", "explanation", "cite"],
        }},
    },
    "required": ["title", "questions"],
}

QUIZ_TYPES = ("mcq", "short", "long")

SHEET_SCHEMA = {
    "type": "OBJECT",
    "properties": {"title": {"type": "STRING"}, "body": {"type": "STRING"}},
    "required": ["title", "body"],
}

MAP_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "title": {"type": "STRING"},
        "nodes": {"type": "ARRAY", "items": {
            "type": "OBJECT",
            "properties": {
                "id": {"type": "STRING"},
                "parent": {"type": "STRING"},
                "label": {"type": "STRING"},
                "note": {"type": "STRING"},
                "cite": _CITE,
            },
            "required": ["id", "parent", "label", "cite"],
        }},
    },
    "required": ["title", "nodes"],
}

EPISODE_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "title": {"type": "STRING"},
        "summary": {"type": "STRING"},
        "lines": {"type": "ARRAY", "items": {
            "type": "OBJECT",
            "properties": {"speaker": {"type": "STRING"}, "text": {"type": "STRING"}, "cite": _CITE},
            "required": ["speaker", "text", "cite"],
        }},
    },
    "required": ["title", "lines"],
}

TRANSCRIPT_SCHEMA = {
    "type": "OBJECT",
    "properties": {"title": {"type": "STRING"}, "transcript": {"type": "STRING"}},
    "required": ["title", "transcript"],
}

# ---------------------------------------------------------------- generators

SHEETS = {
    "study_guide": ("Study guide", "a study guide: the key concepts in a logical order, each explained briefly, "
                    "followed by a short 'Check yourself' list of questions"),
    "briefing": ("Briefing", "a one-page briefing: a 2-sentence overview, then the main points and the most "
                 "important details or numbers, ending with open questions or caveats in the sources"),
    "faq": ("FAQ", "an FAQ of 8–12 questions a student would actually ask, each with a concise answer"),
    "timeline": ("Timeline", "a chronological timeline of the events, stages or steps in the sources as a list of "
                 "'**date or stage** — what happened' lines, then a short note on what the sequence shows"),
    "key_terms": ("Key terms", "a glossary of the key terms, each with a one-line definition and, where useful, "
                  "a short example"),
}

EPISODE_FORMATS = {
    "conversation": ("Talk-through", ["Maya", "Theo"],
                     "a lively two-host conversation. Maya explains, Theo asks the questions a student would ask, "
                     "pushes for examples and summarises. Natural, warm, not scripted-sounding"),
    "brief": ("Quick brief", ["Maya"],
              "a single narrator giving a tight briefing of only the most important points"),
    "debate": ("Debate", ["Maya", "Theo"],
               "a respectful debate: Maya argues for the main claims or interpretations in the sources, Theo "
               "challenges them using limitations, counterpoints or alternative readings found in the sources; "
               "they end by agreeing on what is well supported"),
    "lecture": ("Mini-lecture", ["Theo"],
                "a single lecturer teaching the material step by step, with signposting ('first', 'the key idea "
                "is'), one or two worked examples, and a recap"),
}

EPISODE_LENGTHS = {"short": 450, "medium": 1000, "long": 1700}  # target words (~150 words/min)


def _focus_line(focus: str | None) -> str:
    return f"\nFocus especially on: {focus.strip()}" if focus and focus.strip() else ""


def _clean_cites(cites: Any, n: int) -> list[int]:
    if not isinstance(cites, list):
        return []
    return sorted({int(c) for c in cites if isinstance(c, int | float) and 1 <= int(c) <= n})


def build_deck(passages, count: int, focus: str | None, **kw) -> dict[str, Any]:
    out = generate_json(
        "You write excellent flashcards for active recall. " + STYLE,
        f"Passages:\n\n{passages_prompt(passages)}\n\nWrite {count} flashcards from these passages. Fronts are "
        "specific questions or prompts (not 'What is X?' for everything; mix definitions, causes, processes, "
        "comparisons and applications). Backs are short, complete answers (1–3 sentences). One idea per card. "
        "`cite` lists the passage numbers that support the back." + _focus_line(focus),
        DECK_SCHEMA, **kw,
    )
    cards = [
        {"front": c["front"].strip(), "back": c["back"].strip(), "cite": _clean_cites(c.get("cite"), len(passages))}
        for c in out.get("cards", []) if c.get("front") and c.get("back")
    ]
    if not cards:
        raise GeminiError("Gemini didn't produce any cards. Try again or check more sources.")
    return {"title": out.get("title") or "Flashcards", "cards": cards}


def split_count(count: int, types: list[str]) -> dict[str, int]:
    """Share `count` questions across the chosen types as evenly as possible (earlier types get extras)."""
    types = [t for t in QUIZ_TYPES if t in types] or ["mcq"]
    base, extra = divmod(max(count, len(types)), len(types))
    return {t: base + (1 if i < extra else 0) for i, t in enumerate(types)}


def clean_quiz_question(q: dict[str, Any], n_passages: int) -> dict[str, Any] | None:
    """Validate one generated quiz question of any type; None if unusable. Untyped (old) = mcq."""
    kind = q.get("type") if q.get("type") in QUIZ_TYPES else "mcq"
    # Marks are shown by the UI; drop a trailing "[4]" / "(4 marks)" Gemini sometimes adds to the text.
    text = re.sub(r"\s*(\[\d+\]|\(\d+\s*marks?\))\s*$", "", (q.get("question") or "").strip())
    if not text:
        return None
    base = {"type": kind, "question": text, "explanation": (q.get("explanation") or "").strip(),
            "cite": _clean_cites(q.get("cite"), n_passages)}
    if kind == "mcq":
        opts = [str(o).strip() for o in q.get("options") or [] if str(o).strip()]
        ans = q.get("answer")
        if len(opts) < 2 or not isinstance(ans, int) or not 0 <= ans < len(opts):
            return None
        return {**base, "options": opts, "answer": ans}
    if kind == "short":
        accept = [str(a).strip() for a in q.get("accept") or [] if str(a).strip()][:8]
        if not accept:
            return None
        return {**base, "accept": accept, "marks": 1}
    points = [{"text": p["text"].strip(), "marks": max(1, int(p.get("marks") or 1))}
              for p in q.get("points") or [] if (p.get("text") or "").strip()]
    if not points:
        return None
    marks = q.get("marks") if isinstance(q.get("marks"), int) and q["marks"] > 0 else sum(p["marks"] for p in points)
    return {**base, "points": points, "marks": min(marks, 10)}


def question_marks(q: dict[str, Any]) -> int:
    return 1 if q.get("type", "mcq") in ("mcq", "short") else int(q.get("marks") or 1)


def build_quiz(passages, count: int, difficulty: str, focus: str | None,
               types: list[str] | None = None, **kw) -> dict[str, Any]:
    level = {
        "easy": "recall of key facts and definitions",
        "medium": "understanding: explain, compare, identify causes and consequences",
        "hard": "application and analysis: new scenarios, multi-step reasoning, subtle distinctions",
    }.get(difficulty, "understanding")
    split = split_count(count, types or ["mcq"])
    wanted = []
    if split.get("mcq"):
        wanted.append(f"- {split['mcq']} multiple-choice (`type` \"mcq\"): exactly 4 `options`, one correct; "
                      "plausible distractors drawn from related ideas in the passages; vary which index is "
                      "correct; `answer` = 0-based index of the correct option.")
    if split.get("short"):
        wanted.append(f"- {split['short']} short-answer (`type` \"short\"): answerable in a word or short "
                      "phrase (a term, name, value, or 'X because Y' in under ~10 words). `accept` lists the "
                      "correct answer plus acceptable alternative wordings/synonyms/units.")
    if split.get("long"):
        wanted.append(f"- {split['long']} written-explanation (`type` \"long\"): needs 2–5 sentences "
                      "(explain/describe/compare/evaluate). `marks` 2–6; `points` is a markscheme of "
                      "creditworthy points with their marks (may list more points than marks).")
    out = generate_json(
        "You write rigorous quiz questions for students. " + STYLE,
        f"Passages:\n\n{passages_prompt(passages)}\n\nWrite {sum(split.values())} questions testing {level}:\n"
        + "\n".join(wanted)
        + "\nFill every field of every question; fields that don't apply to its type are [] or 0 (e.g. a short "
        "answer has `options` [] and `answer` 0). Mix the types through the quiz rather than grouping them. "
        "`explanation` says why the answer is "
        "right (for mcq, also why the most tempting wrong option is wrong). `cite` lists supporting passage "
        "numbers." + _focus_line(focus),
        QUIZ_SCHEMA, **kw,
    )
    questions = [q for q in (clean_quiz_question(x, len(passages)) for x in out.get("questions") or []) if q]
    if not questions:
        raise GeminiError("Gemini didn't produce usable questions. Try again.")
    return {"title": out.get("title") or "Quiz", "questions": questions}


def build_sheet(passages, subtype: str, focus: str | None, **kw) -> dict[str, Any]:
    label, what = SHEETS[subtype]
    out = generate_json(
        "You turn source material into clear study documents. " + STYLE,
        f"Passages:\n\n{passages_prompt(passages)}\n\nWrite {what}. Format the `body` as Markdown with "
        "headings (##), short paragraphs and flat bullet lists. Cite passages inline as [n] right after "
        "the claims they support." + _focus_line(focus),
        SHEET_SCHEMA, **kw,
    )
    body = (out.get("body") or "").strip()
    if not body:
        raise GeminiError("Gemini returned an empty sheet. Try again.")
    return {"title": out.get("title") or label, "body": body}


def build_concept_map(passages, focus: str | None, **kw) -> dict[str, Any]:
    out = generate_json(
        "You map how ideas in source material relate. " + STYLE,
        f"Passages:\n\n{passages_prompt(passages)}\n\nBuild a concept tree of the material: one root node "
        "(parent = \"\"), 3–7 main branches, and 2–5 sub-nodes under each where the sources support it "
        "(max depth 4, max 45 nodes). Labels are 1–6 words. `note` is one short sentence on how the node "
        "relates to its parent. Ids are short unique strings. `cite` lists supporting passage numbers."
        + _focus_line(focus),
        MAP_SCHEMA, **kw,
    )
    nodes = out.get("nodes") or []
    ids = {n.get("id") for n in nodes}
    clean = []
    for n in nodes:
        if not n.get("id") or not n.get("label"):
            continue
        parent = n.get("parent") or ""
        clean.append({
            "id": str(n["id"]), "parent": str(parent) if parent in ids and parent != n["id"] else "",
            "label": n["label"].strip(), "note": (n.get("note") or "").strip(),
            "cite": _clean_cites(n.get("cite"), len(passages)),
        })
    if not clean:
        raise GeminiError("Gemini didn't produce a concept map. Try again.")
    roots = [n for n in clean if not n["parent"]]
    if len(roots) > 1:  # keep it a single tree: hang extra roots under the first
        for r in roots[1:]:
            r["parent"] = roots[0]["id"]
    return {"title": out.get("title") or "Concept map", "nodes": clean}


def build_episode(passages, fmt: str, length: str, focus: str | None, **kw) -> dict[str, Any]:
    label, speakers, style = EPISODE_FORMATS[fmt]
    words = EPISODE_LENGTHS.get(length, EPISODE_LENGTHS["medium"])
    who = " and ".join(speakers)
    out = generate_json(
        "You write audio scripts that teach. They will be read aloud by text-to-speech, so write for the ear: "
        "short sentences, no lists, no headings, no Markdown, no stage directions, spell out symbols "
        "('carbon dioxide', not 'CO2'). Use only facts in the passages.",
        f"Passages:\n\n{passages_prompt(passages)}\n\nWrite {style}. Speakers: {who} (use exactly these names "
        f"in `speaker`). About {words} words in total. Open with a hook, not a greeting to 'listeners'. "
        "Each line is one speaker turn of 1–4 sentences. `cite` lists the passage numbers a line draws on "
        "(empty for pure banter). `summary` is one sentence describing the episode." + _focus_line(focus),
        EPISODE_SCHEMA, **kw,
    )
    lines = []
    for ln in out.get("lines", []):
        text = re.sub(r"\[\d+(?:\s*,\s*\d+)*\]", "", (ln.get("text") or "")).strip()
        if not text:
            continue
        speaker = ln.get("speaker") if ln.get("speaker") in speakers else speakers[len(lines) % len(speakers)]
        lines.append({"speaker": speaker, "text": text, "cite": _clean_cites(ln.get("cite"), len(passages))})
    if not lines:
        raise GeminiError("Gemini didn't produce an episode script. Try again.")
    return {"title": out.get("title") or label, "summary": (out.get("summary") or "").strip(),
            "speakers": speakers, "lines": lines}


# ---------------------------------------------------------------- persistence


def create_artifact(
    db: Session,
    subject_id: int,
    kind: str,
    subtype: str,
    params: dict[str, Any],
    passages: list[Retrieved],
    content: dict[str, Any],
) -> Artifact:
    art = Artifact(
        subject_id=subject_id, kind=kind, subtype=subtype, title=content.get("title", kind)[:300],
        params=params, passages=[chunk_citation(r) for r in passages], content={},
    )
    db.add(art)
    db.flush()
    fill_artifact(db, art, content)
    db.commit()
    db.refresh(art)
    return art


def fill_artifact(db: Session, art: Artifact, content: dict[str, Any]) -> None:
    """Store generated content on an artifact (title, content, and a deck's cards). Caller commits."""
    art.title = (content.get("title") or art.title)[:300]
    art.content = {k: v for k, v in content.items() if k not in ("title", "cards")}
    for c in content.get("cards", []):
        db.add(Card(deck_id=art.id, front=c["front"], back=c["back"], cite=c["cite"]))


# ---------------------------------------------------------------- speech (episodes)

VOICES = {"Maya": "Kore", "Theo": "Puck"}
TTS_CHUNK_CHARS = 2400


def _tts_body(group: list[dict[str, Any]], speakers: list[str]) -> dict[str, Any]:
    """Interactions-API speech request: one text item per line, tagged with its speaker."""
    single = len(speakers) == 1
    content = []
    for ln in group:
        item: dict[str, Any] = {"type": "text", "text": ln["text"]}
        if not single:
            item["annotations"] = [{"type": "speech_metadata", "speaker": ln["speaker"]}]
        content.append(item)
    speech = (
        [{"voice": VOICES.get(speakers[0], "Kore")}] if single
        else {"mode": "conversational", "speakers": [{"speaker": sp, "voice": VOICES.get(sp, "Kore")} for sp in speakers]}
    )
    return {
        "input": [{"type": "user_input", "content": content}],
        "response_format": {"type": "audio", "mime_type": "audio/l16", "sample_rate": 24000},
        "generation_config": {"speech_config": speech},
    }


def _tts_groups(lines: list[dict[str, Any]]) -> list[list[dict[str, Any]]]:
    groups, cur, size = [], [], 0
    for ln in lines:
        if cur and size + len(ln["text"]) > TTS_CHUNK_CHARS:
            groups.append(cur)
            cur, size = [], 0
        cur.append(ln)
        size += len(ln["text"])
    if cur:
        groups.append(cur)
    return groups


def synthesize_episode(
    art: Artifact,
    http: httpx.Client | None = None,
    sleep: Callable[[float], None] | None = None,
) -> Path:
    """Render an episode script to a WAV file with Gemini's speech model. Each ~2.4k-char group of
    lines is one request (so a medium episode costs ~3 requests of the TTS model's quota)."""
    s = get_settings()
    speakers = art.content.get("speakers") or ["Maya"]
    lines = art.content.get("lines") or []
    pcm = bytearray()
    rate = 24000
    own = http is None
    http = http or _client(600.0)
    kwargs = {"sleep": sleep} if sleep else {}
    try:
        for group in _tts_groups(lines):
            data = _response_json(send_resilient(
                http, [s.gemini_tts_model], "", _tts_body(group, speakers), endpoint="interactions", **kwargs))
            audio = [c for step in data.get("steps") or [] for c in step.get("content") or [] if c.get("type") == "audio"]
            if not audio:
                raise GeminiError("Gemini's speech model returned no audio.")
            for a in audio:
                rate = int(a.get("sample_rate") or rate)
                pcm += base64.b64decode(a["data"])
    except httpx.HTTPError as exc:
        raise GeminiError(f"Could not reach the Gemini API ({exc.__class__.__name__}).") from exc
    finally:
        if own:
            http.close()

    out_dir = Path(s.data_dir) / "audio"
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / f"episode-{art.id}.wav"
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(bytes(pcm))
    return path


# ---------------------------------------------------------------- transcription (lecture audio, YouTube)

TRANSCRIBE_SYSTEM = (
    "You transcribe lectures and talks for students' notes. Produce a faithful, readable transcript: "
    "remove filler words and false starts, keep all content, split into paragraphs at topic changes, "
    "and add short '## Section' headings where the topic clearly shifts. Do not summarise."
)
MAX_AUDIO_BYTES = 18 * 1024 * 1024  # Gemini inline-data request limit is ~20 MB
YOUTUBE_RE = re.compile(r"^https?://(www\.|m\.)?(youtube\.com/(watch\?v=|shorts/|live/)|youtu\.be/)[\w-]{6,}")


def _transcript_doc(out: dict[str, Any], fallback_title: str) -> ParsedDoc:
    text = (out.get("transcript") or "").strip()
    if not text:
        raise GeminiError("Gemini couldn't hear any speech to transcribe.")
    return parse_text(text, (out.get("title") or fallback_title).strip()[:300])


def transcribe_audio(data: bytes, mime: str, filename: str, **kw) -> ParsedDoc:
    if len(data) > MAX_AUDIO_BYTES:
        raise GeminiError("Audio files up to 18 MB are supported (about 30–60 min of compressed audio).")
    out = generate_json(
        TRANSCRIBE_SYSTEM,
        "Transcribe this recording. `title` is a short descriptive title for the lecture.",
        TRANSCRIPT_SCHEMA,
        parts=[{"inlineData": {"mimeType": mime, "data": base64.b64encode(data).decode()}}],
        **kw,
    )
    return _transcript_doc(out, filename or "Lecture recording")


def transcribe_youtube(url: str, **kw) -> ParsedDoc:
    out = generate_json(
        TRANSCRIBE_SYSTEM,
        "Transcribe the spoken content of this video. `title` is the video's topic in a few words.",
        TRANSCRIPT_SCHEMA,
        parts=[{"fileData": {"fileUri": url}}],
        **kw,
    )
    return _transcript_doc(out, "YouTube video")
