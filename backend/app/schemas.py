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
    board_no: str


class ManualEditRequest(BaseModel):
    operator_id: str
    final_status: CheckStatus
    note: str | None = None


class ManualConfirmationRequest(BaseModel):
    operator_id: str
    row_index: int
    label: str
    confirmed: bool


class ManualConfirmationState(BaseModel):
    row_index: int
    label: str
    confirmed: bool
    confirmed_by: str | None = None
    confirmed_at: str | None = None
    updated_at: str


class CompletionMethod(str, Enum):
    AUTO = "AUTO"
    MANUAL = "MANUAL"


class CompletionRowResult(BaseModel):
    row_index: int
    label: str
    tube_l_expected: str
    tube_r_expected: str
    tube_l_status: str
    label_status: str
    tube_r_status: str
    completion_method: CompletionMethod
    manual_confirmed_by: str | None = None
    manual_confirmed_at: str | None = None
    final_status: str = "OK"


class CompleteRequest(BaseModel):
    operator_id: str
    worker_confirmed: bool = False
    rows: list[CompletionRowResult] = Field(default_factory=list)


class DetectionBox(BaseModel):
    label: str
    confidence: float
    x: float
    y: float
    width: float
    height: float
    ocr_text: str | None = None
    role: str | None = None
    side: str | None = None


class OCRResult(BaseModel):
    text: str
    confidence: float
    bbox: list[float]
    source: str | None = None
    rotated: bool = False
    rotation_deg: int = 0
    rotation_mode: str | None = None
    side: str | None = None
    role: str | None = None
    # YOLO クラス名（例: tube / nmb / label）。フロントの左右分類(isTubeDetection)が利用する。
    label: str | None = None


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
    board_no: str | None = None
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
    manual_confirmations: list[ManualConfirmationState] = Field(default_factory=list)


class InspectionHistoryRow(BaseModel):
    row_index: int
    label: str
    tube_l_expected: str
    tube_r_expected: str
    tube_l_status: str
    label_status: str
    tube_r_status: str
    completion_method: CompletionMethod
    manual_confirmed_by: str | None = None
    manual_confirmed_at: str | None = None
    final_status: str


class InspectionHistoryResponse(BaseModel):
    history_id: str
    session_id: str
    serial_no: str
    board_no: str
    terminal_name: str
    operator_id: str
    started_at: str
    completed_at: str
    final_status: str
    auto_count: int
    manual_count: int
    total_count: int
    rows: list[InspectionHistoryRow] = Field(default_factory=list)


class FrameAnalyzeResponse(InspectionSessionResponse):
    pass
