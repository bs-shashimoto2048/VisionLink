# VisionLink — プロジェクト概要

スマートフォンをエッジ端末として使う**検査支援 Web / PWA アプリ（PoC）**。
製造現場で端子台（チューブ＋ラベル）をカメラで撮影し、YOLO で物体検出・PaddleOCR で文字認識し、
社内マスタ（CSV）の検査テーブルと突き合わせて左右チューブを消し込む。

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
        ai_pipeline.py     YOLO/OCR 実行エンジン（YoloAIPipeline）。OCR 前処理・回転・nmb 数字化
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
      App.tsx              メイン UI（検査画面、消込テーブル、オーバーレイ描画）
      api.ts               API クライアント
      camera.ts            カメラ制御（useCamera, useFrameSampler）
      types.ts             型定義（CheckRow, OCRResult, DetectionBox 等）
      checkReconcile.ts    消込ロジック（reconcileCheckRows, normalizeCheckText）
      styles.css
  docs/                    ARCHITECTURE.md, API.md, SPEC.md, OCR_STRATEGY.md ほか
  model/paddleocr/...      PaddleOCR 推論モデル
  tube_label_template.csv  検査テーブル CSV テンプレート（tube_l,label,tube_r。tube_l==tube_r）
```

## データ / 処理の流れ

1. ログイン `POST /api/auth/login`（モック認証, employee_id ベース）
2. 検査テーブル選択 `GET /api/check-data/{serials,boards,terminals,table}`（CHECK_DATA_ROOT 配下の CSV）
3. （または）社内データ照合 `POST /api/internal-data/lookup` → セッション開始 `POST /api/inspection/session/start`
4. フレーム解析（繰り返し）`POST /api/inspection/frame-analyze`（multipart, JPEG/PNG）
   - `session_manager.process_frame()` が統合:
     - `pipeline.detect()` … YOLO 物体検出
     - `pipeline.ocr_detections()` / `pipeline.ocr_results()` … 検出 bbox を crop して OCR（nmb は数字化）
     - `evaluate_ocr_stability()` … 連続フレームで安定したら `should_ocr`
     - `judge_row()` … 行判定 → `check_status` 更新
   - レスポンス: `detections`, `ocr_results`(label/side/role/rotated 付き), `rows`, `performance`(yolo_ms/ocr_ms/total_ms)
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

---

# 確定仕様（PoC v1）

## 画面（スマホ縦・1画面・レイアウトは動かさない）
1. ヘッダー：左「VisionLink」（タイトル色）／右「設定」。最上段の別タイトル・"検査" 文字列は無し。
2. 映像：比率 4:3（640:480）、幅は画面いっぱい。
3. 操作1行：`[表示] [OCR Turn] [カメラ 開始/停止] [検査 開始/停止]`（常に1列・折り返し禁止）。
4. 検査テーブル見出し（やや小さめ）＋進捗表示＋`[再読込][完了]`。
5. 選択リスト1行：`[製番(8字)] [盤番号(2字)] [端子台(5〜7字)]`、収まらなければ盤番号から省略。見出しとの間に少し余白。
6. データ表：列 `L / Label / R / ALL`（✓ 列は廃止）。幅は画面に収まる（`table-layout:fixed`・min-width なし・ellipsis）。データ行だけ縦スクロール、周囲は固定。
- 進捗表示（見出しと再読込の中間）：未完了は青字「完了数 / 総数」、全完了で緑字「検査完了」。既存の消込状態から算出。

## カメラ / オーバーレイ
- 起動既定は背面カメラ（`facingMode: "environment"`）。
- 検出枠：塗りなし・線のみ・細め(約1.25px)・透過(約0.85)。紫=左 tube 回転／シアン=推論。
- OCR テキスト：小さめ・透過(約0.9)・不透明背景なし（影で可読性補助）。
- 状態オーバーレイ：映像左上、小さめ・暗背景薄め(alpha 約0.5)・略号でなく読める表記（例「検査中 ・ 通信ON ・ 推論 141ms / OCR 1174ms」）。

## 検出・OCR・回転（OCR Turn）
- Rotate OCR ON のとき、**センターラインより左の tube 検出のみ 180°回転して OCR**。nmb/label・右 tube・デバッグ crop は回転しない。
  - backend: `_is_rotate_tube_detection()` / `_should_rotate_left_tube()`（対象=`ROTATE_TUBE_KEYWORDS`, 除外=`ROTATE_EXCLUDE_KEYWORDS`=nmb/label 系）。回転時の付与は `role="tube", side="left"`。
- 左右分類は `OCRResult` に載せた **YOLO クラス名(label)＋中心X** で対称判定（回転の副作用＝rotated の role/side に非依存）。

## nmb（番号）の数字化
- nmb 系（クラス名 nmb/label）の OCR は**数字のみで確定**（値域 1〜999）。見間違いを数字へ寄せる（I/l/|→1, O/o→0, S→5, B→8, Z→2, G→6、非数字除去）。tube は対象外。
  - backend: `_is_nmb_detection()` / `_confine_nmb_text()`（`_ocr_results_with_paddleocr` 主経路と `ocr_detections` の両方に適用）。

## 消込ロジック（`checkReconcile.ts`）
- 各行は回答（検査テーブルの期待値）を1つ持ち（CSV では `tube_l==tube_r`）、左右 tube とも同じ回答と照合。
- 片側ラッチ：一致した側を OK として保持（以降別文字を読んでも OK）。一致側セルの文字色を緑(`#16a34a`)に。
- 照合の正規化（`normalizeCheckText`）：大文字化・空白除去に加え **O と 0 を等価扱い**（両辺）。表示値は OCR original のまま。
- 両側 OK で行を消込完了（ALL）。完了時は該当行へ自動スクロール/ハイライト。リセットは行/テーブル読み直し時のみ。
- nmb は消込対象外（左右 tube のみ）。検査開始はテーブル読込後のみ有効。

## 設定（「設定」で開くオーバーレイ）
- 中身は4項目のみ：YOLO閾値(既定 0.6)／OCR閾値(既定 0.6)／表示FPS／識別FPS。メインにかぶせる形（レイアウトを押し広げない）。
- 接続/セッション系（再接続・カメラ切替・内部データ参照・ログアウト・QR・注文番号・端末番号・端末名）と OK/NG/Pending カード・状態カード・注意書きは **UI 非表示（ロジックは残置）**。`SHOW_SESSION_TOOLS` / `SHOW_STATUS_PANELS` フラグで復元可。表示FPS は未配線。

## 前提・依存
- YOLO クラス名が "tube" 系 / "nmb"・"label" 系キーワードを含むこと。
- nmb は 1〜999 の数値。右 tube は非回転で読める向き。

## スコープ外（保留）
- 検査結果保存・ユーザー情報・ログイン/セットアップ画面の設計（機能はコード残置・UI 非表示）。表示FPS の配線。nmb の桁数 cap。

## リポジトリ
- `main` = PoC 完成版（`poc-v1` タグで固定）。
- `codex-wip` = Codex の壊れた未完成作業のアーカイブ（削除しない）。

---

## コーディング / コミュニケーション規約（ユーザー共通設定より）

- 回答は日本語。変更前に何をどう変えるか簡潔に説明してから実行。
- ファイル削除・破壊的コマンド（`git reset --hard` / 強制 push / ブランチ削除 / `clean -fd` 等）の前は必ず確認。
- `.env` 等の秘密情報は読み書きしない。
- 既存スタイルに合わせ、勝手な大規模リファクタリングはしない。新規依存追加は事前確認。
- テストが通る／動作確認できてから「完了」と報告する。
