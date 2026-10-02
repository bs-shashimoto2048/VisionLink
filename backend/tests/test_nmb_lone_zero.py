from __future__ import annotations

import io
import unittest

from PIL import Image

from app.schemas import DetectionBox
from app.services.ai_pipeline import NMB_LONE_ZERO_MIN_SCORE, YoloAIPipeline


def _jpeg() -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (720, 404), (200, 200, 200)).save(buf, format="JPEG")
    return buf.getvalue()


def _det(label: str) -> DetectionBox:
    return DetectionBox(label=label, confidence=0.9, x=0.47, y=0.30, width=0.06, height=0.07)


def _run(label: str, text: str, score: float, threshold: float = 0.6) -> list[str]:
    """OCR texts the backend returns for one detection whose PaddleOCR read is (text, score)."""
    p = YoloAIPipeline()
    p._ocr = object()
    p._ensure_ocr = lambda: None  # type: ignore[method-assign]
    p._run_paddle_ocr = lambda crop: [{"rec_text": text, "rec_score": score}]  # type: ignore[method-assign]
    results = p._ocr_results_with_paddleocr(_jpeg(), [_det(label)], 1, ocr_confidence_threshold=threshold)
    return [r.text for r in results]


class NmbLoneZeroTest(unittest.TestCase):
    def test_low_confidence_lone_zero_on_nmb_is_kept(self) -> None:
        self.assertEqual(_run("nmb", "0", 0.44), ["0"])
        self.assertEqual(_run("nmb", "0", NMB_LONE_ZERO_MIN_SCORE), ["0"])  # boundary is inclusive
        self.assertEqual(_run("nmb", "0", 0.59), ["0"])

    def test_letter_o_confined_to_zero_is_kept_too(self) -> None:
        self.assertEqual(_run("nmb", "O", 0.40), ["0"])
        self.assertEqual(_run("nmb", "o", 0.35), ["0"])

    def test_below_the_floor_is_still_dropped(self) -> None:
        self.assertEqual(_run("nmb", "0", NMB_LONE_ZERO_MIN_SCORE - 0.01), [])
        self.assertEqual(_run("nmb", "0", 0.0), [])

    def test_other_low_confidence_nmb_reads_are_still_dropped(self) -> None:
        for text, score in [("1", 0.55), ("7", 0.45), ("12", 0.5), ("B", 0.45), ("10", 0.40), ("00", 0.40), ("-", 0.5)]:
            self.assertEqual(_run("nmb", text, score), [], f"{text!r} @ {score}")

    def test_tube_zero_is_never_relaxed(self) -> None:
        self.assertEqual(_run("tube", "0", 0.44), [])
        self.assertEqual(_run("tube", "O", 0.40), [])

    def test_high_confidence_behaviour_is_unchanged(self) -> None:
        self.assertEqual(_run("nmb", "0", 0.9), ["0"])
        self.assertEqual(_run("nmb", "10", 0.95), ["10"])
        self.assertEqual(_run("nmb", "B", 0.8), ["8"])  # digit confinement still applies
        self.assertEqual(_run("tube", "A1X", 0.9), ["A1X"])
        self.assertEqual(_run("nmb", "-", 0.9), [])  # nothing digit-like => dropped as before

    def test_a_lower_global_threshold_is_respected(self) -> None:
        # if the caller already lowers the threshold below the floor, normal acceptance applies
        self.assertEqual(_run("nmb", "0", 0.25, threshold=0.2), ["0"])
        self.assertEqual(_run("nmb", "7", 0.25, threshold=0.2), ["7"])
        self.assertEqual(_run("nmb", "0", 0.15, threshold=0.2), [])

    def test_the_global_threshold_default_is_unchanged(self) -> None:
        self.assertEqual(_run("nmb", "5", 0.59), [])
        self.assertEqual(_run("nmb", "5", 0.6), ["5"])


if __name__ == "__main__":
    unittest.main()
