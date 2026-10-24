from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    # Empty -> start an embedded Postgres+pgvector via pgserver (dev only).
    database_url: str = ""
    pgserver_dir: str = ""  # defaults to %LOCALAPPDATA%/studyapp-pg or ~/.studyapp-pg

    gemini_api_key: str = ""
    gemini_model: str = "gemini-3.8-flash"
    # Used when the main model keeps returning 503 "high demand". Empty disables fallback.
    gemini_fallback_model: str = "gemini-3.5-flash"
    # Speech model for Listen episodes (free-tier TTS quota is small; each ~2.4k chars = 1 request).
    gemini_tts_model: str = "gemini-3.8-flash-tts"
    # Local Whisper for long recordings: tiny | base | small | medium | large-v3 | turbo.
    # "base" transcribes ~2 h of audio in roughly 10–20 min on an 8-core laptop CPU;
    # "small" is noticeably more accurate but ~2–3× slower. Downloaded on first use.
    whisper_model: str = "base"
    whisper_language: str = ""  # e.g. "en"; empty = auto-detect
    whisper_max_minutes: int = 120
    # Where generated audio is written (relative to backend/).
    data_dir: str = "data"
    gemini_base_url: str = "https://generativelanguage.googleapis.com/v1beta"
    # Output cap incl. Gemini's thinking. Only tokens actually produced count against quota,
    # so a high cap just keeps long quizzes/summaries from being cut off.
    gemini_max_tokens: int = 32768
    # Pace requests to stay under the free tier's per-minute limit (0 = no pacing).
    # Check your project's real limits at https://aistudio.google.com/rate-limit
    gemini_rpm: int = 8
    # Longest the API will wait (seconds) for a free slot or a short 429 cooldown before erroring.
    gemini_max_quota_wait: float = 20.0

    # "fastembed" (local ONNX, bge-small-en-v1.5) or "hash" (deterministic, offline; tests).
    embedder: str = "fastembed"
    embed_dim: int = 384

    chunk_tokens: int = 800
    chunk_overlap_tokens: int = 120
    # Passages sent per question (~800 tokens each). 12 ≈ 10k input tokens: more grounding,
    # still far below free-tier per-minute token limits at 8 requests/min.
    retrieval_k: int = 12

    cors_origins: str = "http://localhost:3000"



@lru_cache
def get_settings() -> Settings:
    return Settings()
