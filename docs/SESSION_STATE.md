# セッション状態管理（Prototype）

VisionLink Backendは検査処理をセッション単位で管理します。
この文書は `backend/app/services/session_manager.py` の現行実装を基準にしています。
画面上の L / Label / R 消込については [OCR_STRATEGY.md](OCR_STRATEGY.md) を参照してください。

## 1. セッションの役割

セッションは次の情報を保持します。

- `session_id`
- `operator_id`
- `order_no / serial_no / terminal_name / qr_text`
- Backend側の検査行
- `status`
- `frame_index`
- OCR安定判定状態
- 最新YOLO detections
- 最新OCR results
- 作業者確認状態
- performance
- 作成/更新/完了日時

メモリ上のセッションが存在しない場合でも、保存済みSQLiteデータから復元できます。

## 2. 状態遷移

```text
                 pause
 IN_PROGRESS ─────────────> PAUSED
      │                       │
      │ complete              │ resume
      ▼                       ▼
 COMPLETED                IN_PROGRESS
      
 IN_PROGRESS ── abort ──> ABORTED
 PAUSED      ── abort ──> ABORTED
```

| 状態 | 意味 |
|---|---|
| `IN_PROGRESS` | 検査中 |
| `PAUSED` | 一時停止 |
| `COMPLETED` | 完了 |
| `ABORTED` | 中止 |

## 3. セッション開始

`POST /api/inspection/session/start`

1. 内部データを取得
2. `RuntimeRow` を生成
3. UUIDの `session_id` を発行
4. セッションsnapshotを保存
5. 行データを保存
6. メモリ上のSessionManagerへ登録

## 4. フレーム処理

`POST /api/inspection/frame-analyze`

概略:

```text
camera frame
    │
    ▼
YOLO detect
    │
    ├─ detection OCR
    │      ├─ normal Tube
    │      └─ L ON: left Tube crop 180°
    │
    ├─ OCR results path
    │
    ├─ stability evaluation
    │
    └─ stable時のrow OCR / Backend judgement

Label ONの場合はAPI層で追加処理
    └─ nmb cropを左90°回転 → PaddleOCR
```

Backendの行判定と、画面上の消込は同じものではありません。

- Backend: `judge_row()` によるセッション行状態
- Frontend: `checkReconcile.ts` による Labelアンカー型 L / Label / R 消込

Prototypeの検査画面で利用者が見る消込状態はFrontend側が中心です。

## 5. OCR安定判定

フレームごとの検出signatureを使って安定性を評価します。

- 安定カウントは `stability_count` に保持
- `should_ocr` は安定条件と対象行の存在により決定
- Backendのrow OCRは `should_ocr` 成立時に実行

この安定判定は、FrontendのLabelアンカー消込とは別レイヤーです。

## 6. RuntimeRow

現行Backendの行は概ね次の情報を持ちます。

```text
no
line_no
left_value
right_value
check_status
ocr_text
manual_final_status
manual_edit_history
updated_at
created_at
```

画面側の `tube_l / label / tube_r` 表示モデルとは名称が異なるため、Docsでは混同しないでください。

## 7. セッションResponse

`InspectionSessionResponse` には主に次が含まれます。

```text
session_id
operator_id
status
order_no
serial_no
terminal_name
qr_text
frame_index
stability_count
should_ocr
target_row_no
ocr_text
detections
ocr_results
rows
summary
performance
```

## 8. 保存

セッション開始・更新時にはSQLiteへsnapshot/rows/summaryを保存します。

目的:

- Backend再起動後のセッション復元
- 検査状態の保持
- 将来の履歴・監査拡張の基盤

ただしPrototypeでは、本番監査ログ・履歴保持期間・改ざん防止等の正式要件は未確定です。

## 9. operator確認

フレーム処理では `operator_id` がセッション所有者と一致することを確認します。
不一致時は `PermissionError` となりAPIでは403へ変換されます。

Prototypeのログイン自体はモックであるため、この仕組みを本番認証・認可とみなしてはいけません。

## 10. 完了

セッション完了時には作業者確認を要求します。
完了後は `COMPLETED` として保存されます。

Frontendでは別途、L / Label / R の全消込状態を使って検査完了可否を制御します。

## 11. Prototypeで注意する点

1. Backendの `check_status` とFrontendの消込状態は別ロジック
2. 認証はモック
3. 検査履歴/監査要件は本番仕様未確定
4. Label 90°補正はAPI層で追加される
5. BBoxはOCR cropを回転しても元フレーム座標のまま

この区別は保守時に特に重要です。
