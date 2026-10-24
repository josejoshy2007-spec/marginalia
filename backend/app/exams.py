"""IB-style exam questions with markschemes, and examiner-style marking of student answers.

Question sets follow IB conventions (see ib.py): every item opens with a command term, carries a
mark value, and has either an analytic markscheme (creditworthy points with [n] marks, more points
than marks allowed, OWTTE/accept/reject notes) or, for extended Discuss/Evaluate/To-what-extent
items, markbands with level descriptors plus indicative content. Marking is positive, whole-mark,
command-term-aware, and capped at the question total.
"""

from typing import Any

from .gemini import GeminiError
from .generate import _CITE, STYLE, _clean_cites, _focus_line, generate_json, passages_prompt
from .ib import COMMAND_TERMS, MARKING_RULES, command_terms_block

_MARKSCHEME = {
    "type": "OBJECT",
    "properties": {
        "type": {"type": "STRING", "enum": ["points", "markbands"]},
        "points": {"type": "ARRAY", "items": {
            "type": "OBJECT",
            "properties": {"text": {"type": "STRING"}, "marks": {"type": "INTEGER"}},
            "required": ["text", "marks"],
        }},
        "markbands": {"type": "ARRAY", "items": {
            "type": "OBJECT",
            "properties": {"marks": {"type": "STRING"}, "descriptor": {"type": "STRING"}},
            "required": ["marks", "descriptor"],
        }},
        "indicative": {"type": "ARRAY", "items": {"type": "STRING"}},
        "notes": {"type": "STRING"},
    },
    "required": ["type"],
}

_QUESTION = {
    "type": "OBJECT",
    "properties": {
        "command_term": {"type": "STRING"},
        "question": {"type": "STRING"},
        "marks": {"type": "INTEGER"},
        "markscheme": _MARKSCHEME,
        "cite": _CITE,
    },
    "required": ["command_term", "question", "marks", "markscheme", "cite"],
}

EXAM_SCHEMA = {
    "type": "OBJECT",
    "properties": {"title": {"type": "STRING"}, "questions": {"type": "ARRAY", "items": _QUESTION}},
    "required": ["title", "questions"],
}

MARK_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "marks_awarded": {"type": "INTEGER"},
        "points": {"type": "ARRAY", "items": {
            "type": "OBJECT",
            "properties": {
                "index": {"type": "INTEGER"},
                "awarded": {"type": "INTEGER"},
                "comment": {"type": "STRING"},
            },
            "required": ["index", "awarded", "comment"],
        }},
        "band": {"type": "STRING"},
        "strengths": {"type": "STRING"},
        "improvements": {"type": "STRING"},
        "model_answer": {"type": "STRING"},
    },
    "required": ["marks_awarded", "points", "strengths", "improvements", "model_answer"],
}

SIZES = {"short": 15, "section": 30, "paper": 50}  # target total marks

EXAMINER = (
    "You are an experienced IB senior examiner who writes exam questions and markschemes. "
    + STYLE + "\n\n" + MARKING_RULES + "\n\nIB command terms:\n" + command_terms_block()
)


def _known_term(term: str) -> str:
    term = (term or "").strip()
    return next((t for t in COMMAND_TERMS if t.lower() == term.lower()), term.capitalize())


def clean_question(q: dict[str, Any], n_passages: int) -> dict[str, Any] | None:
    """Validate one generated question; None if unusable."""
    marks = q.get("marks")
    text = (q.get("question") or "").strip()
    ms = q.get("markscheme") or {}
    if not text or not isinstance(marks, int) or marks < 1:
        return None
    points = [
        {"text": p["text"].strip(), "marks": max(1, int(p.get("marks") or 1))}
        for p in ms.get("points") or [] if (p.get("text") or "").strip()
    ]
    bands = [
        {"marks": str(b["marks"]).strip(), "descriptor": b["descriptor"].strip()}
        for b in ms.get("markbands") or [] if (b.get("descriptor") or "").strip()
    ]
    kind = "markbands" if ms.get("type") == "markbands" and bands else "points"
    if kind == "points" and not points:
        return None
    term = _known_term(q.get("command_term", ""))
    return {
        "command_term": term,
        "objective": COMMAND_TERMS.get(term, (2, ""))[0],
        "question": text,
        "marks": min(marks, 20),
        "markscheme": {
            "type": kind,
            "points": points,
            "markbands": bands,
            "indicative": [str(x).strip() for x in ms.get("indicative") or [] if str(x).strip()],
            "notes": (ms.get("notes") or "").strip(),
        },
        "cite": _clean_cites(q.get("cite"), n_passages),
    }


