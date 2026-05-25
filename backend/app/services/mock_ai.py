from __future__ import annotations

from dataclasses import dataclass
from hashlib import sha1

from ..schemas import DetectionBox, InspectionRowTemplate, OCRResult


@dataclass(frozen=True)
class MockYoloResult:
    detections: list[DetectionBox]
    signature: str


@dataclass(frozen=True)
class MockOcrResult:
    text: str | None
    confidence: float
    bbox: list[float]
    success: bool
    reason: str | None = None


def run_ocr_results(
    detections: list[DetectionBox],
    target_row: InspectionRowTemplate | None,
    frame_index: int,
) -> list[OCRResult]:
    fallback_boxes = [
        DetectionBox(label="mock-ocr-region", confidence=0.88, x=0.1, y=0.1, width=0.3, height=0.08),
        DetectionBox(label="mock-ocr-region", confidence=0.84, x=0.14, y=0.24, width=0.34, height=0.08),
        DetectionBox(label="mock-ocr-region", confidence=0.81, x=0.18, y=0.38, width=0.36, height=0.08),
    ]
    source_boxes = [*detections[:3], *fallback_boxes[len(detections[:3]) :]]

    base_values = (
        [target_row.line_no, target_row.left_value, target_row.right_value]
        if target_row
        else [f"MOCK-LINE-{frame_index:03d}", "MOCK-LEFT", "MOCK-RIGHT"]
    )
    results: list[OCRResult] = []
    for index, box in enumerate(source_boxes[:3]):
        raw_text = (
            base_values[index % len(base_values)]
            or getattr(target_row, "left_value", None)
            or getattr(target_row, "right_value", None)
            or getattr(target_row, "item_code", None)
            or getattr(target_row, "item_name", None)
            or f"ROW-{getattr(target_row, 'line_no', index + 1)}"
        )
        text = str(raw_text).strip() or f"ROW-{index + 1}"
        results.append(
            OCRResult(
                text=text,
                confidence=max(0.5, min(0.99, box.confidence - index * 0.03)),
                bbox=[box.x, box.y, box.width, box.height],
                source="mock_ai",
            )
        )
    return results


def detect_objects(frame_bytes: bytes, frame_index: int) -> MockYoloResult:
    # Keep the mock stable for two consecutive samples so OCR can be triggered.
    digest = sha1(str(frame_index // 2).encode("utf-8")).hexdigest()
    jitter = (int(digest[:4], 16) % 12) / 200.0
    confidence = 0.82 + (int(digest[4:6], 16) % 10) / 100.0
    detections = [
        DetectionBox(
            label="connector",
            confidence=min(confidence, 0.98),
            x=0.11 + jitter,
            y=0.18,
            width=0.32,
            height=0.18,
        ),
        DetectionBox(
            label="qr-region",
            confidence=0.74,
            x=0.58,
            y=0.14 + jitter / 2,
            width=0.22,
            height=0.22,
        ),
    ]
    return MockYoloResult(detections=detections, signature=digest[:16])


def run_ocr(
    frame_bytes: bytes,
    target_row: InspectionRowTemplate,
    stable_count: int,
    frame_index: int,
) -> MockOcrResult:
    digest = sha1(frame_bytes + f"{target_row.line_no}:{frame_index}".encode("utf-8")).hexdigest()
    bbox = [0.11, 0.18, 0.32, 0.18]
    if stable_count < 2:
        return MockOcrResult(text=None, confidence=0.0, bbox=bbox, success=False, reason="not_stable")

    if int(digest[:2], 16) % 9 == 0:
        return MockOcrResult(text=None, confidence=0.0, bbox=bbox, success=False, reason="ocr_failed")

    base_text = f"{target_row.line_no}|{target_row.left_value}|{target_row.right_value}"
    if int(digest[2:4], 16) % 7 == 0:
        base_text = base_text.replace("|", "/")
    if int(digest[4:6], 16) % 8 == 0:
        base_text = base_text.replace(target_row.right_value, f"X{target_row.right_value}")

    confidence = 0.76 + (int(digest[6:8], 16) % 20) / 100.0
    return MockOcrResult(
        text=base_text,
        confidence=min(confidence, 0.97),
        bbox=bbox,
        success=True,
    )
