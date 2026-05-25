# セッション状態管理

## 概要

VisionLink では、検査作業の開始から完了までを **セッション** として管理します。セッションは一意の ID で追跡され、状態遷移、データ永続化、エラーハンドリングなどの機能を提供します。

## セッションライフサイクル

```
┌─────────────┐
│   START     │  POST /api/inspection/session/start
└──────┬──────┘
       │
       ▼
┌──────────────────┐
│  IN_PROGRESS     │  フレーム解析: POST /api/inspection/frame-analyze
│  (検査中)         │  一時停止: POST .../pause
└──────┬───────────┘
       │
    ┌──┴──┬────────────────┐
    │     │                │
    ▼     ▼                ▼
 ┌────┐ ┌──────┐      ┌──────────┐
 │PAUSE│ │ABORT │      │COMPLETED │
 └─┬──┘ └──────┘      └──────────┘
   │
   ▼
 ┌─────────────┐
 │ IN_PROGRESS │ (再開)
 └─────────────┘
```

### 状態遷移表

| 現在の状態 | 遷移先 | 操作 | 条件 |
|----------|--------|------|------|
| IN_PROGRESS | PAUSED | pause | 常に可能 |
| IN_PROGRESS | COMPLETED | complete | worker_confirmed = true |
| IN_PROGRESS | ABORTED | abort | 常に可能 |
| PAUSED | IN_PROGRESS | resume | 常に可能 |
| PAUSED | ABORTED | abort | 常に可能 |
| COMPLETED | - | - | 終了状態 |
| ABORTED | - | - | 終了状態 |

## セッションデータ

### セッションオブジェクト

```python
class InspectionSession:
    session_id: str                    # UUID (例: "sess-a1b2c3d4")
    operator_id: str                   # 作業者 ID
    status: SessionStatus              # IN_PROGRESS, PAUSED, COMPLETED, ABORTED
    order_no: str                      # 注文番号
    serial_no: str                     # シリアルNo
    terminal_name: str                 # 検査機器名
    rows: List[InspectionRow]         # 検査項目行
    created_at: datetime               # 作成時刻
    completed_at: Optional[datetime]   # 完了時刻
```

### 検査行オブジェクト

```python
class InspectionRow:
    line_no: int                # 行番号 (1-indexed)
    item_code: str              # 品目コード
    item_name: str              # 品目名
    expected_result: str        # 期待値 ("OK" or "NG")
    status: str                 # 検査結果ステータス
    note: str                   # 備考 (自動判定理由 or 手修正理由)
```

## 状態別の処理

### 1. IN_PROGRESS (検査中)

**特徴**:
- フレーム解析可能
- 手修正可能
- 一時停止・中止可能

**許可される操作**:
- `POST /api/inspection/frame-analyze` - フレーム解析
- `POST /api/inspection/session/{id}/rows/{line}/manual-edit` - 手修正
- `POST /api/inspection/session/{id}/pause` - 一時停止
- `POST /api/inspection/session/{id}/abort` - 中止
- `POST /api/inspection/session/{id}/complete` - 完了

**遷移例**:
```
セッション開始
  ↓
[フレーム 1 解析]
  ↓ (status: PENDING → OK)
[フレーム 2 解析]
  ↓ (status: PENDING → PENDING)
[手修正] (status: PENDING → OK)
  ↓
[完了確認]
  ↓
IN_PROGRESS → COMPLETED
```

### 2. PAUSED (一時停止)

**特徴**:
- フレーム解析不可
- 手修正不可
- 再開・中止のみ可能

**用途**:
- 作業者が中断する必要がある場合
- システムメンテナンス中
- 検査対象の交換

**遷移**:
```
IN_PROGRESS →[pause]→ PAUSED
                       ↓
                   [resume]
                       ↓
                  IN_PROGRESS

PAUSED →[abort]→ ABORTED
```

### 3. COMPLETED (完了)

**特徴**:
- 最終状態 (遷移不可)
- 作業者確認必須
- データは永続保存

**完了条件**:
- `worker_confirmed = true` であること
- すべての行の status が確定していること (PENDING がない)

**遷移**:
```
IN_PROGRESS →[complete (worker_confirmed=true)]→ COMPLETED
```

### 4. ABORTED (中止)