def build_exam(passages, size: str, extended: bool, focus: str | None, course_label: str = "", **kw) -> dict[str, Any]:
    total = SIZES.get(size, SIZES["short"])
    who = course_label or "an IB Diploma course"
    extended_rule = (
        '- End with one extended-response item (Discuss/Evaluate/To what extent, 6–9 marks) marked with '
        'markbands (`type` "markbands": 3–4 bands from low to high, mark ranges like "1–3", descriptors about '
        "knowledge, application, balance and a supported conclusion) plus `indicative` content points.\n"
        if extended else "- No extended-response items.\n"
    )
    out = generate_json(
        EXAMINER,
        f"Passages:\n\n{passages_prompt(passages)}\n\nWrite an exam-style question set for {who} worth about "
        f"{total} marks in total, testing only content in the passages. Build it like a real IB paper section:\n"
        "- Start with short objective-1 items (State/Define/Identify/List, 1–2 marks), then objective-2/3 "
        "structured items (Outline/Describe/Explain/Distinguish/Compare/Analyse/Suggest/Trace/Calculate, "
        "2–6 marks).\n" + extended_rule +
        "- Each question begins with its command term, and the number of creditworthy points fits the marks "
        "(a [3] Explain needs linked reasons, not three facts). Put marks only in `marks`, not in the text.\n"
        '- Analytic markschemes (`type` "points") list each creditworthy point with its marks; there may be '
        'more points than marks ("award [1] for any of…"), and `marks` caps the total. Use `notes` for '
        "accept/reject/OWTTE guidance.\n"
        "- Give a question a short scenario or stem when the IB would, inside `question`.\n"
        "`cite` lists the passage numbers each question is based on." + _focus_line(focus),
        EXAM_SCHEMA, **kw,
    )
    questions = [q for q in (clean_question(x, len(passages)) for x in out.get("questions") or []) if q]
    if not questions:
        raise GeminiError("Gemini didn't produce usable questions. Try again.")
    return {"title": out.get("title") or "Exam practice", "questions": questions,
            "total": sum(q["marks"] for q in questions)}


def draft_markscheme(passages, question: str, marks: int, course_label: str = "", **kw) -> dict[str, Any]:
    """Markscheme for a question the student supplies (e.g. from a past paper), grounded in their sources."""
    out = generate_json(
        EXAMINER,
        f"Passages:\n\n{passages_prompt(passages)}\n\nWrite the markscheme for this {course_label or 'IB'} "
        f"question worth [{marks}], using the passages as the content source (accurate general subject "
        f"knowledge only where they are silent):\n\n<question>\n{question}\n</question>\n\n"
        f"Return a single-item `questions` array: copy the question text, identify its command term, set "
        f"`marks` to {marks}, and use markbands only for an extended Discuss/Evaluate/To-what-extent item.",
        EXAM_SCHEMA, **kw,
    )
    qs = [q for q in (clean_question(x, len(passages)) for x in out.get("questions") or []) if q]
    if not qs:
        raise GeminiError("Couldn't build a markscheme for that question. Try rephrasing it.")
    q = qs[0]
    q["question"], q["marks"] = question.strip(), marks
    title = question.strip().splitlines()[0][:80]
    return {"title": title, "questions": [q], "total": marks}


def scheme_text(q: dict[str, Any]) -> str:
    ms = q["markscheme"]
    if ms["type"] == "markbands":
        text = "Markbands:\n" + "\n".join(f"- [{b['marks']}] {b['descriptor']}" for b in ms["markbands"])
        if ms.get("indicative"):
            text += "\nIndicative content (not exhaustive):\n" + "\n".join(f"- {x}" for x in ms["indicative"])
    else:
        text = "Markscheme points (award each when conveyed):\n" + "\n".join(
            f"{i}. {p['text']} [{p['marks']}]" for i, p in enumerate(ms["points"]))
    if ms.get("notes"):
        text += f"\nNotes: {ms['notes']}"
    return text


def mark_answer(question: dict[str, Any], answer: str, course_label: str = "", **kw) -> dict[str, Any]:
    """Mark one answer against the question's markscheme like an IB examiner."""
    term = question.get("command_term", "")
    out = generate_json(
        MARKING_RULES + "\nGive feedback a student can act on, in the second person, briefly.",
        f"Course: {course_label or 'IB Diploma'}\nQuestion [{question['marks']}]: {question['question']}\n"
        f"Command term: {term} ({COMMAND_TERMS.get(term, (0, ''))[1]})\n\n{scheme_text(question)}\n\n"
        f"Student answer:\n<answer>\n{answer.strip()}\n</answer>\n\n"
        "Mark it. For analytic schemes, return one `points` entry per markscheme point (its index, marks "
        "awarded from 0 to its value, and a short comment pinpointing what earned or missed it). For markbands, "
        "set `band` to the chosen band's mark range, set `marks_awarded`, explain the placement in "
        "`strengths`/`improvements`, and leave `points` empty. `model_answer` is a concise answer that would "
        "earn full marks.",
        MARK_SCHEMA, **kw,
    )
    max_marks = question["marks"]
    ms = question["markscheme"]
    points = []
    if ms["type"] == "points":
        by_index = {p.get("index"): p for p in out.get("points") or [] if isinstance(p.get("index"), int)}
        for i, p in enumerate(ms["points"]):
            got = by_index.get(i, {})
            points.append({"index": i, "awarded": max(0, min(p["marks"], int(got.get("awarded") or 0))),
                           "comment": (got.get("comment") or "").strip()})
        awarded = min(max_marks, sum(p["awarded"] for p in points))
    else:
        awarded = max(0, min(max_marks, int(out.get("marks_awarded") or 0)))
    if not answer.strip():
        awarded, points = 0, [{**p, "awarded": 0} for p in points]
    return {
        "marks_awarded": awarded,
        "max_marks": max_marks,
        "points": points,
        "band": (out.get("band") or "").strip(),
        "strengths": (out.get("strengths") or "").strip(),
        "improvements": (out.get("improvements") or "").strip(),
        "model_answer": (out.get("model_answer") or "").strip(),
    }


