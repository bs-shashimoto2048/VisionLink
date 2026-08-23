export const CheckStatus = {
  OK: "OK",
  NG: "NG",
  PENDING: "PENDING",
  OCR_FAILED: "OCR_FAILED",
  MISMATCH: "MISMATCH",
  MANUAL_FIXED: "MANUAL_FIXED",
} as const;

export type CheckStatus = (typeof CheckStatus)[keyof typeof CheckStatus];

export const SessionStatus = {
  IN_PROGRESS: "IN_PROGRESS",
  PAUSED: "PAUSED",
  COMPLETED: "COMPLETED",
  ABORTED: "ABORTED",
} as const;

export type SessionStatus = (typeof SessionStatus)[keyof typeof SessionStatus];

export interface LoginResponse { employee_id: string; operator_id: string; access_token: string; display_name: string; }
export interface InternalDataRow { no: number; line_no: string; left_value: string; right_value: string; }
export interface InternalDataLookupResponse { source: string; order_no: string; serial_no: string; terminal_name: string; rows: InternalDataRow[]; }
export type CheckDataStatus = "PENDING" | "OK" | "NG";
export interface CheckRow { tube_l: string; label: string; tube_r: string; tube_l_status?: CheckDataStatus; label_status?: CheckDataStatus; tube_r_status?: CheckDataStatus; left_status?: CheckDataStatus; confirm_status?: CheckDataStatus; all_status?: CheckDataStatus; completed?: boolean; }
export interface CheckTableResponse { serial: string; board: string; terminal: string; rows: CheckRow[]; }
export interface DetectionBox { label: string; confidence: number; x: number; y: number; width: number; height: number; ocr_text?: string | null; role?: string | null; side?: string | null; }
export interface OCRResult {
  text: string;
  ocr_text?: string | null;
  value?: string | null;
  label?: string | null;
  confidence: number;
  bbox: [number, number, number, number];
  source?: string | null;
  rotated?: boolean;
  rotation_deg?: number;
  rotation_mode?: "none" | "left_tube" | "label" | null;
  side?: string | null;
  role?: string | null;
}
export interface PerformanceMetrics { yolo_ms: number; ocr_ms: number; total_ms: number; }
export interface ManualEditHistoryEntry { timestamp: string; operator_id: string; note?: string | null; final_status: CheckStatus; }
export interface InspectionRowState { no: number; line_no: string; left_value: string; right_value: string; check_status: CheckStatus; ocr_text?: string | null; manual_final_status?: CheckStatus | null; manual_edit_history: ManualEditHistoryEntry[]; updated_at: string; }
export interface SessionSummary { ok_count: number; ng_count: number; pending_count: number; worker_confirmed: boolean; completion_status: SessionStatus; completed_at?: string | null; }
export interface InspectionSessionResponse { session_id: string; operator_id: string; status: SessionStatus; order_no: string; serial_no: string; terminal_name: string; qr_text?: string | null; frame_index: number; stability_count: number; should_ocr: boolean; target_row_no?: number | null; ocr_text?: string | null; detections: DetectionBox[]; ocr_results: OCRResult[]; rows: InspectionRowState[]; summary?: SessionSummary | null; performance: PerformanceMetrics; }
export interface CameraInfo { deviceId: string; label: string; }
export interface CameraState { connected: boolean; running: boolean; permissionDenied: boolean; error?: string | null; errorCode?: string | null; errorDetail?: string | null; activeDeviceId?: string | null; devices: CameraInfo[]; }
