from __future__ import annotations

import io
import logging
from time import perf_counter

from ..schemas import DetectionBox, OCRResult
from .ai_pipeline import AIModelError, pipeline

try:
    from PIL import Image
except Exception:  # pragma: no cover
    Image = None

logger = logging.getLogger(__name__)


def run_rotated_label_ocr(
    frame_bytes: bytes,
    detections: list[DetectionBox],
    ocr_confidence_threshold: float,
) -> tuple[list[OCRResult], int]:
    """OCR nmb/label crops after rotating the crop 90 degrees counter-clockwise.

    The source image and YOLO bbox stay unchanged; only the OCR input crop is rotated.
    Returned metadata lets the frontend distinguish this mode from the existing
    left-tube 180 degree OCR mode.
    """
    start = perf_counter()
    if Image is None:
        raise AIModelError("Pillow is not installed. Run: pip install -r backend/requirements.txt")

    pipeline._ensure_ocr()
    image = Image.open(io.BytesIO(frame_bytes)).convert("RGB")
    width, height = image.size
    results: list[OCRResult] = []

    for det in detections:
        if not pipeline._is_nmb_detection(det):
            continue

        x1 = int(max(0, min(width - 1, det.x * width)))
        y1 = int(max(0, min(height - 1, det.y * height)))
        x2 = int(max(x1 + 1, min(width, (det.x + det.width) * width)))
        y2 = int(max(y1 + 1, min(height, (det.y + det.height) * height)))
        crop = image.crop((x1, y1, x2, y2)).transpose(Image.Transpose.ROTATE_90)

        try:
            output = pipeline._run_paddle_ocr(__import__("numpy").array(crop))
        except Exception:
            logger.exception("Rotated label OCR failed label=%s bbox=%s", det.label, [det.x, det.y, det.width, det.height])
            continue

        best_text = ""
        best_score = 0.0
        for text, score in pipeline._extract_paddle_text_scores(output):
            if score < ocr_confidence_threshold:
                continue
            confined = pipeline._confine_nmb_text(text)
            if confined and score >= best_score:
                best_text = confined
                best_score = score

        # Keep DetectionBox OCR text in sync so the existing overlay can show nmb OCR too.
        det.ocr_text = best_text or None
        det.role = det.role or "label"
        if best_text:
            results.append(
                OCRResult(
                    text=best_text,
                    confidence=best_score,
                    bbox=[det.x, det.y, det.width, det.height],
                    source="label_ocr_rotated",
                    rotated=True,
                    rotation_deg=-90,
                    rotation_mode="label",
                    label=det.label,
                    side=det.side,
                    role="label",
                )
            )

    elapsed = int((perf_counter() - start) * 1000)
    return results, elapsed
