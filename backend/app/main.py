import os

# School/office networks often inspect HTTPS with their own root certificate, which Windows
# trusts but Python's bundled CA list doesn't. Use the OS trust store for every outbound call
# (Gemini, URL sources, the one-time Whisper/embedding model downloads).
import truststore

truststore.inject_into_ssl()
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")  # plain HTTP downloads; Xet transfers stall on some networks
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")

import uuid  # noqa: E402
from contextlib import asynccontextmanager
from pathlib import Path
from datetime import datetime

from fastapi import Depends, FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from .chat import ChatRequest, retrieval_query, sse
from .config import get_settings
from .db import create_schema, get_db, get_engine
from .embeddings import get_embedder
from .gemini import GeminiError, stream_gemini
from .generate import YOUTUBE_RE, transcribe_audio, transcribe_youtube
from .ingestion.parse import ParsedDoc, ParseError, parse_pdf, parse_text, parse_url
from .ingestion.pipeline import ingest
from . import ib
from .models import Artifact, Chunk, Source, Subject
from .retrieval import retrieve
from . import jobs
from .transcribe import whisper_producer

MAX_PDF_BYTES = 600 * 1024 * 1024  # big scanned-ish textbooks run 200–400 MB
MAX_RECORDING_BYTES = 2 * 1024 * 1024 * 1024  # 2 GB: a 2 h uncompressed WAV fits


@asynccontextmanager
async def lifespan(app: FastAPI):
    create_schema(get_engine())
    from . import db as dbmod

    with dbmod._SessionLocal() as session:
        jobs.resume_pending(session, JOB_PRODUCERS)
        # Summaries run in-process; any left "processing" by a restart can't finish.
        for art in session.scalars(select(Artifact).where(Artifact.status == "processing")).all():
            art.status, art.error = "failed", "Interrupted by a server restart. Please make it again."
        session.commit()
    yield


app = FastAPI(title="Study App API", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in get_settings().cors_origins.split(",") if o.strip()],
    allow_methods=["*"],
    allow_headers=["*"],
)

from .study_routes import router as study_router  # noqa: E402

app.include_router(study_router)


# ---------- schemas ----------

class SubjectIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    ib_course: str | None = Field(default=None, max_length=120)
    ib_level: str | None = Field(default=None, pattern="^(SL|HL|)$")


class SubjectPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    ib_course: str | None = Field(default=None, max_length=120)  # "" clears it
    ib_level: str | None = Field(default=None, pattern="^(SL|HL|)$")


class SubjectOut(BaseModel):
    id: int
    name: str
    created_at: datetime
    source_count: int = 0
    ib_course: str | None = None
    ib_level: str | None = None


class SourceOut(BaseModel):
    id: int
    subject_id: int
    kind: str
    title: str
    url: str | None
    checked: bool
    status: str
    chunk_count: int
    char_count: int
    page_count: int
    progress: float | None = None  # 0–1 while a big upload is being processed in the background
    stage: str | None = None  # e.g. "Reading pages", "Transcribing", "Indexing for search"
    error: str | None = None
    can_retry: bool = False  # failed, but the uploaded file is still here (e.g. ran out of memory)
    created_at: datetime


class SourceDetail(SourceOut):
    text: str
    pages: list[dict]


class TextSourceIn(BaseModel):
    title: str | None = None
    text: str = Field(min_length=1)


class UrlSourceIn(BaseModel):
    url: str = Field(min_length=4, max_length=2000)


class SourcePatch(BaseModel):
    checked: bool | None = None
    title: str | None = None


def _source_out(db: Session, s: Source, detail: bool = False):
    n = db.scalar(select(func.count(Chunk.id)).where(Chunk.source_id == s.id)) or 0
    data = dict(
        id=s.id, subject_id=s.subject_id, kind=s.kind, title=s.title, url=s.url,
        checked=s.checked, status=s.status, chunk_count=n, char_count=len(s.text),
        page_count=len(s.pages or []), created_at=s.created_at,
        progress=(jobs.state(s.id) or (None, None))[0] if s.status == "processing" else None,
        stage=(jobs.state(s.id) or (None, None))[1] if s.status == "processing" else None,
        error=s.error,
        can_retry=s.status == "failed" and bool(s.upload_path) and Path(s.upload_path).exists(),
    )
    if detail:
        return SourceDetail(**data, text=s.text, pages=s.pages or [])
    return SourceOut(**data)


