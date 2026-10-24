"""Reading photos of handwritten work (answers written in an exercise book, a past-paper question,
a quiz answer list) with Gemini's image understanding.

Transcription of answers is deliberately verbatim: spelling, grammar and content are kept exactly
as written, because the text is then marked. "Fixing" it would mark a better answer than the
student wrote.
"""

import base64
from typing import Any

from .gemini import GeminiError
from .generate import generate_json

MAX_IMAGES = 6
MAX_IMAGE_BYTES = 10 * 1024 * 1024
IMAGE_TYPES = {"image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"}

TEXT_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "text": {"type": "STRING"},
        "found": {"type": "BOOLEAN"},
        "marks": {"type": "INTEGER"},
    },
    "required": ["text", "found"],
}

QUIZ_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "answers": {"type": "ARRAY", "items": {
            "type": "OBJECT",
            "properties": {
                "question": {"type": "INTEGER"},
                "choice": {"type": "STRING"},  # multiple-choice letter
                "text": {"type": "STRING"},  # written answer, verbatim
            },
            "required": ["question"],
        }},
    },
    "required": ["answers"],
}

READER = (
    "You read photos of students' handwritten schoolwork and transcribe them exactly. You never correct, "
    "improve, complete or summarise what is written."
)


def image_parts(images: list[tuple[bytes, str]]) -> list[dict[str, Any]]:
    if not images:
        raise GeminiError("Add at least one photo.")
    if len(images) > MAX_IMAGES:
        raise GeminiError(f"Up to {MAX_IMAGES} photos at a time.")
    parts = []
    for data, mime in images:
        if len(data) > MAX_IMAGE_BYTES:
            raise GeminiError("Each photo must be under 10 MB.")
        mime = mime if mime in IMAGE_TYPES else "image/jpeg"
        parts.append({"inlineData": {"mimeType": mime, "data": base64.b64encode(data).decode()}})
    return parts


def read_answer(images: list[tuple[bytes, str]], question: str | None = None, **kw) -> dict[str, Any]:
    """Verbatim transcription of a handwritten answer. With `question`, picks out just that answer
    if the page holds several."""
    which = (
        f"The photo(s) may contain answers to several questions. Transcribe only the answer to this "
        f"question:\n<question>\n{question.strip()}\n</question>\nThe student may have copied the question "
        "in shorter or different words, or written only a number, so pick the answer whose topic best matches "
        "it; don't include the question line itself. Set `found` to false only if no answer on the page is "
        "about this question's topic (then transcribe everything legible)."
        if question and question.strip()
        else "Transcribe all of the student's writing. Set `found` to false only if there is no handwriting."
    )
    out = generate_json(
        READER,
        "Transcribe the student's handwritten answer from the photo(s), in order across photos.\n" + which + "\n"
        "Rules: copy the words exactly as written, keeping spelling mistakes, grammar, abbreviations and "
        "numbering; keep line breaks and bullet points; leave out text that is clearly crossed out; write "
        "[illegible] for words you cannot read; write equations and code as plain text. Do not add anything.",
        TEXT_SCHEMA,
        parts=image_parts(images),
        **kw,
    )
    text = (out.get("text") or "").strip()
    if not text:
        raise GeminiError("Couldn't find any handwriting in that photo. Try a sharper, well-lit photo.")
    return {"text": text, "found": bool(out.get("found", True))}


def read_question(images: list[tuple[bytes, str]], **kw) -> dict[str, Any]:
    """Transcribe an exam question from a photo (e.g. a past paper or textbook) plus its mark value."""
    out = generate_json(
        READER,
        "Transcribe the exam question in the photo exactly, including any stem, data or scenario it needs "
        "and part labels like (a). If the mark value is shown (e.g. [4] or (4 marks)), put the number in "
        "`marks` and leave it out of `text`. If several questions are shown, transcribe the first complete one.",
        TEXT_SCHEMA,
        parts=image_parts(images),
        **kw,
    )
    text = (out.get("text") or "").strip()
    if not text:
        raise GeminiError("Couldn't find a question in that photo. Try a sharper, well-lit photo.")
    marks = out.get("marks")
    return {"text": text, "marks": marks if isinstance(marks, int) and 0 < marks <= 30 else None}


def read_quiz_answers(images: list[tuple[bytes, str]], questions: list[dict[str, Any]], **kw) -> list[Any]:
    """Read a handwritten answer sheet for a (possibly mixed) quiz.

    Multiple-choice answers ("1 B") become option indexes; written answers are transcribed verbatim.
    Unanswered/unreadable questions come back as -1 (mcq) or None (written).
    """
    n = len(questions)
    lines = []
    for i, q in enumerate(questions, start=1):
        if q.get("type", "mcq") == "mcq":
            lines.append(f"{i}. multiple choice (letters A–{chr(64 + len(q['options']))}): {q['question']}")
        else:
            lines.append(f"{i}. written answer: {q['question']}")
    out = generate_json(
        READER,
        "The photo(s) show a student's answers to this quiz:\n" + "\n".join(lines) + "\n\n"
        "For each question they answered, return its number and either the letter they chose (`choice`) or, "
        "for written questions, their answer transcribed exactly as written (`text`: keep spelling and "
        "grammar, leave out crossed-out text, [illegible] for unreadable words). Match answers to questions by "
        "the numbers they wrote; if they changed an answer, use the final one. Skip questions with no answer.",
        QUIZ_SCHEMA,
        parts=image_parts(images),
        **kw,
    )
    answers: list[Any] = [-1 if q.get("type", "mcq") == "mcq" else None for q in questions]
    for a in out.get("answers") or []:
        qn = a.get("question")
        if not isinstance(qn, int) or not 1 <= qn <= n:
            continue
        q = questions[qn - 1]
        if q.get("type", "mcq") == "mcq":
            choice = str(a.get("choice") or "").strip().upper()[:1]
            if choice and "A" <= choice <= "Z" and ord(choice) - 65 < len(q["options"]):
                answers[qn - 1] = ord(choice) - 65
        elif (a.get("text") or "").strip():
            answers[qn - 1] = a["text"].strip()
    if all(a in (-1, None) for a in answers):
        raise GeminiError("Couldn't read any answers in that photo. Number them like \"1 B\" or \"3. …\" and try again.")
    return answers
