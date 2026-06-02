import { useEffect, useMemo, useRef, useState } from "react";
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

const OVERLAY_MODES = {
  series_conf: "表示: シリーズ+確信度",
  raw: "表示: 取得値そのまま",
  ocr_result: "表示: OCR結果",
  inference_result: "表示: 推論結果",
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
  const [overlayMode, setOverlayMode] = useState<keyof typeof OVERLAY_MODES>("series_conf");
  const [yoloThreshold, setYoloThreshold] = useState(0.25);
  const [ocrThreshold, setOcrThreshold] = useState(0.5);
  const [rotateLeftTubeOcr, setRotateLeftTubeOcr] = useState(false);
  const [displayFps, setDisplayFps] = useState(30);
  const [analysisFps, setAnalysisFps] = useState(2);
  const [serials, setSerials] = useState<string[]>([]);
  const [boards, setBoards] = useState<string[]>([]);
  const [terminals, setTerminals] = useState<string[]>([]);
  const [selectedSerial, setSelectedSerial] = useState("");
  const [selectedBoard, setSelectedBoard] = useState("");
  const [selectedTerminal, setSelectedTerminal] = useState("");
  const [checkTable, setCheckTable] = useState<CheckTableResponse | null>(null);
  const [checkDataLoading, setCheckDataLoading] = useState<string | null>(null);
  const [checkDataError, setCheckDataError] = useState<string | null>(null);
  const pendingLookup = useRef(false);

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
    if (operator && !inspection) {
      void refreshActiveSession();
    }
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
    setCheckDataLoading("CSVを読み込み中...");
    setCheckDataError(null);
    fetchCheckTable(selectedSerial, selectedBoard, selectedTerminal)
      .then(setCheckTable)
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
        });
        setLastFrameAnalysis(response);
        setInspection(response);
      } catch (error) {
        if (error instanceof ApiError && error.status === 503) {
          setBanner(`AI unavailable: ${error.message}`);
        } else {
          setBanner(error instanceof Error ? error.message : "Frame upload failed");
        }
      }
    },
  });

  const statusLabel = inspection?.status ?? (operator ? "待機中" : "未ログイン");
  const isInspecting = inspection?.status === SessionStatus.IN_PROGRESS;
  const overlayOcrResults = useMemo(() => {
    const latest = lastFrameAnalysis?.ocr_results ?? [];
    return latest.length > 0 ? latest : (inspection?.ocr_results ?? []);
  }, [inspection?.ocr_results, lastFrameAnalysis?.ocr_results]);

  useEffect(() => {
    if (overlayMode !== "ocr_result") return;
    console.debug("[VisionLink] OCR overlay state", {
      renderedCount: overlayOcrResults.length,
      inspectionOcrResults: inspection?.ocr_results ?? [],
      lastFrameOcrResults: lastFrameAnalysis?.ocr_results ?? [],
      renderedOcrResults: overlayOcrResults.map((result) => ({
        keys: Object.keys(result),
        text: result.text,
        ocr_text: result.ocr_text,
        value: result.value,
        label: result.label,
        confidence: result.confidence,
        bbox: result.bbox,
        source: result.source,
      })),
    });
  }, [inspection?.ocr_results, lastFrameAnalysis?.ocr_results, overlayMode, overlayOcrResults]);

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
    setBanner("ログインしました");
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
    setBanner(`セッション開始: ${response.session_id}`);
  }

  async function handleStopInspection() {
    if (!operator || !inspection) return;
    const response = await pauseInspection({ sessionId: inspection.session_id, employeeId: operator.operator_id });
    setInspection(response);
    setBanner("検査を停止しました");
  }

  async function handleResumeSession() {
    if (!operator || !inspection) return;
    const response = await resumeInspection({ sessionId: inspection.session_id, employeeId: operator.operator_id });
    setInspection(response);
    setBanner("検査を再開しました");
  }

  async function handleAbortInspection() {
    if (!operator || !inspection) return;
    const response = await abortInspection({ sessionId: inspection.session_id, employeeId: operator.operator_id });
    setInspection(response);
    stopCamera();
    window.localStorage.removeItem("visionlink-session");
    setBanner("検査を中止しました");
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
      setBanner("完了前に作業者確認が必要です");
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
    setBanner("検査を完了しました");
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
      <header className="hero">
        <div>
          <p className="eyebrow">{TEXT.appTitle}</p>
          <h1>{TEXT.headline}</h1>
        </div>
      </header>

      {banner ? <div className="banner">{banner}</div> : null}

      {!operator ? (
        <section className="card">
          <h2>{TEXT.loginTitle}</h2>
          <div className="form-grid compact">
            <label>
              社員番号
              <input
                value={loginForm.employeeId}
                maxLength={4}
                onChange={(event) => setLoginForm({ employeeId: event.target.value.replace(/\D/g, "") })}
              />
            </label>
          </div>
          <div className="button-row">
            <button className="primary" onClick={() => void handleLogin()} disabled={loginForm.employeeId.length !== 4}>
              ログイン
            </button>
          </div>
        </section>
      ) : (
        <>
          <section className="card">
            <div className="card-header">
              <h2>カメラ</h2>
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
                </div>

                <label className="overlay-mode-control">
                  表示切替
                  <select value={overlayMode} onChange={(event) => setOverlayMode(event.target.value as keyof typeof OVERLAY_MODES)}>
                    {Object.entries(OVERLAY_MODES).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>

                <div className="camera-inline-status">
                  S:{inspection?.status ?? "待機"} | N:{isOnline ? "ON" : "OFF"} | I:
                  {inspection ? `${inspection.performance.yolo_ms}/${inspection.performance.ocr_ms}ms` : "N/A"}
                </div>

                <div className="camera-control-strip">
                  <button
                    className={rotateLeftTubeOcr ? "toggle-active" : ""}
                    title={rotateLeftTubeOcr ? "左側Tubeの180度回転OCRを無効にする" : "左側Tubeの180度回転OCRを有効にする"}
                    aria-label={rotateLeftTubeOcr ? "Rotate OCR: ON" : "Rotate OCR: OFF"}
                    onClick={() => setRotateLeftTubeOcr((value) => !value)}
                  >
                    {rotateLeftTubeOcr ? "Rotate OCR: ON" : "Rotate OCR: OFF"}
                  </button>
                  <label>
                    YOLO閾値
                    <input type="number" min={0.05} max={0.95} step={0.05} value={yoloThreshold} onChange={(event) => setYoloThreshold(Number(event.target.value))} />
                  </label>
                  <label>
                    OCR閾値
                    <input type="number" min={0.05} max={0.95} step={0.05} value={ocrThreshold} onChange={(event) => setOcrThreshold(Number(event.target.value))} />
                  </label>
                  <label>
                    表示FPS
                    <input type="number" min={1} max={120} step={1} value={displayFps} onChange={(event) => setDisplayFps(Number(event.target.value))} />
                  </label>
                  <label>
                    識別FPS
                    <input type="number" min={1} max={5} step={1} value={analysisFps} onChange={(event) => setAnalysisFps(Number(event.target.value))} />
                  </label>
                  <button onClick={cameraState.running ? stopCamera : startCamera}>{cameraState.running ? "カメラ停止" : "カメラ開始"}</button>
                  <button className={isInspecting ? "danger" : "primary"} onClick={() => void (isInspecting ? handleStopInspection() : handleStartInspection())}>
                    {isInspecting ? "検査停止" : "検査開始"}
                  </button>
                </div>
              </div>

              <div className="info-panel">
                <div className="info-tile">
                  <span>表示FPS</span>
                  <strong>{displayFps}</strong>
                </div>
                <div className="info-tile">
                  <span>識別FPS</span>
                  <strong>{analysisFps}</strong>
                </div>
              </div>
            </div>

            {settingsOpen ? (
              <div className="settings-modal-backdrop" onClick={() => setSettingsOpen(false)}>
                <div className="settings-modal" onClick={(event) => event.stopPropagation()}>
                  <div className="button-row wrap">
                    <button onClick={() => void reconnectCamera()}>再接続</button>
                    <button onClick={() => void switchCamera()}>カメラ切替</button>
                    <button onClick={() => void handleLookup()}>内部データ参照</button>
                    <button onClick={handleLogout}>ログアウト</button>
                  </div>
                  <div className="form-grid intake-grid">
                    <label>
                      QR
                      <input value={intake.qrText} onChange={(event) => setIntake({ ...intake, qrText: event.target.value })} />
                    </label>
                    <label>
                      注文番号
                      <input value={intake.orderNo} onChange={(event) => setIntake({ ...intake, orderNo: event.target.value })} />
                    </label>
                    <label>
                      端末番号
                      <input value={intake.serialNo} onChange={(event) => setIntake({ ...intake, serialNo: event.target.value })} />
                    </label>
                    <label>
                      端末名
                      <input value={intake.terminalName} onChange={(event) => setIntake({ ...intake, terminalName: event.target.value })} />
                    </label>
                  </div>
                </div>
              </div>
            ) : null}

            {lookupPreview ? (
              <div className="lookup-preview">
                <span>{lookupPreview.source}</span>
                <span>
                  {lookupPreview.order_no}/{lookupPreview.serial_no}
                </span>
              </div>
            ) : null}
          </section>

          <section className="card">
            <div className="card-header">
              <h2>検査テーブル</h2>
              <div className="button-row">
                <button onClick={() => void refreshActiveSession()}>再読込</button>
                <button className="primary" onClick={() => void handleComplete()} disabled={!inspection || inspection.status === SessionStatus.COMPLETED}>
                  {TEXT.checkComplete}
                </button>
              </div>
            </div>

            <div className="check-data-selectors">
              <select value={selectedSerial} onChange={(event) => setSelectedSerial(event.target.value)}>
                <option value="">製番</option>
                {serials.map((serial) => (
                  <option key={serial} value={serial}>
                    {serial}
                  </option>
                ))}
              </select>
              <select value={selectedBoard} onChange={(event) => setSelectedBoard(event.target.value)} disabled={!selectedSerial}>
                <option value="">盤番号</option>
                {boards.map((board) => (
                  <option key={board} value={board}>
                    {board}
                  </option>
                ))}
              </select>
              <select value={selectedTerminal} onChange={(event) => setSelectedTerminal(event.target.value)} disabled={!selectedBoard}>
                <option value="">端子台</option>
                {terminals.map((terminal) => (
                  <option key={terminal} value={terminal}>
                    {terminal}
                  </option>
                ))}
              </select>
            </div>

            {checkDataLoading ? <div className="check-data-message">{checkDataLoading}</div> : null}
            {checkDataError ? <div className="check-data-message error">{checkDataError}</div> : null}
            <CheckDataTable rows={checkTable?.rows ?? []} />

            <div className="button-row wrap">
              <label className="checkbox">
                <input type="checkbox" checked={workerConfirmed} onChange={(event) => setWorkerConfirmed(event.target.checked)} />
                {TEXT.workerConfirmed}
              </label>
            </div>

            <div className="summary-grid">
              <div className="summary-box">
                <span>OK</span>
                <strong>{inspection?.summary?.ok_count ?? 0}</strong>
              </div>
              <div className="summary-box">
                <span>NG</span>
                <strong>{inspection?.summary?.ng_count ?? 0}</strong>
              </div>
              <div className="summary-box">
                <span>Pending</span>
                <strong>{inspection?.summary?.pending_count ?? 0}</strong>
              </div>
            </div>
          </section>
        </>
      )}

      <footer className="page-footer">
        <div className={`status-card ${statusTone(statusLabel)}`}>
          <span className="status-label">状態</span>
          <strong>{statusLabel}</strong>
          <span className="status-meta">{operator ? `${operator.display_name} / ${operator.operator_id}` : "社員番号4桁を入力"}</span>
        </div>
        <p className="lead">{TEXT.description}</p>
      </footer>
    </div>
  );
}

