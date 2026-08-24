# VisionLink アーキテクチャ（Prototype）

## 1. 全体構成

```text
┌────────────────────────────┐
│ Frontend                   │
│ React + TypeScript + Vite  │
│ Camera / Overlay / UI      │
└─────────────┬──────────────┘
              │ HTTP(S) / API
              ▼
┌────────────────────────────┐
│ Backend                    │
│ FastAPI                    │
│ Session / Inspection Logic│
└───────┬─────────┬──────────┘
        │         │
        ▼         ▼
     YOLO      PaddleOCR
   Detection   Recognition
        │         │
        └────┬────┘
             ▼
     Reconciliation
 Label anchor / L-Label-R
             │
             ▼
       Inspection result
```

Frontend はカメラ取得と可視化、Backend は検出・OCR・照合を担当します。

## 2. AI処理の責務分離

### YOLO

元画像から Label / nmb / Tube 等の対象を検出し、元画像座標のBBoxを生成します。

### OCR

YOLO BBoxからクロップを生成し、必要に応じて方向補正して PaddleOCR へ渡します。

### Reconciliation

Labelをアンカーとして1端子分の行バンドを構成し、左右Tube OCR結果を対応付けます。

## 3. 方向補正と座標系

重要な設計原則は **検出座標とOCR画像方向を分離する** ことです。

```text
Original frame
    │
    ├─ BBox coordinates ─────────→ UI overlay
    │
    └─ crop
         │
         ├─ normal
         ├─ rotate 180° (L)
         └─ rotate 90° CCW (Label)
                │
                ▼
              OCR
```

OCR用クロップを回転しても元画像上のBBoxは変更しません。

これにより、UI上の検出位置とAI内部の文字方向補正を独立して扱えます。

## 4. Frontendの責務

- カメラ開始・停止
- 検査開始・停止
- Lモードの切替
- Labelモードの切替
- フレーム送信
- YOLO BBox描画
- OCR結果表示
- 読取方向矢印表示
- 検査結果表示
- UIレイアウトの安定化

主要操作は `L / Label / Camera / Inspection` を基本とします。

## 5. Backendの責務

- 検査データの取得
- 検査セッション管理
- フレーム受信
- YOLO推論
- OCR対象クロップ生成
- L / Label 方向補正
- PaddleOCR推論
- OCR安定化
- Labelアンカー方式による行構成
- 左右Tube対応付け
- 期待値との照合
- Frontendへ結果返却

## 6. Labelアンカー行構成

```text
             Frame Y
               ↓
 Label 1  ─────────
          boundary
 Label 2  ─────────  ← row band
          boundary
 Label 3  ─────────
```

Label中心間の中間位置を行境界とし、各行バンド内のTubeをLabelの左右へ割り当てます。

この設計により、単純な固定距離判定より撮影角度や位置ずれへ追従しやすくします。

## 7. データフロー

```text
1. Frontendが検査対象を選択
2. Backendが検査データを取得
3. Camera開始
4. FrontendがフレームをBackendへ送信
5. BackendでYOLO検出
6. BBoxからOCRクロップ生成
7. L / Label設定に応じ方向補正
8. PaddleOCR
9. OCR安定化
10. LabelアンカーでL / Label / Rを構成
11. 期待値と照合
12. Frontendへ結果返却
13. FrontendがBBox・OCR・検査結果を描画
```

## 8. 設定

環境依存値は可能な限り設定として外出しします。

代表例:

- `CHECK_DATA_ROOT`: 検査データのルート
- CORS許可Origin
- AIモデルパス
- OCR / 検出関連閾値

特定PCや共有フォルダ専用の値を一般仕様として固定しないことを推奨します。

## 9. Prototype境界

現在の構成は実機検証を優先したプロトタイプです。

本番化では以下を別途設計対象とします。

- 認証・認可
- 監査ログ
- 検査履歴の保存方針
- モデル版管理
- 設定版管理
- 障害復旧
- ネットワーク境界
- セキュリティ
- 配布・更新方法
- 精度評価基盤

詳細は [TODO.md](TODO.md) を参照してください。
