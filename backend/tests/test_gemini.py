import json

import httpx
import pytest

from app.chat import ChatRequest
from app.gemini import CiteParser, Pacer, build_gemini_body, stream_gemini
from app.ingestion.parse import parse_text
from app.ingestion.pipeline import ingest
from app.models import Subject
from app.retrieval import retrieve

PHOTO = "The Calvin cycle in the stroma fixes carbon dioxide into glucose. Light reactions split water."
WAR = "The Treaty of Versailles was signed in 1919 and imposed reparations on Germany."


@pytest.fixture
def hits(db, embedder):
    subj = Subject(name="Mixed")
    db.add(subj)
    db.commit()
    a = ingest(db, subj.id, "text", parse_text(PHOTO, "Photo notes"), embedder)
    b = ingest(db, subj.id, "text", parse_text(WAR, "War notes"), embedder)
    return retrieve(db, subj.id, [a.id, b.id], embedder.embed_query("Calvin cycle carbon"), k=2)


def _sse(*chunks: dict) -> bytes:
    return b"".join(f"data: {json.dumps(c)}\r\n\r\n".encode() for c in chunks)


def _text_chunk(text: str, finish: str | None = None) -> dict:
    cand: dict = {"content": {"role": "model", "parts": [{"text": text}]}}
    if finish:
        cand["finishReason"] = finish
    return {"candidates": [cand]}


def _client(handler) -> httpx.Client:
    return httpx.Client(transport=httpx.MockTransport(handler))


def _nosleep(_seconds: float) -> None:
    pass


def _quota_429(quota_id: str, delay: str | None = "7s") -> httpx.Response:
    details: list[dict] = [{
        "@type": "type.googleapis.com/google.rpc.QuotaFailure",
        "violations": [{"quotaId": quota_id}],
    }]
    if delay:
        details.append({"@type": "type.googleapis.com/google.rpc.RetryInfo", "retryDelay": delay})
    return httpx.Response(429, json={"error": {"code": 429, "status": "RESOURCE_EXHAUSTED",
                                               "message": "quota", "details": details}})


def test_cite_parser_handles_markers_split_across_chunks(hits):
    p = CiteParser(hits)
    events = p.feed("Carbon is fixed in the stroma [") + p.feed("1]. Also [1, 2") + p.feed("] and [99]") + p.flush()
    text = "".join(e["text"] for e in events if e["type"] == "text")
    cites = [e for e in events if e["type"] == "cite"]
    assert text == "Carbon is fixed in the stroma . Also  and [99]"  # out-of-range marker stays as text
    assert [len(c["citations"]) for c in cites] == [1, 2]
    first = cites[0]["citations"][0]
    src_chunk = hits[0].chunk
    assert (first["start"], first["end"]) == (src_chunk.char_start, src_chunk.char_end)


def test_cite_parser_leaves_years_alone(hits):
    p = CiteParser(hits)
    events = p.feed("Signed in [1919].") + p.flush()
    assert events == [{"type": "text", "text": "Signed in [1919]."}]


def test_body_numbers_passages_and_maps_history_roles(hits):
    req = ChatRequest(
        message="Explain",
        source_ids=[1],
        selection={"source_id": 1, "text": "Calvin cycle"},
        history=[{"role": "assistant", "content": "hello"}, {"role": "user", "content": "q1"},
                 {"role": "assistant", "content": "a1"}],
    )
    body = build_gemini_body(req, hits)
    roles = [c["role"] for c in body["contents"]]
    assert roles == ["user", "model", "user"]  # leading assistant turn dropped, assistant -> model
    prompt = body["contents"][-1]["parts"][0]["text"]
    assert '<passage n="1"' in prompt and '<passage n="2"' in prompt
    assert "<highlight>" in prompt
    assert "systemInstruction" in body


def test_stream_gemini_end_to_end(hits):
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["key"] = request.headers.get("x-goog-api-key")
        return httpx.Response(200, content=_sse(
            _text_chunk("The Calvin cycle fixes CO2 [1"),
            _text_chunk("]. Done.", finish="STOP"),
        ), headers={"content-type": "text/event-stream"})

    req = ChatRequest(message="Where is CO2 fixed?", source_ids=[1])
    out = list(stream_gemini(req, hits, http=_client(handler)))

    assert [e["type"] for e in out] == ["sources", "text", "cite", "text", "done"]
    assert out[1]["text"] == "The Calvin cycle fixes CO2 "
    assert out[2]["citations"][0]["source_id"] == hits[0].source.id
    assert ":streamGenerateContent" in seen["url"] and "alt=sse" in seen["url"]
    assert seen["key"] == "test-key"


