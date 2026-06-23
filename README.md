# VisionLink PoC

スマートフォンをエッジ端末として利用する検査支援 Web / PWA アプリケーションの PoC です。  
Frontend は React + TypeScript + Vite、Backend は FastAPI、保存先は SQLite です。

## 1. 設計方針

- フロントエンドとバックエンドを分離し、将来クラウド AI サーバーへ切り替えやすい構成にしています。
- AI 処理は `ai_pipeline` サービスで実 YOLO（ultralytics）と実 OCR（PaddleOCR）を実行します。`mock_ai` はモデル未配置・ロード失敗時のフォールバックとして残しています。
- 判定ロジック、社内データ照合、ログ保存を個別サービスに分けています。
- 画像フレームは一時利用のみで、永続保存しません。
- 検査完了時は作業者確認を必須にしています。
- PWA としてインストール可能な最小構成を入れています。

## 2. ディレクトリ構成

```text
VisionLink/
  backend/
    requirements.txt
    app/
      api.py
      config.py
      db.py
      main.py
      schemas.py
      services/
        internal_data.py
        judgement.py
        mock_ai.py
        session_manager.py
        store.py
  frontend/
    index.html
    package.json
    public/
      icon.svg
      manifest.webmanifest
      sw.js
    src/
      App.tsx
      api.ts
      camera.ts
      main.tsx
      styles.css
      types.ts
    tsconfig.json
    tsconfig.node.json
    vite.config.ts
```

## 3. API 仕様

### 認証

- `POST /api/auth/login`
- request: `{ "employee_id": "1234" }`
- response: `{ "employee_id", "operator_id", "access_token", "display_name" }`

### 社内データ照合モック

- `POST /api/internal-data/lookup`
- request: `{ "qr_text", "order_no", "serial_no", "terminal_name" }`
- response: `order_no`, `serial_no`, `terminal_name`, `rows`

### 検査セッション開始

- `POST /api/inspection/session/start`
- request: `{ "operator_id", "qr_text", "order_no", "serial_no", "terminal_name" }`
- response: セッション情報 + 初期行テーブル

### セッション制御

- `POST /api/inspection/session/{session_id}/pause`
- `POST /api/inspection/session/{session_id}/resume`
- `POST /api/inspection/session/{session_id}/abort`
- request: `{ "employee_id" }`
- status: `IN_PROGRESS`, `PAUSED`, `COMPLETED`, `ABORTED`

### フレーム解析

- `POST /api/inspection/frame-analyze`
- `multipart/form-data`
- fields:
  - `session_id`
  - `operator_id`
  - `frame_index`
  - `frame` (JPEG/PNG)
- response: YOLO 検出結果、OCR 結果、判定済みテーブル、`yolo_ms` / `ocr_ms` / `total_ms`

### 判定ステータス

- `OK`
- `NG`
- `PENDING`
- `OCR_FAILED`
- `MISMATCH`
- `MANUAL_FIXED`

### 手修正

- `POST /api/inspection/session/{session_id}/rows/{line_no}/manual-edit`
- request: `{ "operator_id", "final_status", "note" }`

### 完了

- `POST /api/inspection/session/{session_id}/complete`
- request: `{ "operator_id", "worker_confirmed" }`

### 取得

- `GET /api/inspection/session/{session_id}`
- `GET /api/health`

## 4. 実装コード

ソースは `backend/` と `frontend/` に配置しています。

## 5. Windows 環境での起動手順

### Backend

```powershell
cd C:\Users\shashimoto\project\workspace_codex\VisionLink\backend
py -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

### Backend HTTPS 起動

```powershell
cd C:\Users\shashimoto\project\workspace_codex\VisionLink\backend
.venv\Scripts\activate
py scripts\run_https.py
```

- 初回実行時に `backend/certs/backend-key.pem` と `backend/certs/backend.pem` を自動生成します。
- 証明書には `localhost`、`127.0.0.1`、PC の LAN IP が入ります。
- iPhone からバックエンドに直接アクセスする場合は `https://<PCのLAN-IP>:8000` を使えます。
- フロントエンドを Vite proxy 経由で使う場合は、バックエンドを HTTP のままでも動きます。
- `backend/start-https.ps1` でも同じ HTTPS 起動を実行できます。

### Frontend

```powershell
cd C:\Users\shashimoto\project\workspace_codex\VisionLink\frontend
npm install
npm run dev -- --host 0.0.0.0
```

### 利用上の注意

- スマートフォンのカメラ利用は HTTPS または `localhost` のような secure context が必要です。
- 開発時は PC で `localhost`、スマホ接続時は将来的に HTTPS 配信を使ってください。

### iPhone 向け HTTPS 起動手順

1. Windows PC に `mkcert` を入れてローカル CA を作成します。
2. PowerShell で以下を実行して証明書を作成します。`192.168.x.x` は PC の LAN IP に置き換えてください。

