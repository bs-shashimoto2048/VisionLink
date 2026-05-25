# システム仕様

## プロジェクト概要

**VisionLink** は、スマートフォンをエッジ端末として利用する検査支援 PWA アプリケーション PoC です。

- **環境**: React + TypeScript + Vite (Frontend), FastAPI + SQLite (Backend)
- **対象**: 製造検査、品質検査など
- **形式**: PWA (Progressive Web App) - インストール可能な Web アプリ

## 主要機能

### 1. 認証・ログイン
- 従業員ID でのログイン
- トークンベース認証 (モック実装)

### 2. 社内データ照合
- QR コード / オーダーNo / シリアルNo で製品情報を検索
- マスタデータとの照合 (現在はモック)

### 3. 検査セッション管理
- セッション開始 → フレーム解析 → 完了の一連フロー
- セッション中の一時停止・再開・中止機能
- 作業者確認必須で完了

### 4. 画像フレーム解析
- カメラからのリアルタイムキャプチャ
- YOLO による物体検出 (不良品判定)
- OCR による文字認識 (シリアル確認)
- 推論結果の自動判定

### 5. 判定結果管理
- 自動判定の表示
- 手修正機能 (作業者による上書き)
- ステータス追跡 (PENDING → OK/NG)

### 6. PWA 対応
- モバイルデバイスへのインストール
- オフライン時の基本機能保有

## 技術スタック

### Backend
- **Framework**: FastAPI (Python 3.9+)
- **Database**: SQLite
- **AI**: PaddleOCR (YOLO, OCR)
- **Server**: uvicorn
- **HTTPS**: mkcert (自己署名証明書)

### Frontend
- **Framework**: React 18 + TypeScript
- **Build Tool**: Vite
- **Styling**: CSS Modules / Plain CSS
- **PWA**: Service Worker + Manifest

## ビジネスルール

### 検査フロー

1. **ログイン** → 従業員ID 入力
2. **検査対象選択** → QR/オーダーNo でマスタ検索
3. **セッション開始** → セッションID 生成
4. **フレーム取得** → 複数枚の画像をキャプチャ
5. **自動解析** → YOLO + OCR 実行
6. **判定** → OK/NG 判定ロジック実行
7. **確認・修正** → 作業者が結果を確認、必要に応じ手修正
8. **完了確認** → 作業者が確認チェック

### 判定ステータス

| ステータス | 説明 |
|-----------|------|
| PENDING | 検査未実施 |
| OK | 検査合格 |
| NG | 検査不合格 |
| OCR_FAILED | OCR 失敗 |
| MISMATCH | データ不一致 |
| MANUAL_FIXED | 手修正済み |

### セッション状態

| 状態 | 説明 | 遷移先 |
|------|------|--------|
| IN_PROGRESS | 検査中 | PAUSED, COMPLETED, ABORTED |
| PAUSED | 一時停止 | IN_PROGRESS, ABORTED |
| COMPLETED | 完了 | - |
| ABORTED | 中止 | - |

## データモデル

### セッション

```python
class InspectionSession:
    session_id: str          # UUID
    operator_id: str         # 作業者ID
    status: str              # IN_PROGRESS, PAUSED, COMPLETED, ABORTED
    order_no: str            # 注文番号
    serial_no: str           # シリアルNo
    terminal_name: str       # 検査機器名
    rows: List[InspectionRow]  # 検査項目
    created_at: datetime
    completed_at: Optional[datetime]
```

### 検査行

```python
class InspectionRow:
    line_no: int             # 行番号
    item_code: str           # 品目コード
    item_name: str           # 品目名
    expected_result: str     # 期待値 (OK/NG)
    status: str              # 検査結果ステータス
    note: str                # 備考
```

### フレーム解析結果

```python
class FrameAnalyzeResponse:
    session_id: str
    frame_index: int
    yolo_results: List[YOLODetection]   # 物体検出結果
    ocr_results: List[OCRResult]         # 文字認識結果
    rows: List[InspectionRow]           # 更新後の行データ
    yolo_ms: int                        # YOLO 実行時間 (ms)
    ocr_ms: int                         # OCR 実行時間 (ms)
    total_ms: int                       # 総実行時間 (ms)
```

## 非機能要件

### パフォーマンス
- フレーム解析: 300ms 以内
  - YOLO: 100ms (目安)
  - OCR: 150ms (目安)
- API レスポンス: 1 秒以内

### 信頼性
- セッション永続化: SQLite で保存
- エラーハンドリング: HTTP ステータスコードで適切に応答
- AI モデル未配置時: 503 Service Unavailable を返す

### セキュリティ
- CORS ホワイトリスト設定
- 認証トークン付き API 呼び出し
- HTTPS 通信 (ローカル開発用証明書)

### 可用性
- PWA インストール対応
- ローカルストレージキャッシュ
- オフライン時の基本動作

## 制約・想定

- **開発環境**: Windows 10/11
- **実行環境**: ローカルネットワーク
- **カメラ**: スマートフォンの背面カメラ
- **ブラウザ**: Chrome / Safari (iOS 13+)
- **画像フォーマット**: JPEG / PNG
- **フレーム解析**: モデル推論で 300ms 程度を想定

## 今後の拡張

1. 実 YOLO / OCR モデル連携
2. QR コード読取エンジン搭載
3. 認証の本実装
4. マスタデータ API 連携
5. 監査ログ強化
6. オフライン時キュー機能