# ---------------------------------------------------------------- mixed-type quiz marking

QUIZ_MARK_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "results": {"type": "ARRAY", "items": {
            "type": "OBJECT",
            "properties": {
                "index": {"type": "INTEGER"},
                "marks_awarded": {"type": "INTEGER"},
                "points_awarded": {"type": "ARRAY", "items": {"type": "INTEGER"}},
                "comment": {"type": "STRING"},
            },
            "required": ["index", "marks_awarded", "comment"],
        }},
    },
    "required": ["results"],
}


def _norm(text: str) -> str:
    import re

    t = re.sub(r"[^\w\s.%-]", " ", (text or "").lower())
    t = re.sub(r"\b(the|a|an)\b", " ", t)
    return re.sub(r"\s+", " ", t).strip(" .")


def mark_quiz(questions: list[dict[str, Any]], answers: list[Any], course_label: str = "", **kw) -> list[dict[str, Any]]:
    """Mark a mixed quiz. MCQ and exact short answers are checked here; the remaining short answers
    and all written explanations are marked together in one Gemini request."""
    from .generate import question_marks

    results: list[dict[str, Any]] = []
    pending: list[int] = []
    for i, q in enumerate(questions):
        kind = q.get("type", "mcq")
        a = answers[i] if i < len(answers) else None
        top = question_marks(q)
        if kind == "mcq":
            ok = isinstance(a, int) and a == q["answer"]
            results.append({"type": kind, "marks": int(ok), "max": 1, "correct": ok, "feedback": "", "points": []})
            continue
        text = a.strip() if isinstance(a, str) else ""
        if not text:
            results.append({"type": kind, "marks": 0, "max": top, "correct": False,
                            "feedback": "No answer given.", "points": []})
            continue
        if kind == "short" and _norm(text) in {_norm(x) for x in q.get("accept", [])}:
            results.append({"type": kind, "marks": 1, "max": 1, "correct": True, "feedback": "", "points": []})
            continue
        results.append({"type": kind, "marks": 0, "max": top, "correct": False, "feedback": "", "points": []})
        pending.append(i)

    if not pending:
        return results

    items = []
    for i in pending:
        q, a = questions[i], answers[i]
        if q["type"] == "short":
            items.append(f"<item index=\"{i}\" type=\"short\" marks=\"1\">\nQuestion: {q['question']}\n"
                         f"Accepted answers: {' | '.join(q['accept'])}\nStudent answer: {a.strip()}\n</item>")
        else:
            scheme = "\n".join(f"{j}. {pt['text']} [{pt['marks']}]" for j, pt in enumerate(q["points"]))
            items.append(f"<item index=\"{i}\" type=\"long\" marks=\"{q['marks']}\">\nQuestion: {q['question']}\n"
                         f"Markscheme points:\n{scheme}\nStudent answer: {a.strip()}\n</item>")
    out = generate_json(
        MARKING_RULES + "\nFor short answers: award the mark if the student's answer means the same as an "
        "accepted answer (synonyms, equivalent units, minor misspellings that don't change the meaning are "
        "fine); a different or vaguer concept gets 0. Feedback is one short sentence in the second person.",
        f"Course: {course_label or 'general'}\nMark each item.\n\n" + "\n\n".join(items)
        + "\n\nReturn one result per item: its `index`, `marks_awarded`, for long items `points_awarded` (marks "
        "per markscheme point, in order), and a `comment` saying what earned or missed marks.",
        QUIZ_MARK_SCHEMA, **kw,
    )
    by_index = {r.get("index"): r for r in out.get("results") or [] if isinstance(r.get("index"), int)}
    for i in pending:
        q, res, got = questions[i], results[i], by_index.get(i, {})
        if q["type"] == "long":
            raw = got.get("points_awarded") or []
            pts = [max(0, min(pt["marks"], int(raw[j]) if j < len(raw) and isinstance(raw[j], int) else 0))
                   for j, pt in enumerate(q["points"])]
            marks = min(res["max"], sum(pts)) if raw else max(0, min(res["max"], int(got.get("marks_awarded") or 0)))
            res["points"] = pts
        else:
            marks = 1 if int(got.get("marks_awarded") or 0) >= 1 else 0
        res["marks"] = marks
        res["correct"] = marks == res["max"]
        res["feedback"] = (got.get("comment") or "").strip()
    return results
