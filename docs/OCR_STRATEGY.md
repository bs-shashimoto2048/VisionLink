# OCR 戦略

## 概要

VisionLink では **PaddleOCR** を OCR エンジンとして採用しています。シリアル番号や型番などの製造ラベル認識が主要な用途です。

## OCR エンジン: PaddleOCR

### 概要
- **提供元**: PaddlePaddle (Baidu)
- **特徴**:
  - 軽量で高速な推論
  - 多言語対応 (日本語含む)
  - モバイル・エッジデバイス向け最適化
  - オープンソース (Apache 2.0)

### 導入方法

```bash
pip install paddleocr paddlepaddle
```

### モデル配置

```
model/
└── paddleocr/
    └── en_PP-OCRv5_mobile_rec/
        ├── config.json
        ├── inference.json
        ├── inference.pdiparams
        ├── inference.yml
        └── README.md
```

**備考**: モデル未配置時、API は `503 Service Unavailable` を返します。

## 推論パイプライン

### 1. 画像入力

```python
# フレーム取得
frame_bytes = await frame.read()
image = cv2.imdecode(np.frombuffer(frame_bytes, np.uint8), cv2.IMREAD_COLOR)
```

### 2. 前処理

- リサイズ: 推奨 320x320 ~ 640x640
- 正規化: [0, 255] → [0, 1]
- 透視変換: 傾斜補正 (オプション)

### 3. OCR 実行

```python
from paddleocr import PaddleOCR

ocr = PaddleOCR(use_angle_cls=True, lang='en')
results = ocr.ocr(image_path, cls=True)

# results[0] = [
#   [
#     [[x1, y1], [x2, y2], [x3, y3], [x4, y4]],  # bbox
#     (text, confidence)  # OCR 結果
#   ],
#   ...
# ]
```

### 4. 後処理

- バウンディングボックス抽出
- 信頼度フィルタ (デフォルト 0.5)
- テキスト正規化 (大文字化、スペース削除など)

### 5. 判定ロジック

```python
class OCRResult:
    text: str              # 認識テキスト
    confidence: float      # 信頼度 [0, 1]
    bbox: List[int]        # バウンディングボックス [x, y, w, h]
```

**信頼度閾値**: `ocr_confidence_threshold` (デフォルト 0.5)
- 0.5 以上: 採用
- 0.5 未満: スキップ

## 性能指標

### 推論時間

| 環境 | 推論時間 (ms) | 備考 |
|------|---------------|------|
| CPU (i7) | 150-200 | 開発環境 |
| GPU (RTX 2060) | 50-80 | 高速化環境 |
| モバイル GPU | 100-150 | スマホ連携時 |

### 精度

| テキスト | 精度 | 注記 |
|---------|------|------|
| シリアル番号 (英数) | 90%+ | クリア画像 |
| 日本語テキスト | 85%+ | 傾斜あり時は低下 |
| バーコード | 低 | OCR には不向き |

## 利用パターン

### 1. シリアル番号認識

```
入力: 製品ラベル画像
OCR結果: "SN-2024-00123"
出力: シリアルNo との照合 → マッチ/ミスマッチ
```

### 2. 型番確認

```
入力: 製品型番ラベル
OCR結果: ["MODEL-XYZ-001", "REV-1.2"]
出力: 期待型番と比較
```

### 3. 検査項目文字確認

```
入力: 検査チェックシート画像
OCR結果: 複数行のテキスト
出力: テーブル行と紐付け
```

## トラブルシューティング

### OCR が失敗する場合

1. **モデルが見つからない**
   ```
   Error: Model not found
   → model/ ディレクトリを確認
   → API は 503 を返す
   ```

2. **信頼度が低い**
   - 画像が暗い / ぼやけている
   - テキストが小さい or 傾いている
   - 解像度が低い
   
   **対策**:
   - カメラフォーカス確認
   - 照明改善
   - 閾値を下げる (0.3 ~ 0.4)

3. **言語の誤認識**
   - デフォルト言語: 英語 (`lang='en'`)
   - 日本語対応: `lang='ja'`
   
   **対策**:
   ```python
   ocr = PaddleOCR(use_angle_cls=True, lang='en,ja')
   ```

4. **推論時間が長い**
   - GPU がない場合は CPU 推論
   - モデルサイズを小さいバージョンに変更
   
   **対策**:
   ```python
   # 軽量版モデル
   ocr = PaddleOCR(
       use_angle_cls=True,
       lang='en',
       det_model_dir='...',  # 軽量版
       rec_model_dir='...'
   )
   ```

## API 呼び出し

### リクエスト

```bash
curl -X POST "http://localhost:8000/api/inspection/frame-analyze" \
  -F "session_id=sess-abc123" \
  -F "operator_id=1234" \
  -F "frame_index=1" \
  -F "ocr_confidence_threshold=0.5" \
  -F "frame=@image.jpg"
```

### レスポンス

```json
{
  "session_id": "sess-abc123",
  "frame_index": 1,
  "ocr_results": [
    {
      "text": "SN-2024-00123",
      "confidence": 0.92,
      "bbox": [100, 50, 250, 100]
    }
  ],
  "ocr_ms": 145,
  "total_ms": 250
}
```

## 今後の改善

1. **言語自動検出**: 日本語/英語混在に対応
2. **テンプレートマッチング**: 既知のラベル形式を学習
3. **キャッシング**: 同じ画像の推論結果をキャッシュ
4. **バッチ処理**: 複数フレームをまとめて処理
5. **GPU 対応**: CUDA/TensorRT で高速化
