"""Routes for generated study material: decks + spaced review, quizzes + attempts, sheets, episodes."""

import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from starlette.concurrency import run_in_threadpool
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .db import get_db
from .embeddings import get_embedder
from .gemini import GeminiError, chunk_citation
from .generate import (
    EPISODE_FORMATS,
    EPISODE_LENGTHS,
    SHEETS,
    build_concept_map,
    build_deck,
    build_episode,
    build_quiz,
    question_marks,
    build_sheet,
    create_artifact,
    fill_artifact,
    select_passages,
    synthesize_episode,
)
from . import ib
from .exams import SIZES as EXAM_SIZES, build_exam, draft_markscheme, mark_answer, mark_quiz
from .models import Artifact, Card, QuizAttempt, Subject
from .retrieval import retrieve
from .summarize import FORMATS as SUMMARY_FORMATS, build_summary, summary_passages
from .srs import GRADES, CardState, preview, schedule
from . import vision

router = APIRouter()

PASSAGE_BUDGET = {"deck": 20, "quiz": 20, "sheet": 24, "episode": 18, "exam": 24}


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _aware(dt: datetime) -> datetime:
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


# ---------------------------------------------------------------- schemas


class GenerateIn(BaseModel):
    kind: Literal["deck", "quiz", "sheet", "episode", "summary", "exam"]
    subtype: str = ""
    source_ids: list[int]
    focus: str | None = Field(default=None, max_length=500)
    count: int | None = Field(default=None, ge=1, le=40)
    difficulty: Literal["easy", "medium", "hard"] = "medium"
    length: Literal["short", "medium", "long"] = "medium"
    page_from: int | None = Field(default=None, ge=1)  # summaries: optional PDF page range
    page_to: int | None = Field(default=None, ge=1)
    extended: bool = True  # exams: include an extended-response (markband) item
    types: list[Literal["mcq", "short", "long"]] = Field(default_factory=lambda: ["mcq"])  # quizzes


class MarkIn(BaseModel):
    answer: str = Field(max_length=20000)


class CustomQuestionIn(BaseModel):
    question: str = Field(min_length=5, max_length=6000)
    marks: int = Field(ge=1, le=30)
    answer: str = Field(default="", max_length=20000)
    source_ids: list[int]


class GradeIn(BaseModel):
    grade: Literal["again", "hard", "good", "easy"]


class AttemptIn(BaseModel):
    # per question: option index for multiple choice, text for short/written answers (None = blank)
    answers: list[int | str | None]


def card_out(c: Card, now: datetime | None = None) -> dict[str, Any]:
    now = now or _now()
    state = CardState(c.ease, c.interval_days, c.reps, c.lapses)
    return {
        "id": c.id, "front": c.front, "back": c.back, "cite": c.cite,
        "reps": c.reps, "lapses": c.lapses, "interval_days": round(c.interval_days, 2),
        "due_at": _aware(c.due_at).isoformat(), "is_new": c.reps == 0 and c.last_reviewed_at is None,
        "next": preview(state, now),
    }


