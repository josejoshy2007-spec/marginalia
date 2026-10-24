import logging
import os
import subprocess
import time
from pathlib import Path

from sqlalchemy import create_engine, text
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session, sessionmaker

from .config import get_settings
from .models import Base

log = logging.getLogger(__name__)

_engine: Engine | None = None
_SessionLocal: sessionmaker | None = None
_pgserver = None  # keep a reference so the embedded server stays up


def _embedded_database_url(db_name: str = "studyapp") -> str:
    """Start (or attach to) an embedded Postgres with pgvector via pgserver."""
    global _pgserver
    import pgserver
    import psycopg

    settings = get_settings()
    base = settings.pgserver_dir or os.path.join(
        os.environ.get("LOCALAPPDATA", str(Path.home())), "studyapp-pg"
    )
    Path(base).mkdir(parents=True, exist_ok=True)
    # pgserver gives Postgres only 10 s to start. After an unclean shutdown (laptop crash/sleep) it first
    # fsyncs and recovers, which took ~50 s on this machine with antivirus scanning the files; Postgres
    # keeps starting in the background, so wait and attach to it instead of failing the API.
    for attempt in range(12):
        try:
            _pgserver = pgserver.get_server(base, cleanup_mode=None)
            break
        except subprocess.TimeoutExpired:
            if attempt == 11:
                raise
            log.warning("Embedded Postgres is still starting (crash recovery?); waiting…")
            time.sleep(10)
    admin_uri = _pgserver.get_uri()
    with psycopg.connect(admin_uri, autocommit=True) as conn:
        exists = conn.execute("SELECT 1 FROM pg_database WHERE datname = %s", (db_name,)).fetchone()
        if not exists:
            conn.execute(f'CREATE DATABASE "{db_name}"')
    return _pgserver.get_uri(db_name)


def _sqlalchemy_url(url: str) -> str:
    if url.startswith("postgresql://"):
        return "postgresql+psycopg://" + url[len("postgresql://"):]
    return url


def init_engine(url: str | None = None, db_name: str = "studyapp") -> Engine:
    global _engine, _SessionLocal
    url = url or get_settings().database_url or _embedded_database_url(db_name)
    _engine = create_engine(_sqlalchemy_url(url), pool_pre_ping=True)
    _SessionLocal = sessionmaker(bind=_engine, expire_on_commit=False)
    return _engine


def create_schema(engine: Engine) -> None:
    with engine.begin() as conn:
        conn.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
    Base.metadata.create_all(engine)
    with engine.begin() as conn:
        # Columns added after the first release (create_all doesn't alter existing tables).
        conn.execute(text("ALTER TABLE sources ADD COLUMN IF NOT EXISTS error TEXT"))
        conn.execute(text("ALTER TABLE sources ADD COLUMN IF NOT EXISTS upload_path TEXT"))
        conn.execute(text("ALTER TABLE subjects ADD COLUMN IF NOT EXISTS ib_course VARCHAR(120)"))
        conn.execute(text("ALTER TABLE subjects ADD COLUMN IF NOT EXISTS ib_level VARCHAR(4)"))
        conn.execute(text("ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'ready'"))
        conn.execute(text("ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS error TEXT"))
        conn.execute(
            text(
                "CREATE INDEX IF NOT EXISTS chunks_embedding_hnsw "
                "ON chunks USING hnsw (embedding vector_cosine_ops)"
            )
        )


def get_engine() -> Engine:
    if _engine is None:
        init_engine()
    return _engine


def get_db():
    if _SessionLocal is None:
        init_engine()
    db: Session = _SessionLocal()
    try:
        yield db
    finally:
        db.close()
