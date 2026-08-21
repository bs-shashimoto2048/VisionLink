import type {
  InspectionSessionResponse,
  InternalDataLookupResponse,
  LoginResponse,
  CheckStatus,
  CheckTableResponse,
} from "./types";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "";
const DEFAULT_TIMEOUT_MS = 15000;

class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) { super(message); this.name = "ApiError"; this.status = status; }
}
function buildUrl(path: string) { return `${API_BASE_URL}${path}`; }
async function requestJson<T>(path: string, init: RequestInit = {}, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
  const controller = new AbortController(); const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(buildUrl(path), { ...init, signal: controller.signal, headers: { ...(init.headers ?? {}) } });
    if (!response.ok) {
      const bodyText = await response.text(); let message = bodyText || response.statusText;
      try { const parsed = JSON.parse(bodyText) as { detail?: string }; if (parsed?.detail) message = parsed.detail; } catch { /* plain text */ }
      throw new ApiError(message, response.status);
    }
    return (await response.json()) as T;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw new ApiError("Request timed out", 408);
    if (error instanceof ApiError) throw error;
    throw new ApiError((error as Error).message || "Communication failed", 0);
  } finally { window.clearTimeout(timeout); }
}
export async function login(employeeId: string) { return requestJson<LoginResponse>("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ employee_id: employeeId }) }); }
export async function lookupInternalData(payload: { qrText?: string; orderNo?: string; serialNo?: string; terminalName?: string }) { return requestJson<InternalDataLookupResponse>("/api/internal-data/lookup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ qr_text: payload.qrText || null, order_no: payload.orderNo || null, serial_no: payload.serialNo || null, terminal_name: payload.terminalName || null }) }); }
export async function fetchCheckSerials() { return requestJson<{ serials: string[] }>("/api/check-data/serials"); }
export async function fetchCheckBoards(serial: string) { return requestJson<{ boards: string[] }>(`/api/check-data/boards?serial=${encodeURIComponent(serial)}`); }
export async function fetchCheckTerminals(serial: string, board: string) { return requestJson<{ terminals: string[] }>(`/api/check-data/terminals?serial=${encodeURIComponent(serial)}&board=${encodeURIComponent(board)}`); }
export async function fetchCheckTable(serial: string, board: string, terminal: string) { return requestJson<CheckTableResponse>(`/api/check-data/table?serial=${encodeURIComponent(serial)}&board=${encodeURIComponent(board)}&terminal=${encodeURIComponent(terminal)}`); }
export async function startInspection(payload: { operatorId: string; qrText?: string; orderNo?: string; serialNo?: string; terminalName?: string }) { return requestJson<InspectionSessionResponse>("/api/inspection/session/start", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ operator_id: payload.operatorId, qr_text: payload.qrText || null, order_no: payload.orderNo || null, serial_no: payload.serialNo || null, terminal_name: payload.terminalName || null }) }); }
export async function analyzeFrame(payload: { sessionId: string; operatorId: string; frameIndex: number; frame: Blob; yoloConfidenceThreshold?: number; ocrConfidenceThreshold?: number; rotateLeftTubeOcr?: boolean; rotateLabelOcr?: boolean }) {
  const formData = new FormData();
  formData.append("session_id", payload.sessionId); formData.append("operator_id", payload.operatorId); formData.append("frame_index", String(payload.frameIndex));
  formData.append("yolo_confidence_threshold", String(payload.yoloConfidenceThreshold ?? 0.25)); formData.append("ocr_confidence_threshold", String(payload.ocrConfidenceThreshold ?? 0.5));
  formData.append("rotate_left_tube_ocr", String(payload.rotateLeftTubeOcr ?? false));
  formData.append("rotate_label_ocr", String(payload.rotateLabelOcr ?? false));
  formData.append("frame", payload.frame, `frame-${payload.frameIndex}.jpg`);
  const response = await requestJson<InspectionSessionResponse>("/api/inspection/frame-analyze", { method: "POST", body: formData }, 20000);
  console.debug("[VisionLink] frame-analyze response", { frame_index: response.frame_index, detections_count: response.detections.length, ocr_results_count: response.ocr_results.length, ocr_results: response.ocr_results }); return response;
}
export async function updateRow(payload: { sessionId: string; lineNo: number; operatorId: string; finalStatus: CheckStatus; note?: string }) { return requestJson<InspectionSessionResponse>(`/api/inspection/session/${payload.sessionId}/rows/${payload.lineNo}/manual-edit`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ operator_id: payload.operatorId, final_status: payload.finalStatus, note: payload.note || null }) }); }
export async function completeInspection(payload: { sessionId: string; operatorId: string; workerConfirmed: boolean }) { return requestJson<InspectionSessionResponse>(`/api/inspection/session/${payload.sessionId}/complete`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ operator_id: payload.operatorId, worker_confirmed: payload.workerConfirmed }) }); }
export async function fetchSession(sessionId: string) { return requestJson<InspectionSessionResponse>(`/api/inspection/session/${sessionId}`); }
export async function pauseInspection(payload: { sessionId: string; employeeId: string }) { return requestJson<InspectionSessionResponse>(`/api/inspection/session/${payload.sessionId}/pause`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ employee_id: payload.employeeId }) }); }
export async function resumeInspection(payload: { sessionId: string; employeeId: string }) { return requestJson<InspectionSessionResponse>(`/api/inspection/session/${payload.sessionId}/resume`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ employee_id: payload.employeeId }) }); }
export async function abortInspection(payload: { sessionId: string; employeeId: string }) { return requestJson<InspectionSessionResponse>(`/api/inspection/session/${payload.sessionId}/abort`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ employee_id: payload.employeeId }) }); }
export { ApiError };