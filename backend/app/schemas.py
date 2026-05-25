from __future__ import annotations

from enum import Enum

from pydantic import BaseModel, Field, field_validator


class CheckStatus(str, Enum):
    OK = "OK"
    NG = "NG"
    PENDING = "PENDING"
    OCR_FAILED = "OCR_FAILED"
    MISMATCH = "MISMATCH"
    MANUAL_FIXED = "MANUAL_FIXED"


class SessionStatus(str, Enum):
    IN_PROGRESS = "IN_PROGRESS"
    PAUSED = "PAUSED"
    COMPLETED = "COMPLETED"
    ABORTED = "ABORTED"


class LoginRequest(BaseModel):
    employee_id: str

    @field_validator("employee_id")
    @classmethod
    def validate_employee_id(cls, value: str) -> str:
        if len(value) != 4 or not value.isdigit():
            raise ValueError("employee_id must be a 4-digit string")
        return value


class LoginResponse(BaseModel):
    employee_id: str
    operator_id: str
    access_token: str
    display_name: str


class InternalDataLookupRequest(BaseModel):
    qr_text: str | None = None
    order_no: str | None = None
    serial_no: str | None = None
    terminal_name: str | None = None


class InspectionRowTemplate(BaseModel):
    no: int
    line_no: str
    left_value: str
    right_value: str


class InternalDataLookupResponse(BaseModel):
    source: str
    order_no: str
    serial_no: str
    terminal_name: str
    rows: list[InspectionRowTemplate] = Field(default_factory=list)


class CheckDataSerialsResponse(BaseModel):
    serials: list[str] = Field(default_factory=list)


class CheckDataBoardsResponse(BaseModel):
    boards: list[str] = Field(default_factory=list)


class CheckDataTerminalsResponse(BaseModel):
    terminals: list[str] = Field(default_factory=list)


class CheckDataRow(BaseModel):
    tube_l: str
    label: str
    tube_r: str
    left_status: str = "PENDING"
    confirm_status: str = "PENDING"
    all_status: str = "PENDING"


class CheckDataTableResponse(BaseModel):
    serial: str
    board: str
    terminal: str
    rows: list[CheckDataRow] = Field(default_factory=list)


class StartInspectionRequest(InternalDataLookupRequest):
    operator_id: str


class ManualEditRequest(BaseModel):
    operator_id: str
    final_status: CheckStatus
    note: str | None = None


class CompleteRequest(BaseModel):
    operator_id: str
    worker_confirmed: bool = False


class DetectionBox(BaseModel):
    label: str
    confidence: float
    x: float
    y: float
    width: float
    height: float
    ocr_text: str | None = None


class OCRResult(BaseModel):
    text: str
    confidence: float
    bbox: list[float]
    source: str | None = None


class PerformanceMetrics(BaseModel):
    yolo_ms: int = 0
    ocr_ms: int = 0
    total_ms: int = 0


class ManualEditHistoryEntry(BaseModel):
    timestamp: str
    operator_id: str
    note: str | None = None
    final_status: CheckStatus


class InspectionRowState(BaseModel):
    no: int
    line_no: str
    left_value: str
    right_value: str
    check_status: CheckStatus
    ocr_text: str | None = None
    manual_final_status: CheckStatus | None = None
    manual_edit_history: list[ManualEditHistoryEntry] = Field(default_factory=list)
    updated_at: str


class SessionSummary(BaseModel):
    ok_count: int
    ng_count: int
    pending_count: int
    worker_confirmed: bool
    completion_status: SessionStatus
    completed_at: str | None = None


class InspectionSessionResponse(BaseModel):
    session_id: str
    operator_id: str
    status: SessionStatus
    order_no: str
    serial_no: str
    terminal_name: str
    qr_text: str | None = None
    frame_index: int = 0
    stability_count: int = 0
    should_ocr: bool = False
    target_row_no: int | None = None
    ocr_text: str | None = None
    detections: list[DetectionBox] = Field(default_factory=list)
    ocr_results: list[OCRResult] = Field(default_factory=list)
    rows: list[InspectionRowState] = Field(default_factory=list)
    summary: SessionSummary | None = None
    performance: PerformanceMetrics = Field(default_factory=PerformanceMetrics)


class FrameAnalyzeResponse(InspectionSessionResponse):
    pass