def _subject_or_404(db: Session, subject_id: int) -> Subject:
    subj = db.get(Subject, subject_id)
    if not subj:
        raise HTTPException(404, "Subject not found")
    return subj


def _source_or_404(db: Session, source_id: int) -> Source:
    src = db.get(Source, source_id)
    if not src:
        raise HTTPException(404, "Source not found")
    return src


# ---------- subjects ----------

@app.get("/health")
def health():
    s = get_settings()
    return {"ok": True, "model": s.gemini_model, "key_configured": bool(s.gemini_api_key)}


@app.get("/subjects", response_model=list[SubjectOut])
def list_subjects(db: Session = Depends(get_db)):
    rows = db.execute(
        select(Subject, func.count(Source.id))
        .outerjoin(Source, Source.subject_id == Subject.id)
        .group_by(Subject.id)
        .order_by(Subject.created_at.desc())
    ).all()
    return [SubjectOut(id=s.id, name=s.name, created_at=s.created_at, source_count=n,
                       ib_course=s.ib_course, ib_level=s.ib_level) for s, n in rows]


@app.post("/subjects", response_model=SubjectOut, status_code=201)
def create_subject(body: SubjectIn, db: Session = Depends(get_db)):
    subj = Subject(name=body.name.strip(), ib_course=(body.ib_course or "").strip() or None,
                   ib_level=body.ib_level or None)
    db.add(subj)
    db.commit()
    return SubjectOut(id=subj.id, name=subj.name, created_at=subj.created_at,
                      ib_course=subj.ib_course, ib_level=subj.ib_level)


@app.patch("/subjects/{subject_id}", response_model=SubjectOut)
def patch_subject(subject_id: int, body: SubjectPatch, db: Session = Depends(get_db)):
    """Rename a subject or set its IB course/level (which steers every generator and the chat)."""
    subj = _subject_or_404(db, subject_id)
    if body.name is not None:
        subj.name = body.name.strip()
    if body.ib_course is not None:
        subj.ib_course = body.ib_course.strip() or None
    if body.ib_level is not None:
        subj.ib_level = body.ib_level or None
    db.commit()
    n = db.scalar(select(func.count(Source.id)).where(Source.subject_id == subj.id)) or 0
    return SubjectOut(id=subj.id, name=subj.name, created_at=subj.created_at, source_count=n,
                      ib_course=subj.ib_course, ib_level=subj.ib_level)


@app.delete("/subjects/{subject_id}", status_code=204)
def delete_subject(subject_id: int, db: Session = Depends(get_db)):
    db.delete(_subject_or_404(db, subject_id))
    db.commit()


# ---------- sources ----------

@app.get("/subjects/{subject_id}/sources", response_model=list[SourceOut])
def list_sources(subject_id: int, db: Session = Depends(get_db)):
    subj = _subject_or_404(db, subject_id)
    return [_source_out(db, s) for s in subj.sources]


def _ingest_or_422(db: Session, subject_id: int, kind: str, parse, url: str | None = None):
    _subject_or_404(db, subject_id)
    try:
        doc = parse()
    except ParseError as exc:
        raise HTTPException(422, str(exc)) from exc
    except GeminiError as exc:
        raise HTTPException(503, str(exc)) from exc
    src = ingest(db, subject_id, kind, doc, get_embedder(), url=url)
    return _source_out(db, src)


@app.post("/subjects/{subject_id}/sources/text", response_model=SourceOut, status_code=201)
def add_text_source(subject_id: int, body: TextSourceIn, db: Session = Depends(get_db)):
    return _ingest_or_422(db, subject_id, "text", lambda: parse_text(body.text, body.title))


@app.post("/subjects/{subject_id}/sources/url", response_model=SourceOut, status_code=201)
def add_url_source(subject_id: int, body: UrlSourceIn, db: Session = Depends(get_db)):
    url = body.url.strip()
    if "://" not in url:
        url = "https://" + url
    if YOUTUBE_RE.match(url):  # videos are transcribed by Gemini instead of scraped
        return _ingest_or_422(db, subject_id, "video", lambda: transcribe_youtube(url), url=url)
    return _ingest_or_422(db, subject_id, "url", lambda: parse_url(url), url=url)


