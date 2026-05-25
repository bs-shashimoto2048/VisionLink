# アーキテクチャ

## 全体構成

VisionLink は frontend と backend に分離された PWA アプリケーションです。

```
┌─────────────────────┐
│   Frontend (PWA)    │
│  React + TypeScript │
│ (Camera + UI)       │
└──────────┬──────────┘
           │
           │ HTTPS/HTTP
           │
┌──────────▼──────────┐
│  Backend API        │
│  FastAPI + SQLite   │
│  (Sessions, Logic)  │
└──────────┬──────────┘
           │
     ┌─────┴──────┬──────────┬──────────┐
     │            │          │          │
  YOLO         OCR     Internal DB    Services
  Models       Engines   Lookup
(PaddleOCR)  (PaddleOCR)  (Mock)
```

## Backend 構造

```
backend/
├── app/
│   ├── __init__.py
│   ├── main.py              # FastAPI アプリ初期化
│   ├── api.py               # API ルータ定義
│   ├── config.py            # 設定管理
│   ├── db.py                # SQLite データベース
│   ├── schemas.py           # Pydantic スキーマ
│   └── services/
│       ├── ai_pipeline.py   # AI モデル実行エンジン
│       ├── session_manager.py   # セッション管理
│       ├── judgement.py      # 判定ロジック
│       ├── internal_data.py  # 社内データ照合
│       ├── store.py          # データストア
│       ├── stability.py      # 安定性関連
│       └── mock_ai.py        # AI モック
├── scripts/
│   ├── run_https.py         # HTTPS 起動
│   └── setup_https.py       # 証明書生成
├── certs/                   # 証明書フォルダ
└── requirements.txt
```

## Frontend 構造

```
frontend/
├── index.html
├── package.json
├── tsconfig.json
├── vite.config.ts           # Vite 設定 (proxy)
├── public/
│   ├── manifest.webmanifest # PWA マニフェスト
│   └── sw.js                # Service Worker
├── scripts/
│   └── setup-https.mjs      # HTTPS 証明書生成
├── certs/                   # 証明書フォルダ
└── src/
    ├── main.tsx             # エントリポイント
    ├── App.tsx              # メインコンポーネント
    ├── api.ts               # API クライアント
    ├── camera.ts            # カメラ制御
    ├── types.ts             # TypeScript 型定義
    ├── styles.css           # スタイル
    └── vite-env.d.ts        # Vite 型定義
```

## データフロー

### 検査フロー

```
1. ログイン
   Frontend → [POST /api/auth/login] → Backend
   
2. データ照合
   Frontend → [POST /api/internal-data/lookup] → Backend
   
3. セッション開始
   Frontend → [POST /api/inspection/session/start] → Backend
   Backend: Session 生成 → SQLite に保存
   
4. フレーム解析 (繰り返し)
   Frontend: カメラキャプチャ → Backend
   Backend:
     a) YOLO 推論 (物体検出)
     b) OCR 推論 (文字認識)
     c) 判定ロジック (OK/NG 判定)
     d) Session 更新
   Frontend: 結果表示
   
5. 手修正
   Frontend → [POST /api/inspection/session/{id}/rows/{line}/manual-edit] → Backend
   Backend: 判定結果を上書き
   
6. 検査完了
   Frontend → [POST /api/inspection/session/{id}/complete] → Backend
   Backend: Session 完了、作業者確認必須
```

## サービス層の責務

| サービス | 責務 |
|---------|------|
| `session_manager.py` | セッション生成、状態管理、フレーム処理の統合 |
| `ai_pipeline.py` | YOLO / OCR モデルの実行、推論 |
| `judgement.py` | 検査結果の判定ロジック |
| `internal_data.py` | 社内マスタデータの照合 |
| `store.py` | データベース保存、ログ記録 |
| `stability.py` | 安定性機能 (タイムアウトなど) |
| `mock_ai.py` | AI のモック実装 |

## セキュリティ

- **CORS**: フロントエンド URL でホワイトリスト設定
- **認証**: 現在はモック (employee_id ベース)
- **HTTPS**: ローカル開発用自動証明書生成
- **サニタイズ**: 入力値の検証

## 設計方針

1. **分離の原則**
   - Frontend/Backend 分離で将来クラウド化対応
   - AI 処理を services に分離で実装差し替え容易
   
2. **一時性**
   - 画像フレームは永続保存せず（検査完了後は破棄）
   - セッション単位の管理
   
3. **確認必須**
   - 検査完了時は作業者確認を必須化
   - 判定結果を手修正可能
   
4. **拡張性**
   - AI モデルはプラグイン化
   - ビジネスロジックは services に集約

## 外部依存

| 項目 | 現状 | 備考 |
|------|------|------|
| YOLO | PaddleOCR TrmRead | 物体検出用 |
| OCR | PaddleOCR | 文字認識用 |
| 認証 | モック | 本実装必要 |
| マスタデータ | モック | API 連携必要 |
