"""Embedding backends. Both produce L2-normalised vectors of `embed_dim` floats."""

import hashlib
import math
import re
from functools import lru_cache
from typing import Protocol

from .config import get_settings


class Embedder(Protocol):
    dim: int

    def embed_passages(self, texts: list[str]) -> list[list[float]]: ...
    def embed_query(self, text: str) -> list[float]: ...


class FastEmbedEmbedder:
    """Local ONNX model (BAAI/bge-small-en-v1.5, 384-d). Downloads weights on first use."""

    def __init__(self, model_name: str = "BAAI/bge-small-en-v1.5"):
        from fastembed import TextEmbedding

        self._model = TextEmbedding(model_name=model_name)
        self.dim = 384

    def embed_passages(self, texts: list[str]) -> list[list[float]]:
        return [v.tolist() for v in self._model.passage_embed(texts)]

    def embed_query(self, text: str) -> list[float]:
        return next(iter(self._model.query_embed(text))).tolist()


_TOKEN = re.compile(r"[a-z0-9]+")


class HashEmbedder:
    """Deterministic hashed bag-of-words (+ bigrams). No network; good enough for tests."""

    def __init__(self, dim: int = 384):
        self.dim = dim

    def _vec(self, text: str) -> list[float]:
        words = _TOKEN.findall(text.lower())
        feats = words + [f"{a}_{b}" for a, b in zip(words, words[1:])]
        v = [0.0] * self.dim
        for f in feats:
            h = int.from_bytes(hashlib.blake2b(f.encode(), digest_size=8).digest(), "little")
            v[h % self.dim] += 1.0 if (h >> 63) & 1 else -1.0
        norm = math.sqrt(sum(x * x for x in v)) or 1.0
        return [x / norm for x in v]

    def embed_passages(self, texts: list[str]) -> list[list[float]]:
        return [self._vec(t) for t in texts]

    def embed_query(self, text: str) -> list[float]:
        return self._vec(text)


@lru_cache
def get_embedder() -> Embedder:
    s = get_settings()
    if s.embedder == "hash":
        return HashEmbedder(s.embed_dim)
    return FastEmbedEmbedder()
