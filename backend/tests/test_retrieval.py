import json
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from app.ingestion.parse import parse_text
from app.ingestion.pipeline import ingest
from app.models import Subject
from app.retrieval import retrieve

PHOTO = (
    "Photosynthesis happens in the chloroplast. Light reactions in the thylakoid membrane split water "
    "and release oxygen. The Calvin cycle in the stroma fixes carbon dioxide into glucose."
)
WAR = (
    "The Treaty of Versailles was signed in 1919. It imposed reparations on Germany and redrew "
    "European borders after the First World War."
)
TECTONICS = (
    "Plate tectonics describes the movement of lithospheric plates. Earthquakes cluster along "
    "plate boundaries where plates collide or slide past each other."
)


@pytest.fixture
def library(db, embedder):
    bio = Subject(name="Science")
    other = Subject(name="Other subject")
    db.add_all([bio, other])
    db.commit()
    photo = ingest(db, bio.id, "text", parse_text(PHOTO, "Photosynthesis notes"), embedder)
    war = ingest(db, bio.id, "text", parse_text(WAR, "History notes"), embedder)
    tect = ingest(db, bio.id, "text", parse_text(TECTONICS, "Geology notes"), embedder)
    foreign = ingest(db, other.id, "text", parse_text(PHOTO, "Someone else's photosynthesis"), embedder)
    return SimpleNamespace(subject=bio, other=other, photo=photo, war=war, tect=tect, foreign=foreign)


def test_most_relevant_chunk_ranks_first(db, embedder, library):
    q = embedder.embed_query("Where does the Calvin cycle fix carbon dioxide?")
    ids = [library.photo.id, library.war.id, library.tect.id]
    hits = retrieve(db, library.subject.id, ids, q, k=3)
    assert hits[0].source.id == library.photo.id
    assert [h.distance for h in hits] == sorted(h.distance for h in hits)


def test_only_checked_sources_are_searched(db, embedder, library):
    q = embedder.embed_query("Calvin cycle carbon dioxide chloroplast")
    hits = retrieve(db, library.subject.id, [library.war.id, library.tect.id], q, k=10)
    assert hits, "should still return the checked sources"
    assert {h.source.id for h in hits} <= {library.war.id, library.tect.id}


def test_no_checked_sources_returns_nothing(db, embedder, library):
    assert retrieve(db, library.subject.id, [], embedder.embed_query("anything"), k=5) == []


def test_other_subjects_sources_never_leak(db, embedder, library):
    q = embedder.embed_query("Calvin cycle")
    # Even if a foreign source id is passed explicitly, the subject filter excludes it.
    hits = retrieve(db, library.subject.id, [library.foreign.id, library.war.id], q, k=10)
    assert library.foreign.id not in {h.source.id for h in hits}


def test_k_limits_results(db, embedder, library):
    q = embedder.embed_query("notes")
    ids = [library.photo.id, library.war.id, library.tect.id]
    assert len(retrieve(db, library.subject.id, ids, q, k=2)) == 2


# ---------- API end to end (Gemini mocked) ----------

def test_api_ingest_then_chat(engine, db, monkeypatch):
    from app.main import app

    captured = {}

    def fake_stream(req, hits, http=None, **kw):
        captured["source_ids"] = {h.source.id for h in hits}
        yield {"type": "sources", "sources": []}
        yield {"type": "text", "text": "ok"}
        yield {"type": "done"}

    monkeypatch.setattr("app.main.stream_gemini", fake_stream)
    with TestClient(app) as client:
        sid = client.post("/subjects", json={"name": "Bio"}).json()["id"]
        s1 = client.post(f"/subjects/{sid}/sources/text", json={"title": "Photo", "text": PHOTO}).json()
        s2 = client.post(f"/subjects/{sid}/sources/text", json={"title": "War", "text": WAR}).json()
        assert s1["chunk_count"] == 1 and s1["status"] == "ready"

        detail = client.get(f"/sources/{s1['id']}").json()
        assert detail["text"] == PHOTO

        resp = client.post(f"/subjects/{sid}/chat", json={"message": "Calvin cycle?", "source_ids": [s2["id"]]})
        events = [json.loads(line[6:]) for line in resp.text.splitlines() if line.startswith("data: ")]
        assert events[-1]["type"] == "done"
        assert captured["source_ids"] == {s2["id"]}

        bad = client.post(f"/subjects/{sid}/sources/pdf", files={"file": ("x.pdf", b"nope", "application/pdf")})
        assert bad.status_code == 422
