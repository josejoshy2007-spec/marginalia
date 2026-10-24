"""Local speech-to-text for long recordings with Whisper (faster-whisper / CTranslate2).

Runs on this machine: free, private, no API quota. PyAV (bundled with faster-whisper) decodes
almost any audio or video container/codec, so mp3, m4a, wav, flac, ogg/opus, webm, aac, wma,
amr, mp4, mkv, mov … all work. Recordings up to `whisper_max_minutes` (default 2 h) are accepted.

Runs as a background job (see jobs.py) on the single "media" queue.
"""

import logging
import os
from collections.abc import Callable, Iterable, Iterator
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any

from .config import get_settings
from .ingestion.parse import ParsedDoc, normalize

log = logging.getLogger(__name__)

from .jobs import JobError, RetryableError


class TranscriptionError(JobError):
    pass


@dataclass
class Segment:
    start: float
    end: float
    text: str


@lru_cache
def _model():
    from faster_whisper import WhisperModel

    s = get_settings()
    # ≤4 threads: barely slower than 8 for "base", but less scratch memory on busy laptops.
    kwargs = {"device": "cpu", "compute_type": "int8", "cpu_threads": min(4, os.cpu_count() or 4)}
    try:  # use the cached copy without touching the network (slow/flaky networks re-download otherwise)
        return WhisperModel(s.whisper_model, local_files_only=True, **kwargs)
    except Exception:
        log.info("Whisper model %s not cached yet; downloading it once", s.whisper_model)
        return WhisperModel(s.whisper_model, **kwargs)


