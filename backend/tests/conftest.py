import os

# Must be set before app modules read settings.
os.environ["EMBEDDER"] = "hash"
# Keep tests independent of whatever key is in backend/.env (requests are mocked anyway).
os.environ["GEMINI_API_KEY"] = "test-key"
os.environ["GEMINI_RPM"] = "0"  # no pacing in tests; Pacer has its own unit test
os.environ["GEMINI_MODEL"] = "gemini-3.8-flash"
os.environ["GEMINI_FALLBACK_MODEL"] = "gemini-3.5-flash"

import pytest  # noqa: E402
from sqlalchemy import text  # noqa: E402

from app import db as dbmod  # noqa: E402
from app.embeddings import HashEmbedder  # noqa: E402
from app.models import Base  # noqa: E402


def make_pdf(pages: list[str]) -> bytes:
    """Build a tiny valid PDF with one line of Helvetica text per page (no extra deps)."""
    objs: list[bytes] = []
    n = len(pages)
    font_id = 3 + 2 * n
    kids = " ".join(f"{3 + 2 * i} 0 R" for i in range(n))
    objs.append(b"<< /Type /Catalog /Pages 2 0 R >>")
    objs.append(f"<< /Type /Pages /Kids [{kids}] /Count {n} >>".encode())
    for i, body in enumerate(pages):
        page_id, content_id = 3 + 2 * i, 4 + 2 * i
        objs.append(
            f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents {content_id} 0 R "
            f"/Resources << /Font << /F1 {font_id} 0 R >> >> >>".encode()
        )
        safe = body.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
        stream = f"BT /F1 11 Tf 40 740 Td ({safe}) Tj ET".encode()
        objs.append(b"<< /Length %d >>\nstream\n" % len(stream) + stream + b"\nendstream")
    objs.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")

    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for i, o in enumerate(objs, start=1):
        offsets.append(len(out))
        out += f"{i} 0 obj\n".encode() + o + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objs) + 1}\n0000000000 65535 f \n".encode()
    for off in offsets:
        out += f"{off:010d} 00000 n \n".encode()
    out += f"trailer\n<< /Size {len(objs) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    return bytes(out)


@pytest.fixture(scope="session")
def engine():
    url = os.environ.get("TEST_DATABASE_URL") or dbmod._embedded_database_url("studyapp_test")
    eng = dbmod.init_engine(url)
    with eng.begin() as conn:
        conn.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
    Base.metadata.drop_all(eng)
    dbmod.create_schema(eng)
    yield eng
    eng.dispose()


@pytest.fixture
def db(engine):
    session = dbmod._SessionLocal()
    yield session
    session.rollback()
    with engine.begin() as conn:
        conn.execute(text("TRUNCATE subjects, sources, chunks RESTART IDENTITY CASCADE"))
    session.close()


@pytest.fixture
def embedder():
    return HashEmbedder(384)
