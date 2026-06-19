# VisionLink — プロジェクト概要

スマートフォンをエッジ端末として使う**検査支援 Web / PWA アプリ（PoC）**。
製造現場で端子台（チューブ＋ラベル）をカメラで撮影し、YOLO で物体検出・PaddleOCR で文字認識し、
社内マスタ（CSV）の検査テーブルと突き合わせて「左チューブ / ラベル / 右チューブ」を消し込む。

- Frontend: React 18 + TypeScript + Vite（PWA）
- Backend: FastAPI + SQLite
- AI: YOLO（ultralytics）＋ PaddleOCR

## 技術スタック / 主要コマンド

### Backend（`backend/`）
- Python 仮想環境: `backend/.venv`（既存）
- 依存: `backend/requirements.txt`（fastapi, uvicorn, ultralytics, paddleocr==2.7.3, paddlepaddle==2.6.2, pillow, numpy<2 ほか）
- 起動: `.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000`
- HTTPS 起動: `.venv\Scripts\python.exe scripts\run_https.py`
- 構文チェック: `.venv\Scripts\python.exe -m py_compile backend/app/services/ai_pipeline.py backend/app/services/session_manager.py backend/app/api.py`
- import 確認: `cd backend; .venv\Scripts\python.exe -c "import app.main; print('ok')"`
- ヘルス: `Invoke-RestMethod http://127.0.0.1:8000/api/health`

### Frontend（`frontend/`）
- 依存: `npm install`（`node_modules` 既存）
- 開発: `npm run dev -- --host 0.0.0.0`
- HTTPS 開発: `npm run dev:https`
- ビルド（型チェック込み）: `npm run build`（= `tsc -b && vite build`）

> 注: PowerShell では `&&` が使えない。`A; if ($?) { B }` を使う。

## ディレクトリ構成

```
VisionLink/
  backend/
    app/
      main.py              FastAPI 初期化（CORS, startup で init_db）
      api.py               API ルータ（/api/...）
      config.py            設定（CORS, CHECK_DATA_ROOT 等）
      db.py                SQLite 永続化
      schemas.py           Pydantic スキーマ（DetectionBox, OCRResult, CheckStatus 等）
      services/
        ai_pipeline.py     YOLO/OCR 実行エンジン（YoloAIPipeline）。OCR 前処理・回転処理
        session_manager.py セッション生成/状態管理/フレーム処理の統合（manager シングルトン）
        judgement.py       行判定ロジック（judge_row, effective_status）
        internal_data.py   社内マスタ照合（モック）
        check_data.py      検査テーブル CSV 読み込み（serials/boards/terminals/table）
        store.py           DB 保存・ログ
        stability.py       OCR 安定性判定（連続フレームの安定カウント）
        mock_ai.py         AI モック
    requirements.txt
    scripts/               HTTPS 証明書生成・起動
  frontend/
    src/
      App.tsx              メイン UI（検査画面、消込テーブル表示）
      api.ts               API クライアント
      camera.ts            カメラ制御（useCamera, useFrameSampler）
      types.ts             型定義（CheckRow, OCRResult, DetectionBox 等）
      checkReconcile.ts    ★消込ロジック（reconcileCheckRows）。※recover には未存在（codex-wip で新規追加）
      styles.css
  docs/                    ARCHITECTURE.md, API.md, SPEC.md, OCR_STRATEGY.md ほか
  model/paddleocr/...      PaddleOCR 推論モデル
  tube_label_template.csv  検査テーブル CSV テンプレート
```

## データ / 処理の流れ

1. ログイン `POST /api/auth/login`（モック認証, employee_id ベース）
2. 検査テーブル選択 `GET /api/check-data/{serials,boards,terminals,table}`（CHECK_DATA_ROOT 配下の CSV）
3. （または）社内データ照合 `POST /api/internal-data/lookup` → セッション開始 `POST /api/inspection/session/start`
4. フレーム解析（繰り返し）`POST /api/inspection/frame-analyze`（multipart, JPEG/PNG）
   - `session_manager.process_frame()` が統合:
     - `pipeline.detect()` … YOLO 物体検出
     - `pipeline.ocr_detections()` / `pipeline.ocr_results()` … 検出 bbox を crop して OCR
     - `evaluate_ocr_stability()` … 連続フレームで安定したら `should_ocr`
     - `judge_row()` … 行判定 → `check_status` 更新
   - レスポンス: `detections`, `ocr_results`, `rows`, `performance`(yolo_ms/ocr_ms/total_ms)
