from __future__ import annotations

from dataclasses import dataclass, field
import logging
from threading import Lock
from uuid import uuid4

from ..db import load_session
from ..schemas import (
    CheckStatus,
    CompleteRequest,
    DetectionBox,
    FrameAnalyzeResponse,
    InspectionRowState,
    InspectionRowTemplate,
    InspectionSessionResponse,
    InternalDataLookupRequest,
    ManualConfirmationRequest,
    ManualConfirmationState,
    ManualEditHistoryEntry,
    ManualEditRequest,
    OCRResult,
    PerformanceMetrics,
    SessionStatus,
    SessionSummary,
    StartInspectionRequest,
)
from .ai_pipeline import AIModelError, DetectionResult, pipeline
from .check_data import load_table
from .internal_data import lookup_internal_data
from .label_ocr import run_rotated_label_ocr
from .judgement import effective_status, judge_row
from .stability import OcrStabilityState, evaluate_ocr_stability
from .store import (
    load_manual_confirmation_states,
    now_iso,
    persist_inspection_history,
    persist_manual_confirmation,
    persist_manual_confirmation_event,
    persist_rows,
    persist_session_snapshot,
    persist_summary,
)

logger = logging.getLogger(__name__)


@dataclass
class RuntimeRow:
    no: int
    line_no: str
    left_value: str
    right_value: str
    check_status: CheckStatus = CheckStatus.PENDING
    ocr_text: str | None = None
    manual_final_status: CheckStatus | None = None
    manual_edit_history: list[dict] = field(default_factory=list)
    updated_at: str = field(default_factory=now_iso)
    created_at: str = field(default_factory=now_iso)

    def to_schema(self) -> InspectionRowState:
        return InspectionRowState(
            no=self.no,
            line_no=self.line_no,
            left_value=self.left_value,
            right_value=self.right_value,
            check_status=self.check_status,
            ocr_text=self.ocr_text,
            manual_final_status=self.manual_final_status,
            manual_edit_history=[ManualEditHistoryEntry(**item) for item in self.manual_edit_history],
            updated_at=self.updated_at,
        )

    def to_record(self) -> dict:
        return {
            "no": self.no,
            "line_no": self.line_no,
            "left_value": self.left_value,
            "right_value": self.right_value,
            "check_status": self.check_status.value,
            "ocr_text": self.ocr_text,
            "manual_final_status": self.manual_final_status.value if self.manual_final_status else None,
            "manual_edit_history": self.manual_edit_history,
            "updated_at": self.updated_at,
            "created_at": self.created_at,
        }


@dataclass
class RuntimeSession:
    session_id: str
    operator_id: str
    qr_text: str | None
    order_no: str
    serial_no: str
    terminal_name: str
    board_no: str
    rows: list[RuntimeRow]
    status: SessionStatus = SessionStatus.IN_PROGRESS
    frame_index: int = 0
    stability_count: int = 0
    target_row_no: int | None = None
    ocr_text: str | None = None
    detections: list[DetectionBox] = field(default_factory=list)
    ocr_results: list[OCRResult] = field(default_factory=list)
    worker_confirmed: bool = False
    manual_confirmations: dict[int, ManualConfirmationState] = field(default_factory=dict)
    completion_status: SessionStatus = SessionStatus.IN_PROGRESS
    completed_at: str | None = None
    performance: PerformanceMetrics = field(default_factory=PerformanceMetrics)
    ocr_state: OcrStabilityState = field(default_factory=OcrStabilityState)
    created_at: str = field(default_factory=now_iso)
    updated_at: str = field(default_factory=now_iso)
    last_error: str | None = None

    def summary(self) -> SessionSummary:
        ok_count = 0
        ng_count = 0
        pending_count = 0
        for row in self.rows:
            status = effective_status(row.check_status, row.manual_final_status)
            if status == CheckStatus.OK:
                ok_count += 1
            elif status in (CheckStatus.NG, CheckStatus.MISMATCH, CheckStatus.OCR_FAILED):
                ng_count += 1
            else:
                pending_count += 1
        return SessionSummary(
            ok_count=ok_count,
            ng_count=ng_count,
            pending_count=pending_count,
            worker_confirmed=self.worker_confirmed,
            completion_status=self.completion_status,
            completed_at=self.completed_at,
        )

    def snapshot(self) -> dict:
        summary = self.summary()
        return {
            "session_id": self.session_id,
            "operator_id": self.operator_id,
            "qr_text": self.qr_text,
            "order_no": self.order_no,
            "serial_no": self.serial_no,
            "terminal_name": self.terminal_name,
            "board_no": self.board_no,
            "status": self.status.value,
            "frame_index": self.frame_index,
            "stability_count": self.stability_count,
            "worker_confirmed": int(self.worker_confirmed),
            "ok_count": summary.ok_count,
            "ng_count": summary.ng_count,
            "pending_count": summary.pending_count,
            "completion_status": self.completion_status.value,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "completed_at": self.completed_at,
        }

    def to_response(self) -> InspectionSessionResponse:
        return InspectionSessionResponse(
            session_id=self.session_id,
            operator_id=self.operator_id,
            status=self.status,
            order_no=self.order_no,
            serial_no=self.serial_no,
            terminal_name=self.terminal_name,
            board_no=self.board_no,
            qr_text=self.qr_text,
            frame_index=self.frame_index,
            stability_count=self.stability_count,
            should_ocr=self.stability_count >= 2,
            target_row_no=self.target_row_no,
            ocr_text=self.ocr_text,
            detections=self.detections,
            ocr_results=self.ocr_results,
            rows=[row.to_schema() for row in self.rows],
            summary=self.summary(),
            performance=self.performance,
            manual_confirmations=[
                self.manual_confirmations[index]
                for index in sorted(self.manual_confirmations)
            ],
        )


