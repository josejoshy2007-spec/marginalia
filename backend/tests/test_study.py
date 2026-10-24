import base64
import json
import wave
from datetime import datetime, timedelta, timezone

import httpx
import pytest
from fastapi.testclient import TestClient

from app import generate as gen
from app.gemini import GeminiError
from app.ingestion.parse import parse_text
from app.ingestion.pipeline import ingest
from app.models import Artifact, Subject
from app.srs import CardState, preview, schedule

NOW = datetime(2026, 10, 18, 12, 0, tzinfo=timezone.utc)
LONG = "\n\n".join(f"Section {i}. " + "The Calvin cycle fixes carbon dioxide in the stroma. " * 40 for i in range(12))


# ---------------------------------------------------------------- spaced repetition


def test_new_card_intervals_grow_with_grade():
    s = CardState()
    _, again = schedule(s, "again", NOW)
    _, hard = schedule(s, "hard", NOW)
    _, good = schedule(s, "good", NOW)
    _, easy = schedule(s, "easy", NOW)
    assert again - NOW == timedelta(minutes=10)
    assert NOW < hard < good < easy


def test_successful_reviews_compound_and_lapse_resets():
    s, now = CardState(), NOW
    intervals = []
    for _ in range(4):
        s, due = schedule(s, "good", now)
        intervals.append(s.interval_days)
        now = due
    assert intervals == sorted(intervals) and intervals[-1] > 5
    lapsed, due = schedule(s, "again", now)
    assert lapsed.reps == 0 and lapsed.lapses == 1 and lapsed.ease < s.ease
    assert due - now == timedelta(minutes=10)


def test_ease_never_drops_below_floor():
    s = CardState()
    for _ in range(20):
        s, _ = schedule(s, "again", NOW)
    assert s.ease == pytest.approx(1.3)


def test_preview_labels():
    p = preview(CardState(), NOW)
    assert p == {"again": "10m", "hard": "12h", "good": "1d", "easy": "3d"}
    with pytest.raises(ValueError):
        schedule(CardState(), "perfect", NOW)


# ---------------------------------------------------------------- passage selection


@pytest.fixture
def subject_with_sources(db, embedder):
    subj = Subject(name="Bio")
    db.add(subj)
    db.commit()
    a = ingest(db, subj.id, "text", parse_text(LONG, "Long notes"), embedder)
    b = ingest(db, subj.id, "text", parse_text("Mitochondria make ATP by aerobic respiration.", "Short"), embedder)
    return subj, a, b


def test_select_passages_spreads_across_sources_and_through_each(db, embedder, subject_with_sources):
    subj, a, b = subject_with_sources
    picked = gen.select_passages(db, subj.id, [a.id, b.id], embedder, None, budget=6)
    assert {r.source.id for r in picked} == {a.id, b.id}
    long_ords = [r.chunk.ord for r in picked if r.source.id == a.id]
    assert long_ords[0] == 0 and long_ords[-1] > 1, "should sample through the source, not just its start"


def test_select_passages_with_focus_uses_similarity(db, embedder, subject_with_sources):
    subj, a, b = subject_with_sources
    picked = gen.select_passages(db, subj.id, [a.id, b.id], embedder, "mitochondria ATP respiration", budget=1)
    assert picked[0].source.id == b.id
    assert gen.select_passages(db, subj.id, [], embedder, None, budget=5) == []


# ---------------------------------------------------------------- generators (Gemini mocked)


def _gemini_json(payload: dict, finish: str = "STOP"):
    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        handler.body = body
        return httpx.Response(200, json={"candidates": [{
            "content": {"parts": [{"text": "thinking…", "thought": True}, {"text": json.dumps(payload)}]},
            "finishReason": finish,
        }]})
    return handler


def _kw(handler):
    return {"http": httpx.Client(transport=httpx.MockTransport(handler)), "sleep": lambda s: None}


@pytest.fixture
def passages(db, embedder, subject_with_sources):
    subj, a, b = subject_with_sources
    return gen.select_passages(db, subj.id, [a.id, b.id], embedder, None, budget=4)