def artifact_out(db: Session, a: Artifact, detail: bool = False) -> dict[str, Any]:
    out: dict[str, Any] = {
        "id": a.id, "subject_id": a.subject_id, "kind": a.kind, "subtype": a.subtype, "title": a.title,
        "params": a.params, "created_at": _aware(a.created_at).isoformat(),
        "has_audio": bool(a.audio_path and Path(a.audio_path).exists()),
    }
    if a.kind == "deck":
        now = _now()
        out["card_count"] = db.scalar(select(func.count(Card.id)).where(Card.deck_id == a.id)) or 0
        out["due_count"] = db.scalar(
            select(func.count(Card.id)).where(Card.deck_id == a.id, Card.due_at <= now)
        ) or 0
    if a.kind == "quiz":
        qs = a.content.get("questions", [])
        out["question_count"] = len(qs)
        out["total_marks"] = sum(question_marks(q) for q in qs)
        out["types"] = sorted({q.get("type", "mcq") for q in qs})
        attempts = a.attempts
        out["attempts"] = len(attempts)
        out["best"] = max((t.score for t in attempts), default=None)
        out["last"] = attempts[-1].score if attempts else None
    out["status"] = getattr(a, "status", None) or "ready"
    out["error"] = a.error
    if out["status"] == "processing":
        st = gen_state(a.id)
        out["progress"], out["stage"] = st if st else (None, None)
    if a.kind == "summary":
        out["parts"] = a.content.get("parts")
    if a.kind == "exam":
        qs = a.content.get("questions", [])
        latest = _latest_marks(a)
        out["question_count"] = len(qs)
        out["total_marks"] = sum(q["marks"] for q in qs)
        out["answered"] = len(latest)
        out["scored"] = sum((m["result"] or {}).get("marks_awarded", 0) for m in latest.values())
        out["scored_of"] = sum(qs[i]["marks"] for i in latest if i < len(qs))
    if a.kind == "episode":
        words = sum(len(ln["text"].split()) for ln in a.content.get("lines", []))
        out["minutes"] = max(1, round(words / 150))
        out["summary"] = a.content.get("summary", "")
    if detail:
        out["content"] = a.content
        out["passages"] = a.passages
        if a.kind == "deck":
            out["cards"] = [card_out(c) for c in a.cards]
        if a.kind == "exam":
            out["marked"] = {str(k): v for k, v in _latest_marks(a).items()}
    return out


def _subject_or_404(db: Session, subject_id: int) -> Subject:
    subj = db.get(Subject, subject_id)
    if not subj:
        raise HTTPException(404, "Subject not found")
    return subj


def _artifact_or_404(db: Session, artifact_id: int, kind: str | None = None) -> Artifact:
    art = db.get(Artifact, artifact_id)
    if not art or (kind and art.kind != kind):
        raise HTTPException(404, "Not found")
    return art


# ---------------------------------------------------------------- generic artifacts


@router.get("/subjects/{subject_id}/artifacts")
def list_artifacts(subject_id: int, kind: str | None = None, db: Session = Depends(get_db)):
    _subject_or_404(db, subject_id)
    stmt = select(Artifact).where(Artifact.subject_id == subject_id)
    if kind:
        stmt = stmt.where(Artifact.kind == kind)
    return [artifact_out(db, a) for a in db.scalars(stmt.order_by(Artifact.created_at.desc())).all()]


@router.post("/subjects/{subject_id}/artifacts", status_code=201)
def generate_artifact(subject_id: int, body: GenerateIn, db: Session = Depends(get_db)):
    """Start generating study material from the given (checked) sources.

    Returns at once with the artifact in status "processing"; the work runs on a background
    worker (~30–90 s; summaries of whole books longer), so it survives the student leaving the
    page or reloading. Poll the artifact (or the list) until status is "ready" or "failed".
    """
    return _generate(db, subject_id, body)


