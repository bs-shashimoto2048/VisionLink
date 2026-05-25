# API 仕様

## 概要

VisionLink バックエンド API は FastAPI で構築された RESTful API です。認証、検査セッション管理、画像フレーム解析、社内データ照合などのエンドポイントを提供します。

## エンドポイント

### ヘルスチェック

```
GET /api/health
```

Response:
```json
{
  "status": "ok"
}
```

### 認証

#### ログイン

```
POST /api/auth/login
```

Request:
```json
{
  "employee_id": "1234"
}
```

Response:
```json
{
  "employee_id": "1234",
  "operator_id": "1234",
  "access_token": "mock-token-1234",
  "display_name": "Operator 1234"
}
```

**備考**: 現在はモック実装です。本実装が必要です。

### 社内データ照合

#### データ検索

```
POST /api/internal-data/lookup
```

Request:
```json
{
  "qr_text": "QR-001",
  "order_no": "ORD-2024-001",
  "serial_no": "SN-12345",
  "terminal_name": "Terminal-A"
}
```

Response:
```json
{
  "order_no": "ORD-2024-001",
  "serial_no": "SN-12345",
  "terminal_name": "Terminal-A",
  "rows": [
    {
      "line_no": 1,
      "item_code": "ITEM-001",
      "item_name": "Component A",
      "expected_result": "OK",
      "status": "PENDING",
      "note": ""
    }
  ]
}
```

### 検査セッション

#### セッション開始

```
POST /api/inspection/session/start
```

Request:
```json
{
  "operator_id": "1234",
  "qr_text": "QR-001",
  "order_no": "ORD-2024-001",
  "serial_no": "SN-12345",
  "terminal_name": "Terminal-A"
}
```

Response:
```json
{
  "session_id": "sess-abc123",
  "operator_id": "1234",
  "status": "IN_PROGRESS",
  "order_no": "ORD-2024-001",
  "serial_no": "SN-12345",
  "terminal_name": "Terminal-A",
  "rows": [...],
  "created_at": "2024-01-01T12:00:00Z",
  "completed_at": null
}
```

#### セッション取得

```
GET /api/inspection/session/{session_id}
```

Response: セッション情報 (開始と同じスキーマ)

#### セッション制御

##### 一時停止

```
POST /api/inspection/session/{session_id}/pause
```

Request:
```json
{
  "employee_id": "1234"
}
```

Response: セッション情報 (status: PAUSED)

##### 再開

```
POST /api/inspection/session/{session_id}/resume
```

Request:
```json
{
  "employee_id": "1234"
}
```

Response: セッション情報 (status: IN_PROGRESS)

##### 中止

```
POST /api/inspection/session/{session_id}/abort
```

Request:
```json
{
  "employee_id": "1234"
}
```

Response: セッション情報 (status: ABORTED)

### フレーム解析

#### 画像フレーム解析

```
POST /api/inspection/frame-analyze
Content-Type: multipart/form-data
```

Request Parameters:
- `session_id`: セッション ID (string)
- `operator_id`: 作業者 ID (string)
- `frame_index`: フレームインデックス (integer, default: 0)
- `yolo_confidence_threshold`: YOLO 信頼度閾値 (float, default: 0.25)
- `ocr_confidence_threshold`: OCR 信頼度閾値 (float, default: 0.5)
- `frame`: 画像ファイル (binary, JPEG/PNG)

Response:
```json
{
  "session_id": "sess-abc123",
  "frame_index": 1,
  "yolo_results": [
    {
      "class_id": 0,
      "class_name": "defect",
      "confidence": 0.95,
      "bbox": [100, 100, 200, 200]
    }
  ],
  "ocr_results": [
    {
      "text": "ABC-123",
      "confidence": 0.88,
      "bbox": [50, 50, 150, 100]
    }
  ],
  "rows": [
    {
      "line_no": 1,
      "item_code": "ITEM-001",
      "item_name": "Component A",
      "expected_result": "OK",
      "status": "OK",
      "note": "Automatic detection"
    }
  ],
  "yolo_ms": 100,
  "ocr_ms": 150,
  "total_ms": 250
}
```

### 手修正

#### 行の手修正

```
POST /api/inspection/session/{session_id}/rows/{line_no}/manual-edit
```

Request:
```json
{
  "operator_id": "1234",
  "final_status": "OK",
  "note": "Manually confirmed"
}
```

Response: セッション情報

### セッション完了

#### 検査完了

```
POST /api/inspection/session/{session_id}/complete
```

Request:
```json
{
  "operator_id": "1234",
  "worker_confirmed": true
}
```

Response: セッション情報 (status: COMPLETED)

## ステータスコード

| コード | 説明 |
|--------|------|
| 200 | OK |
| 400 | Bad Request |
| 403 | Forbidden (権限不足) |
| 404 | Not Found |
| 500 | Internal Server Error |
| 503 | Service Unavailable (AI モデル未配置など) |

## 判定ステータス

| ステータス | 説明 |
|-----------|------|
| OK | 検査OK |
| NG | 検査NG |
| PENDING | 検査待ち |
| OCR_FAILED | OCR失敗 |
| MISMATCH | データ不一致 |
| MANUAL_FIXED | 手修正済み |

## セッション状態

| 状態 | 説明 |
|------|------|
| IN_PROGRESS | 検査中 |
| PAUSED | 一時停止中 |
| COMPLETED | 検査完了 |
| ABORTED | 検査中止 |