@app.post("/subjects/{subject_id}/sources/audio", response_model=SourceOut, status_code=201)
async def add_audio_source(subject_id: int, file: UploadFile = File(...), db: Session = Depends(get_db)):
    """A lecture recording (uploaded or recorded in the browser), transcribed by Gemini."""
    data = await file.read()
    mime = (file.content_type or "").split(";")[0] or "audio/webm"
    if not (mime.startswith("audio/") or mime.startswith("video/")):
        raise HTTPException(422, "That file isn't audio.")
    name = (file.filename or "").rsplit(".", 1)[0]
    return await run_in_threadpool(_ingest_or_422, db, subject_id, "audio", lambda: transcribe_audio(data, mime, name))


@app.post("/subjects/{subject_id}/sources/recording", response_model=SourceOut, status_code=202)
async def add_recording(subject_id: int, file: UploadFile = File(...), db: Session = Depends(get_db)):
    """A lecture recording of any audio/video format, up to 2 h, transcribed locally by Whisper.

    Returns immediately with status "processing"; poll the source list for `progress`.
    """
    _subject_or_404(db, subject_id)
    dest = await _save_upload(file, MAX_RECORDING_BYTES, "Recordings up to 2 GB are supported.")
    return _start_job(db, subject_id, "audio", file.filename, "Lecture recording", dest)


async def _save_upload(file: UploadFile, limit: int, too_big: str, magic: bytes | None = None) -> Path:
    """Stream an upload to backend/data/uploads without holding it in memory."""
    upload_dir = Path(get_settings().data_dir) / "uploads"
    upload_dir.mkdir(parents=True, exist_ok=True)
    dest = upload_dir / f"{uuid.uuid4().hex}{Path(file.filename or '').suffix.lower()[:10]}"
    size = 0
    try:
        with dest.open("wb") as out:
            while chunk := await file.read(8 * 1024 * 1024):
                if size == 0 and magic and not chunk.startswith(magic):
                    raise HTTPException(422, "That file isn't a PDF")
                size += len(chunk)
                if size > limit:
                    raise HTTPException(413, too_big)
                out.write(chunk)
        if size == 0:
            raise HTTPException(422, "That file is empty.")
    except HTTPException:
        dest.unlink(missing_ok=True)
        raise
    return dest


def _start_job(db: Session, subject_id: int, kind: str, filename: str | None, fallback: str, path: Path):
    title = Path(filename or "").stem.replace("_", " ").strip() or fallback
    src = Source(subject_id=subject_id, kind=kind, title=title[:500], text="", pages=[],
                 status="processing", upload_path=str(path))
    db.add(src)
    db.commit()
    queue, produce, share = JOB_PRODUCERS[kind]
    jobs.submit(queue, src.id, path, produce, share)
    return _source_out(db, src)


def pdf_producer(path: Path, title: str, report) -> ParsedDoc:
    """jobs.Producer for uploaded PDFs: page-by-page extraction with progress."""
    doc = parse_pdf(path, title=None, on_progress=lambda i, n: report(i / n, f"Reading pages ({i}/{n})"))
    if doc.title == "Untitled PDF":
        doc.title = title
    return doc


# Source.kind -> (queue, producer, share of the progress bar spent producing vs. indexing)
JOB_PRODUCERS = {
    "audio": ("media", whisper_producer, 0.9),
    "pdf": ("docs", pdf_producer, 0.5),
}


@app.post("/subjects/{subject_id}/sources/pdf", response_model=SourceOut, status_code=202)
async def add_pdf_source(subject_id: int, file: UploadFile = File(...), db: Session = Depends(get_db)):
    """PDFs up to 600 MB. Streamed to disk, then parsed and indexed in the background:
    returns status "processing" at once; poll the source list for `progress`/`stage`."""
    _subject_or_404(db, subject_id)
    dest = await _save_upload(file, MAX_PDF_BYTES, "PDFs up to 600 MB are supported.", magic=b"%PDF")
    return _start_job(db, subject_id, "pdf", file.filename, "Untitled PDF", dest)


@app.get("/sources/{source_id}", response_model=SourceDetail)
def get_source(source_id: int, db: Session = Depends(get_db)):
    return _source_out(db, _source_or_404(db, source_id), detail=True)


