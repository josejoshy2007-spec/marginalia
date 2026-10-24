from datetime import datetime, timezone

from pgvector.sqlalchemy import Vector
from sqlalchemy import JSON, Boolean, DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship

from .config import get_settings


def _now() -> datetime:
    return datetime.now(timezone.utc)


class Base(DeclarativeBase):
    pass


class Subject(Base):
    __tablename__ = "subjects"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(200))
    # IB course this subject belongs to (e.g. "Computer Science") + "SL"/"HL"; steers all generation.
    ib_course: Mapped[str | None] = mapped_column(String(120), nullable=True)
    ib_level: Mapped[str | None] = mapped_column(String(4), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)

    sources: Mapped[list["Source"]] = relationship(
        back_populates="subject", cascade="all, delete-orphan", order_by="Source.id"
    )


class Source(Base):
    __tablename__ = "sources"

    id: Mapped[int] = mapped_column(primary_key=True)
    subject_id: Mapped[int] = mapped_column(ForeignKey("subjects.id", ondelete="CASCADE"), index=True)
    kind: Mapped[str] = mapped_column(String(10))  # pdf | text | url
    title: Mapped[str] = mapped_column(String(500))
    url: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Full extracted text; chunk char offsets index into this string.
    text: Mapped[str] = mapped_column(Text)
    # [{"page": 1, "start": 0, "end": 1234}, ...] — empty for non-paginated sources.
    pages: Mapped[list] = mapped_column(JSON, default=list)
    checked: Mapped[bool] = mapped_column(Boolean, default=True)
    status: Mapped[str] = mapped_column(String(20), default="ready")  # ready | processing | failed
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Uploaded recording waiting for / undergoing Whisper transcription (deleted when done).
    upload_path: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)

    subject: Mapped[Subject] = relationship(back_populates="sources")
    chunks: Mapped[list["Chunk"]] = relationship(
        back_populates="source", cascade="all, delete-orphan", order_by="Chunk.ord"
    )


class Chunk(Base):
    __tablename__ = "chunks"

    id: Mapped[int] = mapped_column(primary_key=True)
    source_id: Mapped[int] = mapped_column(ForeignKey("sources.id", ondelete="CASCADE"), index=True)
    ord: Mapped[int] = mapped_column(Integer)
    text: Mapped[str] = mapped_column(Text)  # == source.text[char_start:char_end]
    char_start: Mapped[int] = mapped_column(Integer)
    char_end: Mapped[int] = mapped_column(Integer)
    page_start: Mapped[int | None] = mapped_column(Integer, nullable=True)
    page_end: Mapped[int | None] = mapped_column(Integer, nullable=True)
    token_count: Mapped[int] = mapped_column(Integer)
    embedding: Mapped[list[float]] = mapped_column(Vector(get_settings().embed_dim))

    source: Mapped[Source] = relationship(back_populates="chunks")


class Artifact(Base):
    """Something generated from a subject's sources: a card deck, quiz, study sheet or audio episode.

    `passages` freezes the chunks the generator saw, so a `cite: [n]` in `content` keeps resolving
    to `passages[n-1]` (source id + char span) even after re-chunking or new sources.
    """

    __tablename__ = "artifacts"

    id: Mapped[int] = mapped_column(primary_key=True)
    subject_id: Mapped[int] = mapped_column(ForeignKey("subjects.id", ondelete="CASCADE"), index=True)
    kind: Mapped[str] = mapped_column(String(20))  # deck | quiz | sheet | episode | summary | exam
    subtype: Mapped[str] = mapped_column(String(30), default="")  # e.g. study_guide, debate
    title: Mapped[str] = mapped_column(String(300))
    params: Mapped[dict] = mapped_column(JSON, default=dict)
    content: Mapped[dict] = mapped_column(JSON, default=dict)
    passages: Mapped[list] = mapped_column(JSON, default=list)
    audio_path: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(String(20), default="ready")  # ready | processing | failed
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)

    cards: Mapped[list["Card"]] = relationship(
        back_populates="deck", cascade="all, delete-orphan", order_by="Card.id"
    )
    attempts: Mapped[list["QuizAttempt"]] = relationship(
        back_populates="quiz", cascade="all, delete-orphan", order_by="QuizAttempt.id"
    )


class Card(Base):
    """A flashcard with SM-2 style spaced-repetition state."""

    __tablename__ = "cards"

    id: Mapped[int] = mapped_column(primary_key=True)
    deck_id: Mapped[int] = mapped_column(ForeignKey("artifacts.id", ondelete="CASCADE"), index=True)
    front: Mapped[str] = mapped_column(Text)
    back: Mapped[str] = mapped_column(Text)
    cite: Mapped[list] = mapped_column(JSON, default=list)
    ease: Mapped[float] = mapped_column(default=2.5)
    interval_days: Mapped[float] = mapped_column(default=0.0)
    reps: Mapped[int] = mapped_column(Integer, default=0)
    lapses: Mapped[int] = mapped_column(Integer, default=0)
    due_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, index=True)
    last_reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    deck: Mapped[Artifact] = relationship(back_populates="cards")


class QuizAttempt(Base):
    __tablename__ = "quiz_attempts"

    id: Mapped[int] = mapped_column(primary_key=True)
    quiz_id: Mapped[int] = mapped_column(ForeignKey("artifacts.id", ondelete="CASCADE"), index=True)
    answers: Mapped[list] = mapped_column(JSON, default=list)  # chosen option index per question (-1 = skipped)
    score: Mapped[int] = mapped_column(Integer)
    total: Mapped[int] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)

    quiz: Mapped[Artifact] = relationship(back_populates="attempts")
