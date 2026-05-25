以下が、**ボタン名が状態に応じて切り替わること**が明確に伝わるよう修正した全文です。

````text id="f7uzpu"
Web UI と backend に、左側チューブ文字の180度回転OCR用の Rotate / Reset 機能を追加してください。

目的:
カメラ画面で、画面向かって label と検出された BBox 左側の Tube 文字、つまり画像上で左側にあるチューブマーカー文字が上下反転して読みにくい場合があります。
この領域だけを内部的に180度回転して OCR し、正しい向きの OCR 結果として返せるようにしてください。

対象:
- frontend/src/App.tsx
- frontend/src/api.ts
- frontend/src/types.ts
- frontend/src/styles.css
- backend/app/api.py
- backend/app/schemas.py
- backend/app/services/ai_pipeline.py
- backend/app/services/session_manager.py
- 必要に応じて関連ファイル

背景:
現在、推論結果モードでは YOLO BBOX と OCR文字列を表示できています。
添付画像の赤枠内のように、画面向かって label / 端子番号の左側にある Tube 文字が上下反転している場合があります。
この左側 Tube 領域は、通常OCRのままだと文字が反転して認識精度が落ちるため、Rotate モードでは対象領域の crop を 180度回転してから OCR に渡してください。

UI要件:

1. Web UI のカメラ操作ボタン群に、回転OCR切替ボタンを追加してください。

配置:
- `[カメラ停止]` ボタンの前に配置する

例:

[Rotate OCR: OFF] [カメラ停止] [検査停止]

2. ボタン名は、現在状態が一目で分かるように必ず切り替えてください。

初期状態:
- rotateLeftTubeOcr = false
- ボタン表示: `Rotate OCR: OFF`
- 意味: 左側Tubeの180度回転OCRは無効。通常OCR。

押下後:
- rotateLeftTubeOcr = true
- ボタン表示: `Rotate OCR: ON`
- 意味: 左側Tubeの180度回転OCRが有効。対象cropを180度回転してOCR。

再押下後:
- rotateLeftTubeOcr = false
- ボタン表示: `Rotate OCR: OFF`
- 通常OCRに戻る。

重要:
- ボタン名は `Rotate OCR: OFF` / `Rotate OCR: ON` のように、ON/OFFが明確に分かる表記にしてください。
- 単に `Rotate` / `Reset` だけだと現在状態か押下後動作か分かりにくいため避けてください。
- ただし内部実装の状態名は `rotateLeftTubeOcr` のままで構いません。

3. 必要であれば、ボタンの補助 title / aria-label も状態に応じて切り替えてください。

例:
- OFF時 title: `左側Tubeの180度回転OCRを有効にする`
- ON時 title: `左側Tubeの180度回転OCRを無効にする`

4. ボタンの見た目を分かりやすくしてください。

- OFF状態: 通常ボタン
- ON状態: 強調色、または active クラス
- スマホでも押しやすいサイズ
- 既存のコンパクトな操作レイアウトを壊さない

5. Rotate OCR: ON のとき、画面上の対象 BBox 枠色を紫色に変更してください。

対象:
- 画面向かって label / 検出BBox の左側にある Tube BBox
- 添付画像の赤枠内に相当する左側 Tube 領域
- 通常時は既存色
- Rotate OCR: ON では対象の枠を紫色にする

CSS例:
- 通常 OCR / 推論 BBox: cyan 系
- Rotate 対象 BBox: purple / violet 系
- ラベル背景も必要なら紫系にする

6. 推論結果モードでは、Rotate OCR: ON のときも表示する文字は OCRで読んだ文字列のみとしてください。

表示例:
- `L12345`

表示しないもの:
- confidence
- `[paddleocr]`
- `[mock_ai]`

OCR結果モードでは従来通り:
- `{text} {confidence}% [source]`
を維持して構いません。

frontend → backend 連携要件:

7. frame-analyze API 呼び出し時に rotateLeftTubeOcr の状態を送ってください。

例:
- multipart/form-data に `rotate_left_tube_ocr` を追加
- true / false を文字列で送信

frontend/src/api.ts:
- frameAnalyze の引数に rotateLeftTubeOcr を追加
- FormData に `rotate_left_tube_ocr` を追加

8. frontend/src/types.ts に必要な型を追加してください。

例:
- FrameAnalyzeRequest などがあれば rotate_left_tube_ocr / rotateLeftTubeOcr を追加
- OCRResult に rotation / rotated / role / side などを追加してもよい

backend API要件:

9. `/api/inspection/frame-analyze` で `rotate_left_tube_ocr` を受け取れるようにしてください。

例:
```python
rotate_left_tube_ocr: bool = Form(False)
````

10. session_manager / ai_pipeline へ rotate_left_tube_ocr を渡してください。

処理の流れ:

* api.py

  * rotate_left_tube_ocr を受け取る
* session_manager.process_frame(...)

  * rotate_left_tube_ocr を引数で受け取る
* ai_pipeline.ocr_results(...)

  * rotate_left_tube_ocr を引数で受け取る
* crop 選択・OCR実行時に左側Tube対象だけ180度回転する

backend OCR処理要件:

11. Rotate OCR: ON のときは、左側 Tube BBox の crop を 180度回転してから OCR に渡してください。

実装イメージ:

```python
if rotate_left_tube_ocr and is_left_tube_bbox(detection, image_width, image_height):
    crop = cv2.rotate(crop, cv2.ROTATE_180)
