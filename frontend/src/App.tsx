import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ApiError,
  abortInspection,
  analyzeFrame,
  completeInspection,
  fetchCheckBoards,
  fetchCheckSerials,
  fetchCheckTable,
  fetchCheckTerminals,
  fetchSession,
  login,
  lookupInternalData,
  pauseInspection,
  resumeInspection,
  startInspection,
} from "./api";
import { useCamera, useFrameSampler } from "./camera";
import { CheckStatus, SessionStatus } from "./types";
import type { CheckRow, CheckTableResponse, InspectionSessionResponse, InternalDataLookupResponse, LoginResponse, OCRResult } from "./types";
import { reconcileCheckRows } from "./checkReconcile";

const OVERLAY_MODES = {
  inference_result: "表示: 推論結果",
  ocr_result: "表示: OCR結果",
  raw: "表示: 取得値そのまま",
  series_conf: "表示: シリーズ+確信度",
} as const;

const TEXT = {
  appTitle: "VisionLink",
  headline: "検査",
  description: "カメラ起動後、検査開始で推論・描画が有効になります。",
  loginTitle: "ログイン",
  checkComplete: "完了",
  workerConfirmed: "作業者確認",
};

const DEFAULT_INTAKE = { qrText: "DEMO-0001", orderNo: "", serialNo: "", terminalName: "" };
const SHOW_SESSION_TOOLS = false;
const SHOW_STATUS_PANELS = false;

function rowKey(row: CheckRow, index: number) {
  return `${row.tube_l}-${row.label}-${row.tube_r}-${index}`;
}

function isRowCompleted(row: CheckRow) {
  return Boolean(row.completed) || row.all_status === "OK";
}

function sessionStatusLabel(status?: string) {
  switch (status) {
    case SessionStatus.IN_PROGRESS:
      return "検査中";
    case SessionStatus.PAUSED:
      return "一時停止";
    case SessionStatus.COMPLETED:
      return "完了";
    case SessionStatus.ABORTED:
      return "中止";
    default:
      return "待機中";
  }
}

function statusTone(status: string) {
  if (status === CheckStatus.OK || status === SessionStatus.IN_PROGRESS) return "tone-ok";
  if (status === CheckStatus.NG || status === CheckStatus.MISMATCH) return "tone-ng";
  if (status === SessionStatus.COMPLETED) return "tone-done";
  if (status === CheckStatus.OCR_FAILED || status === CheckStatus.PENDING) return "tone-warn";
  if (status === CheckStatus.MANUAL_FIXED) return "tone-manual";
  return "tone-neutral";
}