def _generate(db: Session, subject_id: int, body: GenerateIn, reuse: Artifact | None = None) -> dict[str, Any]:
    """Validate, pick passages and queue the job. With `reuse`, refill that (failed) artifact instead
    of creating a new one, so "Try again" doesn't leave a trail of failed copies."""
    subject = _subject_or_404(db, subject_id)
    ctx = ib.context(subject)
    course = ib.course_of(subject)
    subtype = body.subtype
    if body.kind == "summary":
        return _start_summary(db, subject_id, body, ctx, reuse)
    if body.kind == "sheet" and subtype not in (*SHEETS, "concept_map"):
        raise HTTPException(422, f"Unknown sheet type '{subtype}'")
    if body.kind == "episode":
        subtype = subtype or "conversation"
        if subtype not in EPISODE_FORMATS:
            raise HTTPException(422, f"Unknown episode format '{subtype}'")

    passages = select_passages(db, subject_id, body.source_ids, get_embedder(), body.focus,
                               PASSAGE_BUDGET[body.kind])
    if not passages:
        raise HTTPException(422, "Check at least one source with text in the Library first.")

    if body.kind == "exam":
        subtype = subtype if subtype in EXAM_SIZES else "short"
    label = course.label if course else ""
    kind, count, difficulty, focus, extended, length, types = (
        body.kind, body.count, body.difficulty, body.focus, body.extended, body.length, body.types)

    def produce(on_progress):
        # Looked up at call time so tests can monkeypatch the builders.
        if kind == "deck":
            on_progress(0.1, "Writing the cards")
            return build_deck(passages, count or 15, focus, ctx=ctx)
        if kind == "quiz":
            on_progress(0.1, "Writing the questions")
            return build_quiz(passages, count or 8, difficulty, focus, types=types, ctx=ctx)
        if kind == "sheet" and subtype == "concept_map":
            on_progress(0.1, "Mapping the ideas")
            return build_concept_map(passages, focus, ctx=ctx)
        if kind == "sheet":
            on_progress(0.1, "Writing the sheet")
            return build_sheet(passages, subtype, focus, ctx=ctx)
        if kind == "exam":
            on_progress(0.1, "Writing questions and markschemes")
            return build_exam(passages, subtype, extended, focus, course_label=label, ctx=ctx)
        on_progress(0.1, "Writing the script")
        return build_episode(passages, subtype, length, focus, ctx=ctx)

    params = body.model_dump(exclude={"kind", "subtype"})
    return _start_generation(db, subject_id, body.kind, subtype, params, passages, produce, reuse)


@router.get("/artifacts/{artifact_id}")
def get_artifact(artifact_id: int, db: Session = Depends(get_db)):
    return artifact_out(db, _artifact_or_404(db, artifact_id), detail=True)


@router.patch("/artifacts/{artifact_id}")
def rename_artifact(artifact_id: int, body: dict[str, str], db: Session = Depends(get_db)):
    art = _artifact_or_404(db, artifact_id)
    if title := (body.get("title") or "").strip():
        art.title = title[:300]
        db.commit()
    return artifact_out(db, art)


@router.delete("/artifacts/{artifact_id}", status_code=204)
def delete_artifact(artifact_id: int, db: Session = Depends(get_db)):
    art = _artifact_or_404(db, artifact_id)
    if art.audio_path:
        Path(art.audio_path).unlink(missing_ok=True)
    db.delete(art)
    db.commit()


# ---------------------------------------------------------------- spaced review


@router.get("/artifacts/{artifact_id}/review")
def review_queue(artifact_id: int, limit: int = 50, db: Session = Depends(get_db)):
    """Cards due now: relearning/review cards first (oldest due first), then new ones."""
    _artifact_or_404(db, artifact_id, "deck")
    now = _now()
    cards = db.scalars(
        select(Card).where(Card.deck_id == artifact_id, Card.due_at <= now)
        .order_by((Card.reps == 0), Card.due_at, Card.id).limit(limit)
    ).all()
    upcoming = db.scalar(select(func.min(Card.due_at)).where(Card.deck_id == artifact_id, Card.due_at > now))
    return {"cards": [card_out(c, now) for c in cards],
            "next_due_at": _aware(upcoming).isoformat() if upcoming else None}


@router.post("/cards/{card_id}/review")
def review_card(card_id: int, body: GradeIn, db: Session = Depends(get_db)):
    card = db.get(Card, card_id)
    if not card:
        raise HTTPException(404, "Card not found")
    now = _now()
    state, due = schedule(CardState(card.ease, card.interval_days, card.reps, card.lapses), body.grade, now)
    card.ease, card.interval_days, card.reps, card.lapses = state.ease, state.interval_days, state.reps, state.lapses
    card.due_at, card.last_reviewed_at = due, now
    db.commit()
    return card_out(card, now)


@router.post("/artifacts/{artifact_id}/reset", status_code=204)
def reset_deck(artifact_id: int, db: Session = Depends(get_db)):
    """Make every card new and due again (e.g. cramming before an exam)."""
    art = _artifact_or_404(db, artifact_id, "deck")
    now = _now()
    for c in art.cards:
        c.ease, c.interval_days, c.reps, c.lapses, c.due_at, c.last_reviewed_at = 2.5, 0.0, 0, 0, now, None
    db.commit()


# ---------------------------------------------------------------- quizzes


