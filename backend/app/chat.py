"""Chat request schema and SSE helpers. Generation itself lives in gemini.py."""

import json
from typing import Any

from pydantic import BaseModel, Field


class Selection(BaseModel):
    source_id: int
    text: str
    start: int | None = None
    end: int | None = None


class HistoryTurn(BaseModel):
    role: str = Field(pattern="^(user|assistant)$")
    content: str


class ChatRequest(BaseModel):
    message: str = Field(min_length=1, max_length=8000)
    source_ids: list[int]
    selection: Selection | None = None
    history: list[HistoryTurn] = Field(default_factory=list)


def retrieval_query(req: ChatRequest) -> str:
    return f"{req.selection.text}\n\n{req.message}" if req.selection else req.message


def sse(event: dict[str, Any]) -> str:
    return f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