function App() {
  const { videoRef, startCamera, stopCamera, reconnectCamera, switchCamera, cameraState } = useCamera();
  const [operator, setOperator] = useState<LoginResponse | null>(() => {
    const saved = window.localStorage.getItem("visionlink-operator");
    return saved ? (JSON.parse(saved) as LoginResponse) : null;
  });
  const [loginForm, setLoginForm] = useState({ employeeId: "" });
  const [inspection, setInspection] = useState<InspectionSessionResponse | null>(null);
  const [lastFrameAnalysis, setLastFrameAnalysis] = useState<InspectionSessionResponse | null>(null);
  const [intake, setIntake] = useState(DEFAULT_INTAKE);
  const [lookupPreview, setLookupPreview] = useState<InternalDataLookupResponse | null>(null);
  const [workerConfirmed, setWorkerConfirmed] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [overlayMode, setOverlayMode] = useState<keyof typeof OVERLAY_MODES>("inference_result");
  const [yoloThreshold, setYoloThreshold] = useState(0.6);
  const [ocrThreshold, setOcrThreshold] = useState(0.6);
  const [rotateLeftTubeOcr, setRotateLeftTubeOcr] = useState(false);
  const [rotateLabelOcr, setRotateLabelOcr] = useState(false);
  const [displayFps, setDisplayFps] = useState(30);
  const [analysisFps, setAnalysisFps] = useState(2);
  const [serials, setSerials] = useState<string[]>([]);
  const [boards, setBoards] = useState<string[]>([]);
  const [terminals, setTerminals] = useState<string[]>([]);
  const [selectedSerial, setSelectedSerial] = useState("");
  const [selectedBoard, setSelectedBoard] = useState("");
  const [selectedTerminal, setSelectedTerminal] = useState("");
  const [checkTable, setCheckTable] = useState<CheckTableResponse | null>(null);
  const [checkRows, setCheckRows] = useState<CheckRow[]>([]);
  const [checkDataLoading, setCheckDataLoading] = useState<string | null>(null);
  const [checkDataError, setCheckDataError] = useState<string | null>(null);
  const pendingLookup = useRef(false);
  const guideX = 0.5;

  const bannerTimer = useRef<number | null>(null);
  const showBanner = (text: string, opts?: { error?: boolean }) => {
    setBanner(text);
    if (bannerTimer.current) window.clearTimeout(bannerTimer.current);
    bannerTimer.current = window.setTimeout(() => setBanner(null), opts?.error ? 5000 : 2000);
  };
  const dismissBanner = () => {
    if (bannerTimer.current) window.clearTimeout(bannerTimer.current);
    setBanner(null);
  };
  useEffect(() => () => {
    if (bannerTimer.current) window.clearTimeout(bannerTimer.current);
  }, []);

  useEffect(() => {
    const syncOnline = () => setIsOnline(navigator.onLine);
    window.addEventListener("online", syncOnline);
    window.addEventListener("offline", syncOnline);
    return () => {
      window.removeEventListener("online", syncOnline);
      window.removeEventListener("offline", syncOnline);
    };
  }, []);

  useEffect(() => {
    if (operator && !inspection) void refreshActiveSession();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [operator]);

  useEffect(() => {
    setCheckDataLoading("製番を読み込み中...");
    setCheckDataError(null);
    fetchCheckSerials()
      .then((response) => setSerials(response.serials))
      .catch((error) => setCheckDataError(error instanceof Error ? error.message : "共有サーバーにアクセスできません"))
      .finally(() => setCheckDataLoading(null));
  }, []);

  useEffect(() => {
    setBoards([]);
    setTerminals([]);
    setSelectedBoard("");
    setSelectedTerminal("");
    setCheckTable(null);
    setCheckRows([]);
    setInspection(null);
    setLastFrameAnalysis(null);
    setWorkerConfirmed(false);
    if (!selectedSerial) return;
    setCheckDataLoading("盤番号を読み込み中...");
    setCheckDataError(null);
    fetchCheckBoards(selectedSerial)
      .then((response) => setBoards(response.boards))
      .catch((error) => setCheckDataError(error instanceof Error ? error.message : "盤番号を読み込めません"))
      .finally(() => setCheckDataLoading(null));
  }, [selectedSerial]);

  useEffect(() => {
    setTerminals([]);
    setSelectedTerminal("");
    setCheckTable(null);
    setCheckRows([]);
    setInspection(null);
    setLastFrameAnalysis(null);
    setWorkerConfirmed(false);
    if (!selectedSerial || !selectedBoard) return;
    setCheckDataLoading("端子台を読み込み中...");
    setCheckDataError(null);
    fetchCheckTerminals(selectedSerial, selectedBoard)
      .then((response) => setTerminals(response.terminals))
      .catch((error) => setCheckDataError(error instanceof Error ? error.message : "端子台を読み込めません"))
      .finally(() => setCheckDataLoading(null));
  }, [selectedSerial, selectedBoard]);

  useEffect(() => {
    if (!selectedSerial || !selectedBoard || !selectedTerminal) return;
    setCheckTable(null);
    setInspection(null);
    setLastFrameAnalysis(null);
    setWorkerConfirmed(false);
    setCheckDataLoading("CSVを読み込み中...");
    setCheckDataError(null);
    fetchCheckTable(selectedSerial, selectedBoard, selectedTerminal)
      .then((response) => {
        setCheckTable(response);
        setCheckRows(response.rows.map((row) => ({ ...row })));
      })
      .catch((error) => setCheckDataError(error instanceof Error ? error.message : "CSVを読み込めません"))
      .finally(() => setCheckDataLoading(null));
  }, [selectedSerial, selectedBoard, selectedTerminal]);

  useFrameSampler({
    videoRef,
    enabled: Boolean(operator && inspection?.status === SessionStatus.IN_PROGRESS && cameraState.running),
    fps: analysisFps,
    onFrame: async (frame, frameIndex) => {
      if (!operator || !inspection) return;
      try {
        const response = await analyzeFrame({
          sessionId: inspection.session_id,
          operatorId: operator.operator_id,
          frameIndex,
          frame,
          yoloConfidenceThreshold: yoloThreshold,
          ocrConfidenceThreshold: ocrThreshold,
          rotateLeftTubeOcr,
          rotateLabelOcr,
        });
        console.debug("[VisionLink] frame analyze for reconcile", {
          frameIndex: response.frame_index,
          yoloCount: response.detections?.length ?? 0,
          ocrCount: response.ocr_results?.length ?? 0,
          ocrResults: response.ocr_results?.map((result) => ({
            text: result.text,
            label: result.label,
            bbox: result.bbox,
            role: result.role,
            source: result.source,
            rotated: result.rotated,
            rotation_deg: result.rotation_deg,
            rotation_mode: result.rotation_mode,
          })),
        });
        setLastFrameAnalysis(response);
        setInspection(response);
      } catch (error) {
        if (error instanceof ApiError && error.status === 503) {
          showBanner(`AI unavailable: ${error.message}`, { error: true });
        } else {
          showBanner(error instanceof Error ? error.message : "Frame upload failed", { error: true });
        }
      }
    },
  });

  const statusLabel = inspection?.status ?? (operator ? "待機中" : "未ログイン");
  const inspectionRunning = inspection?.status === SessionStatus.IN_PROGRESS;
  const isInspectionActive = inspectionRunning || inspection?.status === SessionStatus.PAUSED || inspection?.status === SessionStatus.COMPLETED;
  const overlayOcrResults = useMemo(() => {
    const latest = lastFrameAnalysis?.ocr_results ?? [];
    return latest.length > 0 ? latest : (inspection?.ocr_results ?? []);
  }, [inspection?.ocr_results, lastFrameAnalysis?.ocr_results]);
  const isCheckTableReady = Boolean(selectedSerial) && Boolean(selectedBoard) && Boolean(selectedTerminal) && (checkTable?.rows?.length ?? 0) > 0;
  const reconcileFrameIndex = lastFrameAnalysis?.frame_index ?? inspection?.frame_index ?? 0;

  useEffect(() => {
    setCheckRows((prevRows) => {
      if (!isCheckTableReady || !isInspectionActive || prevRows.length === 0) return prevRows;
      return reconcileCheckRows({
        rows: prevRows,
        yoloResults: lastFrameAnalysis?.detections ?? inspection?.detections ?? [],
        ocrResults: overlayOcrResults,
        guideX,
        frameIndex: reconcileFrameIndex,
      });
    });
  }, [checkRows.length, isCheckTableReady, isInspectionActive, lastFrameAnalysis?.detections, inspection?.detections, overlayOcrResults, guideX, reconcileFrameIndex]);

  const allRowsCompleted = checkRows.length > 0 && checkRows.every(isRowCompleted);
  const totalCount = checkRows.length;
  const completedCount = checkRows.filter(isRowCompleted).length;
  const prevCompletedRef = useRef<Set<string>>(new Set());
  const [highlightKey, setHighlightKey] = useState<string | null>(null);

  useEffect(() => {
    const prev = prevCompletedRef.current;
    const next = new Set<string>();
    let newlyCompleted: string | null = null;
    checkRows.forEach((row, index) => {
      const key = rowKey(row, index);
      if (isRowCompleted(row)) {
        next.add(key);
        if (!prev.has(key)) newlyCompleted = key;
      }
    });
    prevCompletedRef.current = next;
    if (newlyCompleted) setHighlightKey(newlyCompleted);
  }, [checkRows]);

  const focusKey = useMemo(() => {
    const index = checkRows.findIndex((row) => !isRowCompleted(row));
    if (index < 0) return null;
    return rowKey(checkRows[index], index);
  }, [checkRows]);

  async function refreshActiveSession() {
    const sessionId = window.localStorage.getItem("visionlink-session");
    if (!sessionId) return;
    try {
      const response = await fetchSession(sessionId);
      setInspection(response);
      setLastFrameAnalysis(null);
      setWorkerConfirmed(Boolean(response.summary?.worker_confirmed));
    } catch {
      window.localStorage.removeItem("visionlink-session");
    }
  }

  async function handleLogin() {
    const response = await login(loginForm.employeeId);
    setOperator(response);
    window.localStorage.setItem("visionlink-operator", JSON.stringify(response));
    showBanner("ログインしました");
  }

  async function handleStartInspection() {
    if (!operator) return;
    const response = await startInspection({
      operatorId: operator.operator_id,
      qrText: intake.qrText || undefined,
      orderNo: intake.orderNo || undefined,
      serialNo: intake.serialNo || undefined,
      terminalName: intake.terminalName || undefined,
    });
    setInspection(response);
    setLastFrameAnalysis(null);
    setWorkerConfirmed(false);
    window.localStorage.setItem("visionlink-session", response.session_id);
  }

  async function handleStopInspection() {
    if (!operator || !inspection) return;
    const response = await pauseInspection({ sessionId: inspection.session_id, employeeId: operator.operator_id });
    setInspection(response);
    showBanner("検査を停止しました");
  }

  async function handleLookup() {
    if (pendingLookup.current) return;
    pendingLookup.current = true;
    try {
      const response = await lookupInternalData({
        qrText: intake.qrText || undefined,
        orderNo: intake.orderNo || undefined,
        serialNo: intake.serialNo || undefined,
        terminalName: intake.terminalName || undefined,
      });
      setLookupPreview(response);
    } finally {
      pendingLookup.current = false;
    }
  }

  async function handleComplete() {
    if (!operator || !inspection) return;
    if (!workerConfirmed) {
      showBanner("完了前に作業者確認が必要です", { error: true });
      return;
    }
    const response = await completeInspection({
      sessionId: inspection.session_id,
      operatorId: operator.operator_id,
      workerConfirmed,
    });
    setInspection(response);
    stopCamera();
    window.localStorage.removeItem("visionlink-session");
    showBanner("検査を完了しました");
  }

  function handleLogout() {
    setOperator(null);
    setInspection(null);
    setLastFrameAnalysis(null);
    setLookupPreview(null);
    setWorkerConfirmed(false);
    stopCamera();
    window.localStorage.removeItem("visionlink-operator");
    window.localStorage.removeItem("visionlink-session");
  }

  return (
    <div className="app-shell">
      {banner ? (
        <div className="banner">
          <span className="banner-text">{banner}</span>
          <button type="button" className="banner-close" aria-label="閉じる" onClick={dismissBanner}>×</button>
        </div>
      ) : null}

      {!operator ? (
        <section className="card">
          <h2>{TEXT.loginTitle}</h2>
          <div className="form-grid compact">
            <label>
              社員番号
              <input value={loginForm.employeeId} maxLength={4} onChange={(event) => setLoginForm({ employeeId: event.target.value.replace(/\D/g, "") })} />
            </label>
          </div>
          <div className="button-row">
            <button className="primary" onClick={() => void handleLogin()} disabled={loginForm.employeeId.length !== 4}>ログイン</button>
          </div>
        </section>
      ) : (
        <>
          <section className="card">
            <div className="card-header">
              <h2 className="app-title">VisionLink</h2>
              <div className="button-row">
                <button onClick={() => setSettingsOpen((v) => !v)}>{settingsOpen ? "設定を閉じる" : "設定"}</button>
              </div>
            </div>

            <div className="camera-grid">
              <div className="video-panel">
                <div className="video-stage">
                  <video ref={videoRef} className="camera-video" playsInline muted autoPlay />
                  <div className="camera-center-guide" aria-hidden="true" />
                  <OverlayCanvas detections={inspection?.detections ?? []} ocrResults={overlayOcrResults} mode={overlayMode} />
                  <div className="video-badge">{cameraState.running ? "カメラ起動中" : "カメラ停止中"}</div>
                  <div className="video-badge video-badge-right">検出: {inspection?.detections.length ?? 0}</div>
                  <div className="camera-status-overlay">
                    {sessionStatusLabel(inspection?.status)} ・ 通信{isOnline ? "ON" : "OFF"} ・{" "}
                    {inspection ? `推論 ${inspection.performance.yolo_ms}ms / OCR ${inspection.performance.ocr_ms}ms` : "推論 —"}
                  </div>
                </div>

                <div className="camera-bottom-bar">
                  <button
                    className={`ocr-direction-button ocr-direction-l${rotateLeftTubeOcr ? " is-active" : ""}`}
                    title={rotateLeftTubeOcr ? "左側Tube 180度回転OCR: ON" : "左側Tube 180度回転OCR: OFF"}
                    aria-pressed={rotateLeftTubeOcr}
                    onClick={() => setRotateLeftTubeOcr((value) => !value)}
                  >L</button>
                  <button
                    className={`ocr-direction-button ocr-direction-label${rotateLabelOcr ? " is-active" : ""}`}
                    title={rotateLabelOcr ? "Label 90度左回転OCR: ON" : "Label 90度左回転OCR: OFF"}
                    aria-pressed={rotateLabelOcr}
                    onClick={() => setRotateLabelOcr((value) => !value)}
                  >Label</button>
                  <button
                    onClick={cameraState.running ? stopCamera : startCamera}
                    disabled={!isCheckTableReady && !cameraState.running}
                    title={!isCheckTableReady ? "検査テーブルを選択してから開始してください" : undefined}
                  >{cameraState.running ? "カメラ停止" : "カメラ開始"}</button>
                  <button
                    className={inspectionRunning ? "danger" : "primary"}
                    onClick={() => void (inspectionRunning ? handleStopInspection() : handleStartInspection())}
                    disabled={!isCheckTableReady && !inspectionRunning}
                    title={!isCheckTableReady ? "検査テーブルを選択してから開始してください" : undefined}
                  >{inspectionRunning ? "検査停止" : "検査開始"}</button>
                </div>
              </div>
            </div>

            {settingsOpen ? createPortal(
              <div className="settings-modal-backdrop" onClick={() => setSettingsOpen(false)}>
                <div className="settings-modal" onClick={(event) => event.stopPropagation()}>
                  <div className="settings-modal-header">
                    <h3>設定</h3>
                    <button onClick={() => setSettingsOpen(false)}>閉じる</button>
                  </div>
                  <div className="settings-fields">
                    <label className="settings-field">表示モード
                      <select aria-label="表示切替" value={overlayMode} onChange={(event) => setOverlayMode(event.target.value as keyof typeof OVERLAY_MODES)}>
                        {Object.entries(OVERLAY_MODES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                      </select>
                    </label>
                    <label className="settings-field">YOLO閾値
                      <input type="number" min={0.05} max={0.95} step={0.05} value={yoloThreshold} onChange={(event) => setYoloThreshold(Number(event.target.value))} />
                    </label>
                    <label className="settings-field">OCR閾値
                      <input type="number" min={0.05} max={0.95} step={0.05} value={ocrThreshold} onChange={(event) => setOcrThreshold(Number(event.target.value))} />
                    </label>
                    <label className="settings-field">表示FPS
                      <input type="number" min={1} max={120} step={1} value={displayFps} onChange={(event) => setDisplayFps(Number(event.target.value))} />
                    </label>
                    <label className="settings-field">識別FPS
                      <input type="number" min={1} max={5} step={1} value={analysisFps} onChange={(event) => setAnalysisFps(Number(event.target.value))} />
                    </label>
                  </div>
                  {SHOW_SESSION_TOOLS ? (
                    <>
                      <div className="button-row wrap">
                        <button onClick={() => void reconnectCamera()}>再接続</button>
                        <button onClick={() => void switchCamera()}>カメラ切替</button>
                        <button onClick={() => void handleLookup()}>内部データ参照</button>
                        <button onClick={handleLogout}>ログアウト</button>
                      </div>
                    </>
                  ) : null}
                </div>
              </div>, document.body
            ) : null}

            {lookupPreview ? <div className="lookup-preview"><span>{lookupPreview.source}</span><span>{lookupPreview.order_no}/{lookupPreview.serial_no}</span></div> : null}
          </section>

          <section className="card">
            <div className="card-header">
              <h2 className="section-title">検査テーブル</h2>
              {totalCount > 0 ? (allRowsCompleted ? <span className="inspect-progress is-done">検査完了</span> : <span className="inspect-progress">{completedCount} / {totalCount}</span>) : null}
              <div className="button-row">
                <button onClick={() => void refreshActiveSession()}>再読込</button>
                <button className="primary" onClick={() => void handleComplete()} disabled={!isCheckTableReady || !inspectionRunning || !allRowsCompleted || !workerConfirmed}>完了</button>
              </div>
            </div>

            <div className="check-data-selectors">
              <select value={selectedSerial} onChange={(event) => setSelectedSerial(event.target.value)}>
                <option value="">製番</option>{serials.map((serial) => <option key={serial} value={serial}>{serial}</option>)}
              </select>
              <select value={selectedBoard} onChange={(event) => setSelectedBoard(event.target.value)} disabled={!selectedSerial}>
                <option value="">盤番号</option>{boards.map((board) => <option key={board} value={board}>{board}</option>)}
              </select>
              <select value={selectedTerminal} onChange={(event) => setSelectedTerminal(event.target.value)} disabled={!selectedBoard}>
                <option value="">端子台</option>{terminals.map((terminal) => <option key={terminal} value={terminal}>{terminal}</option>)}
              </select>
            </div>

            {checkDataLoading ? <div className="check-data-message">{checkDataLoading}</div> : null}
            {checkDataError ? <div className="check-data-message error">{checkDataError}</div> : null}
            <CheckDataTable rows={checkRows} highlightKey={highlightKey} focusKey={focusKey} allCompleted={allRowsCompleted} />

            <div className="button-row wrap">
              <label className="checkbox">
                <input type="checkbox" checked={workerConfirmed} onChange={(event) => setWorkerConfirmed(event.target.checked)} disabled={!isCheckTableReady || !allRowsCompleted} />
                {TEXT.workerConfirmed}
              </label>
            </div>

            {SHOW_STATUS_PANELS ? <div className="summary-grid" /> : null}
          </section>
        </>
      )}

      {SHOW_STATUS_PANELS ? (
        <footer className="page-footer">
          <div className={`status-card ${statusTone(statusLabel)}`}><span className="status-label">状態</span><strong>{statusLabel}</strong></div>
          <p className="lead">{TEXT.description}</p>
        </footer>
      ) : null}
    </div>
  );
}

type OverlayBox = { x: number; y: number; width: number; height: number };
type RotationMode = "none" | "left_tube" | "label";

function getRotationMode(result?: OCRResult): RotationMode {
  if (result?.rotation_mode === "label" || result?.rotation_deg === -90) return "label";
  if (result?.rotation_mode === "left_tube" || result?.rotation_deg === 180) return "left_tube";
  return "none";
}

function OverlayCanvas({ detections, ocrResults, mode }: {
  detections: { label: string; confidence: number; x: number; y: number; width: number; height: number; ocr_text?: string | null }[];
  ocrResults: OCRResult[];
  mode: "series_conf" | "raw" | "ocr_result" | "inference_result";
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const draw = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const parent = canvas.parentElement;
      if (!parent) return;
      const rect = parent.getBoundingClientRect();
      const ratio = window.devicePixelRatio || 1;
      canvas.width = rect.width * ratio;
      canvas.height = rect.height * ratio;
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.clearRect(0, 0, rect.width, rect.height);

      const toCanvasBox = (box: OverlayBox) => {
        const isNormalized = Math.max(box.x, box.y, box.width, box.height) <= 1;
        const rawLeft = isNormalized ? box.x * rect.width : box.x;
        const rawTop = isNormalized ? box.y * rect.height : box.y;
        const rawWidth = isNormalized ? box.width * rect.width : box.width;
        const rawHeight = isNormalized ? box.height * rect.height : box.height;
        const left = Math.max(0, Math.min(rect.width - 2, rawLeft));
        const top = Math.max(0, Math.min(rect.height - 2, rawTop));
        const width = Math.max(2, Math.min(rect.width - left, rawWidth));
        const height = Math.max(2, Math.min(rect.height - top, rawHeight));
        return { left, top, width, height };
      };

      const toBoxInput = (bbox: [number, number, number, number]): OverlayBox => ({ x: bbox[0], y: bbox[1], width: bbox[2], height: bbox[3] });
      const getOcrText = (result?: OCRResult) => (result?.text ?? result?.ocr_text ?? result?.value ?? result?.label ?? "").trim();
      const colorFor = (rotationMode: RotationMode) => rotationMode === "label" ? "rgba(249, 115, 22, 0.9)" : rotationMode === "left_tube" ? "rgba(168, 85, 247, 0.9)" : "rgba(34, 211, 238, 0.9)";

      const isCenterInside = (inner: ReturnType<typeof toCanvasBox>, outer: ReturnType<typeof toCanvasBox>) => {
        const centerX = inner.left + inner.width / 2;
        const centerY = inner.top + inner.height / 2;
        return centerX >= outer.left && centerX <= outer.left + outer.width && centerY >= outer.top && centerY <= outer.top + outer.height;
      };

      const matchingResult = (box: OverlayBox, index: number) => {
        const sameOrder = ocrResults[index];
        if (sameOrder && Math.abs(detections.length - ocrResults.length) <= 1) return sameOrder;
        const canvasBox = toCanvasBox(box);
        return ocrResults.find((result) => isCenterInside(toCanvasBox(toBoxInput(result.bbox)), canvasBox));
      };

      const drawBox = (box: OverlayBox, label: string, rotationMode: RotationMode) => {
        const { left, top, width, height } = toCanvasBox(box);
        ctx.strokeStyle = colorFor(rotationMode);
        ctx.lineWidth = 1.25;
        ctx.strokeRect(left, top, width, height);
        const labelText = label.trim();
        if (!labelText) return;
        ctx.save();
        ctx.font = "bold 11px Segoe UI, sans-serif";
        ctx.textBaseline = "middle";
        ctx.shadowColor = "rgba(0, 0, 0, 0.8)";
        ctx.shadowBlur = 3;
        ctx.fillStyle = "rgba(255, 255, 255, 0.92)";
        ctx.fillText(labelText, left + 6, top + 11);
        ctx.restore();
      };

      const drawRotationArrow = (result: OCRResult, rotationMode: RotationMode) => {
        if (rotationMode === "none") return;
        const { left, top } = toCanvasBox(toBoxInput(result.bbox));
        const color = colorFor(rotationMode);
        const text = rotationMode === "label" ? "↶90°" : "↻180°";
        ctx.save();
        ctx.font = "bold 15px Segoe UI Symbol, Segoe UI, sans-serif";
        ctx.textBaseline = "bottom";
        ctx.fillStyle = color.replace("0.9", "0.72");
        ctx.shadowColor = "rgba(0, 0, 0, 0.55)";
        ctx.shadowBlur = 2;
        ctx.fillText(text, Math.max(2, left - 3), Math.max(16, top - 3));
        ctx.restore();
      };

      if (mode === "inference_result") {
        detections.forEach((box, index) => {
          const result = matchingResult(box, index);
          const text = box.ocr_text?.trim() || getOcrText(result);
          drawBox(box, text, getRotationMode(result));
        });
      } else if (mode === "ocr_result" && ocrResults.length > 0) {
        ocrResults.forEach((result) => drawBox(toBoxInput(result.bbox), getOcrText(result) || "OCR未取得", getRotationMode(result)));
      } else {
        detections.forEach((box, index) => {
          const result = matchingResult(box, index);
          const text = mode === "raw" ? (box.ocr_text?.trim() || getOcrText(result) || box.label) : `${box.label} ${Math.round(box.confidence * 100)}%`;
          drawBox(box, text, getRotationMode(result));
        });
      }

      const topByMode = (["left_tube", "label"] as RotationMode[])
        .map((rotationMode) => ocrResults
          .filter((result) => getRotationMode(result) === rotationMode)
          .sort((a, b) => a.bbox[1] - b.bbox[1])[0])
        .filter((result): result is OCRResult => Boolean(result));
      topByMode.forEach((result) => drawRotationArrow(result, getRotationMode(result)));
    };

    draw();
    window.addEventListener("resize", draw);
    return () => window.removeEventListener("resize", draw);
  }, [detections, ocrResults, mode]);

  return <canvas ref={canvasRef} className="overlay-canvas" />;
}

function allStatusLabel(status?: "PENDING" | "OK" | "NG") {
  if (status === "OK") return "OK";
  if (status === "NG") return "NG";
  return "";
}

function CheckDataTable({ rows, highlightKey, focusKey, allCompleted }: {
  rows: CheckRow[];
  highlightKey?: string | null;
  focusKey?: string | null;
  allCompleted?: boolean;
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const focusRowRef = useRef<HTMLTableRowElement | null>(null);
  const autoScrollingRef = useRef(false);
  const autoScrollClearTimer = useRef<number | null>(null);
  const idleTimer = useRef<number | null>(null);
  const [suspendAutoFollow, setSuspendAutoFollow] = useState(false);

  const scrollToFocus = () => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    if (!allCompleted && !focusRowRef.current) return;
    autoScrollingRef.current = true;
    if (allCompleted) wrap.scrollTo({ top: 0, behavior: "smooth" });
    else focusRowRef.current!.scrollIntoView({ block: "center", behavior: "smooth" });
    if (autoScrollClearTimer.current) window.clearTimeout(autoScrollClearTimer.current);
    autoScrollClearTimer.current = window.setTimeout(() => { autoScrollingRef.current = false; }, 600);
  };

  useEffect(() => {
    if (suspendAutoFollow) return;
    scrollToFocus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusKey, allCompleted, suspendAutoFollow]);

  const handleScroll = () => {
    if (autoScrollingRef.current) return;
    setSuspendAutoFollow(true);
    if (idleTimer.current) window.clearTimeout(idleTimer.current);
    idleTimer.current = window.setTimeout(() => setSuspendAutoFollow(false), 700);
  };

  useEffect(() => () => {
    if (idleTimer.current) window.clearTimeout(idleTimer.current);
    if (autoScrollClearTimer.current) window.clearTimeout(autoScrollClearTimer.current);
  }, []);

  return (
    <div className="check-table-wrap" ref={wrapRef} onScroll={handleScroll}>
      <table className="check-data-table">
        <thead><tr><th>L</th><th>Label</th><th>R</th><th>ALL</th></tr></thead>
        <tbody>
          {rows.map((row, index) => {
            const key = rowKey(row, index);
            const completed = isRowCompleted(row);
            const isHighlight = key === highlightKey;
            const isFocus = key === focusKey;
            return (
              <tr key={key} ref={isFocus ? focusRowRef : undefined} className={`${completed ? "check-row-completed" : ""}${isHighlight ? " check-row-flash" : ""}`}>
                <td className={row.tube_l_status === "OK" ? "check-cell-ok" : ""}>{row.tube_l}</td>
                <td className={`check-status-mark ${row.label_status === "OK" ? "check-cell-ok" : ""}`}>{row.label}</td>
                <td className={`check-status-mark ${row.tube_r_status === "OK" ? "check-cell-ok" : ""}`}>{row.tube_r}</td>
                <td className={`check-status-mark ${row.all_status === "OK" ? "check-cell-ok" : ""}`}>{allStatusLabel(row.all_status)}</td>
              </tr>
            );
          })}
          {!rows.length ? <tr><td colSpan={4} className="empty-state">チェックデータがありません</td></tr> : null}
        </tbody>
      </table>
    </div>
  );
}

export default App;