@router.post("/artifacts/{artifact_id}/attempts")
def submit_attempt(artifact_id: int, body: AttemptIn, db: Session = Depends(get_db)):
    """Mark a quiz attempt. Written answers are marked by Gemini (one request for the whole quiz)."""
    art = _artifact_or_404(db, artifact_id, "quiz")
    questions = art.content.get("questions", [])
    answers = (list(body.answers) + [None] * len(questions))[: len(questions)]
    course = ib.course_of(db.get(Subject, art.subject_id))
    try:
        results = mark_quiz(questions, answers, course_label=course.label if course else "")
    except GeminiError as exc:
        raise HTTPException(503, f"Couldn't mark the written answers: {exc}") from exc
    score = sum(r["marks"] for r in results)
    total = sum(r["max"] for r in results)
    db.add(QuizAttempt(quiz_id=art.id, answers=answers, score=score, total=total))
    db.commit()
    return {
        "score": score, "total": total, "answers": answers, "results": results,
        "correct": [q["answer"] if q.get("type", "mcq") == "mcq" else (q.get("accept") or [None])[0]
                    for q in questions],
    }


# ---------------------------------------------------------------- episode audio


@router.post("/artifacts/{artifact_id}/audio")
def render_audio(artifact_id: int, db: Session = Depends(get_db)):
    """Render studio audio with Gemini's speech model (uses TTS quota; can take a minute or two)."""
    art = _artifact_or_404(db, artifact_id, "episode")
    try:
        path = synthesize_episode(art)
    except GeminiError as exc:
        raise HTTPException(503, str(exc)) from exc
    art.audio_path = str(path)
    db.commit()
    return artifact_out(db, art)


@router.get("/artifacts/{artifact_id}/audio")
def get_audio(artifact_id: int, db: Session = Depends(get_db)):
    art = _artifact_or_404(db, artifact_id, "episode")
    if not art.audio_path or not Path(art.audio_path).exists():
        raise HTTPException(404, "No audio rendered yet")
    return FileResponse(art.audio_path, media_type="audio/wav", filename=f"{art.title}.wav")


@router.get("/study/options")
def study_options():
    """Labels for the frontend's pickers, so names live in one place."""
    return {
        "sheets": {k: v[0] for k, v in SHEETS.items()} | {"concept_map": "Concept map"},
        "episode_formats": {k: {"label": v[0], "speakers": v[1]} for k, v in EPISODE_FORMATS.items()},
        "episode_lengths": {k: max(1, round(w / 150)) for k, w in EPISODE_LENGTHS.items()},
        "grades": GRADES,
    }


# ---------------------------------------------------------------- summaries (background)

_gen_pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix="generate")
_gen_state: dict[int, tuple[float, str]] = {}
_gen_lock = threading.Lock()
SUMMARY_LENGTH = {"short": "brief", "medium": "standard", "long": "detailed"}


def _set_gen(art_id: int, value: tuple[float, str] | None) -> None:
    with _gen_lock:
        if value is None:
            _gen_state.pop(art_id, None)
        else:
            _gen_state[art_id] = value


def gen_state(art_id: int) -> tuple[float, str] | None:
    with _gen_lock:
        return _gen_state.get(art_id)


def _start_summary(db: Session, subject_id: int, body: GenerateIn, ctx: str,
                   reuse: Artifact | None = None) -> dict[str, Any]:
    fmt = body.subtype or "key_points"
    if fmt not in SUMMARY_FORMATS:
        raise HTTPException(422, f"Unknown summary format '{fmt}'")
    try:
        passages = summary_passages(db, subject_id, body.source_ids, get_embedder(), body.focus,
                                    body.page_from, body.page_to)
    except GeminiError as exc:
        raise HTTPException(422, str(exc)) from exc
    if not passages:
        raise HTTPException(422, "Nothing to summarise: check a ready source (and a page range that exists).")
    params = body.model_dump(exclude={"kind", "subtype"})
    length = SUMMARY_LENGTH[body.length]
    focus = body.focus
    return _start_generation(
        db, subject_id, "summary", fmt, params, passages,
        lambda on_progress: build_summary(passages, fmt, length, focus, on_progress=on_progress, ctx=ctx),
        reuse,
    )


