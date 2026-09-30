from __future__ import annotations

import threading
import unittest
from unittest.mock import patch

from app.schemas import (
    CheckDataRow,
    CheckDataTableResponse,
    ManualConfirmationRequest,
    PerformanceMetrics,
)
from app.services.ai_pipeline import DetectionResult, OcrResultsResult
from app.services.session_manager import RuntimeRow, RuntimeSession, SessionManager


class InferenceConcurrencyTest(unittest.TestCase):
    def test_manual_confirmation_is_not_blocked_by_running_inference(self) -> None:
        manager = SessionManager()
        session = RuntimeSession(
            session_id="session-concurrency",
            operator_id="1234",
            qr_text=None,
            order_no="ORD-1",
            serial_no="A1AA0001",
            terminal_name="TB1FL",
            board_no="1",
            rows=[
                RuntimeRow(
                    no=1,
                    line_no="23",
                    left_value="L1P8",
                    right_value="L1P8",
                )
            ],
        )
        manager._sessions[session.session_id] = session

        inference_started = threading.Event()
        release_inference = threading.Event()
        inference_finished = threading.Event()
        manual_finished = threading.Event()
        inference_error: list[BaseException] = []
        manual_error: list[BaseException] = []

        def slow_detect(*args, **kwargs):
            inference_started.set()
            if not release_inference.wait(timeout=3):
                raise RuntimeError("test timed out waiting to release inference")
            return DetectionResult(
                detections=[],
                performance=PerformanceMetrics(),
                signature="frame-1",
            )

        def run_inference() -> None:
            try:
                manager.process_frame(
                    session_id=session.session_id,
                    operator_id="1234",
                    frame_bytes=b"frame",
                    frame_index=1,
                )
            except BaseException as exc:  # pragma: no cover - surfaced by assertion
                inference_error.append(exc)
            finally:
                inference_finished.set()

        def run_manual_confirmation() -> None:
            try:
                manager.set_manual_confirmation(
                    session.session_id,
                    ManualConfirmationRequest(
                        operator_id="1234",
                        row_index=0,
                        label="23",
                        confirmed=True,
                    ),
                )
            except BaseException as exc:  # pragma: no cover - surfaced by assertion
                manual_error.append(exc)
            finally:
                manual_finished.set()

        check_table = CheckDataTableResponse(
            serial="A1AA0001",
            board="1",
            terminal="TB1FL",
            rows=[CheckDataRow(tube_l="L1P8", label="23", tube_r="L1P8")],
        )

        with (
            patch("app.services.session_manager.pipeline.detect", side_effect=slow_detect),
            patch(
                "app.services.session_manager.pipeline.ocr_detections",
                return_value=PerformanceMetrics(),
            ),
            patch(
                "app.services.session_manager.pipeline.ocr_results",
                return_value=OcrResultsResult(
                    ocr_results=[],
                    performance=PerformanceMetrics(),
                    source="test",
                ),
            ),
            patch("app.services.session_manager.load_table", return_value=check_table),
            patch("app.services.session_manager.persist_rows"),
            patch("app.services.session_manager.persist_session_snapshot"),
            patch("app.services.session_manager.persist_manual_confirmation"),
            patch("app.services.session_manager.persist_manual_confirmation_event"),
        ):
            inference_thread = threading.Thread(target=run_inference, daemon=True)
            inference_thread.start()
            self.assertTrue(inference_started.wait(timeout=1), "inference did not start")

            manual_thread = threading.Thread(target=run_manual_confirmation, daemon=True)
            manual_thread.start()

            try:
                self.assertTrue(
                    manual_finished.wait(timeout=0.5),
                    "manual confirmation waited for inference to finish",
                )
                self.assertFalse(manual_error, f"manual confirmation failed: {manual_error}")
                self.assertTrue(
                    manager._sessions[session.session_id]
                    .manual_confirmations[0]
                    .confirmed
                )
                self.assertFalse(
                    inference_finished.is_set(),
                    "inference unexpectedly completed before it was released",
                )
            finally:
                release_inference.set()

            self.assertTrue(inference_finished.wait(timeout=2), "inference did not finish")
            self.assertFalse(inference_error, f"inference failed: {inference_error}")


if __name__ == "__main__":
    unittest.main()