```

または:

```python
crop = np.rot90(crop, 2)
```

12. 180度回転する対象は、まず以下の判定で実装してください。

優先順:

A. detection に class_name / role / side がある場合

* class_name が tube / tube_l / left_tube / tube_left など
* side が left
* role が tube_l
  この場合は対象とする

B. class 情報がない場合

* bbox の中心 x が画像幅の左半分にあるもの
* かつ label / terminal 中央列より左側にあるもの
* まずは `center_x < image_width * 0.5` を基準にしてよい

C. 既存の CSV 検査テーブルの tube_l と対応する場合

* 今回はまだ対応付けが難しければ未実装でよい
* 将来拡張用に TODO コメントを残す

13. Rotate OCR: ON のとき、どの bbox を回転対象にしたかログを出してください。

info または debug で以下を確認できるようにする:

* rotate_left_tube_ocr true/false
* detection index
* raw bbox
* crop bbox pixel
* is_left_tube true/false
* rotated true/false
* OCR text
* confidence

14. OCRResult に rotate 情報を返してください。

例:

```json
{
  "text": "K12345",
  "confidence": 0.91,
  "bbox": [0.12, 0.34, 0.18, 0.04],
  "source": "paddleocr",
  "rotated": true,
  "rotation_deg": 180,
  "side": "left"
}
```

通常OCRの場合:

```json
{
  "text": "POA9S8",
  "confidence": 0.89,
  "bbox": [...],
  "source": "paddleocr",
  "rotated": false,
  "rotation_deg": 0
}
```

15. frontend では rotated=true の OCRResult / 対応する BBox を紫色で描画してください。

16. Rotate OCR: ON のときでも、右側 Tube や中央 Label は通常向きのOCRのままにしてください。

重要:

* すべての crop を回転しない
* 左側 Tube 対象だけを回転する
* label / 端子番号 / 右側Tubeは通常OCR

17. Rotate OCR: OFF のときは従来通りの挙動を維持してください。

* OCR crop は回転しない
* 枠色も従来色
* APIパラメータを送っても false なら影響なし

18. UIの状態表示にも Rotate OCR の状態が分かるようにしてください。

例:

* ステータスカードまたは小さな表示に `Rotate OCR: ON/OFF`
* ただし画面を圧迫しないこと
* スマホ表示で邪魔にならないこと

19. 既存機能を壊さないでください。

維持するもの:

* カメラ開始/停止
* 検査開始/停止
* YOLO閾値
* OCR閾値
* 表示FPS
* 識別FPS
* 表示切替
* YOLO結果モード
* OCR結果モード
* 推論結果モード
* CSV由来の検査テーブル
* 製番 → 盤番号 → 端子台 の選択
* OCR / YOLO の BBOX overlay
* PaddleOCR → mock_ai fallback

20. build / 構文確認をしてください。

* backend:

  * python -m py_compile backend/app/api.py backend/app/schemas.py backend/app/services/ai_pipeline.py backend/app/services/session_manager.py

* frontend:

  * npm run build

21. 実行確認してください。

確認項目:

* UIに `Rotate OCR: OFF` / `Rotate OCR: ON` ボタンがカメラ停止ボタンの前に表示される
* 初期表示は `Rotate OCR: OFF`
* 押下すると `Rotate OCR: ON` に変わる
* 再押下で `Rotate OCR: OFF` に戻る
* Rotate OCR: ON 状態で frame-analyze request に rotate_left_tube_ocr=true が送られる
* Rotate OCR: OFF 状態で frame-analyze request に rotate_left_tube_ocr=false が送られる
* backend log に rotate_left_tube_ocr=true/false が出る
* 左側 Tube 対象 crop のみ 180度回転される
* rotated=true の OCRResult が返る
* frontend で rotated=true 対象の BBox が紫色になる
* 推論結果モードでは BBox内にOCR文字列のみ表示される
* confidence や source は推論結果モードでは表示されない

22. 注意:
    添付画像の赤枠は説明用であり、画面に赤枠を追加する必要はありません。
    実装では「左側 Tube BBox」を検出して、その対象枠を Rotate OCR: ON のときに紫色にしてください。

23. 将来拡張用の TODO:

* class_name / side / role がYOLO結果から明示的に返るようになったら、それを優先して左Tube判定する
* CSV検査テーブルの tube_l と OCR結果を照合して、左側Tubeの行対応をより正確にする
* 左側Tubeだけでなく、必要に応じて個別BBox単位の回転ON/OFFにも対応する

```

変更点は、`Rotate/Reset` という曖昧な表記ではなく、**`Rotate OCR: OFF` / `Rotate OCR: ON`** に統一したところです。これなら現在状態が明確に伝わります。
```
