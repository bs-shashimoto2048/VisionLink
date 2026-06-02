/api/inspection/frame-analyze が 500 Internal Server Error になり、推論しなくなりました。
直前に backend log の詳細化、OCR前処理、Rotate OCR 周りのログ追加をしています。
まず追加機能ではなく、500の原因特定と復旧を優先してください。

対応してください。

1. backend console の 500 発生時スタックトレースを確認してください。
   - 例外のファイル名
   - 行番号
   - 例外メッセージ
   - どのログ出力・前処理・OCR処理で落ちているか

2. もしスタックトレースが出ていない場合は、/api/inspection/frame-analyze の処理全体を logger.exception で捕捉し、原因が必ず出るようにしてください。
   ただし、握りつぶして正常扱いにはしないでください。

3. 直近で追加した詳細ログの format 不整合を確認してください。
   特に以下を確認してください。
   - logger.info/debug の %s プレースホルダ数と引数数が一致しているか
   - f-string 内で未定義変数を参照していないか
   - bbox_raw / bbox_pixel / role / side / class_name が None の場合でも落ちないか
   - crop_shape_before / crop_shape_after_rotate / crop_shape_after_preprocess が未定義のままログされていないか
   - elapsed_ms / guide_x / center_x などが未定義になっていないか

4. OCR前処理で落ちていないか確認してください。
   特に以下を確認してください。
   - crop が None または空配列の場合はスキップ
   - crop の width/height が 0 の場合はスキップ
   - cv2.cvtColor に 1ch/3ch/4ch の想定外画像を渡していないか
   - CLAHE は 1ch uint8 に対して適用しているか
   - threshold は grayscale に対して適用しているか
   - resize の計算で 0 除算していないか
   - deskew 失敗時に元画像を返しているか
   - ksize=1 の blur/morph で例外になっていないか

5. Rotate OCR 判定で落ちていないか確認してください。
   - detection.class_name が無い場合も安全に扱う
   - detection.role / side が無い場合も安全に扱う
   - bbox が [x,y,w,h] / [x1,y1,x2,y2] / 正規化座標のどれでも安全に処理する
   - bbox の値が None / 空 / 長さ不足の場合はその detection をスキップ

6. PaddleOCR が失敗した場合は 500 にせず、従来通り mock_ai fallback してください。
   - PaddleOCR 例外 → logger.exception → fallback=mock_ai
   - PaddleOCR empty → fallback=mock_ai
   - mock_ai も空 → ocr_results=[] で 200 を返す

7. YOLO detection が失敗した場合も、以前の仕様通り 500 にせず処理継続してください。
   - detections=[] として OCR debug crop または mock_ai fallback に進む
   - ただし致命的な入力不正は 400 で返す

8. frame-analyze の最終レスポンスは、通常ケースでは必ず 200 を返すよう復旧してください。
   - yolo_results
   - ocr_results
   - rows
   - yolo_ms / ocr_ms / total_ms
   が返ること

9. 一時的に直近追加した詳細ログや前処理を feature flag で無効化できるようにしてください。
   例:
   OCR_PREPROCESS_ENABLED=true/false
   OCR_DEBUG_LOG_ENABLED=true/false
   問題切り分けのため、false にすると従来の推論が動く状態にしてください。

10. 確認してください。
   - backend py_compile 成功
   - /api/health 成功
   - /api/inspection/session/start 成功
   - /api/inspection/frame-analyze が 500 ではなく 200 を返す
   - backend log に例外が出ない
   - frontend の推論結果モードで BBOX / OCR が再表示される

まずやること:
- 500 のスタックトレースを特定
- その例外を修正
- PaddleOCR / 前処理 / ログ追加で例外が起きても mock_ai fallback して 200 を返すように戻す

目的:
新しいログ・前処理・Rotate OCR の追加によって frame-analyze が落ちないようにし、推論表示を復旧すること。