import json

import httpx
import pytest
from fastapi.testclient import TestClient

from app import vision
from app.gemini import GeminiError

PNG = b"\x89PNG\r\n\x1a\n" + b"0" * 100


def _gemini(payload):
    calls = []

    def handler(request):
        calls.append(json.loads(request.content))
        return httpx.Response(200, json={"candidates": [{"content": {"parts": [{"text": json.dumps(payload)}]},
                                                         "finishReason": "STOP"}]})

    return calls, {"http": httpx.Client(transport=httpx.MockTransport(handler)), "sleep": lambda s: None}


def test_read_answer_sends_images_and_question():
    calls, kw = _gemini({"text": "Packets are routed by IP adress.", "found": True})
    out = vision.read_answer([(PNG, "image/png"), (PNG, "image/heic")], "Explain routing. [3]", **kw)
    assert out == {"text": "Packets are routed by IP adress.", "found": True}  # spelling kept verbatim
    parts = calls[0]["contents"][0]["parts"]
    assert [p["inlineData"]["mimeType"] for p in parts[:2]] == ["image/png", "image/heic"]
    assert "Explain routing" in parts[-1]["text"] and "exactly as written" in parts[-1]["text"]


def test_read_answer_limits_and_empty():
    _, kw = _gemini({"text": "  ", "found": False})
    with pytest.raises(GeminiError, match="Couldn't find any handwriting"):
        vision.read_answer([(PNG, "image/png")], **kw)
    with pytest.raises(GeminiError, match="Up to 6"):
        vision.read_answer([(PNG, "image/png")] * 7)
    with pytest.raises(GeminiError, match="at least one"):
        vision.read_answer([])


def test_read_question_extracts_marks():
    _, kw = _gemini({"text": "Explain why a binary search is faster.", "found": True, "marks": 4})
    assert vision.read_question([(PNG, "image/jpeg")], **kw) == {"text": "Explain why a binary search is faster.", "marks": 4}
    _, kw = _gemini({"text": "Q", "found": True, "marks": 99})
    assert vision.read_question([(PNG, "image/jpeg")], **kw)["marks"] is None


MCQ = {"type": "mcq", "question": "Pick one", "options": ["a", "b", "c", "d"], "answer": 0}


def test_read_quiz_answers_maps_letters_and_text():
    qs = [MCQ, MCQ, {"type": "short", "question": "Name it", "accept": ["x"]}, MCQ]
    calls, kw = _gemini({"answers": [{"question": 1, "choice": "b"}, {"question": 2, "choice": "E"},
                                     {"question": 3, "text": " chlorofyll "}, {"question": 9, "choice": "A"}]})
    # q2: "E" is not an option; q4 unanswered; q9 doesn't exist; written text kept verbatim
    assert vision.read_quiz_answers([(PNG, "image/png")], qs, **kw) == [1, -1, "chlorofyll", -1]
    prompt = calls[0]["contents"][0]["parts"][-1]["text"]
    assert "1. multiple choice (letters A–D)" in prompt and "3. written answer: Name it" in prompt
    _, kw = _gemini({"answers": []})
    with pytest.raises(GeminiError, match="Couldn't read any answers"):
        vision.read_quiz_answers([(PNG, "image/png")], [MCQ], **kw)


def test_vision_routes(engine, db, monkeypatch):
    from app import study_routes
    from app.main import app

    seen = {}
    monkeypatch.setattr(study_routes.vision, "read_answer",
                        lambda images, question=None: seen.update(n=len(images), q=question) or {"text": "my answer", "found": True})
    monkeypatch.setattr(study_routes.vision, "read_quiz_answers", lambda images, questions: [0] * len(questions))
    with TestClient(app) as client:
        r = client.post("/vision/answer", data={"question": "Explain X."},
                        files=[("files", ("p1.jpg", PNG, "image/jpeg")), ("files", ("p2.jpg", PNG, "image/jpeg"))])
        assert r.json() == {"text": "my answer", "found": True} and seen == {"n": 2, "q": "Explain X."}
        bad = client.post("/vision/answer", files=[("files", ("notes.pdf", b"%PDF", "application/pdf"))])
        assert bad.status_code == 422

        sid = client.post("/subjects", json={"name": "S"}).json()["id"]
        from app.models import Artifact
        art = Artifact(subject_id=sid, kind="quiz", subtype="", title="Q", content={"questions": [
            {"question": "a", "options": ["1", "2"], "answer": 0, "explanation": "", "cite": []},
            {"question": "b", "options": ["1", "2", "3"], "answer": 2, "explanation": "", "cite": []}]})
        db.add(art)
        db.commit()
        r = client.post(f"/artifacts/{art.id}/quiz-photo", files=[("files", ("a.png", PNG, "image/png"))])
        assert r.json() == {"answers": [0, 0]}
