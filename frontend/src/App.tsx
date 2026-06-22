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
import type { CheckDataStatus, CheckRow, CheckTableResponse, InspectionSessionResponse, InternalDataLookupResponse, LoginResponse, OCRResult } from "./types";
import { reconcileCheckRows } from "./checkReconcile";

// 表示切替リスト: 順序は現状の逆順、デフォルトは「推論結果」（要件3）
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

// 接続/セッション系ツール(再接続・カメラ切替・内部データ参照・ログアウト・intakeフォーム)を
// UI から非表示にするフラグ。state/ハンドラ/ロジックは残し、true に戻せば復活する（要件F1）。
const SHOW_SESSION_TOOLS = false;

// OK/NG/Pending サマリー・状態カード・注意書きを UI から非表示にするフラグ（集計/state は維持）。
// スマホで場所を圧迫するため。true に戻せば復活する。
const SHOW_STATUS_PANELS = false;

function rowKey(row: CheckRow, index: number) {
  return `${row.tube_l}-${row.label}-${row.tube_r}-${index}`;
}

function isRowCompleted(row: CheckRow) {
  return Boolean(row.completed) || row.all_status === "OK";
}

// 映像左上の状態表示用: セッション状態を読んで分かる日本語に
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
        });
        console.debug("[VisionLink] frame analyze for reconcile", {
          frameIndex: response.frame_index,
          isCheckTableReady,
          inspectionRunning,
          checkRowsLength: checkTable?.rows?.length ?? 0,
          yoloCount: response.detections?.length ?? 0,
          ocrCount: response.ocr_results?.length ?? 0,
          ocrResults: response.ocr_results?.map((result) => ({
            text: result.text,
            ocr_text: result.ocr_text,
            value: result.value,
            label: result.label,
            bbox: result.bbox,
            role: result.role,
            class_name: result.label,
            source: result.source,
            rotated: result.rotated,
          })),
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
  const inspectionRunning = inspection?.status === SessionStatus.IN_PROGRESS;
  const isInspectionActive =
    inspectionRunning ||
    inspection?.status === SessionStatus.PAUSED ||
    inspection?.status === SessionStatus.COMPLETED;
  const overlayOcrResults = useMemo(() => {
    const latest = lastFrameAnalysis?.ocr_results ?? [];
    return latest.length > 0 ? latest : (inspection?.ocr_results ?? []);
  }, [inspection?.ocr_results, lastFrameAnalysis?.ocr_results]);
  const isCheckTableReady = Boolean(selectedSerial) && Boolean(selectedBoard) && Boolean(selectedTerminal) && (checkTable?.rows?.length ?? 0) > 0;
  const reconcileFrameIndex = lastFrameAnalysis?.frame_index ?? inspection?.frame_index ?? 0;
  useEffect(() => {
    console.debug("[VisionLink] reconcile gate", {
      isCheckTableReady,
      inspectionRunning,
      isInspectionActive,
      checkRowsLength: checkTable?.rows?.length ?? 0,
      checkRowsStateLength: checkRows.length,
      yoloCount: lastFrameAnalysis?.detections?.length ?? inspection?.detections?.length ?? 0,
      ocrCount: lastFrameAnalysis?.ocr_results?.length ?? inspection?.ocr_results?.length ?? 0,
    });
  }, [checkRows.length, checkTable?.rows?.length, inspectionRunning, isInspectionActive, isCheckTableReady, lastFrameAnalysis?.detections?.length, lastFrameAnalysis?.ocr_results?.length, inspection?.detections?.length, inspection?.ocr_results?.length]);
  useEffect(() => {
    setCheckRows((prevRows) => {
      if (!isCheckTableReady || !isInspectionActive || prevRows.length === 0) {
        console.debug("[VisionLink] reconcile skipped", {
          isCheckTableReady,
          isInspectionActive,
          prevRowsLength: prevRows.length,
        });
        return prevRows;
      }

      const nextRows = reconcileCheckRows({
        rows: prevRows,
        yoloResults: lastFrameAnalysis?.detections ?? inspection?.detections ?? [],
        ocrResults: overlayOcrResults,
        guideX,
        frameIndex: reconcileFrameIndex,
      });

      console.debug("[VisionLink] reconcile applied", {
        frameIndex: reconcileFrameIndex,
        previous: prevRows.map((row) => ({
          label: row.label,
          tube_l_status: row.tube_l_status,
          tube_r_status: row.tube_r_status,
          completed: row.completed,
        })),
        next: nextRows.map((row) => ({
          label: row.label,
          tube_l_status: row.tube_l_status,
          tube_r_status: row.tube_r_status,
          completed: row.completed,
        })),
      });

      return nextRows;
    });
  }, [checkRows.length, isCheckTableReady, isInspectionActive, lastFrameAnalysis?.detections, inspection?.detections, overlayOcrResults, guideX, reconcileFrameIndex]);
  const allRowsCompleted = checkRows.length > 0 && checkRows.every(isRowCompleted);
  // 進捗表示用（既存の消込状態から算出。新たな判定は増やさない）
  const totalCount = checkRows.length;
  const completedCount = checkRows.filter(isRowCompleted).length;

  // 消込が成立した行を検出して、その行へ自動スクロール＋ハイライトする（要件F5）
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
    // セッション開始の表示は非表示（要件フェーズ2）。開始ロジックは維持。バナー要素はエラー表示用に残す。
    // setBanner(`セッション開始: ${response.session_id}`);
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
      {/* 最上部タイトル(VisionLink)とその直下の"検査"は非表示（要件2）。実質の最上部見出しは
          下のカメラカード見出し("VisionLink")が担う。復元する場合はこのコメントを戻す。
      <header className="hero">
        <div>
          <p className="eyebrow">{TEXT.appTitle}</p>
          <h1>{TEXT.headline}</h1>
        </div>
      </header>
      */}

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
                  {/* 状態表示は映像内の固定オーバーレイ（左上）。略号をやめ読んで分かる表記に（要件5） */}
                  <div className="camera-status-overlay">
                    {sessionStatusLabel(inspection?.status)} ・ 通信{isOnline ? "ON" : "OFF"} ・{" "}
                    {inspection
                      ? `推論 ${inspection.performance.yolo_ms}ms / OCR ${inspection.performance.ocr_ms}ms`
                      : "推論 —"}
                  </div>
                </div>

                {/* 下部操作バー: [表示]セレクタ / OCR Turn / カメラ / 検査 を常に1列に収める（要件4） */}
                <div className="camera-bottom-bar">
                  <select
                    className="bottom-bar-select"
                    aria-label="表示切替"
                    value={overlayMode}
                    onChange={(event) => setOverlayMode(event.target.value as keyof typeof OVERLAY_MODES)}
                  >
                    {Object.entries(OVERLAY_MODES).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                  <button
                    className={rotateLeftTubeOcr ? "toggle-active" : ""}
                    title={rotateLeftTubeOcr ? "左側Tubeの180度回転OCRを無効にする" : "左側Tubeの180度回転OCRを有効にする"}
                    aria-label={rotateLeftTubeOcr ? "Rotate OCR: ON" : "Rotate OCR: OFF"}
                    onClick={() => setRotateLeftTubeOcr((value) => !value)}
                  >
                    {rotateLeftTubeOcr ? "OCR Turn ON" : "OCR Turn OFF"}
                  </button>
                  <button
                    onClick={cameraState.running ? stopCamera : startCamera}
                    disabled={!isCheckTableReady && !cameraState.running}
                    title={!isCheckTableReady ? "検査テーブルを選択してから開始してください" : undefined}
                  >
                    {cameraState.running ? "カメラ停止" : "カメラ開始"}
                  </button>
                  <button
                    className={inspectionRunning ? "danger" : "primary"}
                    onClick={() => void (inspectionRunning ? handleStopInspection() : handleStartInspection())}
                    disabled={!isCheckTableReady && !inspectionRunning}
                    title={!isCheckTableReady ? "検査テーブルを選択してから開始してください" : undefined}
                  >
                    {inspectionRunning ? "検査停止" : "検査開始"}
                  </button>
                </div>
              </div>
            </div>

            {settingsOpen ? (
              <div className="settings-modal-backdrop" onClick={() => setSettingsOpen(false)}>
                <div className="settings-modal" onClick={(event) => event.stopPropagation()}>
                  <div className="settings-modal-header">
                    <h3>設定</h3>
                    <button onClick={() => setSettingsOpen(false)}>閉じる</button>
                  </div>

                  {/* オーバーレイの中身は4調整値のみ（要件F1） */}
                  <div className="settings-fields">
                    <label className="settings-field">
                      YOLO閾値
                      <input type="number" min={0.05} max={0.95} step={0.05} value={yoloThreshold} onChange={(event) => setYoloThreshold(Number(event.target.value))} />
                    </label>
                    <label className="settings-field">
                      OCR閾値
                      <input type="number" min={0.05} max={0.95} step={0.05} value={ocrThreshold} onChange={(event) => setOcrThreshold(Number(event.target.value))} />
                    </label>
                    <label className="settings-field">
                      表示FPS
                      <input type="number" min={1} max={120} step={1} value={displayFps} onChange={(event) => setDisplayFps(Number(event.target.value))} />
                    </label>
                    <label className="settings-field">
                      識別FPS
                      <input type="number" min={1} max={5} step={1} value={analysisFps} onChange={(event) => setAnalysisFps(Number(event.target.value))} />
                    </label>
                  </div>

                  {/* 接続/セッション系・intakeフォームは非表示（state/ロジックは保持。SHOW_SESSION_TOOLS=true で復活） */}
                  {SHOW_SESSION_TOOLS ? (
                    <>
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
                    </>
                  ) : null}
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
              <h2 className="section-title">検査テーブル</h2>
              {/* 進捗: 未完了は青字「完了/総数」、全行完了で緑字「検査完了」（要件3） */}
              {totalCount > 0 ? (
                allRowsCompleted ? (
                  <span className="inspect-progress is-done">検査完了</span>
                ) : (
                  <span className="inspect-progress">
                    {completedCount} / {totalCount}
                  </span>
                )
              ) : null}
              <div className="button-row">
                <button onClick={() => void refreshActiveSession()}>再読込</button>
                <button
                  className="primary"
                  onClick={() => void handleComplete()}
                  disabled={!isCheckTableReady || !inspectionRunning || !allRowsCompleted || !workerConfirmed}
                  title={!allRowsCompleted ? "すべての行の照合完了後に完了できます" : !workerConfirmed ? "作業者確認が必要です" : undefined}
                >
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
            <CheckDataTable rows={checkRows} highlightKey={highlightKey} />

            <div className="button-row wrap">
              <label className="checkbox">
                <input type="checkbox" checked={workerConfirmed} onChange={(event) => setWorkerConfirmed(event.target.checked)} disabled={!isCheckTableReady || !allRowsCompleted} />
                {TEXT.workerConfirmed}
              </label>
            </div>

            {/* OK/NG/Pending サマリー（集計は維持・表示のみ停止） */}
            {SHOW_STATUS_PANELS ? (
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
            ) : null}
          </section>
        </>
      )}

      {/* 状態カード(IN_PROGRESS/Operator)・最下段の注意書き（表示のみ停止・ロジックは維持） */}
      {SHOW_STATUS_PANELS ? (
        <footer className="page-footer">
          <div className={`status-card ${statusTone(statusLabel)}`}>
            <span className="status-label">状態</span>
            <strong>{statusLabel}</strong>
            <span className="status-meta">{operator ? `${operator.display_name} / ${operator.operator_id}` : "社員番号4桁を入力"}</span>
          </div>
          <p className="lead">{TEXT.description}</p>
        </footer>
      ) : null}
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
        const labelHeight = 18;
        const labelX = left + 2;
        const labelY = top + 2;

        // 枠線のみ・細め・透過（映像が透ける）。回転=紫は維持。
        ctx.strokeStyle = rotated ? "rgba(168, 85, 247, 0.85)" : "rgba(251, 191, 36, 0.85)";
        ctx.lineWidth = 1.25;
        ctx.strokeRect(left, top, width, height);

        // 不透明な背景塗りは廃止。影で可読性だけ控えめに補助し、文字は小さめ＋透過。
        ctx.save();
        ctx.font = "bold 12px Segoe UI, sans-serif";
        ctx.textBaseline = "middle";
        ctx.shadowColor = "rgba(0, 0, 0, 0.8)";
        ctx.shadowBlur = 3;
        ctx.fillStyle = "rgba(255, 255, 255, 0.9)";
        ctx.fillText(labelText, labelX + 4, labelY + labelHeight / 2);
        ctx.restore();
      };

      const drawInferenceBox = (box: { x: number; y: number; width: number; height: number }, label: string, rotated = false) => {
        const { left, top, width, height } = toCanvasBox(box);
        // 枠線のみ・細め・透過（映像が透ける）。回転=紫は維持。
        ctx.strokeStyle = rotated ? "rgba(168, 85, 247, 0.85)" : "rgba(34, 211, 238, 0.85)";
        ctx.lineWidth = 1.25;
        ctx.strokeRect(left, top, width, height);

        const labelText = label.trim();
        if (!labelText) return;

        const labelHeight = 18;
        const labelX = left + 2;
        const labelY = top + 2;
        // 不透明な背景塗りは廃止。影で可読性だけ控えめに補助し、文字は小さめ＋透過。
        ctx.save();
        ctx.font = "bold 11px Segoe UI, sans-serif";
        ctx.textBaseline = "middle";
        ctx.shadowColor = "rgba(0, 0, 0, 0.8)";
        ctx.shadowBlur = 3;
        ctx.fillStyle = "rgba(255, 255, 255, 0.9)";
        ctx.fillText(labelText, labelX + 4, labelY + labelHeight / 2);
        ctx.restore();
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

function CheckDataTable({ rows, highlightKey }: { rows: CheckRow[]; highlightKey?: string | null }) {
  const highlightRowRef = useRef<HTMLTableRowElement | null>(null);

  // 消込で確定した行をスクロール領域内で可視位置へ寄せる（ページは動かさない: block:"nearest"）
  useEffect(() => {
    if (!highlightKey) return;
    const rowEl = highlightRowRef.current;
    if (!rowEl) return;
    rowEl.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [highlightKey]);

  return (
    <div className="check-table-wrap">
      <table className="check-data-table">
        <thead>
          <tr>
            <th>L</th>
            <th>Label</th>
            <th>R</th>
            <th>ALL</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => {
            const key = rowKey(row, index);
            const completed = isRowCompleted(row);
            const isHighlight = key === highlightKey;
            return (
              <tr
                key={key}
                ref={isHighlight ? highlightRowRef : undefined}
                className={`${completed ? "check-row-completed" : ""}${isHighlight ? " check-row-flash" : ""}`}
              >
                <td className={row.tube_l_status === "OK" ? "check-cell-ok" : ""}>{row.tube_l}</td>
                <td className="check-status-mark">{row.label}</td>
                <td className={`check-status-mark ${row.tube_r_status === "OK" ? "check-cell-ok" : ""}`}>{row.tube_r}</td>
                <td className={`check-status-mark ${row.all_status === "OK" ? "check-cell-ok" : ""}`}>{allStatusLabel(row.all_status)}</td>
              </tr>
            );
          })}
          {!rows.length ? (
            <tr>
              <td colSpan={4} className="empty-state">
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