```powershell
cd C:\Users\shashimoto\project\workspace_codex\VisionLink\frontend
mkdir certs
mkcert -install
mkcert -key-file certs/localhost-key.pem -cert-file certs/localhost.pem localhost 127.0.0.1 192.168.x.x
```

3. iPhone に `mkcert` のルート CA を信頼させます。`mkcert -CAROOT` で出る `rootCA.pem` を端末に入れて、`設定 > 一般 > 情報 > 証明書信頼設定` で完全信頼を有効化します。
4. Frontend を起動します。

```powershell
npm run dev -- --host 0.0.0.0
```

5. iPhone の Safari で `https://192.168.x.x:5173` を開きます。
6. カメラ権限を許可します。

### HTTPS で iPhone から開く起動コマンド

```powershell
cd C:\Users\shashimoto\project\workspace_codex\VisionLink\frontend
npm run dev:https
```

- 初回実行時に `frontend/certs/localhost-key.pem` と `frontend/certs/localhost.pem` を自動生成します。
- 証明書には `localhost`、`127.0.0.1`、PC の LAN IP が入ります。
- iPhone からは `https://<PCのLAN-IP>:5173` を開いてください。
- 生成済み証明書を使い回すので、LAN IP が変わったら `frontend/certs/` を削除して再生成してください。

### カメラ失敗時の見え方

- `NotAllowedError`: 権限拒否
- `NotFoundError`: カメラ未検出
- `NotReadableError`: 別アプリが占有中
- `SecurityError`: HTTPS でない、またはブラウザ権限が不足
- 画面上ではエラー本文に加えて `Code` と補足説明を表示します。

## 6. AI モデルの利用状況

PoC v1 時点で、YOLO・OCR とも**実モデルを使用**しています（`backend/app/services/ai_pipeline.py`）。

- **YOLO（物体検出）**: 実モデル使用。`model/yolo/TrmRead_yolo26s_20260401.pt`（チューニング済み）を ultralytics でロードし推論します。
- **OCR（文字認識）**: 実モデル使用。PaddleOCR を実行します。
  - 環境に PaddleOCR 3.x（`paddleocr.tools` 非提供）が入っている場合は `TextRecognition` + `model/paddleocr/en_PP-OCRv5_mobile_rec`（モバイル軽量）経路。
  - PaddleOCR 2.x 環境では `TextRecognizer` + `model/paddleocr/en_PP-OCRv3_rec_infer`（`inference.pdmodel` / `inference.pdiparams`）経路。
  - フロントの消し込みは `frame-analyze` の `ocr_results`（`source="paddleocr"`）を使用します。

### モック / フォールバックの発動条件

実モデルが使えない場合に限り `mock_ai` などへフォールバックします。

- YOLO 未配置・依存未導入・ロード失敗時: `session_manager` がデモ検出（`ocr-demo-region`）を1件挿入して継続します。
- OCR の import 失敗・モデルファイル不正・実行例外・**実 OCR 結果が空**のとき: `ocr_results` が `mock_ai`（`source="mock_ai"`、`label="mock-ocr-region"` 等の固定値）にフォールバックします。
- 安定化後の行 OCR（`pipeline.ocr()` / `should_ocr` 経路）は現状 `mock_ai.run_ocr` のままです（消し込みには未使用）。

## 7. 今後追加すべき TODO

- 行 OCR（`pipeline.ocr()` / 安定化経路）の実 OCR 化（現状モック）
- QR 読取機能の追加
- 詳細な判定ルールの実装
- 認証の本実装
- 現場別マスタデータ API 連携
- 完了・再開・再検査フローの拡張
- 監査ログの強化
- オフライン時の再送キュー

---

## 8. Backend (Windows / venv)

```powershell
cd C:\Users\shashimoto\project\workspace_codex\VisionLink\backend
py -0p
py -3 -m venv .venv
.\.venv\Scripts\python.exe -m pip install --upgrade pip
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -m pip install paddlepaddle
.\.venv\Scripts\python.exe -c "import paddleocr; import paddle; print('paddleocr ok'); print('paddlepaddle ok')"
.\.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

- `pyenv` エラー時は `python` ではなく `py -3` または `.\.venv\Scripts\python.exe` を使用してください。
- 起動確認:

```powershell
Invoke-RestMethod http://127.0.0.1:8000/api/health
```

- YOLO モデル未配置時でも、`/api/inspection/frame-analyze` は `session_manager` がデモ検出（`ocr-demo-region`）を挿入して継続します（503 にはなりません）。OCR も実行できない場合は `mock_ai` にフォールバックします。詳細は「6. AI モデルの利用状況」を参照してください。

## 9. Quick Start 手順

### Backend

>仮想環境起動
```powershell
cd .\backend
py -m venv .venv
.venv\Scripts\activate
```

>サーバー起動
```powershell
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

### Frontend

```powershell
cd .\frontend
npm run dev -- --host 0.0.0.0
```

---
