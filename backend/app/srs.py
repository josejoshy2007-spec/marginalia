"""Spaced repetition: a compact SM-2 variant with four grades (again / hard / good / easy)."""

from dataclasses import dataclass
from datetime import datetime, timedelta

GRADES = ("again", "hard", "good", "easy")
MIN_EASE = 1.3
RELEARN_MINUTES = 10  # an "again" card comes back in the same session


@dataclass
class CardState:
    ease: float = 2.5
    interval_days: float = 0.0
    reps: int = 0
    lapses: int = 0


def schedule(state: CardState, grade: str, now: datetime) -> tuple[CardState, datetime]:
    """Return the card's next state and due time after answering with `grade`."""
    if grade not in GRADES:
        raise ValueError(f"grade must be one of {GRADES}")
    ease, interval, reps, lapses = state.ease, state.interval_days, state.reps, state.lapses

    if grade == "again":
        lapses += 1 if reps > 0 else 0
        reps = 0
        ease = max(MIN_EASE, ease - 0.2)
        interval = 0.0
        return CardState(ease, interval, reps, lapses), now + timedelta(minutes=RELEARN_MINUTES)

    if reps == 0:
        interval = {"hard": 0.5, "good": 1.0, "easy": 3.0}[grade]
    elif reps == 1:
        interval = {"hard": 2.0, "good": 3.0, "easy": 5.0}[grade]
    else:
        factor = {"hard": 1.2, "good": ease, "easy": ease * 1.3}[grade]
        interval = max(interval + 1, interval * factor)

    ease = max(MIN_EASE, ease + {"hard": -0.15, "good": 0.0, "easy": 0.15}[grade])
    reps += 1
    return CardState(ease, interval, reps, lapses), now + timedelta(days=interval)


def preview(state: CardState, now: datetime) -> dict[str, str]:
    """Human labels for when each grade would bring the card back ("10m", "1d", "2w")."""
    out = {}
    for g in GRADES:
        _, due = schedule(state, g, now)
        out[g] = _human(due - now)
    return out


def _human(delta: timedelta) -> str:
    mins = delta.total_seconds() / 60
    if mins < 60:
        return f"{round(mins)}m"
    hours = mins / 60
    if hours < 24:
        return f"{round(hours)}h"
    days = hours / 24
    if days < 14:
        return f"{round(days)}d"
    if days < 60:
        return f"{round(days / 7)}w"
    return f"{round(days / 30)}mo"