def test_build_deck_cleans_cards_and_citations(passages):
    h = _gemini_json({"title": "Calvin", "cards": [
        {"front": "Where is CO₂ fixed?", "back": "In the stroma.", "cite": [1, 1, 99]},
        {"front": "", "back": "dropped", "cite": []},
    ]})
    deck = gen.build_deck(passages, 5, "carbon fixation", **_kw(h))
    assert deck["cards"] == [{"front": "Where is CO₂ fixed?", "back": "In the stroma.", "cite": [1]}]
    cfg = h.body["generationConfig"]
    assert cfg["responseMimeType"] == "application/json" and "responseSchema" in cfg
    prompt = h.body["contents"][0]["parts"][-1]["text"]
    assert '<passage n="1"' in prompt and "Focus especially on: carbon fixation" in prompt


def test_build_quiz_drops_invalid_questions(passages):
    h = _gemini_json({"title": "Q", "questions": [
        {"question": "Q1", "options": ["a", "b", "c", "d"], "answer": 2, "explanation": "because", "cite": [2]},
        {"question": "bad", "options": ["a", "b"], "answer": 5, "explanation": "", "cite": []},
    ]})
    quiz = gen.build_quiz(passages, 2, "hard", None, **_kw(h))
    assert len(quiz["questions"]) == 1 and quiz["questions"][0]["answer"] == 2
    assert "application and analysis" in h.body["contents"][0]["parts"][-1]["text"]


def test_build_concept_map_forces_single_tree(passages):
    h = _gemini_json({"title": "Map", "nodes": [
        {"id": "r", "parent": "", "label": "Photosynthesis", "cite": [1]},
        {"id": "a", "parent": "r", "label": "Light reactions", "cite": []},
        {"id": "x", "parent": "", "label": "Stray root", "cite": []},
        {"id": "b", "parent": "ghost", "label": "Orphan", "cite": []},
    ]})
    m = gen.build_concept_map(passages, None, **_kw(h))
    roots = [n for n in m["nodes"] if not n["parent"]]
    assert [r["id"] for r in roots] == ["r"]


def test_build_episode_strips_markers_and_fixes_speakers(passages):
    h = _gemini_json({"title": "Ep", "summary": "s", "lines": [
        {"speaker": "Maya", "text": "Plants fix carbon [1].", "cite": [1]},
        {"speaker": "Narrator", "text": "So where?", "cite": []},
    ]})
    ep = gen.build_episode(passages, "conversation", "short", None, **_kw(h))
    assert ep["lines"][0]["text"] == "Plants fix carbon ."
    assert {ln["speaker"] for ln in ep["lines"]} <= {"Maya", "Theo"}
    assert ep["speakers"] == ["Maya", "Theo"]


def test_generate_json_reports_truncation(passages):
    h = _gemini_json({"title": "x", "cards": []}, finish="MAX_TOKENS")
    with pytest.raises(GeminiError, match="too long"):
        gen.build_deck(passages, 5, None, **_kw(h))


# ---------------------------------------------------------------- speech + transcription


def test_synthesize_episode_writes_wav(tmp_path, monkeypatch, db, subject_with_sources):
    monkeypatch.setattr(gen.get_settings(), "data_dir", str(tmp_path))
    subj, _, _ = subject_with_sources
    lines = [{"speaker": "Maya" if i % 2 else "Theo", "text": "word " * 200, "cite": []} for i in range(4)]
    art = Artifact(subject_id=subj.id, kind="episode", subtype="conversation", title="Ep",
                   content={"speakers": ["Maya", "Theo"], "lines": lines})
    db.add(art)
    db.commit()
    pcm = b"\x01\x00" * 2400
    seen = []

    def handler(request):
        assert request.url.path.endswith("/interactions")
        body = json.loads(request.content)
        seen.append(body)
        return httpx.Response(200, json={"status": "completed", "steps": [{"type": "model_output", "content": [
            {"type": "audio", "sample_rate": 24000, "mime_type": "audio/l16; rate=24000; channels=1",
             "data": base64.b64encode(pcm).decode()}
        ]}]})

    path = gen.synthesize_episode(art, **_kw(handler))
    assert len(seen) == 2  # 4 × 1000 chars → two ≤2400-char groups
    assert seen[0]["model"] == gen.get_settings().gemini_tts_model
    items = seen[0]["input"][0]["content"]
    assert [i["annotations"][0]["speaker"] for i in items] == ["Theo", "Maya"]
    assert len(seen[0]["generation_config"]["speech_config"]["speakers"]) == 2
    with wave.open(str(path)) as w:
        assert w.getframerate() == 24000 and w.getnframes() == 2 * 2400