function OverlayCanvas({
  detections,
  ocrResults,
  mode,
}: {
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

      const toCanvasBox = (box: { x: number; y: number; width: number; height: number }) => {
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

      const toBoxInput = (bbox: [number, number, number, number]) => ({
        x: bbox[0],
        y: bbox[1],
        width: bbox[2],
        height: bbox[3],
      });

      const getOcrText = (result?: OCRResult) => (result?.text ?? result?.ocr_text ?? result?.value ?? result?.label ?? "").trim();

      const isCenterInside = (
        inner: { left: number; top: number; width: number; height: number },
        outer: { left: number; top: number; width: number; height: number }
      ) => {
        const centerX = inner.left + inner.width / 2;
        const centerY = inner.top + inner.height / 2;
        return centerX >= outer.left && centerX <= outer.left + outer.width && centerY >= outer.top && centerY <= outer.top + outer.height;
      };

      const resolveInferenceText = (
        box: { label: string; confidence: number; x: number; y: number; width: number; height: number; ocr_text?: string | null },
        index: number
      ) => {
        const detectionText = box.ocr_text?.trim();
        if (detectionText) return { text: detectionText, rotated: false };

        const sameOrderResult = ocrResults[index];
        const sameOrderText = getOcrText(sameOrderResult);
        if (sameOrderText && Math.abs(detections.length - ocrResults.length) <= 1) {
          return { text: sameOrderText, rotated: Boolean(sameOrderResult?.rotated) };
        }

        const boxCanvas = toCanvasBox(box);
        const overlapped = ocrResults
          .filter((result) => isCenterInside(toCanvasBox(toBoxInput(result.bbox)), boxCanvas))
          .map((result) => ({ text: getOcrText(result), rotated: Boolean(result.rotated) }))
          .filter((result) => result.text);
        return { text: overlapped.map((result) => result.text).join(" "), rotated: overlapped.some((result) => result.rotated) };
      };

      const drawBox = (box: { x: number; y: number; width: number; height: number }, label: string, rotated = false) => {
        const { left, top, width, height } = toCanvasBox(box);
        const labelText = label.trim() || "(no text)";
        const labelHeight = 24;
        ctx.font = "bold 16px Segoe UI, sans-serif";
        const labelWidth = Math.min(Math.max(ctx.measureText(labelText).width + 16, width, 130), rect.width - left);
        const labelX = left;
        const labelY = top + 2;

        ctx.strokeStyle = rotated ? "#a855f7" : "#fbbf24";
        ctx.lineWidth = 3;
        ctx.strokeRect(left, top, width, height);
        ctx.fillStyle = "rgba(0, 0, 0, 0.82)";
        ctx.fillRect(labelX, labelY, labelWidth, labelHeight);
        ctx.fillStyle = "#ffffff";
        ctx.textBaseline = "middle";
        ctx.fillText(labelText, labelX + 8, labelY + labelHeight / 2);
      };

      const drawInferenceBox = (box: { x: number; y: number; width: number; height: number }, label: string, rotated = false) => {
        const { left, top, width, height } = toCanvasBox(box);
        ctx.strokeStyle = rotated ? "#a855f7" : "#22d3ee";
        ctx.lineWidth = 3;
        ctx.strokeRect(left, top, width, height);

        const labelText = label.trim();
        if (!labelText) return;

        const labelHeight = 24;
        ctx.font = "bold 14px Segoe UI, sans-serif";
        const labelWidth = Math.min(Math.max(ctx.measureText(labelText).width + 14, 32), Math.max(32, width - 4), rect.width - left - 2);
        const labelX = left + 2;
        const labelY = top + 2;
        ctx.fillStyle = "rgba(0, 0, 0, 0.72)";
        ctx.fillRect(labelX, labelY, labelWidth, labelHeight);
        ctx.fillStyle = "#ffffff";
        ctx.textBaseline = "middle";
        ctx.fillText(labelText, labelX + 7, labelY + labelHeight / 2);
      };

      if (mode === "inference_result") {
        const boxes = detections.map((box, index) => ({
          box,
          result: resolveInferenceText(box, index),
        }));
        boxes.forEach(({ box, result }) => drawInferenceBox(box, result.text, result.rotated));
        console.debug("[VisionLink] inference overlay state", {
          yoloCount: detections.length,
          ocrCount: ocrResults.length,
          renderedCount: boxes.length,
          boxes: boxes.map(({ box, result }) => ({ bbox: [box.x, box.y, box.width, box.height], text: result.text, rotated: result.rotated })),
        });
        return;
      }

      if (mode === "ocr_result") {
        if (ocrResults.length > 0) {
          ocrResults.forEach((result) => {
            const [x, y, width, height] = result.bbox;
            const labelText = result.text ?? result.ocr_text ?? result.value ?? result.label ?? "(no text)";
            drawBox({ x, y, width, height }, labelText || "(no text)", Boolean(result.rotated));
          });
          return;
        }

        detections.forEach((box) => {
          drawBox(box, box.ocr_text?.trim() || "OCR未取得");
        });
        return;
      }

      detections.forEach((box) => {
        const hasOcr = Boolean(box.ocr_text && box.ocr_text.trim());
        const label = mode === "raw" ? (hasOcr ? box.ocr_text!.trim() : box.label) : `${box.label} ${Math.round(box.confidence * 100)}%`;
        drawBox(box, label);
      });
    };

    draw();
    window.addEventListener("resize", draw);
    return () => window.removeEventListener("resize", draw);
  }, [detections, ocrResults, mode]);

  return <canvas ref={canvasRef} className="overlay-canvas" />;
}

function statusMark(status?: "PENDING" | "OK" | "NG") {
  if (status === "OK") return "◯";
  if (status === "NG") return "×";
  return "";
}

function allStatusLabel(status?: "PENDING" | "OK" | "NG") {
  if (status === "OK") return "OK";
  if (status === "NG") return "NG";
  return "";
}

function CheckDataTable({ rows }: { rows: CheckRow[] }) {
  return (
    <div className="check-table-wrap">
      <table className="check-data-table">
        <thead>
          <tr>
            <th>✔</th>
            <th>Tube_L</th>
            <th>Label</th>
            <th>Tube_R</th>
            <th>✔</th>
            <th>ALL☑</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={`${row.tube_l}-${row.label}-${row.tube_r}-${index}`}>
              <td>{statusMark(row.left_status)}</td>
              <td>{row.tube_l}</td>
              <td>{row.label}</td>
              <td>{row.tube_r}</td>
              <td>{statusMark(row.confirm_status)}</td>
              <td>{allStatusLabel(row.all_status)}</td>
            </tr>
          ))}
          {!rows.length ? (
            <tr>
              <td colSpan={6} className="empty-state">
                チェックデータがありません
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}

export default App;
