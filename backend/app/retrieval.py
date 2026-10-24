from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.orm import Session

from .models import Chunk, Source


@dataclass
class Retrieved:
    chunk: Chunk
    source: Source
    distance: float


def retrieve(
    db: Session,
    subject_id: int,
    source_ids: list[int],
    query_vec: list[float],
    k: int = 8,
) -> list[Retrieved]:
    """Top-k chunks by cosine distance, restricted to the given (checked) sources of a subject.

    An empty `source_ids` returns nothing — unchecked means "don't use", never "use all".
    """
    if not source_ids:
        return []
    dist = Chunk.embedding.cosine_distance(query_vec).label("distance")
    stmt = (
        select(Chunk, Source, dist)
        .join(Source, Chunk.source_id == Source.id)
        .where(Source.subject_id == subject_id, Source.id.in_(source_ids))
        .order_by(dist)
        .limit(k)
    )
    return [Retrieved(c, s, float(d)) for c, s, d in db.execute(stmt).all()]
