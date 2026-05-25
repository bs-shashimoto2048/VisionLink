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
    ManualEditHistoryEntry,
    ManualEditRequest,
    OCRResult,
    PerformanceMetrics,
    SessionStatus,
    SessionSummary,
    StartInspectionRequest,
)
from .ai_pipeline import AIModelError, DetectionResult, pipeline
from .internal_data import lookup_internal_data
from .judgement import effective_status, judge_row
from .stability import OcrStabilityState, evaluate_ocr_stability
from .store import now_iso, persist_rows, persist_session_snapshot, persist_summary

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
    rows: list[RuntimeRow]
    status: SessionStatus = SessionStatus.IN_PROGRESS
    frame_index: int = 0
    stability_count: int = 0
    target_row_no: int | None = None
    ocr_text: str | None = None
    detections: list[DetectionBox] = field(default_factory=list)
    ocr_results: list[OCRResult] = field(default_factory=list)
    worker_confirmed: bool = False
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
        )


class SessionManager:
    def __init__(self) -> None:
        self._lock = Lock()
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
        session = RuntimeSession(
            session_id=session_row["session_id"],
            operator_id=session_row["operator_id"],
            qr_text=session_row["qr_text"],
            order_no=session_row["order_no"],
            serial_no=session_row["serial_no"],
            terminal_name=session_row["terminal_name"],
            rows=rows,
            status=SessionStatus(session_row["status"]),
            frame_index=session_row["frame_index"],
            stability_count=session_row["stability_count"],
            worker_confirmed=bool(session_row["worker_confirmed"]),
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
    ) -> FrameAnalyzeResponse:
        with self._lock:
            session = self._ensure_session(session_id)
            if session.operator_id != operator_id:
                raise PermissionError("operator mismatch")
            if session.status == SessionStatus.COMPLETED:
                return FrameAnalyzeResponse(**session.to_response().model_dump())

            session.frame_index = max(session.frame_index + 1, frame_index or 0)
            session.updated_at = now_iso()

            target_row = session.rows[(session.frame_index - 1) % len(session.rows)] if session.rows else None
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

            try:
                detection = pipeline.detect(frame_bytes, session.frame_index, confidence_threshold=yolo_confidence_threshold)
            except AIModelError as exc:
                session.last_error = str(exc)
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
                    signature=f"demo:{session.frame_index}",
                )
                logger.info(
                    "frame-analyze inserted demo detection session_id=%s frame_index=%s reason=%s",
                    session.session_id,
                    session.frame_index,
                    str(exc),
                )
            session.performance = detection.performance
            session.detections = detection.detections
            session.ocr_results = []
            logger.info(
                "frame-analyze detections session_id=%s frame_index=%s count=%s detections=%s",
                session.session_id,
                session.frame_index,
                len(session.detections),
                [det.model_dump() for det in session.detections],
            )
            try:
                det_ocr_perf = pipeline.ocr_detections(
                    frame_bytes,
                    session.detections,
                    ocr_confidence_threshold=ocr_confidence_threshold,
                )
                session.performance = PerformanceMetrics(
                    yolo_ms=session.performance.yolo_ms,
                    ocr_ms=det_ocr_perf.ocr_ms,
                    total_ms=session.performance.yolo_ms + det_ocr_perf.ocr_ms,
                )
                session.ocr_text = next((d.ocr_text for d in session.detections if d.ocr_text), None)
                session.ocr_results = [
                    OCRResult(
                        text=det.ocr_text.strip(),
                        confidence=det.confidence,
                        bbox=[det.x, det.y, det.width, det.height],
                        source="detection_ocr",
                    )
                    for det in session.detections
                    if det.ocr_text and det.ocr_text.strip()
                ]
                logger.debug(
                    "frame-analyze detection OCR session_id=%s frame_index=%s ocr_results=%s",
                    session.session_id,
                    session.frame_index,
                    [result.model_dump() for result in session.ocr_results],
                )
            except AIModelError as exc:
                session.last_error = str(exc)
                session.performance = PerformanceMetrics(
                    yolo_ms=session.performance.yolo_ms,
                    ocr_ms=0,
                    total_ms=session.performance.yolo_ms,
                )
                session.ocr_text = None

            logger.debug("CALL pipeline.ocr_results from session_manager")
            ocr_results_result = pipeline.ocr_results(
                frame_bytes,
                session.detections,
                row_template,
                session.frame_index,
                ocr_confidence_threshold=ocr_confidence_threshold,
            )
            if ocr_results_result.ocr_results:
                session.ocr_results = ocr_results_result.ocr_results
                session.ocr_text = session.ocr_results[0].text
                session.performance = PerformanceMetrics(
                    yolo_ms=session.performance.yolo_ms,
                    ocr_ms=max(session.performance.ocr_ms, ocr_results_result.performance.ocr_ms),
                    total_ms=session.performance.yolo_ms + max(session.performance.ocr_ms, ocr_results_result.performance.ocr_ms),
                )
            logger.info(
                "frame-analyze OCR results source=%s session_id=%s frame_index=%s count=%s",
                ocr_results_result.source,
                session.session_id,
                session.frame_index,
                len(ocr_results_result.ocr_results),
            )
            logger.debug(
                "frame-analyze OCR results detail source=%s session_id=%s frame_index=%s ocr_results=%s",
                ocr_results_result.source,
                session.session_id,
                session.frame_index,
                [result.model_dump() for result in ocr_results_result.ocr_results],
            )

            stability = evaluate_ocr_stability(session.ocr_state, detection.signature, detection.detections)
            session.stability_count = session.ocr_state.stable_count
            session.should_ocr = stability.stable and target_row is not None
            session.target_row_no = target_row.no if target_row else None
            if not session.ocr_text:
                session.ocr_text = None

            if session.should_ocr and target_row and row_template:
                ocr_result = pipeline.ocr(frame_bytes, row_template, session.stability_count, session.frame_index)
                session.ocr_text = ocr_result.text
                logger.info(
                    "frame-analyze row OCR session_id=%s frame_index=%s target_row_no=%s text=%s confidence=%s bbox=%s success=%s reason=%s",
                    session.session_id,
                    session.frame_index,
                    target_row.no,
                    ocr_result.text,
                    ocr_result.confidence,
                    ocr_result.bbox,
                    ocr_result.success,
                    ocr_result.reason,
                )
                session.performance = PerformanceMetrics(
                    yolo_ms=session.performance.yolo_ms,
                    ocr_ms=ocr_result.performance.ocr_ms,
                    total_ms=session.performance.yolo_ms + ocr_result.performance.ocr_ms,
                )
                if ocr_result.success:
                    if ocr_result.text:
                        session.ocr_results.append(
                            OCRResult(
                                text=ocr_result.text,
                                confidence=ocr_result.confidence,
                                bbox=ocr_result.bbox,
                                source="row_ocr",
                            )
                        )
                    judgement = judge_row(row_template, ocr_result.text)
                    target_row.check_status = judgement.status
                    target_row.ocr_text = ocr_result.text
                    target_row.updated_at = now_iso()
                else:
                    target_row.check_status = CheckStatus.OCR_FAILED
                    target_row.ocr_text = None
                    target_row.updated_at = now_iso()

            persist_rows(session.session_id, [row.to_record() for row in session.rows])
            persist_session_snapshot(session.snapshot())
            logger.info(
                "frame-analyze response OCR session_id=%s frame_index=%s ocr_results_count=%s",
                session.session_id,
                session.frame_index,
                len(session.ocr_results),
            )
            logger.debug(
                "frame-analyze response OCR detail session_id=%s frame_index=%s ocr_results=%s",
                session.session_id,
                session.frame_index,
                [
                    {
                        "text": result.text,
                        "confidence": result.confidence,
                        "bbox": result.bbox,
                        "source": result.source,
                    }
                    for result in session.ocr_results
                ],
            )
            return FrameAnalyzeResponse(**session.to_response().model_dump())

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
            session.worker_confirmed = True
            session.status = SessionStatus.COMPLETED
            session.completion_status = SessionStatus.COMPLETED
            session.completed_at = now_iso()
            session.updated_at = now_iso()

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