def _stamp(seconds: float) -> str:
    seconds = int(seconds)
    h, rem = divmod(seconds, 3600)
    m, s = divmod(rem, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


def segments_to_text(segments: Iterable[Segment], pause: float = 2.0, max_chars: int = 900) -> str:
    """Group Whisper segments into readable paragraphs, each opened with a (mm:ss) timestamp.

    A new paragraph starts after a pause longer than `pause` seconds or once a paragraph
    reaches ~`max_chars`, ending on a segment boundary.
    """
    paras: list[str] = []
    cur: list[str] = []
    cur_start = 0.0
    last_end: float | None = None
    size = 0
    for seg in segments:
        text = seg.text.strip()
        if not text:
            continue
        gap = seg.start - last_end if last_end is not None else 0.0
        if cur and (gap > pause or size >= max_chars):
            paras.append(f"({_stamp(cur_start)}) " + " ".join(cur))
            cur, size = [], 0
        if not cur:
            cur_start = seg.start
        cur.append(text)
        size += len(text) + 1
        last_end = seg.end
    if cur:
        paras.append(f"({_stamp(cur_start)}) " + " ".join(cur))
    return "\n\n".join(paras)


SAMPLE_RATE = 16000  # what Whisper expects
WINDOW_SECONDS = 600  # decode + transcribe 10 min at a time (~38 MB of float32 audio)

UNREADABLE = "Couldn't read that file as audio. Is it a sound or video recording?"


def probe_duration(path: Path) -> float:
    """Length in seconds from the container header (0 if unknown)."""
    import av

    with av.open(str(path)) as container:
        if container.duration:
            return container.duration / 1_000_000  # av.time_base
        stream = next(iter(container.streams.audio), None)
        if stream is not None and stream.duration and stream.time_base:
            return float(stream.duration * stream.time_base)
    return 0.0


def decode_windows(path: Path, window_seconds: int = WINDOW_SECONDS) -> Iterator[tuple[float, "np.ndarray"]]:
    """Yield (offset_seconds, mono 16 kHz float32 samples) windows of a media file.

    We decode with PyAV ourselves instead of handing faster-whisper the path. (1) faster-whisper
    1.2's own loader passes an option PyAV ≥15 removed. (2) It decodes the whole file into memory
    (~460 MB for 2 h), too much for a busy 8 GB laptop. Windows keep it at ~40 MB.
    """
    import av
    import numpy as np

    per_window = window_seconds * SAMPLE_RATE
    with av.open(str(path)) as container:
        stream = next(iter(container.streams.audio), None)
        if stream is None:
            raise TranscriptionError("That file has no audio track.")
        resampler = av.AudioResampler(format="s16", layout="mono", rate=SAMPLE_RATE)
        buf: list[np.ndarray] = []
        buffered = 0
        offset = 0.0

        def frames():
            for frame in container.decode(stream):
                yield from resampler.resample(frame)
            yield from resampler.resample(None)  # flush

        for out in frames():
            samples = out.to_ndarray().reshape(-1)
            buf.append(samples)
            buffered += samples.size
            while buffered >= per_window:
                joined = np.concatenate(buf)
                yield offset, joined[:per_window].astype(np.float32) / 32768.0
                rest = joined[per_window:]
                buf, buffered = ([rest] if rest.size else []), rest.size
                offset += window_seconds
        if buffered:
            yield offset, np.concatenate(buf).astype(np.float32) / 32768.0


def transcribe_file(
    path: Path,
    on_progress: Callable[[float], None] = lambda f: None,
    model_factory: Callable[[], Any] | None = None,
) -> tuple[str, float, str]:
    """Transcribe a media file window by window. Returns (text, duration_seconds, language)."""
    s = get_settings()
    model = (model_factory or _model)()  # looked up at call time so tests can swap _model
    try:
        duration = probe_duration(path)
    except TranscriptionError:
        raise
    except Exception as exc:  # PyAV raises its own error types for undecodable input
        log.warning("Couldn't open %s as media: %r", path.name, exc)
        raise TranscriptionError(UNREADABLE) from exc

    limit = s.whisper_max_minutes * 60
    if duration > limit + 60:
        raise TranscriptionError(
            f"That recording is {round(duration / 60)} min long; the limit is {s.whisper_max_minutes} min."
        )

    collected: list[Segment] = []
    language = s.whisper_language or None
    try:
        for offset, audio in decode_windows(path):
            segments, info = model.transcribe(
                audio,
                language=language,
                vad_filter=True,  # skip silence: faster and fewer hallucinated lines
                beam_size=1,
                condition_on_previous_text=False,  # avoids repetition loops on long audio
            )
            for seg in segments:
                collected.append(Segment(offset + seg.start, offset + seg.end, seg.text))
                if duration:
                    on_progress(min(0.99, (offset + seg.end) / duration))
            language = language or getattr(info, "language", None)  # detect once, then keep it
            if duration:
                on_progress(min(0.99, (offset + audio.size / SAMPLE_RATE) / duration))
    except TranscriptionError:
        raise
    except Exception as exc:
        if "alloc" in str(exc).lower() or isinstance(exc, MemoryError):
            raise
        log.warning("Decoding/transcribing %s failed: %r", path.name, exc)
        raise TranscriptionError(UNREADABLE) from exc

    text = normalize(segments_to_text(collected))
    if not text:
        raise TranscriptionError("No speech was found in that recording.")
    return text, duration, language or ""


def whisper_producer(path: Path, title: str, report: Callable[[float, str], None]) -> ParsedDoc:
    """jobs.Producer: load Whisper (first use downloads ~145 MB), then transcribe with progress."""
    report(0.0, "Loading Whisper")
    try:
        model = _model()
    except Exception as exc:
        log.exception("Could not load Whisper model")
        if "alloc" in str(exc).lower() or isinstance(exc, MemoryError):
            raise RetryableError(
                "Not enough free memory on this computer to run Whisper (it needs about 1 GB). "
                "Close a few apps or browser tabs, then press Retry."
            ) from exc
        raise RetryableError(
            "Couldn't load the Whisper model. The first run downloads it from Hugging Face, so check the "
            "internet connection and try again."
        ) from exc

    def on_progress(f: float) -> None:
        report(f, "Transcribing")

    text, _duration, _lang = transcribe_file(path, on_progress, model_factory=lambda: model)
    return ParsedDoc(title=title, text=text)