PLACEHOLDER_TITLES = {"deck": "Recall cards", "quiz": "Quiz", "exam": "Exam practice", "summary": "Summary"}


def _placeholder_title(kind: str, subtype: str) -> str:
    if kind == "sheet":
        return "Concept map" if subtype == "concept_map" else SHEETS.get(subtype, ("Study sheet",))[0]
    if kind == "episode":
        return EPISODE_FORMATS.get(subtype, ("Episode",))[0]
    if kind == "summary":
        return SUMMARY_FORMATS.get(subtype, ("Summary",))[0]
    return PLACEHOLDER_TITLES.get(kind, kind)


def _start_generation(db: Session, subject_id: int, kind: str, subtype: str, params: dict[str, Any],
                      passages, produce, reuse: Artifact | None = None) -> dict[str, Any]:
    """Save a "processing" placeholder now and run `produce(on_progress) -> content` on a worker."""
    title = _placeholder_title(kind, subtype)
    if reuse is None:
        art = create_artifact(db, subject_id, kind, subtype, params, passages, {"title": title})
    else:
        art = reuse
        for card in list(art.cards):
            db.delete(card)
        art.title, art.content, art.error = title, {}, None
        art.passages = [chunk_citation(r) for r in passages]
    art.status = "processing"
    db.commit()
    _set_gen(art.id, (0.0, "Queued"))
    _gen_pool.submit(_run_generation, art.id, produce, title)
    return artifact_out(db, art, detail=True)


def _run_generation(art_id: int, produce, title: str) -> None:
    from . import db as dbmod

    session = dbmod._SessionLocal()
    try:
        content = produce(lambda f, st: _set_gen(art_id, (round(f, 3), st)))
        art = session.get(Artifact, art_id)
        if art is None:  # deleted while generating
            return
        fill_artifact(session, art, content)
        art.status = "ready"
        session.commit()
    except Exception as exc:
        session.rollback()
        art = session.get(Artifact, art_id)
        if art is not None:
            art.status = "failed"
            art.error = str(exc) if isinstance(exc, GeminiError) else "Generating failed unexpectedly."
            art.title = f"{title} (failed)"
            session.commit()
    finally:
        _set_gen(art_id, None)
        session.close()


# ---------------------------------------------------------------- IB exam questions + marking


def _latest_marks(art: Artifact) -> dict[int, dict[str, Any]]:
    """The most recent marked answer per question index."""
    latest: dict[int, dict[str, Any]] = {}
    for att in art.attempts:
        for entry in att.answers:
            if isinstance(entry, dict) and "q" in entry:
                latest[entry["q"]] = {"answer": entry.get("answer", ""), "result": entry.get("result")}
    return latest


@router.post("/artifacts/{artifact_id}/questions/{qi}/mark")
def mark_question(artifact_id: int, qi: int, body: MarkIn, db: Session = Depends(get_db)):
    art = _artifact_or_404(db, artifact_id, "exam")
    questions = art.content.get("questions", [])
    if not 0 <= qi < len(questions):
        raise HTTPException(404, "No such question")
    if not body.answer.strip():
        raise HTTPException(422, "Write an answer first.")
    course = ib.course_of(db.get(Subject, art.subject_id))
    try:
        result = mark_answer(questions[qi], body.answer, course_label=course.label if course else "")
    except GeminiError as exc:
        raise HTTPException(503, str(exc)) from exc
    db.add(QuizAttempt(quiz_id=art.id, answers=[{"q": qi, "answer": body.answer, "result": result}],
                       score=result["marks_awarded"], total=result["max_marks"]))
    db.commit()
    return result


