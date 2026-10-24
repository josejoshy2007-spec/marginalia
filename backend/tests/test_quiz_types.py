import json

import httpx

from app import exams
from app import generate as gen

MCQ = {"type": "mcq", "question": "Which?", "options": ["a", "b", "c", "d"], "answer": 2}
SHORT = {"type": "short", "question": "Name the pigment.", "accept": ["chlorophyll", "chlorophyll a"], "marks": 1}
LONG = {"type": "long", "question": "Explain why rate plateaus.", "marks": 3,
        "points": [{"text": "another factor limits", "marks": 1}, {"text": "e.g. CO2/temperature", "marks": 1},
                   {"text": "enzymes saturated", "marks": 2}]}


def _gemini(payload):
    calls = []

    def handler(request):
        calls.append(json.loads(request.content))
        return httpx.Response(200, json={"candidates": [{"content": {"parts": [{"text": json.dumps(payload)}]},
                                                         "finishReason": "STOP"}]})

    return calls, {"http": httpx.Client(transport=httpx.MockTransport(handler)), "sleep": lambda s: None}


def test_split_count():
    assert gen.split_count(8, ["mcq"]) == {"mcq": 8}
    assert gen.split_count(8, ["long", "mcq"]) == {"mcq": 4, "long": 4}
    assert gen.split_count(5, ["mcq", "short", "long"]) == {"mcq": 2, "short": 2, "long": 1}
    assert gen.split_count(1, ["mcq", "short", "long"]) == {"mcq": 1, "short": 1, "long": 1}  # at least one each
    assert gen.split_count(4, []) == {"mcq": 4}


def test_clean_quiz_question_types():
    assert gen.clean_quiz_question({"question": "Q", "options": ["a", "b"], "answer": 1}, 3)["type"] == "mcq"  # old quizzes
    assert gen.clean_quiz_question({"type": "short", "question": "Q", "accept": []}, 3) is None
    s = gen.clean_quiz_question({"type": "short", "question": "Q", "accept": ["ATP", " "]}, 3)
    assert s["accept"] == ["ATP"] and s["marks"] == 1
    lq = gen.clean_quiz_question({"type": "long", "question": "Q", "points": [{"text": "a", "marks": 2}, {"text": "b", "marks": 1}]}, 3)
    assert lq["marks"] == 3 and gen.question_marks(lq) == 3
    assert gen.clean_quiz_question({"type": "long", "question": "Q", "points": []}, 3) is None


def test_build_quiz_asks_for_chosen_types(db, embedder):
    from app.ingestion.parse import parse_text
    from app.ingestion.pipeline import ingest
    from app.models import Subject

    subj = Subject(name="Q")
    db.add(subj)
    db.commit()
    src = ingest(db, subj.id, "text", parse_text("Chlorophyll absorbs light. " * 50, "Notes"), embedder)
    passages = gen.select_passages(db, subj.id, [src.id], embedder, None, budget=3)
    calls, kw = _gemini({"title": "Mixed", "questions": [MCQ, SHORT, LONG, {"type": "short", "question": "bad"}]})
    out = gen.build_quiz(passages, 6, "medium", None, types=["short", "long"], **kw)
    assert [q["type"] for q in out["questions"]] == ["mcq", "short", "long"]
    prompt = calls[0]["contents"][0]["parts"][-1]["text"]
    assert "3 short-answer" in prompt and "3 written-explanation" in prompt and "multiple-choice (`type`" not in prompt


def test_mark_quiz_local_only_needs_no_gemini():
    res = exams.mark_quiz([MCQ, SHORT, MCQ], [2, "  The Chlorophyll. ", 0])  # no http client given: must not call out
    assert [(r["marks"], r["max"], r["correct"]) for r in res] == [(1, 1, True), (1, 1, True), (0, 1, False)]


def test_mark_quiz_batches_written_answers_and_clamps():
    calls, kw = _gemini({"results": [
        {"index": 1, "marks_awarded": 1, "comment": "Same meaning."},
        {"index": 2, "marks_awarded": 9, "points_awarded": [1, 5, 0], "comment": "Named a limiting factor."},
    ]})
    res = exams.mark_quiz([MCQ, SHORT, LONG, LONG], [1, "chlorofil", "Another factor like CO2 limits it.", "  "], **kw)
    assert len(calls) == 1  # one request for the whole quiz
    items = calls[0]["contents"][0]["parts"][-1]["text"]
    assert 'index="1" type="short"' in items and 'index="2" type="long"' in items and 'index="3"' not in items
    assert res[0]["marks"] == 0
    assert (res[1]["marks"], res[1]["correct"], res[1]["feedback"]) == (1, True, "Same meaning.")
    assert res[2]["points"] == [1, 1, 0] and res[2]["marks"] == 2 and res[2]["max"] == 3  # per-point caps
    assert (res[3]["marks"], res[3]["feedback"]) == (0, "No answer given.")
