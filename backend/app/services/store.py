from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Iterable

from ..db import load_session, touch_summary, upsert_line_results, upsert_session


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def persist_session_snapshot(snapshot: dict) -> None:
    upsert_session(snapshot)


def persist_rows(session_id: str, rows: Iterable[dict]) -> None:
    upsert_line_results(session_id, rows)


def load_snapshot(session_id: str) -> tuple[dict | None, list[dict]]:
    return load_session(session_id)


def persist_summary(session_id: str, summary: dict) -> None:
    touch_summary(session_id, summary)


def serialize_history(history: list[dict]) -> str:
    return json.dumps(history, ensure_ascii=False)