@router.post("/subjects/{subject_id}/exam/custom", status_code=201)
def custom_question(subject_id: int, body: CustomQuestionIn, db: Session = Depends(get_db)):
    """Your own (or a past-paper) question: draft a markscheme from your sources, then mark your answer."""
    subject = _subject_or_404(db, subject_id)
    course = ib.course_of(subject)
    label = course.label if course else ""
    passages = retrieve(db, subject_id, body.source_ids, get_embedder().embed_query(body.question), k=10)
    if not passages:
        raise HTTPException(422, "Check at least one source with text in the Library first.")
    try:
        content = draft_markscheme(passages, body.question, body.marks, course_label=label, ctx=ib.context(subject))
        result = (mark_answer(content["questions"][0], body.answer, course_label=label)
                  if body.answer.strip() else None)
    except GeminiError as exc:
        raise HTTPException(503, str(exc)) from exc
    art = create_artifact(db, subject_id, "exam", "custom", {"source_ids": body.source_ids}, passages, content)
    if result:
        db.add(QuizAttempt(quiz_id=art.id, answers=[{"q": 0, "answer": body.answer, "result": result}],
                           score=result["marks_awarded"], total=result["max_marks"]))
        db.commit()
        db.refresh(art)
    return artifact_out(db, art, detail=True)


@router.get("/ib/options")
def ib_options():
    return {
        "courses": ib.COURSES,
        "command_terms": [{"term": t, "objective": lv, "definition": d} for t, (lv, d) in ib.COMMAND_TERMS.items()],
        "summary_formats": {k: v[0] for k, v in SUMMARY_FORMATS.items()},
    }


# ---------------------------------------------------------------- photos of handwritten work


async def _images(files: list[UploadFile]) -> list[tuple[bytes, str]]:
    if not files:
        raise HTTPException(422, "Add at least one photo.")
    if len(files) > vision.MAX_IMAGES:
        raise HTTPException(422, f"Up to {vision.MAX_IMAGES} photos at a time.")
    out = []
    for f in files:
        data = await f.read(vision.MAX_IMAGE_BYTES + 1)
        if len(data) > vision.MAX_IMAGE_BYTES:
            raise HTTPException(413, "Each photo must be under 10 MB.")
        mime = (f.content_type or "").split(";")[0]
        if not mime.startswith("image/"):
            raise HTTPException(422, f"{f.filename or 'That file'} isn't a photo.")
        out.append((data, mime))
    return out


async def _vision_call(fn, *args, **kwargs):
    try:
        return await run_in_threadpool(fn, *args, **kwargs)
    except GeminiError as exc:
        raise HTTPException(503, str(exc)) from exc


@router.post("/vision/answer")
async def photo_answer(files: list[UploadFile] = File(...), question: str | None = Form(None)):
    """Read a handwritten answer from photo(s), word for word, for the student to check and then mark."""
    return await _vision_call(vision.read_answer, await _images(files), question)


@router.post("/vision/question")
async def photo_question(files: list[UploadFile] = File(...)):
    """Read an exam question (and its [marks]) from a photo of a past paper or book."""
    return await _vision_call(vision.read_question, await _images(files))


@router.post("/artifacts/{artifact_id}/quiz-photo")
async def quiz_photo(artifact_id: int, files: list[UploadFile] = File(...), db: Session = Depends(get_db)):
    """Read handwritten multiple-choice answers ("1 B, 2 D…") into option indexes for this quiz."""
    art = _artifact_or_404(db, artifact_id, "quiz")
    questions = art.content.get("questions", [])
    answers = await _vision_call(vision.read_quiz_answers, await _images(files), questions)
    return {"answers": answers}


@router.post("/artifacts/{artifact_id}/retry", status_code=202)
def retry_artifact(artifact_id: int, db: Session = Depends(get_db)):
    """Re-run a failed generation (e.g. Gemini was overloaded) with its original settings."""
    art = _artifact_or_404(db, artifact_id)
    if art.status != "failed":
        raise HTTPException(409, "Only failed items can be retried.")
    if art.subtype == "custom":
        raise HTTPException(409, "Ask that question again from “Mark my question”.")
    known = set(GenerateIn.model_fields)
    params = {k: v for k, v in (art.params or {}).items() if k in known}
    body = GenerateIn(kind=art.kind, subtype=art.subtype, **params)
    return _generate(db, art.subject_id, body, reuse=art)
