from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Iterable

from .config import DB_PATH


class ClosingConnection(sqlite3.Connection):
    """Commit/rollback like sqlite3.Connection, then always release the file handle."""

    def __exit__(self, exc_type, exc_value, traceback):
        try:
            return super().__exit__(exc_type, exc_value, traceback)
        finally:
            self.close()


def get_connection() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(
        DB_PATH,
        check_same_thread=False,
        factory=ClosingConnection,
    )
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
                board_no TEXT,
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

            CREATE TABLE IF NOT EXISTS inspection_manual_confirmations (
                session_id TEXT NOT NULL,
                row_index INTEGER NOT NULL,
                label TEXT NOT NULL,
                confirmed INTEGER NOT NULL DEFAULT 0,
                confirmed_by TEXT,
                confirmed_at TEXT,
                updated_at TEXT NOT NULL,
                PRIMARY KEY(session_id, row_index),
                FOREIGN KEY(session_id) REFERENCES inspection_sessions(session_id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS inspection_manual_confirmation_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                row_index INTEGER NOT NULL,
                label TEXT NOT NULL,
                action TEXT NOT NULL,
                operator_id TEXT NOT NULL,
                created_at TEXT NOT NULL,
                FOREIGN KEY(session_id) REFERENCES inspection_sessions(session_id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS inspection_history (
                history_id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL UNIQUE,
                serial_no TEXT NOT NULL,
                board_no TEXT NOT NULL,
                terminal_name TEXT NOT NULL,
                operator_id TEXT NOT NULL,
                started_at TEXT NOT NULL,
                completed_at TEXT NOT NULL,
                final_status TEXT NOT NULL,
                auto_count INTEGER NOT NULL,
                manual_count INTEGER NOT NULL,
                total_count INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS inspection_history_rows (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                history_id TEXT NOT NULL,
                row_index INTEGER NOT NULL,
                label TEXT NOT NULL,
                tube_l_expected TEXT NOT NULL,
                tube_r_expected TEXT NOT NULL,
                tube_l_status TEXT NOT NULL,
                label_status TEXT NOT NULL,
                tube_r_status TEXT NOT NULL,
                completion_method TEXT NOT NULL,
                manual_confirmed_by TEXT,
                manual_confirmed_at TEXT,
                final_status TEXT NOT NULL,
                UNIQUE(history_id, row_index),
                FOREIGN KEY(history_id) REFERENCES inspection_history(history_id) ON DELETE CASCADE
            );
            """
        )
        columns = {
            row["name"]
            for row in conn.execute("PRAGMA table_info(inspection_sessions)").fetchall()
        }
        if "board_no" not in columns:
            conn.execute("ALTER TABLE inspection_sessions ADD COLUMN board_no TEXT")


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
                session_id, operator_id, qr_text, order_no, serial_no, terminal_name, board_no,
                status, frame_index, stability_count, worker_confirmed,
                ok_count, ng_count, pending_count, completion_status,
                created_at, updated_at, completed_at
            ) VALUES (
                :session_id, :operator_id, :qr_text, :order_no, :serial_no, :terminal_name, :board_no,
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
                board_no=excluded.board_no,
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



def upsert_manual_confirmation(
    session_id: str,
    row_index: int,
    label: str,
    confirmed: bool,
    confirmed_by: str | None,
    confirmed_at: str | None,
    updated_at: str,
) -> None:
    with get_connection() as conn:
        conn.execute(
            """
            INSERT INTO inspection_manual_confirmations (
                session_id, row_index, label, confirmed, confirmed_by, confirmed_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(session_id, row_index) DO UPDATE SET
                label=excluded.label,
                confirmed=excluded.confirmed,
                confirmed_by=excluded.confirmed_by,
                confirmed_at=excluded.confirmed_at,
                updated_at=excluded.updated_at
            """,
            (
                session_id,
                row_index,
                label,
                int(confirmed),
                confirmed_by,
                confirmed_at,
                updated_at,
            ),
        )


def load_manual_confirmations(session_id: str) -> list[dict]:
    with get_connection() as conn:
        rows = conn.execute(
            """
            SELECT row_index, label, confirmed, confirmed_by, confirmed_at, updated_at
            FROM inspection_manual_confirmations
            WHERE session_id = ?
            ORDER BY row_index ASC
            """,
            (session_id,),
        ).fetchall()
        return [
            {
                "row_index": row["row_index"],
                "label": row["label"],
                "confirmed": bool(row["confirmed"]),
                "confirmed_by": row["confirmed_by"],
                "confirmed_at": row["confirmed_at"],
                "updated_at": row["updated_at"],
            }
            for row in rows
        ]


def append_manual_confirmation_event(
    session_id: str,
    row_index: int,
    label: str,
    action: str,
    operator_id: str,
    created_at: str,
) -> None:
    with get_connection() as conn:
        conn.execute(
            """
            INSERT INTO inspection_manual_confirmation_events (
                session_id, row_index, label, action, operator_id, created_at
            ) VALUES (?, ?, ?, ?, ?, ?)
            """,
            (session_id, row_index, label, action, operator_id, created_at),
        )


def persist_inspection_history(history: dict, rows: Iterable[dict]) -> None:
    with get_connection() as conn:
        conn.execute(
            """
            INSERT INTO inspection_history (
                history_id, session_id, serial_no, board_no, terminal_name,
                operator_id, started_at, completed_at, final_status,
                auto_count, manual_count, total_count
            ) VALUES (
                :history_id, :session_id, :serial_no, :board_no, :terminal_name,
                :operator_id, :started_at, :completed_at, :final_status,
                :auto_count, :manual_count, :total_count
            )
            ON CONFLICT(session_id) DO UPDATE SET
                serial_no=excluded.serial_no,
                board_no=excluded.board_no,
                terminal_name=excluded.terminal_name,
                operator_id=excluded.operator_id,
                started_at=excluded.started_at,
                completed_at=excluded.completed_at,
                final_status=excluded.final_status,
                auto_count=excluded.auto_count,
                manual_count=excluded.manual_count,
                total_count=excluded.total_count
            """,
            history,
        )
        conn.execute("DELETE FROM inspection_history_rows WHERE history_id = ?", (history["history_id"],))
        for row in rows:
            conn.execute(
                """
                INSERT INTO inspection_history_rows (
                    history_id, row_index, label, tube_l_expected, tube_r_expected,
                    tube_l_status, label_status, tube_r_status, completion_method,
                    manual_confirmed_by, manual_confirmed_at, final_status
                ) VALUES (
                    :history_id, :row_index, :label, :tube_l_expected, :tube_r_expected,
                    :tube_l_status, :label_status, :tube_r_status, :completion_method,
                    :manual_confirmed_by, :manual_confirmed_at, :final_status
                )
                """,
                row,
            )


def load_inspection_history(session_id: str) -> tuple[dict | None, list[dict]]:
    with get_connection() as conn:
        history = conn.execute(
            "SELECT * FROM inspection_history WHERE session_id = ?",
            (session_id,),
        ).fetchone()
        if history is None:
            return None, []
        rows = conn.execute(
            """
            SELECT * FROM inspection_history_rows
            WHERE history_id = ?
            ORDER BY row_index ASC
            """,
            (history["history_id"],),
        ).fetchall()
        return dict(history), [dict(row) for row in rows]
