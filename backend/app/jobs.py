"""Background ingestion for big inputs (textbook PDFs up to ~600 MB, recordings up to 2 h).

The upload route streams the file to disk, creates the Source with status "processing",
and submits a job here. A job turns the file into a ParsedDoc (`produce`), then chunks and
embeds it into that Source. Progress + a human-readable stage are kept in memory for the
UI to poll; on restart, unfinished jobs whose upload is still on disk are re-queued.

Two queues so a long lecture transcription never blocks a textbook (and vice versa).
"""

import logging
import threading
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from .ingestion.parse import ParsedDoc, ParseError

log = logging.getLogger(__name__)

Report = Callable[[float, str], None]
Producer = Callable[[Path, str, Report], ParsedDoc]

_queues = {
    "media": ThreadPoolExecutor(max_workers=1, thread_name_prefix="media-job"),  # Whisper is CPU-heavy
    "docs": ThreadPoolExecutor(max_workers=2, thread_name_prefix="doc-job"),
}
_state: dict[int, tuple[float, str]] = {}
_lock = threading.Lock()


class JobError(Exception):
    """A failure with a message fit to show the student."""


class RetryableError(JobError):
    """A failure worth retrying with the same file (e.g. low memory, network). The upload is kept."""


def state(source_id: int) -> tuple[float, str] | None:
    with _lock:
        return _state.get(source_id)


def _set(source_id: int, value: tuple[float, str] | None) -> None:
    with _lock:
        if value is None:
            _state.pop(source_id, None)
        else:
            _state[source_id] = value


def _run(source_id: int, path: Path, produce: Producer, produce_share: float) -> None:
    from . import db as dbmod
    from .embeddings import get_embedder
    from .ingestion.pipeline import store_chunks
    from .models import Source

    if dbmod._SessionLocal is None:
        dbmod.init_engine()
    session = dbmod._SessionLocal()
    try:
        src = session.get(Source, source_id)
        if src is None:
            return

        def report(fraction: float, stage: str) -> None:
            _set(source_id, (round(min(1.0, max(0.0, fraction)) * produce_share, 4), stage))

        doc = produce(path, src.title, report)

        def index_progress(fraction: float) -> None:
            _set(source_id, (round(produce_share + (1 - produce_share) * fraction, 4), "Indexing for search"))

        index_progress(0.0)
        src = session.get(Source, source_id)
        if src is None:  # deleted meanwhile
            return
        src.title = (doc.title or src.title)[:500]
        store_chunks(session, src, doc, get_embedder(), on_progress=index_progress)
        src.status, src.error, src.upload_path = "ready", None, None
        session.commit()
        path.unlink(missing_ok=True)
    except Exception as exc:
        session.rollback()
        if not isinstance(exc, JobError) and ("alloc" in str(exc).lower() or isinstance(exc, MemoryError)):
            log.warning("Source %s ran out of memory: %s", source_id, exc)
            exc = RetryableError(
                "This computer ran out of free memory while processing the file. "
                "Close a few apps or browser tabs, then press Retry."
            )
        friendly = isinstance(exc, (JobError, ParseError))
        if not friendly:
            log.exception("Ingestion job for source %s failed", source_id)
        src = session.get(Source, source_id)
        keep = isinstance(exc, RetryableError)
        if src is not None:
            src.status = "failed"
            src.error = str(exc) if friendly else "Processing failed unexpectedly."
            if not keep:
                src.upload_path = None
            session.commit()
        if not keep:
            path.unlink(missing_ok=True)
    finally:
        _set(source_id, None)
        session.close()


def submit(queue: str, source_id: int, path: Path, produce: Producer, produce_share: float = 0.6) -> None:
    """Run `produce` then indexing in the background. `produce_share` = part of the bar for producing."""
    _set(source_id, (0.0, "Queued"))
    _queues[queue].submit(_run, source_id, path, produce, produce_share)


def resume_pending(session, producers: dict[str, tuple[str, Producer, float]]) -> None:
    """Re-queue unfinished jobs after a restart. `producers` maps Source.kind -> (queue, produce, share)."""
    from sqlalchemy import select

    from .models import Source

    for src in session.scalars(select(Source).where(Source.status == "processing")).all():
        spec = producers.get(src.kind)
        if spec and src.upload_path and Path(src.upload_path).exists():
            queue, produce, share = spec
            submit(queue, src.id, Path(src.upload_path), produce, share)
        else:
            src.status, src.error = "failed", "Interrupted by a server restart. Please upload it again."
    session.commit()