**特徴**:
- 最終状態 (遷移不可)
- 検査途中での中止
- データは保持される (監査ログ用)

**遷移**:
```
IN_PROGRESS →[abort]→ ABORTED
PAUSED →[abort]→ ABORTED
```

## フレーム解析後の状態変化

### 例: YOLO + OCR 実行時

```
入力: frame (JPEG)

実行フロー:
1. YOLO 推論 → 物体検出結果
2. OCR 推論 → 文字認識結果
3. 判定ロジック実行
   - 期待値と推論結果を比較
   - status を PENDING → OK/NG に更新
4. session.rows を更新
5. セッションを SQLite に保存

出力:
{
  "session_id": "sess-abc",
  "status": "IN_PROGRESS",  # 変わらず
  "rows": [
    {
      "line_no": 1,
      "status": "OK",        # PENDING → OK に更新
      "note": "Auto-detected defect: confidence=0.95"
    },
    ...
  ]
}
```

## エラーハンドリング

### セッション不在

```
GET /api/inspection/session/sess-invalid

Response:
Status 404
{"detail": "session not found"}
```

### 無効な状態遷移

```
セッション status = "COMPLETED"

POST /api/inspection/session/{id}/pause

Response:
Status 403
{"detail": "Cannot pause a completed session"}
```

### フレーム解析失敗

```
POST /api/inspection/frame-analyze
(AI モデル未配置)

Response:
Status 503
{"detail": "YOLO model not found"}
```

## データ永続化

### SQLite スキーマ

```sql
-- sessions テーブル
CREATE TABLE sessions (
  session_id TEXT PRIMARY KEY,
  operator_id TEXT,
  status TEXT,
  order_no TEXT,
  serial_no TEXT,
  terminal_name TEXT,
  created_at TIMESTAMP,
  completed_at TIMESTAMP
);

-- rows テーブル
CREATE TABLE rows (
  session_id TEXT,
  line_no INTEGER,
  item_code TEXT,
  item_name TEXT,
  expected_result TEXT,
  status TEXT,
  note TEXT,
  PRIMARY KEY (session_id, line_no),
  FOREIGN KEY (session_id) REFERENCES sessions(session_id)
);
```

## セッション管理の実装 (session_manager.py)

```python
class SessionManager:
    def start_session(self, request: StartInspectionRequest) -> InspectionSession:
        """セッション開始"""
        session_id = generate_session_id()
        session = InspectionSession(
            session_id=session_id,
            operator_id=request.operator_id,
            status="IN_PROGRESS",
            ...
        )
        self.store.save_session(session)
        return session
    
    def process_frame(self, session_id: str, frame_bytes: bytes) -> InspectionSession:
        """フレーム解析"""
        session = self.get_session(session_id)
        if session.status != "IN_PROGRESS":
            raise PermissionError("Session not in progress")
        
        # AI パイプライン実行
        yolo_result, ocr_result = self.ai_pipeline.infer(frame_bytes)
        
        # 判定ロジック実行
        updated_rows = self.judgement.judge(session.rows, yolo_result, ocr_result)
        
        # セッション更新
        session.rows = updated_rows
        self.store.save_session(session)
        
        return session
    
    def complete_session(self, session_id: str, worker_confirmed: bool) -> InspectionSession:
        """セッション完了"""
        session = self.get_session(session_id)
        if not worker_confirmed:
            raise ValueError("Worker confirmation required")
        
        session.status = "COMPLETED"
        session.completed_at = datetime.now()
        self.store.save_session(session)
        
        return session
```

## 監査ログ

### 記録項目

```python
class AuditLog:
    session_id: str
    timestamp: datetime
    event: str          # "session_start", "frame_analyze", "manual_edit", "complete"
    operator_id: str
    status_before: str
    status_after: str
    detail: dict        # イベント固有情報
```

### ログ記録例

```json
{
  "session_id": "sess-abc123",
  "timestamp": "2024-01-15T10:30:45Z",
  "event": "frame_analyze",
  "operator_id": "1234",
  "status_before": "IN_PROGRESS",
  "status_after": "IN_PROGRESS",
  "detail": {
    "frame_index": 1,
    "yolo_ms": 100,
    "ocr_ms": 145,
    "row_updates": [{"line_no": 1, "status": "OK"}]
  }
}
```
