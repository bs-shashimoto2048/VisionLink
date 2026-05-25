from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Iterable

from .config import DB_PATH


def get_connection() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    with get_connection() as conn:
        conn.executescript(
            """
            PRAGMA journal_mode=WAL;

            CREATE TABLE IF NOT EXISTS inspection_sessions (
                session_id TEXT PRIMARY KEY,
                operator_id TEXT NOT NULL,
                qr_text TEXT,
                order_no TEXT NOT NULL,
                serial_no TEXT NOT NULL,
                terminal_name TEXT NOT NULL,
                status TEXT NOT NULL,
                frame_index INTEGER NOT NULL DEFAULT 0,
                stability_count INTEGER NOT NULL DEFAULT 0,
                worker_confirmed INTEGER NOT NULL DEFAULT 0,
                ok_count INTEGER NOT NULL DEFAULT 0,
                ng_count INTEGER NOT NULL DEFAULT 0,
                pending_count INTEGER NOT NULL DEFAULT 0,
                completion_status TEXT NOT NULL DEFAULT 'IN_PROGRESS',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                completed_at TEXT
            );

            CREATE TABLE IF NOT EXISTS inspection_line_results (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                no INTEGER NOT NULL,
                line_no TEXT NOT NULL,
                left_value TEXT NOT NULL,
                right_value TEXT NOT NULL,
                check_status TEXT NOT NULL,
                ocr_text TEXT,
                manual_final_status TEXT,
                manual_edit_history TEXT NOT NULL DEFAULT '[]',
                updated_at TEXT NOT NULL,
                created_at TEXT NOT NULL,
                UNIQUE(session_id, no),
                FOREIGN KEY(session_id) REFERENCES inspection_sessions(session_id) ON DELETE CASCADE
            );
            """
        )


def _json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False)


def _parse_json(value: str | None) -> list[dict]:
    if not value:
        return []
    parsed = json.loads(value)
    return parsed if isinstance(parsed, list) else []


def upsert_session(snapshot: dict) -> None:
    with get_connection() as conn:
        conn.execute(
            """
            INSERT INTO inspection_sessions (
                session_id, operator_id, qr_text, order_no, serial_no, terminal_name,
                status, frame_index, stability_count, worker_confirmed,
                ok_count, ng_count, pending_count, completion_status,
                created_at, updated_at, completed_at
            ) VALUES (
                :session_id, :operator_id, :qr_text, :order_no, :serial_no, :terminal_name,
                :status, :frame_index, :stability_count, :worker_confirmed,
                :ok_count, :ng_count, :pending_count, :completion_status,
                :created_at, :updated_at, :completed_at
            )
            ON CONFLICT(session_id) DO UPDATE SET
                operator_id=excluded.operator_id,
                qr_text=excluded.qr_text,
                order_no=excluded.order_no,
                serial_no=excluded.serial_no,
                terminal_name=excluded.terminal_name,
                status=excluded.status,
                frame_index=excluded.frame_index,
                stability_count=excluded.stability_count,
                worker_confirmed=excluded.worker_confirmed,
                ok_count=excluded.ok_count,
                ng_count=excluded.ng_count,
                pending_count=excluded.pending_count,
                completion_status=excluded.completion_status,
                updated_at=excluded.updated_at,
                completed_at=excluded.completed_at
            """,
            snapshot,
        )


def upsert_line_results(session_id: str, rows: Iterable[dict]) -> None:
    with get_connection() as conn:
        for row in rows:
            payload = {
                "session_id": session_id,
                "no": row["no"],
                "line_no": row["line_no"],
                "left_value": row["left_value"],
                "right_value": row["right_value"],
                "check_status": row["check_status"],
                "ocr_text": row.get("ocr_text"),
                "manual_final_status": row.get("manual_final_status"),
                "manual_edit_history": _json(row.get("manual_edit_history", [])),
                "updated_at": row["updated_at"],
                "created_at": row["created_at"],
            }
            conn.execute(
                """
                INSERT INTO inspection_line_results (
                    session_id, no, line_no, left_value, right_value, check_status,
                    ocr_text, manual_final_status, manual_edit_history, updated_at, created_at
                ) VALUES (
                    :session_id, :no, :line_no, :left_value, :right_value, :check_status,
                    :ocr_text, :manual_final_status, :manual_edit_history, :updated_at, :created_at
                )
                ON CONFLICT(session_id, no) DO UPDATE SET
                    line_no=excluded.line_no,
                    left_value=excluded.left_value,
                    right_value=excluded.right_value,
                    check_status=excluded.check_status,
                    ocr_text=excluded.ocr_text,
                    manual_final_status=excluded.manual_final_status,
                    manual_edit_history=excluded.manual_edit_history,
                    updated_at=excluded.updated_at
                """,
                payload,
            )


def load_session(session_id: str) -> tuple[dict | None, list[dict]]:
    with get_connection() as conn:
        session_row = conn.execute(
            "SELECT * FROM inspection_sessions WHERE session_id = ?",
            (session_id,),
        ).fetchone()
        if session_row is None:
            return None, []
        line_rows = conn.execute(
            "SELECT * FROM inspection_line_results WHERE session_id = ? ORDER BY no ASC",
            (session_id,),
        ).fetchall()
        rows: list[dict] = []
        for row in line_rows:
            rows.append(
                {
                    "no": row["no"],
                    "line_no": row["line_no"],
                    "left_value": row["left_value"],
                    "right_value": row["right_value"],
                    "check_status": row["check_status"],
                    "ocr_text": row["ocr_text"],
                    "manual_final_status": row["manual_final_status"],
                    "manual_edit_history": _parse_json(row["manual_edit_history"]),
                    "updated_at": row["updated_at"],
                    "created_at": row["created_at"],
                }
            )
        return dict(session_row), rows


def touch_summary(session_id: str, summary: dict) -> None:
    with get_connection() as conn:
        conn.execute(
            """
            UPDATE inspection_sessions
            SET status = :status,
                frame_index = :frame_index,
                stability_count = :stability_count,
                worker_confirmed = :worker_confirmed,
                ok_count = :ok_count,
                ng_count = :ng_count,
                pending_count = :pending_count,
                completion_status = :completion_status,
                updated_at = :updated_at,
                completed_at = :completed_at
            WHERE session_id = :session_id
            """,
            summary,
        )