def test_transcribe_audio_and_youtube(monkeypatch):
    h = _gemini_json({"title": "Cell lecture", "transcript": "Today   we cover cells.\n\n\n\nMitochondria."})
    doc = gen.transcribe_audio(b"fake-audio", "audio/webm", "rec", **_kw(h))
    assert doc.title == "Cell lecture" and doc.text == "Today we cover cells.\n\nMitochondria."
    assert h.body["contents"][0]["parts"][0]["inlineData"]["mimeType"] == "audio/webm"
    gen.transcribe_youtube("https://youtu.be/abcdefghijk", **_kw(h))
    assert h.body["contents"][0]["parts"][0]["fileData"]["fileUri"] == "https://youtu.be/abcdefghijk"
    with pytest.raises(GeminiError, match="18 MB"):
        gen.transcribe_audio(b"x" * (gen.MAX_AUDIO_BYTES + 1), "audio/mpeg", "big")


def test_youtube_url_detection():
    assert gen.YOUTUBE_RE.match("https://www.youtube.com/watch?v=dQw4w9WgXcQ")
    assert gen.YOUTUBE_RE.match("https://youtu.be/dQw4w9WgXcQ")
    assert not gen.YOUTUBE_RE.match("https://example.com/watch?v=dQw4w9WgXcQ")


# ---------------------------------------------------------------- API flow


def test_api_deck_review_and_quiz_attempts(engine, db, embedder, monkeypatch):
    from app import study_routes
    from app.main import app

    monkeypatch.setattr(study_routes, "build_deck", lambda p, n, f, **kw: {"title": "Deck", "cards": [
        {"front": f"Q{i}", "back": f"A{i}", "cite": [1]} for i in range(3)]})
    monkeypatch.setattr(study_routes, "build_quiz", lambda p, n, d, f, **kw: {"title": "Quiz", "questions": [
        {"question": "Q", "options": ["a", "b", "c", "d"], "answer": 1, "explanation": "", "cite": [1]},
        {"question": "Q2", "options": ["a", "b", "c", "d"], "answer": 3, "explanation": "", "cite": []}]})

    with TestClient(app) as client:
        sid = client.post("/subjects", json={"name": "S"}).json()["id"]
        src = client.post(f"/subjects/{sid}/sources/text", json={"title": "T", "text": LONG}).json()

        deck = client.post(f"/subjects/{sid}/artifacts", json={"kind": "deck", "source_ids": [src["id"]]}).json()
        assert deck["status"] == "processing"
        deck = wait_ready(client, deck)
        assert deck["status"] == "ready" and deck["title"] == "Deck"
        assert deck["card_count"] == 3 and deck["due_count"] == 3
        assert deck["passages"][0]["source_id"] == src["id"]

        queue = client.get(f"/artifacts/{deck['id']}/review").json()["cards"]
        assert len(queue) == 3
        r = client.post(f"/cards/{queue[0]['id']}/review", json={"grade": "good"}).json()
        assert r["reps"] == 1
        assert len(client.get(f"/artifacts/{deck['id']}/review").json()["cards"]) == 2
        client.post(f"/artifacts/{deck['id']}/reset")
        assert len(client.get(f"/artifacts/{deck['id']}/review").json()["cards"]) == 3

        quiz = wait_ready(client, client.post(f"/subjects/{sid}/artifacts",
                           json={"kind": "quiz", "source_ids": [src["id"]], "difficulty": "hard"}).json())
        res = client.post(f"/artifacts/{quiz['id']}/attempts", json={"answers": [1]}).json()
        assert (res["score"], res["total"], res["answers"], res["correct"]) == (1, 2, [1, None], [1, 3])
        assert [r["correct"] for r in res["results"]] == [True, False]
        listed = client.get(f"/subjects/{sid}/artifacts", params={"kind": "quiz"}).json()
        assert listed[0]["best"] == 1 and listed[0]["attempts"] == 1

        bad = client.post(f"/subjects/{sid}/artifacts", json={"kind": "sheet", "subtype": "poem", "source_ids": [src["id"]]})
        assert bad.status_code == 422
        none = client.post(f"/subjects/{sid}/artifacts", json={"kind": "deck", "source_ids": []})
        assert none.status_code == 422
        assert client.get(f"/artifacts/{deck['id']}/audio").status_code == 404


