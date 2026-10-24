import time
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest
from fastapi.testclient import TestClient

from app import transcribe as tr
from app.transcribe import Segment, TranscriptionError, segments_to_text, transcribe_file


def test_segments_grouped_into_timestamped_paragraphs():
    segs = [
        Segment(0.0, 4.0, " Welcome to the lecture."),
        Segment(4.2, 8.0, " Today: photosynthesis."),
        Segment(12.5, 15.0, " First, the light reactions."),  # 4.5 s pause → new paragraph
        Segment(3700.0, 3705.0, " Final recap."),
    ]
    text = segments_to_text(segs)
    assert text.split("\n\n") == [
        "(0:00) Welcome to the lecture. Today: photosynthesis.",
        "(0:12) First, the light reactions.",
        "(1:01:40) Final recap.",
    ]


def test_long_paragraphs_are_split():
    segs = [Segment(i, i + 1, "word " * 40) for i in range(20)]  # ~200 chars each, no pauses
    paras = segments_to_text(segs, max_chars=900).split("\n\n")
    assert len(paras) > 3 and all(len(p) < 1400 for p in paras)


class FakeModel:
    """Stands in for WhisperModel; also defines the length of the fake media file (see fake_media)."""

    current: "FakeModel | None" = None

    def __init__(self, duration: float, segs: list[Segment] | None = None, fail: bool = False):
        self.duration, self.segs, self.fail = duration, segs or [], fail
        FakeModel.current = self

    def transcribe(self, audio, **kw):
        if self.fail:
            raise RuntimeError("Invalid data found when processing input")
        assert kw["vad_filter"] is True
        assert isinstance(audio, np.ndarray) and audio.dtype == np.float32
        return iter(self.segs), SimpleNamespace(duration=self.duration, language="en")


@pytest.fixture(autouse=True)
def fake_media(monkeypatch):
    """Tests use fake bytes as 'recordings': stub probing/decoding with the FakeModel's duration."""
    monkeypatch.setattr(tr, "probe_duration", lambda path: FakeModel.current.duration if FakeModel.current else 0)
    monkeypatch.setattr(tr, "decode_windows", lambda path: iter([(0.0, np.zeros(1600, dtype=np.float32))]))
    yield
    FakeModel.current = None


def test_transcribe_file_reports_progress_and_text(tmp_path):
    seen = []
    model = FakeModel(100, [Segment(0, 50, "Half way."), Segment(50, 100, "Done.")])
    text, dur, lang = transcribe_file(tmp_path / "x.m4a", seen.append, lambda: model)
    assert text == "(0:00) Half way. Done." and dur == 100 and lang == "en"
    assert seen[:2] == [0.5, 0.99] and max(seen) == 0.99


def test_transcribe_file_enforces_two_hour_limit(tmp_path):
    with pytest.raises(TranscriptionError, match="limit is 120 min"):
        transcribe_file(tmp_path / "x.mp3", model_factory=lambda: FakeModel(3 * 3600))


def test_transcribe_file_errors(tmp_path):
    with pytest.raises(TranscriptionError, match="Couldn't read"):
        transcribe_file(tmp_path / "x.bin", model_factory=lambda: FakeModel(10, fail=True))
    with pytest.raises(TranscriptionError, match="No speech"):
        transcribe_file(tmp_path / "x.wav", model_factory=lambda: FakeModel(10, []))


def test_recording_upload_runs_background_job(engine, db, monkeypatch, tmp_path):
    from app.config import get_settings
    from app.main import app

    monkeypatch.setattr(get_settings(), "data_dir", str(tmp_path))
    model = FakeModel(30, [Segment(0, 10, "Chloroplasts capture light."), Segment(10, 30, "The Calvin cycle fixes carbon.")])
    monkeypatch.setattr(tr, "_model", lambda: model)

    with TestClient(app) as client:
        sid = client.post("/subjects", json={"name": "Lectures"}).json()["id"]
        r = client.post(f"/subjects/{sid}/sources/recording",
                        files={"file": ("Week_3 lecture.opus", b"fake-bytes", "audio/ogg")})
        assert r.status_code == 202
        src = r.json()
        assert src["status"] == "processing" and src["title"] == "Week 3 lecture"

        for _ in range(100):  # the job runs on the worker thread
            listed = client.get(f"/subjects/{sid}/sources").json()[0]
            if listed["status"] != "processing":
                break
            time.sleep(0.05)
        assert listed["status"] == "ready", listed
        assert listed["chunk_count"] >= 1 and listed["progress"] is None
        detail = client.get(f"/sources/{src['id']}").json()
        assert "Calvin cycle" in detail["text"]
        assert not any(Path(tmp_path, "uploads").iterdir()), "upload should be deleted after success"

        model.fail = True
        bad = client.post(f"/subjects/{sid}/sources/recording", files={"file": ("x.bin", b"junk", "application/octet-stream")}).json()
        for _ in range(100):
            failed = client.get(f"/sources/{bad['id']}").json()
            if failed["status"] != "processing":
                break
            time.sleep(0.05)
        assert failed["status"] == "failed" and "Couldn't read" in failed["error"]

        empty = client.post(f"/subjects/{sid}/sources/recording", files={"file": ("e.mp3", b"", "audio/mpeg")})
        assert empty.status_code == 422


