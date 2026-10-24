import json
import time
from types import SimpleNamespace

import httpx
import pytest
from fastapi.testclient import TestClient

from app import exams, ib, summarize
from app.gemini import GeminiError
from app.ingestion.parse import parse_text
from app.ingestion.pipeline import ingest
from app.models import Subject

from .conftest import make_pdf

LONG = "\n\n".join(f"Section {i}. " + "Packets are routed across networks using IP addresses. " * 30 for i in range(10))


def _gemini(*payloads):
    """Mock Gemini returning the given JSON payloads in order (the last repeats); records request bodies."""
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(json.loads(request.content))
        payload = payloads[min(len(calls) - 1, len(payloads) - 1)]
        return httpx.Response(200, json={"candidates": [{"content": {"parts": [{"text": json.dumps(payload)}]},
                                                         "finishReason": "STOP"}]})

    return calls, {"http": httpx.Client(transport=httpx.MockTransport(handler)), "sleep": lambda s: None}


@pytest.fixture
def passages(db, embedder):
    subj = Subject(name="CS")
    db.add(subj)
    db.commit()
    src = ingest(db, subj.id, "text", parse_text(LONG, "Networks"), embedder)
    return summarize.summary_passages(db, subj.id, [src.id], embedder)


# ---------------------------------------------------------------- IB context


def test_context_only_when_course_set():
    assert ib.context(SimpleNamespace(ib_course=None, ib_level=None)) == ""
    ctx = ib.context(SimpleNamespace(ib_course="Computer Science", ib_level="HL"))
    assert "IB Computer Science HL" in ctx
    assert "Evaluate: Make an appraisal by weighing up the strengths and limitations." in ctx
    assert "Objective 1" in ctx and "Objective 3" in ctx


# ---------------------------------------------------------------- questions


def test_clean_question_normalises_and_validates():
    q = exams.clean_question({
        "command_term": "explain", "question": "Explain why packets are routed.", "marks": 3,
        "markscheme": {"type": "points", "points": [{"text": "IP addresses", "marks": 1}, {"text": "", "marks": 1}]},
        "cite": [1, 99],
    }, n_passages=2)
    assert q["command_term"] == "Explain" and q["objective"] == 3
    assert q["markscheme"]["points"] == [{"text": "IP addresses", "marks": 1}] and q["cite"] == [1]
    # markbands requested but none given -> falls back to points
    q2 = exams.clean_question({"command_term": "Discuss", "question": "Discuss X.", "marks": 6,
                               "markscheme": {"type": "markbands", "points": [{"text": "a", "marks": 2}]}, "cite": []}, 1)
    assert q2["markscheme"]["type"] == "points"
    assert exams.clean_question({"command_term": "State", "question": "", "marks": 1, "markscheme": {}}, 1) is None
    assert exams.clean_question({"command_term": "State", "question": "State X", "marks": 0,
                                 "markscheme": {"type": "points", "points": [{"text": "a", "marks": 1}]}}, 1) is None


def test_build_exam_prompt_and_totals(passages):
    calls, kw = _gemini({"title": "Networks", "questions": [
        {"command_term": "Define", "question": "Define IP address.", "marks": 1,
         "markscheme": {"type": "points", "points": [{"text": "a unique numerical label", "marks": 1}]}, "cite": [1]},
        {"command_term": "Evaluate", "question": "Evaluate packet switching.", "marks": 6,
         "markscheme": {"type": "markbands", "markbands": [{"marks": "1–3", "descriptor": "limited"},
                                                          {"marks": "4–6", "descriptor": "balanced"}],
                        "indicative": ["resilience", "overhead"]}, "cite": [2]},
    ]})
    out = exams.build_exam(passages, "short", True, None, course_label="IB Computer Science HL", **kw)
    assert out["total"] == 7 and out["questions"][1]["markscheme"]["type"] == "markbands"
    prompt = calls[0]["contents"][0]["parts"][-1]["text"]
    assert "IB Computer Science HL" in prompt and "worth about 15 marks" in prompt and "markbands" in prompt
    assert "Make an appraisal" in calls[0]["systemInstruction"]["parts"][0]["text"]


# ---------------------------------------------------------------- marking

