from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Iterable

from ..db import (
    append_manual_confirmation_event,
    load_manual_confirmations,
    load_session,
    persist_inspection_history as persist_inspection_history_record,
    touch_summary,
    upsert_line_results,
    upsert_manual_confirmation,
    upsert_session,
)


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



def persist_manual_confirmation(
    session_id: str,
    row_index: int,
    label: str,
    confirmed: bool,
    confirmed_by: str | None,
    confirmed_at: str | None,
    updated_at: str,
) -> None:
    upsert_manual_confirmation(
        session_id=session_id,
        row_index=row_index,
        label=label,
        confirmed=confirmed,
        confirmed_by=confirmed_by,
        confirmed_at=confirmed_at,
        updated_at=updated_at,
    )


def load_manual_confirmation_states(session_id: str) -> list[dict]:
    return load_manual_confirmations(session_id)


def persist_manual_confirmation_event(
    session_id: str,
    row_index: int,
    label: str,
    action: str,
    operator_id: str,
    created_at: str,
) -> None:
    append_manual_confirmation_event(
        session_id=session_id,
        row_index=row_index,
        label=label,
        action=action,
        operator_id=operator_id,
        created_at=created_at,
    )


def persist_inspection_history(history: dict, rows: Iterable[dict]) -> None:
    persist_inspection_history_record(history, rows)
