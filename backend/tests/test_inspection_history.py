from __future__ import annotations

import sqlite3
import tempfile
import unittest
from pathlib import Path

from app import db


class InspectionHistoryStorageTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self._original_db_path = db.DB_PATH
        db.DB_PATH = Path(self._tmp.name) / "visionlink-test.db"
        db.init_db()
        db.upsert_session(
            {
                "session_id": "session-1",
                "operator_id": "1234",
                "qr_text": None,
                "order_no": "ORD-1",
                "serial_no": "A1AA0001",
                "terminal_name": "TB1FL",
                "board_no": "1",
                "status": "IN_PROGRESS",
                "frame_index": 0,
                "stability_count": 0,
                "worker_confirmed": 0,
                "ok_count": 0,
                "ng_count": 0,
                "pending_count": 2,
                "completion_status": "IN_PROGRESS",
                "created_at": "2026-09-30T10:00:00+09:00",
                "updated_at": "2026-09-30T10:00:00+09:00",
                "completed_at": None,
            }
        )

    def tearDown(self) -> None:
        db.DB_PATH = self._original_db_path
        self._tmp.cleanup()

    def test_manual_confirmation_state_and_events_are_persisted(self) -> None:
        db.upsert_manual_confirmation(
            session_id="session-1",
            row_index=1,
            label="23",
            confirmed=True,
            confirmed_by="1234",
            confirmed_at="2026-09-30T10:01:00+09:00",
            updated_at="2026-09-30T10:01:00+09:00",
        )
        db.append_manual_confirmation_event(
            session_id="session-1",
            row_index=1,
            label="23",
            action="MANUAL_CONFIRMED",
            operator_id="1234",
            created_at="2026-09-30T10:01:00+09:00",
        )
        db.upsert_manual_confirmation(
            session_id="session-1",
            row_index=1,
            label="23",
            confirmed=False,
            confirmed_by=None,
            confirmed_at=None,
            updated_at="2026-09-30T10:02:00+09:00",
        )
        db.append_manual_confirmation_event(
            session_id="session-1",
            row_index=1,
            label="23",
            action="MANUAL_CONFIRM_REVOKED",
            operator_id="1234",
            created_at="2026-09-30T10:02:00+09:00",
        )

        states = db.load_manual_confirmations("session-1")
        self.assertEqual(1, len(states))
        self.assertFalse(states[0]["confirmed"])
        self.assertEqual("23", states[0]["label"])

        with db.get_connection() as conn:
            events = conn.execute(
                """
                SELECT action FROM inspection_manual_confirmation_events
                WHERE session_id = ?
                ORDER BY id ASC
                """,
                ("session-1",),
            ).fetchall()
        self.assertEqual(
            ["MANUAL_CONFIRMED", "MANUAL_CONFIRM_REVOKED"],
            [row["action"] for row in events],
        )

    def test_terminal_block_history_contains_all_terminal_results(self) -> None:
        history = {
            "history_id": "history-session-1",
            "session_id": "session-1",
            "serial_no": "A1AA0001",
            "board_no": "1",
            "terminal_name": "TB1FL",
            "operator_id": "1234",
            "started_at": "2026-09-30T10:00:00+09:00",
            "completed_at": "2026-09-30T10:05:00+09:00",
            "final_status": "COMPLETED",
            "auto_count": 1,
            "manual_count": 1,
            "total_count": 2,
        }
        rows = [
            {
                "history_id": "history-session-1",
                "row_index": 0,
                "label": "22",
                "tube_l_expected": "A3S7N2D",
                "tube_r_expected": "A3S7N2D",
                "tube_l_status": "OK",
                "label_status": "OK",
                "tube_r_status": "OK",
                "completion_method": "AUTO",
                "manual_confirmed_by": None,
                "manual_confirmed_at": None,
                "final_status": "OK",
            },
            {
                "history_id": "history-session-1",
                "row_index": 1,
                "label": "23",
                "tube_l_expected": "L1P8",
                "tube_r_expected": "L1P8",
                "tube_l_status": "OK",
                "label_status": "OK",
                "tube_r_status": "PENDING",
                "completion_method": "MANUAL",
                "manual_confirmed_by": "1234",
                "manual_confirmed_at": "2026-09-30T10:04:00+09:00",
                "final_status": "OK",
            },
        ]

        db.persist_inspection_history(history, rows)
        saved_history, saved_rows = db.load_inspection_history("session-1")

        self.assertIsNotNone(saved_history)
        assert saved_history is not None
        self.assertEqual("A1AA0001", saved_history["serial_no"])
        self.assertEqual(1, saved_history["auto_count"])
        self.assertEqual(1, saved_history["manual_count"])
        self.assertEqual(2, saved_history["total_count"])
        self.assertEqual(["22", "23"], [row["label"] for row in saved_rows])
        self.assertEqual(["AUTO", "MANUAL"], [row["completion_method"] for row in saved_rows])
        self.assertEqual("1234", saved_rows[1]["manual_confirmed_by"])


if __name__ == "__main__":
    unittest.main()