@pytest.mark.parametrize(
    "status,message,expect",
    [
        (400, "API key not valid. Please pass a valid API key.", "GEMINI_API_KEY"),
        (429, "Resource has been exhausted", "per-minute limit"),
        (404, "models/x is not found", "GEMINI_MODEL"),
    ],
)
def test_stream_gemini_reports_api_errors(hits, status, message, expect):
    def handler(request):
        return httpx.Response(status, json={"error": {"code": status, "message": message}})

    out = list(stream_gemini(ChatRequest(message="q", source_ids=[1]), hits, http=_client(handler)))
    assert out[-1]["type"] == "error" and expect in out[-1]["message"]


def test_stream_gemini_retries_when_overloaded(hits):
    calls = {"n": 0}

    def handler(request):
        calls["n"] += 1
        if calls["n"] < 3:
            return httpx.Response(503, json={"error": {"code": 503, "message": "high demand"}})
        return httpx.Response(200, content=_sse(_text_chunk("Answer [1].", finish="STOP")))

    out = list(stream_gemini(ChatRequest(message="q", source_ids=[1]), hits, http=_client(handler), sleep=_nosleep))
    assert calls["n"] == 3
    assert out[-1]["type"] == "done"


def test_stream_gemini_falls_back_to_second_model(hits):
    models = []

    def handler(request):
        model = request.url.path.split("/models/")[1].split(":")[0]
        models.append(model)
        if model == "gemini-3.8-flash":
            return httpx.Response(503, json={"error": {"code": 503, "message": "high demand"}})
        return httpx.Response(200, content=_sse(_text_chunk("Answer [1].", finish="STOP")))

    out = list(stream_gemini(ChatRequest(message="q", source_ids=[1]), hits, http=_client(handler), sleep=_nosleep))
    assert models == ["gemini-3.8-flash"] * 3 + ["gemini-3.5-flash"]
    assert out[-1]["type"] == "done"


def test_stream_gemini_gives_up_after_retries(hits):
    def handler(request):
        return httpx.Response(503, json={"error": {"code": 503, "message": "high demand"}})

    out = list(stream_gemini(ChatRequest(message="q", source_ids=[1]), hits, http=_client(handler), sleep=_nosleep))
    assert out[-1]["type"] == "error" and "overloaded" in out[-1]["message"]


def test_per_minute_429_waits_google_delay_then_succeeds(hits):
    slept, calls = [], {"n": 0}

    def handler(request):
        calls["n"] += 1
        if calls["n"] == 1:
            return _quota_429("GenerateRequestsPerMinutePerProjectPerModel-FreeTier", "7s")
        return httpx.Response(200, content=_sse(_text_chunk("Ok [1].", finish="STOP")))

    out = list(stream_gemini(ChatRequest(message="q", source_ids=[1]), hits, http=_client(handler), sleep=slept.append))
    assert out[-1]["type"] == "done"
    assert slept == [7.5]


def test_daily_quota_429_switches_to_fallback_model(hits):
    models = []

    def handler(request):
        model = request.url.path.split("/models/")[1].split(":")[0]
        models.append(model)
        if model == "gemini-3.8-flash":
            return _quota_429("GenerateRequestsPerDayPerProjectPerModel-FreeTier", "3600s")
        return httpx.Response(200, content=_sse(_text_chunk("Ok [1].", finish="STOP")))

    out = list(stream_gemini(ChatRequest(message="q", source_ids=[1]), hits, http=_client(handler), sleep=_nosleep))
    assert models == ["gemini-3.8-flash", "gemini-3.5-flash"]  # no pointless retries on a daily cap
    assert out[-1]["type"] == "done"


def test_daily_quota_on_both_models_explains_reset(hits):
    def handler(request):
        return _quota_429("GenerateRequestsPerDayPerProjectPerModel-FreeTier", None)

    out = list(stream_gemini(ChatRequest(message="q", source_ids=[1]), hits, http=_client(handler), sleep=_nosleep))
    assert out[-1]["type"] == "error" and "daily quota" in out[-1]["message"]


def test_pacer_limits_requests_per_minute():
    now = [0.0]
    p = Pacer(clock=lambda: now[0])
    assert [p.wait_needed(3) for _ in range(3)] == [0, 0, 0]
    assert p.wait_needed(3) == pytest.approx(60)
    now[0] = 30
    assert p.wait_needed(3) == pytest.approx(30)
    now[0] = 60.1
    assert p.wait_needed(3) == 0  # oldest slot expired
    assert p.wait_needed(0) == 0  # pacing disabled


def test_stream_gemini_safety_block(hits):
    def handler(request):
        return httpx.Response(200, content=_sse({"promptFeedback": {"blockReason": "SAFETY"}}))

    out = list(stream_gemini(ChatRequest(message="q", source_ids=[1]), hits, http=_client(handler)))
    assert out[-1] == {"type": "error", "message": "Gemini blocked this request (SAFETY)."}