@app.patch("/sources/{source_id}", response_model=SourceOut)
def patch_source(source_id: int, body: SourcePatch, db: Session = Depends(get_db)):
    src = _source_or_404(db, source_id)
    if body.checked is not None:
        src.checked = body.checked
    if body.title:
        src.title = body.title.strip()[:500]
    db.commit()
    return _source_out(db, src)


@app.delete("/sources/{source_id}", status_code=204)
def delete_source(source_id: int, db: Session = Depends(get_db)):
    src = _source_or_404(db, source_id)
    if src.upload_path and src.status != "processing":
        Path(src.upload_path).unlink(missing_ok=True)
    db.delete(src)
    db.commit()


@app.post("/sources/{source_id}/retry", response_model=SourceOut, status_code=202)
def retry_source(source_id: int, db: Session = Depends(get_db)):
    """Re-run a failed background job on the file that was already uploaded."""
    src = _source_or_404(db, source_id)
    if src.status != "failed" or not src.upload_path or not Path(src.upload_path).exists():
        raise HTTPException(409, "Nothing to retry for this source. Upload it again.")
    src.status, src.error = "processing", None
    db.commit()
    queue, produce, share = JOB_PRODUCERS[src.kind]
    jobs.submit(queue, src.id, Path(src.upload_path), produce, share)
    return _source_out(db, src)


# ---------- chat ----------

@app.post("/subjects/{subject_id}/chat")
def chat(subject_id: int, req: ChatRequest, db: Session = Depends(get_db)):
    subject = _subject_or_404(db, subject_id)
    ctx = ib.context(subject)
    source_ids = list(req.source_ids)
    # A highlight always grounds in its own source, even if unchecked.
    if req.selection and req.selection.source_id not in source_ids:
        source_ids.append(req.selection.source_id)
    query_vec = get_embedder().embed_query(retrieval_query(req))
    hits = retrieve(db, subject_id, source_ids, query_vec, k=get_settings().retrieval_k)

    def gen():
        for event in stream_gemini(req, hits, ctx=ctx):
            yield sse(event)

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ---------- export (to move the library onto the phone app) ----------


@app.get("/export")
def export_library(db: Session = Depends(get_db)):
    """Everything as a Marginalia backup file the phone app can import. Search vectors are left out
    (the phone uses Gemini embeddings of a different size), so the phone re-indexes the sources;
    episode audio stays here (it can be rendered again on the phone)."""
    from .models import Card, QuizAttempt

    def iso(dt):
        return dt.isoformat() if dt else None

    data = {
        "app": "marginalia", "version": 1, "exported_at": datetime.now().astimezone().isoformat(),
        "subjects": [{"id": s.id, "name": s.name, "created_at": iso(s.created_at), "ib_course": s.ib_course,
                      "ib_level": s.ib_level} for s in db.scalars(select(Subject)).all()],
        "sources": [{"id": s.id, "subject_id": s.subject_id, "kind": s.kind, "title": s.title, "url": s.url,
                     "text": s.text, "pages": s.pages or [], "checked": s.checked, "status": s.status,
                     "created_at": iso(s.created_at)}
                    for s in db.scalars(select(Source).where(Source.status == "ready")).all()],
        "chunks": [],
        "artifacts": [{"id": a.id, "subject_id": a.subject_id, "kind": a.kind, "subtype": a.subtype, "title": a.title,
                       "params": a.params, "content": a.content, "passages": a.passages, "status": a.status,
                       "created_at": iso(a.created_at)}
                      for a in db.scalars(select(Artifact).where(Artifact.status == "ready")).all()],
        "cards": [{"id": c.id, "deck_id": c.deck_id, "front": c.front, "back": c.back, "cite": c.cite, "ease": c.ease,
                   "interval_days": c.interval_days, "reps": c.reps, "lapses": c.lapses, "due_at": iso(c.due_at),
                   "last_reviewed_at": iso(c.last_reviewed_at)} for c in db.scalars(select(Card)).all()],
        "attempts": [{"id": t.id, "quiz_id": t.quiz_id, "answers": t.answers, "score": t.score, "total": t.total,
                      "created_at": iso(t.created_at)} for t in db.scalars(select(QuizAttempt)).all()],
    }
    stamp = datetime.now().strftime("%Y-%m-%d")
    return JSONResponse(data, headers={"Content-Disposition": f'attachment; filename="marginalia-laptop-{stamp}.json"'})