POINTS_Q = {"command_term": "Explain", "question": "Explain X.", "marks": 3,
            "markscheme": {"type": "points", "points": [{"text": "a", "marks": 1}, {"text": "b", "marks": 2},
                                                        {"text": "c", "marks": 2}], "markbands": [], "indicative": [], "notes": ""}}


def test_mark_answer_clamps_points_and_total():
    _, kw = _gemini({"marks_awarded": 99, "points": [
        {"index": 0, "awarded": 5, "comment": "ok"}, {"index": 1, "awarded": 2, "comment": "good"},
        {"index": 2, "awarded": 2, "comment": "also"}], "strengths": "s", "improvements": "i", "model_answer": "m"})
    r = exams.mark_answer(POINTS_Q, "my answer", **kw)
    assert [p["awarded"] for p in r["points"]] == [1, 2, 2]  # each point capped at its value
    assert r["marks_awarded"] == 3 and r["max_marks"] == 3  # total capped at the question's marks


def test_mark_answer_markbands_and_blank():
    q = {**POINTS_Q, "marks": 6, "markscheme": {"type": "markbands", "points": [], "indicative": [], "notes": "",
                                                 "markbands": [{"marks": "1–3", "descriptor": "x"}, {"marks": "4–6", "descriptor": "y"}]}}
    _, kw = _gemini({"marks_awarded": 5, "points": [], "band": "4–6", "strengths": "", "improvements": "", "model_answer": ""})
    assert exams.mark_answer(q, "an answer", **kw)["marks_awarded"] == 5
    _, kw = _gemini({"marks_awarded": 2, "points": [{"index": 0, "awarded": 1, "comment": ""}],
                     "strengths": "", "improvements": "", "model_answer": ""})
    assert exams.mark_answer(POINTS_Q, "   ", **kw)["marks_awarded"] == 0


# ---------------------------------------------------------------- summaries


def test_small_summary_is_one_pass(passages):
    calls, kw = _gemini({"title": "Networks", "body": "IP routes packets [1]."})
    out = summarize.build_summary(passages, "cornell", "brief", None, **kw)
    assert len(calls) == 1 and out["parts"] == 1 and "[1]" in out["body"]
    assert "Cornell notes" in calls[0]["contents"][0]["parts"][-1]["text"]


def test_big_summary_map_reduces_with_global_numbers(passages, monkeypatch):
    monkeypatch.setattr(summarize, "SINGLE_PASS_TOKENS", 100)
    monkeypatch.setattr(summarize, "MAP_BATCH_TOKENS", 400)
    groups = summarize.batches(passages, 400)
    assert len(groups) > 1
    calls, kw = _gemini({"title": "Part", "body": "notes [3]"})
    progress = []
    out = summarize.build_summary(passages, "key_points", "standard", None,
                                  on_progress=lambda f, s: progress.append(s), **kw)
    assert len(calls) == len(groups) + 1 and out["parts"] == len(groups)
    second = calls[1]["contents"][0]["parts"][-1]["text"]
    first_n = groups[1][0][0]
    assert f'<passage n="{first_n}"' in second  # numbering continues across parts
    assert "Combine them" in calls[-1]["contents"][0]["parts"][-1]["text"]
    assert progress[-1] == "Combining the parts"


def test_summary_page_range(db, embedder):
    subj = Subject(name="Book")
    db.add(subj)
    db.commit()
    from app.ingestion.parse import parse_pdf

    src = ingest(db, subj.id, "pdf", parse_pdf(make_pdf([f"Page {i} " + "word " * 300 for i in range(1, 7)])), embedder)
    picked = summarize.summary_passages(db, subj.id, [src.id], embedder, page_from=3, page_to=4)
    assert picked and all(r.chunk.page_end >= 3 and r.chunk.page_start <= 4 for r in picked)


# ---------------------------------------------------------------- API