def wait_ready(client, art: dict) -> dict:
    """Generation runs in the background: poll the artifact until it leaves "processing"."""
    import time as _time

    for _ in range(200):
        art = client.get(f"/artifacts/{art['id']}").json()
        if art.get("status") != "processing":
            return art
        _time.sleep(0.05)
    raise AssertionError("generation did not finish")


def test_generation_failure_is_recorded(engine, db, monkeypatch):
    from app import study_routes
    from app.main import app

    def boom(*a, **kw):
        raise GeminiError("Gemini's free daily quota is used up.")

    monkeypatch.setattr(study_routes, "build_episode", boom)
    with TestClient(app) as client:
        sid = client.post("/subjects", json={"name": "S"}).json()["id"]
        src = client.post(f"/subjects/{sid}/sources/text", json={"title": "T", "text": LONG}).json()
        ep = client.post(f"/subjects/{sid}/artifacts", json={"kind": "episode", "subtype": "debate",
                                                            "source_ids": [src["id"]]}).json()
        assert ep["status"] == "processing" and ep["title"] == "Debate"
        ep = wait_ready(client, ep)
        assert ep["status"] == "failed" and "daily quota" in ep["error"] and ep["title"] == "Debate (failed)"


def test_failed_generation_can_be_retried_in_place(engine, db, monkeypatch):
    from app import study_routes
    from app.main import app

    calls = {"n": 0}

    def flaky(passages, count, focus, **kw):
        calls["n"] += 1
        if calls["n"] == 1:
            raise GeminiError("Gemini is overloaded right now.")
        return {"title": "Deck", "cards": [{"front": "Q", "back": "A", "cite": [1]}]}

    monkeypatch.setattr(study_routes, "build_deck", flaky)
    with TestClient(app) as client:
        sid = client.post("/subjects", json={"name": "S"}).json()["id"]
        src = client.post(f"/subjects/{sid}/sources/text", json={"title": "T", "text": LONG}).json()
        deck = wait_ready(client, client.post(f"/subjects/{sid}/artifacts",
                                              json={"kind": "deck", "source_ids": [src["id"]], "count": 10}).json())
        assert deck["status"] == "failed"
        again = client.post(f"/artifacts/{deck['id']}/retry").json()
        assert again["id"] == deck["id"] and again["status"] == "processing"
        deck = wait_ready(client, again)
        assert deck["status"] == "ready" and deck["card_count"] == 1 and deck["error"] is None
        assert len(client.get(f"/subjects/{sid}/artifacts", params={"kind": "deck"}).json()) == 1  # no duplicate
        assert client.post(f"/artifacts/{deck['id']}/retry").status_code == 409  # only failed ones


def test_export_is_a_phone_backup(engine, db, embedder, monkeypatch):
    """GET /export produces the backup format the phone app imports (no search vectors)."""
    from app import study_routes
    from app.main import app

    monkeypatch.setattr(study_routes, "build_deck", lambda p, n, f, **kw: {"title": "Deck", "cards": [
        {"front": "Q", "back": "A", "cite": [1]}]})
    with TestClient(app) as client:
        sid = client.post("/subjects", json={"name": "Export me", "ib_course": "Physics", "ib_level": "HL"}).json()["id"]
        src = client.post(f"/subjects/{sid}/sources/text", json={"title": "T", "text": LONG}).json()
        deck = wait_ready(client, client.post(f"/subjects/{sid}/artifacts",
                                              json={"kind": "deck", "source_ids": [src["id"]]}).json())
        res = client.get("/export")
        assert res.status_code == 200
        assert "attachment" in res.headers["content-disposition"]
        data = res.json()
    assert data["app"] == "marginalia" and data["version"] == 1 and data["chunks"] == []
    subj = next(s for s in data["subjects"] if s["id"] == sid)
    assert subj["ib_course"] == "Physics" and subj["ib_level"] == "HL"
    source = next(s for s in data["sources"] if s["id"] == src["id"])
    assert source["text"] and source["subject_id"] == sid
    assert any(a["id"] == deck["id"] and a["passages"] for a in data["artifacts"])
    assert any(c["deck_id"] == deck["id"] and c["front"] == "Q" for c in data["cards"])