class SessionManager:
    def __init__(self) -> None:
        # Session state is protected only for short read/update sections.
        # AI inference uses a separate lock so UI operations do not wait for YOLO/OCR.
        self._lock = Lock()
        self._pipeline_lock = Lock()
        self._sessions: dict[str, RuntimeSession] = {}

    def _build_session(self, request: StartInspectionRequest) -> RuntimeSession:
        lookup = lookup_internal_data(
            InternalDataLookupRequest(
                qr_text=request.qr_text,
                order_no=request.order_no,
                serial_no=request.serial_no,
                terminal_name=request.terminal_name,
            )
        )
        session_id = str(uuid4())
        rows = [
            RuntimeRow(
                no=item.no,
                line_no=item.line_no,
                left_value=item.left_value,
                right_value=item.right_value,
            )
            for item in lookup.rows
        ]
        session = RuntimeSession(
            session_id=session_id,
            operator_id=request.operator_id,
            qr_text=request.qr_text,
            order_no=lookup.order_no,
            serial_no=lookup.serial_no,
            terminal_name=lookup.terminal_name,
            board_no=request.board_no,
            rows=rows,
        )
        persist_session_snapshot(session.snapshot())
        persist_rows(session.session_id, [row.to_record() for row in session.rows])
        return session

    def start_session(self, request: StartInspectionRequest) -> InspectionSessionResponse:
        with self._lock:
            session = self._build_session(request)
            self._sessions[session.session_id] = session
            return session.to_response()

    def _ensure_session(self, session_id: str) -> RuntimeSession:
        session = self._sessions.get(session_id)
        if session is not None:
            return session

        session_row, row_rows = load_session(session_id)
        if session_row is None:
            raise KeyError(session_id)

        rows = [
            RuntimeRow(
                no=row["no"],
                line_no=row["line_no"],
                left_value=row["left_value"],
                right_value=row["right_value"],
                check_status=CheckStatus(row["check_status"]),
                ocr_text=row["ocr_text"],
                manual_final_status=CheckStatus(row["manual_final_status"]) if row["manual_final_status"] else None,
                manual_edit_history=row["manual_edit_history"],
                updated_at=row["updated_at"],
                created_at=row["created_at"],
            )
            for row in row_rows
        ]
        manual_confirmations = {
            item["row_index"]: ManualConfirmationState(**item)
            for item in load_manual_confirmation_states(session_id)
        }
        session = RuntimeSession(
            session_id=session_row["session_id"],
            operator_id=session_row["operator_id"],
            qr_text=session_row["qr_text"],
            order_no=session_row["order_no"],
            serial_no=session_row["serial_no"],
            terminal_name=session_row["terminal_name"],
            board_no=session_row["board_no"] or "",
            rows=rows,
            status=SessionStatus(session_row["status"]),
            frame_index=session_row["frame_index"],
            stability_count=session_row["stability_count"],
            worker_confirmed=bool(session_row["worker_confirmed"]),
            manual_confirmations=manual_confirmations,
            completion_status=SessionStatus(session_row["completion_status"]),
            created_at=session_row["created_at"],
            updated_at=session_row["updated_at"],
            completed_at=session_row["completed_at"],
        )
        self._sessions[session_id] = session
        return session

    def get_session(self, session_id: str) -> InspectionSessionResponse:
        with self._lock:
            session = self._ensure_session(session_id)
            return session.to_response()

    def process_frame(
        self,
        session_id: str,
        operator_id: str,
        frame_bytes: bytes,
        frame_index: int,
        yolo_confidence_threshold: float = 0.25,
        ocr_confidence_threshold: float = 0.5,
        rotate_left_tube_ocr: bool = False,
    ) -> FrameAnalyzeResponse:
        # Keep model access serialized because YOLO/PaddleOCR instances are shared,
        # but do not hold the session-state lock while inference is running.
        with self._pipeline_lock:
            with self._lock:
                session = self._ensure_session(session_id)
                if session.operator_id != operator_id:
                    raise PermissionError("operator mismatch")
                if session.status != SessionStatus.IN_PROGRESS:
                    return FrameAnalyzeResponse(**session.to_response().model_dump())

                assigned_frame_index = max(session.frame_index + 1, frame_index or 0)
                session.frame_index = assigned_frame_index
                session.updated_at = now_iso()

                target_row_index = (
                    (assigned_frame_index - 1) % len(session.rows)
                    if session.rows
                    else None
                )
                target_row = (
                    session.rows[target_row_index]
                    if target_row_index is not None
                    else None
                )
                row_template = (
                    InspectionRowTemplate(
                        no=target_row.no,
                        line_no=target_row.line_no,
                        left_value=target_row.left_value,
                        right_value=target_row.right_value,
                    )
                    if target_row
                    else None
                )

            # Heavy YOLO/OCR work intentionally runs outside self._lock.
            last_error: str | None = None
            try:
                detection = pipeline.detect(
                    frame_bytes,
                    assigned_frame_index,
                    confidence_threshold=yolo_confidence_threshold,
                )
            except AIModelError as exc:
                last_error = str(exc)
                detection = DetectionResult(
                    detections=[
                        DetectionBox(
                            label="ocr-demo-region",
                            confidence=0.9,
                            x=0.1,
                            y=0.1,
                            width=0.28,
                            height=0.08,
                        )
                    ],
                    performance=PerformanceMetrics(yolo_ms=0, ocr_ms=0, total_ms=0),
                    signature=f"demo:{assigned_frame_index}",
                )
                logger.info(
                    "frame-analyze inserted demo detection session_id=%s frame_index=%s reason=%s",
                    session_id,
                    assigned_frame_index,
                    str(exc),
                )

            performance = detection.performance
            detections = detection.detections
            ocr_results: list[OCRResult] = []
            ocr_text: str | None = None

            logger.info(
                "frame-analyze detections session_id=%s frame_index=%s rotate_left_tube_ocr=%s count=%s detections=%s",
                session_id,
                assigned_frame_index,
                rotate_left_tube_ocr,
                len(detections),
                [det.model_dump() for det in detections],
            )

            try:
                det_ocr_perf = pipeline.ocr_detections(
                    frame_bytes,
                    detections,
                    ocr_confidence_threshold=ocr_confidence_threshold,
                    rotate_left_tube_ocr=rotate_left_tube_ocr,
                )
                performance = PerformanceMetrics(
                    yolo_ms=performance.yolo_ms,
                    ocr_ms=det_ocr_perf.ocr_ms,
                    total_ms=performance.yolo_ms + det_ocr_perf.ocr_ms,
                )
                ocr_text = next((d.ocr_text for d in detections if d.ocr_text), None)
                ocr_results = [
                    OCRResult(
                        text=det.ocr_text.strip(),
                        confidence=det.confidence,
                        bbox=[det.x, det.y, det.width, det.height],
                        source="detection_ocr",
                        rotated=bool(det.side == "left" and det.role == "tube" and rotate_left_tube_ocr),
                        rotation_deg=180 if det.side == "left" and det.role == "tube" and rotate_left_tube_ocr else 0,
                        label=det.label,
                        side=det.side,
                        role=det.role,
                    )
                    for det in detections
                    if det.ocr_text and det.ocr_text.strip()
                ]
            except AIModelError as exc:
                last_error = str(exc)
                performance = PerformanceMetrics(
                    yolo_ms=performance.yolo_ms,
                    ocr_ms=0,
                    total_ms=performance.yolo_ms,
                )
                ocr_text = None

            logger.debug("CALL pipeline.ocr_results from session_manager")
            ocr_results_result = pipeline.ocr_results(
                frame_bytes,
                detections,
                row_template,
                assigned_frame_index,
                ocr_confidence_threshold=ocr_confidence_threshold,
                rotate_left_tube_ocr=rotate_left_tube_ocr,
            )
            if ocr_results_result.ocr_results:
                ocr_results = ocr_results_result.ocr_results
                ocr_text = ocr_results[0].text
                max_ocr_ms = max(
                    performance.ocr_ms,
                    ocr_results_result.performance.ocr_ms,
                )
                performance = PerformanceMetrics(
                    yolo_ms=performance.yolo_ms,
                    ocr_ms=max_ocr_ms,
                    total_ms=performance.yolo_ms + max_ocr_ms,
                )

            # Stability state belongs to the session, so mutate it only while locked.
            with self._lock:
                session = self._ensure_session(session_id)
                if (
                    session.operator_id != operator_id
                    or session.status != SessionStatus.IN_PROGRESS
                    or session.frame_index != assigned_frame_index
                ):
                    return FrameAnalyzeResponse(**session.to_response().model_dump())

                stability = evaluate_ocr_stability(
                    session.ocr_state,
                    detection.signature,
                    detection.detections,
                )
                stability_count = session.ocr_state.stable_count
                should_ocr = stability.stable and row_template is not None

            row_ocr_result = None
            if should_ocr and row_template:
                row_ocr_result = pipeline.ocr(
                    frame_bytes,
                    row_template,
                    stability_count,
                    assigned_frame_index,
                )

            # Apply inference atomically. If the session was stopped/completed while
            # inference ran, discard this frame instead of overwriting newer state.
            with self._lock:
                session = self._ensure_session(session_id)
                if (
                    session.operator_id != operator_id
                    or session.status != SessionStatus.IN_PROGRESS
                    or session.frame_index != assigned_frame_index
                ):
                    return FrameAnalyzeResponse(**session.to_response().model_dump())

                session.performance = performance
                session.detections = detections
                session.ocr_results = list(ocr_results)
                session.ocr_text = ocr_text
                session.stability_count = stability_count
                session.target_row_no = row_template.no if row_template else None
                session.last_error = last_error
                session.updated_at = now_iso()

                if row_ocr_result is not None and row_template is not None:
                    session.ocr_text = row_ocr_result.text
                    session.performance = PerformanceMetrics(
                        yolo_ms=session.performance.yolo_ms,
                        ocr_ms=row_ocr_result.performance.ocr_ms,
                        total_ms=session.performance.yolo_ms + row_ocr_result.performance.ocr_ms,
                    )
                    if row_ocr_result.success:
                        if row_ocr_result.text:
                            session.ocr_results.append(
                                OCRResult(
                                    text=row_ocr_result.text,
                                    confidence=row_ocr_result.confidence,
                                    bbox=row_ocr_result.bbox,
                                    source="row_ocr",
                                )
                            )
                        judgement = judge_row(row_template, row_ocr_result.text)
                        if target_row_index is not None and target_row_index < len(session.rows):
                            current_target = session.rows[target_row_index]
                            current_target.check_status = judgement.status
                            current_target.ocr_text = row_ocr_result.text
                            current_target.updated_at = now_iso()
                    elif target_row_index is not None and target_row_index < len(session.rows):
                        current_target = session.rows[target_row_index]
                        current_target.check_status = CheckStatus.OCR_FAILED
                        current_target.ocr_text = None
                        current_target.updated_at = now_iso()

                persist_rows(
                    session.session_id,
                    [row.to_record() for row in session.rows],
                )
                persist_session_snapshot(session.snapshot())
                response = FrameAnalyzeResponse(**session.to_response().model_dump())

            logger.info(
                "frame-analyze response OCR session_id=%s frame_index=%s ocr_results_count=%s",
                session_id,
                assigned_frame_index,
                len(response.ocr_results),
            )
            return response

    def process_rotated_label_ocr(
        self,
        frame_bytes: bytes,
        detections: list[DetectionBox],
        ocr_confidence_threshold: float,
    ) -> tuple[list[OCRResult], int]:
        # Shares PaddleOCR with frame inference; serialize model access without
        # blocking session-state operations.
        with self._pipeline_lock:
            return run_rotated_label_ocr(
                frame_bytes,
                detections,
                ocr_confidence_threshold,
            )

    def manual_edit_row(self, session_id: str, line_no: int, request: ManualEditRequest) -> InspectionSessionResponse:
        with self._lock:
            session = self._ensure_session(session_id)
            if session.operator_id != request.operator_id:
                raise PermissionError("operator mismatch")
            row = next((item for item in session.rows if item.no == line_no), None)
            if row is None:
                raise KeyError(f"row {line_no} not found")
            row.manual_edit_history.append(
                {
                    "timestamp": now_iso(),
                    "operator_id": request.operator_id,
                    "note": request.note,
                    "final_status": request.final_status.value,
                }
            )
            row.manual_final_status = request.final_status
            row.check_status = CheckStatus.MANUAL_FIXED
            row.updated_at = now_iso()
            persist_rows(session.session_id, [item.to_record() for item in session.rows])
            persist_session_snapshot(session.snapshot())
            return session.to_response()

    def set_manual_confirmation(
        self,
        session_id: str,
        request: ManualConfirmationRequest,
    ) -> InspectionSessionResponse:
        with self._lock:
            session = self._ensure_session(session_id)
            if session.operator_id != request.operator_id:
                raise PermissionError("operator mismatch")
            if session.status not in (SessionStatus.IN_PROGRESS, SessionStatus.PAUSED):
                raise ValueError("manual confirmation is only available for an active inspection")
            if not session.board_no:
                raise ValueError("board number is missing from this inspection session")

            check_table = load_table(session.serial_no, session.board_no, session.terminal_name)
            if request.row_index < 0 or request.row_index >= len(check_table.rows):
                raise ValueError(f"invalid row index: {request.row_index}")
            expected = check_table.rows[request.row_index]
            if request.label != expected.label:
                raise ValueError(f"row {request.row_index} label does not match current check data")

            timestamp = now_iso()
            state = ManualConfirmationState(
                row_index=request.row_index,
                label=request.label,
                confirmed=request.confirmed,
                confirmed_by=request.operator_id if request.confirmed else None,
                confirmed_at=timestamp if request.confirmed else None,
                has_confirmation_history=True,
                updated_at=timestamp,
            )
            session.manual_confirmations[request.row_index] = state
            session.updated_at = timestamp
            persist_manual_confirmation(
                session_id=session.session_id,
                row_index=request.row_index,
                label=request.label,
                confirmed=request.confirmed,
                confirmed_by=state.confirmed_by,
                confirmed_at=state.confirmed_at,
                updated_at=timestamp,
            )
            persist_manual_confirmation_event(
                session_id=session.session_id,
                row_index=request.row_index,
                label=request.label,
                action="MANUAL_CONFIRMED" if request.confirmed else "MANUAL_CONFIRM_REVOKED",
                operator_id=request.operator_id,
                created_at=timestamp,
            )
            persist_session_snapshot(session.snapshot())
            return session.to_response()

    def pause_session(self, session_id: str, operator_id: str) -> InspectionSessionResponse:
        with self._lock:
            session = self._ensure_session(session_id)
            if session.operator_id != operator_id:
                raise PermissionError("operator mismatch")
            session.status = SessionStatus.PAUSED
            session.updated_at = now_iso()
            persist_session_snapshot(session.snapshot())
            return session.to_response()

    def resume_session(self, session_id: str, operator_id: str) -> InspectionSessionResponse:
        with self._lock:
            session = self._ensure_session(session_id)
            if session.operator_id != operator_id:
                raise PermissionError("operator mismatch")
            session.status = SessionStatus.IN_PROGRESS
            session.updated_at = now_iso()
            persist_session_snapshot(session.snapshot())
            return session.to_response()

    def abort_session(self, session_id: str, operator_id: str) -> InspectionSessionResponse:
        with self._lock:
            session = self._ensure_session(session_id)
            if session.operator_id != operator_id:
                raise PermissionError("operator mismatch")
            session.status = SessionStatus.ABORTED
            session.completion_status = SessionStatus.ABORTED
            session.updated_at = now_iso()
            persist_session_snapshot(session.snapshot())
            return session.to_response()

    def complete_session(self, session_id: str, request: CompleteRequest) -> InspectionSessionResponse:
        with self._lock:
            session = self._ensure_session(session_id)
            if session.operator_id != request.operator_id:
                raise PermissionError("operator mismatch")
            if not request.worker_confirmed:
                raise ValueError("worker confirmation is required")
            if not request.rows:
                raise ValueError("completion row results are required")

            if not session.board_no:
                raise ValueError("board number is missing from this inspection session")
            check_table = load_table(session.serial_no, session.board_no, session.terminal_name)
            if len(request.rows) != len(check_table.rows):
                raise ValueError(
                    f"completion rows do not match check data: expected {len(check_table.rows)}, got {len(request.rows)}"
                )

            history_rows: list[dict] = []
            auto_count = 0
            manual_count = 0
            seen_row_indexes: set[int] = set()
            for row in request.rows:
                if row.row_index < 0 or row.row_index >= len(check_table.rows):
                    raise ValueError(f"invalid row index: {row.row_index}")
                expected = check_table.rows[row.row_index]
                if (
                    row.label != expected.label
                    or row.tube_l_expected != expected.tube_l
                    or row.tube_r_expected != expected.tube_r
                ):
                    raise ValueError(f"row {row.row_index} does not match current check data")

                if row.row_index in seen_row_indexes:
                    raise ValueError(f"duplicate row index: {row.row_index}")
                seen_row_indexes.add(row.row_index)
                if row.final_status != "OK":
                    raise ValueError(f"row {row.label} is not complete")

                manual_confirmed_by: str | None = None
                manual_confirmed_at: str | None = None
                if row.completion_method.value == "AUTO":
                    if not (
                        row.tube_l_status == "OK"
                        and row.label_status == "OK"
                        and row.tube_r_status == "OK"
                    ):
                        raise ValueError(f"row {row.label} does not satisfy AUTO completion")
                    auto_count += 1
                else:
                    confirmation = session.manual_confirmations.get(row.row_index)
                    if (
                        confirmation is None
                        or not confirmation.confirmed
                        or confirmation.label != row.label
                    ):
                        raise ValueError(f"row {row.label} is not manually confirmed")
                    manual_confirmed_by = confirmation.confirmed_by
                    manual_confirmed_at = confirmation.confirmed_at
                    manual_count += 1

                history_rows.append(
                    {
                        "history_id": f"history-{session.session_id}",
                        "row_index": row.row_index,
                        "label": row.label,
                        "tube_l_expected": row.tube_l_expected,
                        "tube_r_expected": row.tube_r_expected,
                        "tube_l_status": row.tube_l_status,
                        "label_status": row.label_status,
                        "tube_r_status": row.tube_r_status,
                        "completion_method": row.completion_method.value,
                        "manual_confirmed_by": manual_confirmed_by,
                        "manual_confirmed_at": manual_confirmed_at,
                        "final_status": row.final_status,
                    }
                )

            session.worker_confirmed = True
            session.status = SessionStatus.COMPLETED
            session.completion_status = SessionStatus.COMPLETED
            session.completed_at = now_iso()
            session.updated_at = session.completed_at

            persist_inspection_history(
                {
                    "history_id": f"history-{session.session_id}",
                    "session_id": session.session_id,
                    "serial_no": session.serial_no,
                    "board_no": session.board_no,
                    "terminal_name": session.terminal_name,
                    "operator_id": session.operator_id,
                    "started_at": session.created_at,
                    "completed_at": session.completed_at,
                    "final_status": "COMPLETED",
                    "auto_count": auto_count,
                    "manual_count": manual_count,
                    "total_count": len(history_rows),
                },
                history_rows,
            )

            summary = session.summary()
            persist_rows(session.session_id, [item.to_record() for item in session.rows])
            persist_session_snapshot(session.snapshot())
            persist_summary(
                session.session_id,
                {
                    "session_id": session.session_id,
                    "status": session.status.value,
                    "frame_index": session.frame_index,
                    "stability_count": session.stability_count,
                    "worker_confirmed": int(session.worker_confirmed),
                    "ok_count": summary.ok_count,
                    "ng_count": summary.ng_count,
                    "pending_count": summary.pending_count,
                    "completion_status": session.completion_status.value,
                    "updated_at": session.updated_at,
                    "completed_at": session.completed_at,
                },
            )
            return session.to_response()


manager = SessionManager()