def test_api_ib_subject_summary_exam_and_custom(engine, db, monkeypatch):
    from app import study_routes
    from app.main import app

    seen = {}
    monkeypatch.setattr(study_routes, "build_summary",
                        lambda p, fmt, length, focus, on_progress, **kw: (seen.update(ctx=kw.get("ctx"), fmt=fmt, length=length),
                                                                          {"title": "Summary", "body": "Body [1].", "parts": 1})[1])
    q = {"command_term": "Explain", "objective": 3, "question": "Explain routing.", "marks": 3, "cite": [1],
         "markscheme": {"type": "points", "points": [{"text": "a", "marks": 2}, {"text": "b", "marks": 1}],
                        "markbands": [], "indicative": [], "notes": ""}}
    monkeypatch.setattr(study_routes, "build_exam", lambda *a, **kw: {"title": "Exam", "questions": [q], "total": 3})
    monkeypatch.setattr(study_routes, "draft_markscheme", lambda *a, **kw: {"title": "Mine", "questions": [q], "total": 3})
    monkeypatch.setattr(study_routes, "mark_answer", lambda question, answer, **kw: {
        "marks_awarded": 2, "max_marks": question["marks"], "points": [], "band": "",
        "strengths": "s", "improvements": "i", "model_answer": "m"})

    with TestClient(app) as client:
        sid = client.post("/subjects", json={"name": "CS"}).json()["id"]
        subj = client.patch(f"/subjects/{sid}", json={"ib_course": "Computer Science", "ib_level": "HL"}).json()
        assert subj["ib_course"] == "Computer Science" and subj["ib_level"] == "HL"
        assert client.patch(f"/subjects/{sid}", json={"ib_level": "XL"}).status_code == 422
        src = client.post(f"/subjects/{sid}/sources/text", json={"title": "Net", "text": LONG}).json()

        art = client.post(f"/subjects/{sid}/artifacts", json={"kind": "summary", "subtype": "ib_revision",
                                                              "source_ids": [src["id"]], "length": "long"}).json()
        assert art["status"] == "processing"
        for _ in range(100):
            art = client.get(f"/artifacts/{art['id']}").json()
            if art["status"] != "processing":
                break
            time.sleep(0.05)
        assert art["status"] == "ready" and art["content"]["body"] == "Body [1]."
        assert seen["fmt"] == "ib_revision" and seen["length"] == "detailed" and "IB Computer Science HL" in seen["ctx"]

        exam = wait_ready(client, client.post(f"/subjects/{sid}/artifacts", json={"kind": "exam", "subtype": "section",
                                                               "source_ids": [src["id"]]}).json())
        assert exam["total_marks"] == 3 and exam["answered"] == 0
        assert client.post(f"/artifacts/{exam['id']}/questions/0/mark", json={"answer": " "}).status_code == 422
        r = client.post(f"/artifacts/{exam['id']}/questions/0/mark", json={"answer": "Routers forward packets."}).json()
        assert r["marks_awarded"] == 2
        again = client.get(f"/artifacts/{exam['id']}").json()
        assert again["marked"]["0"]["answer"] == "Routers forward packets." and again["scored"] == 2

        custom = client.post(f"/subjects/{sid}/exam/custom", json={
            "question": "Explain how routing works.", "marks": 3, "answer": "It uses IP.", "source_ids": [src["id"]]}).json()
        assert custom["subtype"] == "custom" and custom["marked"]["0"]["result"]["marks_awarded"] == 2

        opts = client.get("/ib/options").json()
        assert "Computer Science" in opts["courses"] and any(t["term"] == "Discuss" for t in opts["command_terms"])


def test_generate_json_retries_dropped_connections():
    from app.generate import generate_json

    calls = {"n": 0}

    def handler(request):
        calls["n"] += 1
        if calls["n"] < 3:
            raise httpx.RemoteProtocolError("Server disconnected without sending a response.")
        return httpx.Response(200, json={"candidates": [{"content": {"parts": [{"text": '{"title": "t", "body": "b"}'}]},
                                                         "finishReason": "STOP"}]})

    out = generate_json("sys", "prompt", {"type": "OBJECT"},
                        http=httpx.Client(transport=httpx.MockTransport(handler)), sleep=lambda s: None)
    assert out == {"title": "t", "body": "b"} and calls["n"] == 3

    def always(request):
        raise httpx.ReadTimeout("timed out")

    with pytest.raises(GeminiError, match="kept dropping"):
        generate_json("sys", "prompt", {"type": "OBJECT"},
                      http=httpx.Client(transport=httpx.MockTransport(always)), sleep=lambda s: None)


def wait_ready(client, art: dict) -> dict:
    """Generation runs in the background: poll the artifact until it leaves "processing"."""
    import time as _time

    for _ in range(200):
        art = client.get(f"/artifacts/{art['id']}").json()
        if art.get("status") != "processing":
            return art
        _time.sleep(0.05)
    raise AssertionError("generation did not finish")
