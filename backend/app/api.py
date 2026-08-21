from __future__ import annotations

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
import logging

from .schemas import (
    CheckDataBoardsResponse,
    CheckDataSerialsResponse,
    CheckDataTableResponse,
    CheckDataTerminalsResponse,
    CompleteRequest,
    FrameAnalyzeResponse,
    InternalDataLookupRequest,
    InternalDataLookupResponse,
    InspectionSessionResponse,
    LoginRequest,
    LoginResponse,
    ManualEditRequest,
    PerformanceMetrics,
    StartInspectionRequest,
)
from .services.check_data import CheckDataError, list_boards, list_serials, list_terminals, load_table
from .services.internal_data import lookup_internal_data
from .services.ai_pipeline import AIModelError
from .services.label_ocr import run_rotated_label_ocr
from .services.session_manager import manager

router = APIRouter(prefix="/api")
logger = logging.getLogger(__name__)


@router.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@router.post("/auth/login", response_model=LoginResponse)
def login(request: LoginRequest) -> LoginResponse:
    employee_id = request.employee_id
    return LoginResponse(
        employee_id=employee_id,
        operator_id=employee_id,
        access_token=f"mock-token-{employee_id}",
        display_name=f"Operator {employee_id}",
    )


@router.post("/internal-data/lookup", response_model=InternalDataLookupResponse)
def internal_data_lookup(request: InternalDataLookupRequest) -> InternalDataLookupResponse:
    return lookup_internal_data(request).to_response()


@router.get("/check-data/serials", response_model=CheckDataSerialsResponse)
def check_data_serials() -> CheckDataSerialsResponse:
    try:
        return CheckDataSerialsResponse(serials=list_serials())
    except OSError as exc:
        raise HTTPException(status_code=503, detail=f"check data root is not accessible: {exc}") from exc


@router.get("/check-data/boards", response_model=CheckDataBoardsResponse)
def check_data_boards(serial: str) -> CheckDataBoardsResponse:
    try:
        return CheckDataBoardsResponse(boards=list_boards(serial))
    except CheckDataError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except OSError as exc:
        raise HTTPException(status_code=503, detail=f"check data path is not accessible: {exc}") from exc


@router.get("/check-data/terminals", response_model=CheckDataTerminalsResponse)
def check_data_terminals(serial: str, board: str) -> CheckDataTerminalsResponse:
    try:
        return CheckDataTerminalsResponse(terminals=list_terminals(serial, board))
    except CheckDataError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except OSError as exc:
        raise HTTPException(status_code=503, detail=f"check data path is not accessible: {exc}") from exc


@router.get("/check-data/table", response_model=CheckDataTableResponse)
def check_data_table(serial: str, board: str, terminal: str) -> CheckDataTableResponse:
    try:
        return load_table(serial, board, terminal)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="CSVが見つかりません") from exc
    except CheckDataError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except OSError as exc:
        raise HTTPException(status_code=503, detail=f"共有サーバーにアクセスできません: {exc}") from exc


@router.post("/inspection/session/start", response_model=InspectionSessionResponse)
def start_inspection(request: StartInspectionRequest) -> InspectionSessionResponse:
    return manager.start_session(request)


@router.get("/inspection/session/{session_id}", response_model=InspectionSessionResponse)
def get_session(session_id: str) -> InspectionSessionResponse:
    try:
        return manager.get_session(session_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="session not found") from exc


@router.post("/inspection/frame-analyze", response_model=FrameAnalyzeResponse)
async def frame_analyze(
    session_id: str = Form(...),
    operator_id: str = Form(...),
    frame_index: int = Form(0),
    yolo_confidence_threshold: float = Form(0.6),
    ocr_confidence_threshold: float = Form(0.6),
    rotate_left_tube_ocr: bool = Form(False),
    rotate_label_ocr: bool = Form(False),
    frame: UploadFile = File(...),
) -> FrameAnalyzeResponse:
    try:
        frame_bytes = await frame.read()
        response = manager.process_frame(
            session_id=session_id,
            operator_id=operator_id,
            frame_bytes=frame_bytes,
            frame_index=frame_index,
            yolo_confidence_threshold=yolo_confidence_threshold,
            ocr_confidence_threshold=ocr_confidence_threshold,
            rotate_left_tube_ocr=rotate_left_tube_ocr,
        )
        if rotate_label_ocr:
            label_results, label_ocr_ms = run_rotated_label_ocr(
                frame_bytes,
                response.detections,
                ocr_confidence_threshold,
            )
            if label_results:
                # Rotated label OCR is authoritative for nmb/label detections. Preserve tube results.
                label_boxes = {tuple(result.bbox) for result in label_results}
                response.ocr_results = [
                    result
                    for result in response.ocr_results
                    if not (result.role == "label" or tuple(result.bbox) in label_boxes)
                ] + label_results
                response.ocr_text = label_results[0].text
            response.performance = PerformanceMetrics(
                yolo_ms=response.performance.yolo_ms,
                ocr_ms=response.performance.ocr_ms + label_ocr_ms,
                total_ms=response.performance.total_ms + label_ocr_ms,
            )
        return response
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="session not found") from exc
    except AIModelError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except Exception as exc:  # pragma: no cover - runtime safety
        logger.exception("frame-analyze failed")
        raise HTTPException(status_code=500, detail=f"frame analysis failed: {exc}") from exc


@router.post("/inspection/session/{session_id}/rows/{line_no}/manual-edit", response_model=InspectionSessionResponse)
def manual_edit(
    session_id: str,
    line_no: int,
    request: ManualEditRequest,
) -> InspectionSessionResponse:
    try:
        return manager.manual_edit_row(session_id, line_no, request)
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.post("/inspection/session/{session_id}/complete", response_model=InspectionSessionResponse)
def complete(
    session_id: str,
    request: CompleteRequest,
) -> InspectionSessionResponse:
    try:
        return manager.complete_session(session_id, request)
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.post("/inspection/session/{session_id}/pause", response_model=InspectionSessionResponse)
def pause_session(session_id: str, request: LoginRequest) -> InspectionSessionResponse:
    try:
        return manager.pause_session(session_id, request.employee_id)
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.post("/inspection/session/{session_id}/resume", response_model=InspectionSessionResponse)
def resume_session(session_id: str, request: LoginRequest) -> InspectionSessionResponse:
    try:
        return manager.resume_session(session_id, request.employee_id)
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.post("/inspection/session/{session_id}/abort", response_model=InspectionSessionResponse)
def abort_session(session_id: str, request: LoginRequest) -> InspectionSessionResponse:
    try:
        return manager.abort_session(session_id, request.employee_id)
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