def _wait_ready(client, source_id):
    for _ in range(200):
        s = client.get(f"/sources/{source_id}").json()
        if s["status"] != "processing":
            return s
        time.sleep(0.05)
    raise AssertionError("job did not finish")


def test_pdf_upload_is_streamed_and_processed_in_background(engine, db, monkeypatch, tmp_path):
    from app.config import get_settings
    from app.main import app

    from .conftest import make_pdf

    monkeypatch.setattr(get_settings(), "data_dir", str(tmp_path))
    pdf = make_pdf(["Mitochondria produce ATP.", "Ribosomes build proteins.", "The nucleus stores DNA."])
    with TestClient(app) as client:
        sid = client.post("/subjects", json={"name": "Books"}).json()["id"]
        r = client.post(f"/subjects/{sid}/sources/pdf", files={"file": ("Cell_Biology.pdf", pdf, "application/pdf")})
        assert r.status_code == 202 and r.json()["status"] == "processing"
        done = _wait_ready(client, r.json()["id"])
        assert done["status"] == "ready" and done["title"] == "Cell Biology"
        assert done["page_count"] == 3 and done["chunk_count"] >= 1
        assert "Ribosomes" in done["text"]

        bad = client.post(f"/subjects/{sid}/sources/pdf", files={"file": ("x.pdf", b"not a pdf", "application/pdf")})
        assert bad.status_code == 422
        assert not any(Path(tmp_path, "uploads").iterdir())


def test_low_memory_failure_keeps_upload_and_can_retry(engine, db, monkeypatch, tmp_path):
    from app.config import get_settings
    from app.main import app

    monkeypatch.setattr(get_settings(), "data_dir", str(tmp_path))
    good = FakeModel(20, [Segment(0, 20, "Retry worked.")])

    def no_memory():
        raise RuntimeError("mkl_malloc: failed to allocate memory")

    monkeypatch.setattr(tr, "_model", no_memory)
    with TestClient(app) as client:
        sid = client.post("/subjects", json={"name": "Retry"}).json()["id"]
        src = client.post(f"/subjects/{sid}/sources/recording", files={"file": ("talk.mp3", b"bytes", "audio/mpeg")}).json()
        failed = _wait_ready(client, src["id"])
        assert failed["status"] == "failed" and "free memory" in failed["error"]
        assert failed["can_retry"] is True

        monkeypatch.setattr(tr, "_model", lambda: good)
        assert client.post(f"/sources/{src['id']}/retry").status_code == 202
        done = _wait_ready(client, src["id"])
        assert done["status"] == "ready" and "Retry worked." in done["text"]
        assert client.post(f"/sources/{src['id']}/retry").status_code == 409
        assert not any(Path(tmp_path, "uploads").iterdir())


def test_real_decoder_windows_and_probe(tmp_path, monkeypatch):
    """Exercise PyAV for real (no model): a 2.5 s 44.1 kHz stereo WAV → mono 16 kHz windows."""
    import wave

    monkeypatch.undo()  # use the real probe_duration / decode_windows
    path = tmp_path / "tone.wav"
    rate, seconds = 44100, 2.5
    t = np.arange(int(rate * seconds)) / rate
    tone = (0.3 * np.sin(2 * np.pi * 440 * t) * 32767).astype(np.int16)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(np.repeat(tone, 2).tobytes())

    assert tr.probe_duration(path) == pytest.approx(2.5, abs=0.05)
    windows = list(tr.decode_windows(path, window_seconds=1))
    assert [round(o) for o, _ in windows] == [0, 1, 2]
    assert all(a.dtype == np.float32 and a.ndim == 1 for _, a in windows)
    total = sum(a.size for _, a in windows)
    assert total == pytest.approx(2.5 * 16000, rel=0.02)
    assert 0.1 < float(np.abs(windows[0][1]).max()) <= 1.0

    with pytest.raises(Exception):
        tr.probe_duration(tmp_path / "missing.wav")
    bad = tmp_path / "bad.mp3"
    bad.write_bytes(b"definitely not audio")
    with pytest.raises(TranscriptionError, match="Couldn't read"):
        transcribe_file(bad, model_factory=lambda: FakeModel(10))
