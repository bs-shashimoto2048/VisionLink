# VisionLink USER_GUIDE visual placement plan

This file tracks the visual assets that must be embedded into `USER_GUIDE.md`.

The guide must not rely on one large infographic. Each visual is tied to one explanation section and the Markdown text must explain the operation independently.

## Required visuals

1. **Actual iPhone inspection screen**
   - Place near the beginning of the guide.
   - Shows the actual Safari screen with camera, BBox, L, Label, camera control, inspection control, progress, table, worker confirmation.

2. **Terminal / Tube relationship photo**
   - Place under `2.1 1端子の基本構成`.
   - Shows the real left Tube / Label / right Tube relationship.

3. **Terminal block orientation example**
   - Place under `3.1 端子台は縦向きに読み込む`.
   - Shows the terminal block before and after turning it 90 degrees for inspection.

4. **L 180 degree OCR example**
   - Place under `7. Lボタンの使い方`.
   - Show original left Tube orientation and OCR-corrected orientation.
   - BBox itself must remain unrotated.

5. **Label 90 degree OCR example**
   - Place under `8. Labelボタンの使い方`.
   - Show nmb visually rotated 90 degrees clockwise in the camera and the OCR crop corrected 90 degrees counter-clockwise.
   - BBox itself must remain unrotated.

6. **BBox color example**
   - Place under `9. BBox・色・矢印の見方`.
   - Purple = L, orange = Label/nmb, cyan = normal/right Tube.

7. **Inspection flow examples**
   - Place under `13. 実際の検査フロー`.
   - Camera live / inspection active / OK / NG examples as separate visuals.

8. **Inspection table detail**
   - Place under `11. 検査テーブルと消込の見方`.
   - Shows `L / Label / R / ALL`, green OK and NG examples.

## Source images

Use the actual images supplied in the project discussion. Do not redraw the real hardware into a different geometry. Do not aggressively downscale source screenshots.

## Acceptance

`USER_GUIDE.md` is not complete until these visuals are embedded in the relevant sections and render on GitHub.