5. フロントは `ocr_results` と検査テーブル行を `reconcileCheckRows()` で突き合わせて消し込み表示
6. 手修正 `POST .../rows/{line_no}/manual-edit`
7. 完了 `POST .../complete`（`worker_confirmed` 必須）／pause/resume/abort あり

### ステータス
- 行: `OK / NG / PENDING / OCR_FAILED / MISMATCH / MANUAL_FIXED`（`CheckStatus`）
- セッション: `IN_PROGRESS / PAUSED / COMPLETED / ABORTED`（`SessionStatus`）
- フロント消込セル: `PENDING / OK / NG`（`CheckDataStatus`）

## 設計方針（重要な前提）

- Frontend/Backend 分離 → 将来クラウド AI サーバーへ差し替え可能。
- 画像フレームは永続保存しない（一時利用のみ）。
- 検査完了時は**作業者確認（worker_confirmed）必須**。
- YOLO モデル未配置時、`frame-analyze` は 503 を返す（`session_manager` 側でデモ検出を挿入するフォールバックあり）。

## 現在の状態（2026-06-19 時点 / 復旧・統合作業）

- `main`（`be14d39`）= 復旧前の土台（このあと `recover` を ff-only 統合予定）。
- `recover` = `be14d39` を土台に、Codex が中断したバグ修正を**正しく実装し直したブランチ**。下記の修正を反映済み・ビルド/起動確認済み。
- `codex-wip`（`57eed9c`）= Codex がトークン切れで中断した**壊れた未完成作業**を保全したアーカイブ（当面削除しない）。

### 適用したバグ修正（`instructions.md` の仕様に準拠）
1. **Rotate OCR の対象を修正**: 「左側チューブ」ではなく「中央ガイドラインより左側の label/nmb」を 180°回転して OCR する仕様へ。
   - backend `ai_pipeline.py`: `_should_rotate_left_label()` / `_is_rotate_label_detection()` 等を新設（label/nmb 系を対象, tube 系は除外, debug crop は除外）。
   - Codex の破綻（`_ocr_results_with_paddleocr` の呼び出しで `bbox_pixel` 欠落・引数ズレ／回転結果の `role="tube"`）を修正。回転結果は `role="label", side="left"`。
2. **消込ロジックを左右別判定に修正**: 右チューブだけ読めても左チューブ/ALL OK になるバグを修正。
   - `reconcileCheckRows` を `frontend/src/checkReconcile.ts` に分離。左右別 Set（`leftTubeTexts`/`rightTubeTexts`）で判定し、両方 OK のときだけ `completed`。
   - `App.tsx` は `checkRows` を state 化し、フレーム毎に再消込。OverlayCanvas は `rotated` の OCR を紫(`#a855f7`)表示（既存実装）。

### 既知の未対応（別件・要相談）
- `ai_pipeline.py` 末尾の `def ocr(...)` がモジュール関数 `preprocess_ocr_crop` 内にインデントされており、`YoloAIPipeline.ocr` メソッドとして存在しない（**be14d39 から続く既存の潜在バグ**）。`session_manager` の行 OCR 経路（`should_ocr` 時）で `pipeline.ocr()` 呼び出しが AttributeError になる恐れ。今回の修正スコープ外のため未着手。
- `session_manager.py` の OCRResult 組み立て（フォールバック経路）は旧 `role=="tube"` ベースの rotated 判定のまま。主経路（`ocr_results()`）が結果を返す場合は上書きされるため通常は影響しないが、新仕様と不整合。

## コーディング / コミュニケーション規約（ユーザー共通設定より）

- 回答は日本語。変更前に何をどう変えるか簡潔に説明してから実行。
- ファイル削除・破壊的コマンド（`git reset --hard` / 強制 push / ブランチ削除 / `clean -fd` 等）の前は必ず確認。
- `.env` 等の秘密情報は読み書きしない。
- 既存スタイルに合わせ、勝手な大規模リファクタリングはしない。新規依存追加は事前確認。
- テストが通る／動作確認できてから「完了」と報告する。
