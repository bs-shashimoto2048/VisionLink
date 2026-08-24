# VisionLink API リファレンス（Prototype）

この文書は VisionLink Prototype の `backend/app/api.py` を基準にした API リファレンスです。
利用者向け操作は [USER_GUIDE.md](USER_GUIDE.md)、システム全体は [ARCHITECTURE.md](ARCHITECTURE.md) を参照してください。

## 1. 基本情報

- Base path: `/api`
- Backend: FastAPI
- フレーム解析: `multipart/form-data`
- セッション系レスポンス: `InspectionSessionResponse`
- Prototype の認証は社員番号4桁を使うモック実装です

## 2. Health

### `GET /api/health`

```json
{
  "status": "ok"
}
```

## 3. Login

### `POST /api/auth/login`

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

`employee_id` は4桁数字です。Prototype では実認証基盤とは接続していません。

## 4. 検査データ選択

### `GET /api/check-data/serials`

利用可能な製番一覧を返します。

```json
{
  "serials": ["A1AA0001"]
}
```

### `GET /api/check-data/boards?serial={serial}`

指定製番の盤番号一覧を返します。

### `GET /api/check-data/terminals?serial={serial}&board={board}`

指定製番・盤番号の端子台一覧を返します。

### `GET /api/check-data/table?serial={serial}&board={board}&terminal={terminal}`

検査テーブルを返します。

```json
{
  "serial": "A1AA0001",
  "board": "...",
  "terminal": "...",
  "rows": [
    {
      "tube_l": "101",
      "label": "1",
      "tube_r": "101",
      "left_status": "PENDING",
      "confirm_status": "PENDING",
      "all_status": "PENDING"
    }
  ]
}
```

主なエラー:

| HTTP | 内容 |
|---|---|
| 400 | 指定値・CSV構造が不正 |
| 404 | CSVが見つからない |
| 503 | 共有サーバー/検査データルートへアクセスできない |

## 5. 内部データ照合

### `POST /api/internal-data/lookup`

Request:

```json
{
  "qr_text": null,
  "order_no": null,
  "serial_no": "A1AA0001",
  "terminal_name": "TB1"
}
```

Response は `source / order_no / serial_no / terminal_name / rows` を持ちます。
Prototypeでは検査画面の主導線は `check-data` 系です。内部データ照合は将来連携を見据えた別経路として残しています。

## 6. 検査セッション

### `POST /api/inspection/session/start`

Request:

```json
{
  "operator_id": "1234",
  "qr_text": null,
  "order_no": null,
  "serial_no": "A1AA0001",
  "terminal_name": "TB1"
}
```

新しいセッションを作成し、`session_id` を返します。

### `GET /api/inspection/session/{session_id}`

保存済みまたはメモリ上のセッション状態を取得します。

### `POST /api/inspection/session/{session_id}/pause`

Request:

```json
{
  "employee_id": "1234"
}
```

### `POST /api/inspection/session/{session_id}/resume`

Request は pause と同じです。

### `POST /api/inspection/session/{session_id}/abort`

Request は pause と同じです。

### `POST /api/inspection/session/{session_id}/complete`

Request:

```json
{
  "operator_id": "1234",
  "worker_confirmed": true
}
```

Prototype のUIでは全行消込後に作業者確認を行って完了します。

## 7. フレーム解析

### `POST /api/inspection/frame-analyze`

Content-Type: `multipart/form-data`

| Form field | 型 | 既定値 | 内容 |
|---|---:|---:|---|
| `session_id` | string | 必須 | セッションID |
| `operator_id` | string | 必須 | 作業者ID |
| `frame_index` | int | 0 | フレーム番号 |
| `yolo_confidence_threshold` | float | 0.6 | YOLO閾値 |
| `ocr_confidence_threshold` | float | 0.6 | OCR閾値 |
| `rotate_left_tube_ocr` | bool | false | L: 左側TubeをOCR前に180°補正 |
| `rotate_label_ocr` | bool | false | Label: nmb cropをOCR前に左90°補正 |
| `frame` | file | 必須 | JPEG等のフレーム画像 |

### 回転仕様

#### `rotate_left_tube_ocr=true`

- 対象: 左側のTube
- OCR用crop: 180°回転
- 元フレーム: 回転しない
- YOLO BBox: 回転しない
- OCR結果: `rotated=true`, `rotation_deg=180`

#### `rotate_label_ocr=true`

前提は「nmb数字が画面上で右へ90°倒れている」状態です。

- 対象: nmb / Label
- OCR用crop: 左へ90°回転して正立化
- 元フレーム: 回転しない
- YOLO BBox: 回転しない
- OCR結果: `rotated=true`, `rotation_deg=-90`, `rotation_mode="label"`
- Label ON中は未回転nmb結果を検査へフォールバックしません

### 主なResponseフィールド

```json
{
  "session_id": "...",
  "operator_id": "1234",
  "status": "IN_PROGRESS",
  "frame_index": 10,
  "stability_count": 2,
  "should_ocr": true,
  "target_row_no": 1,
  "ocr_text": "1",
  "detections": [],
  "ocr_results": [],
  "rows": [],
  "summary": {},
  "performance": {
    "yolo_ms": 20,
    "ocr_ms": 80,
    "total_ms": 100
  }
}
```

### `OCRResult`

| Field | 内容 |
|---|---|
| `text` | OCR文字列 |
| `confidence` | OCR確信度 |
| `bbox` | 元フレーム上の `[x, y, width, height]` |
| `source` | OCR経路 |
| `rotated` | OCR用cropを回転したか |
| `rotation_deg` | 0 / 180 / -90 |
| `rotation_mode` | Label回転時は `label` |
| `label` | YOLOクラス名 |
| `side` | left/right等 |
| `role` | tube/label等 |

> `bbox` はOCR cropの回転後サイズではありません。常に元カメラ画像上のYOLO検出BBoxです。

## 8. 手修正

### `POST /api/inspection/session/{session_id}/rows/{line_no}/manual-edit`

Request:

```json
{
  "operator_id": "1234",
  "final_status": "OK",
  "note": "manual confirmation"
}
```

Backendのセッション行に対する手修正APIです。現在の主UI消込はFrontendの `checkReconcile.ts` による L / Label / R 判定が中心です。

## 9. ステータス

### CheckStatus

- `OK`
- `NG`
- `PENDING`
- `OCR_FAILED`
- `MISMATCH`
- `MANUAL_FIXED`

### SessionStatus

- `IN_PROGRESS`
- `PAUSED`
- `COMPLETED`
- `ABORTED`

## 10. エラー

| HTTP | 主な意味 |
|---|---|
| 400 | 入力不正、完了条件未達等 |
| 403 | operator不一致、状態遷移不可等 |
| 404 | セッション/CSVが存在しない |
| 500 | 予期しないフレーム解析失敗 |
| 503 | AIモデル、共有データ、OCR依存等の利用不可 |

FastAPIのSwagger UIも実行中Backendから確認できますが、本書はPrototypeの実装意図を補足するための正式Docsとして維持します。
