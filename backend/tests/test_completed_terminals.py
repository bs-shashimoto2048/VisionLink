from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from starlette.testclient import TestClient

from app import db
from app.main import app


def _history(history_id: str, serial_no: str, board_no: str, terminal_name: str, completed_at: str) -> dict:
    return {
        "history_id": history_id,
        "session_id": f"session-{history_id}",
        "serial_no": serial_no,
        "board_no": board_no,
        "terminal_name": terminal_name,
        "operator_id": "1234",
        "started_at": "2026-09-30T10:00:00+09:00",
        "completed_at": completed_at,
        "final_status": "COMPLETED",
        "auto_count": 1,
        "manual_count": 0,
        "total_count": 1,
    }


class CompletedTerminalsTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self._original_db_path = db.DB_PATH
        db.DB_PATH = Path(self._tmp.name) / "visionlink-test.db"
        db.init_db()

    def tearDown(self) -> None:
        db.DB_PATH = self._original_db_path
        self._tmp.cleanup()

    def _add(self, history_id: str, serial_no: str, board_no: str, terminal_name: str, completed_at: str = "2026-09-30T10:05:00+09:00") -> None:
        db.persist_inspection_history(_history(history_id, serial_no, board_no, terminal_name, completed_at), [])

    def test_no_history_returns_empty(self) -> None:
        self.assertEqual(db.load_completed_terminals("A1AA0001", "1"), [])

    def test_only_terminal_with_history_is_returned(self) -> None:
        self._add("h1", "A1AA0001", "1", "TB1FR")
        self.assertEqual(db.load_completed_terminals("A1AA0001", "1"), ["TB1FR"])

    def test_repeated_completion_of_same_terminal_is_returned_once(self) -> None:
        self._add("h1", "A1AA0001", "1", "TB1FR", "2026-09-30T10:05:00+09:00")
        self._add("h2", "A1AA0001", "1", "TB1FR", "2026-09-30T11:05:00+09:00")
        self._add("h3", "A1AA0001", "1", "TB1FR", "2026-09-30T12:05:00+09:00")
        self.assertEqual(db.load_completed_terminals("A1AA0001", "1"), ["TB1FR"])

    def test_other_serial_and_board_are_not_mixed_in(self) -> None:
        self._add("h1", "A1AA0001", "1", "TB1FR")
        self._add("h2", "A1AA0002", "1", "TB2FL")  # other serial
        self._add("h3", "A1AA0001", "2", "TB3FL")  # other board
        self.assertEqual(db.load_completed_terminals("A1AA0001", "1"), ["TB1FR"])
        self.assertEqual(db.load_completed_terminals("A1AA0002", "1"), ["TB2FL"])
        self.assertEqual(db.load_completed_terminals("A1AA0001", "2"), ["TB3FL"])

    def test_multiple_terminals_are_distinct_and_sorted(self) -> None:
        self._add("h1", "A1AA0001", "1", "TB2FL")
        self._add("h2", "A1AA0001", "1", "TB1FR")
        self._add("h3", "A1AA0001", "1", "TB2FL")
        self.assertEqual(db.load_completed_terminals("A1AA0001", "1"), ["TB1FR", "TB2FL"])

    def test_endpoint_returns_completed_terminals(self) -> None:
        self._add("h1", "A1AA0001", "1", "TB1FR")
        self._add("h2", "A1AA0001", "1", "TB1FR")
        # No `with`: startup (init_db on the real DB) is not run.
        client = TestClient(app)
        response = client.get("/api/inspection/completed-terminals", params={"serial_no": "A1AA0001", "board_no": "1"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.json(),
            {"serial_no": "A1AA0001", "board_no": "1", "terminals": ["TB1FR"]},
        )
        missing = client.get("/api/inspection/completed-terminals", params={"serial_no": "A1AA0001"})
        self.assertEqual(missing.status_code, 422)


if __name__ == "__main__":
    unittest.main()
