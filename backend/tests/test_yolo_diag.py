from __future__ import annotations

import io
import unittest

import numpy as np
from PIL import Image

from app.services.ai_pipeline import YoloAIPipeline
from app.services.yolo_diag import format_diag, frame_quality, summarize_boxes


class SummarizeBoxesTest(unittest.TestCase):
    def test_counts_before_and_after_threshold(self) -> None:
        boxes = [("nmb", 0.95), ("nmb", 0.62), ("tube", 0.55), ("tube", 0.30), ("tube", 0.88)]
        s = summarize_boxes(boxes, 0.6)
        self.assertEqual(s["raw_boxes"], 5)
        self.assertEqual(s["above_threshold"], 3)
        self.assertEqual(s["below_threshold"], 2)
        self.assertAlmostEqual(s["max_conf"], 0.95)
        self.assertEqual(s["classes_raw"], {"nmb": 2, "tube": 3})
        self.assertEqual(s["classes_kept"], {"nmb": 2, "tube": 1})

    def test_confidence_histogram_bins(self) -> None:
        s = summarize_boxes([("t", 0.26), ("t", 0.45), ("t", 0.55), ("t", 0.65), ("t", 0.75), ("t", 0.85), ("t", 0.95), ("t", 1.0)], 0.6)
        self.assertEqual(s["conf_hist"], {"0.25-0.40": 1, "0.40-0.50": 1, "0.50-0.60": 1, "0.60-0.70": 1, "0.70-0.80": 1, "0.80-0.90": 1, "0.90-1.00": 2})

    def test_no_boxes_is_safe(self) -> None:
        s = summarize_boxes([], 0.6)
        self.assertEqual((s["raw_boxes"], s["above_threshold"], s["max_conf"]), (0, 0, 0.0))


class FrameQualityTest(unittest.TestCase):
    def test_sharp_vs_flat_image(self) -> None:
        checker = (np.indices((40, 40)).sum(axis=0) % 2 * 255).astype(np.uint8)
        flat = np.full((40, 40), 128, dtype=np.uint8)
        sharp_q, flat_q = frame_quality(checker), frame_quality(flat)
        self.assertGreater(sharp_q["blur_laplacian_var"], 1000)
        self.assertEqual(flat_q["blur_laplacian_var"], 0.0)
        self.assertAlmostEqual(flat_q["brightness"], 128.0)

    def test_tiny_or_invalid_arrays_do_not_raise(self) -> None:
        self.assertEqual(frame_quality(np.zeros((2, 2)))["blur_laplacian_var"], 0.0)
        self.assertEqual(frame_quality(np.zeros((0, 0)))["brightness"], 0.0)

    def test_format_contains_the_fields_needed_next_time(self) -> None:
        line = format_diag(7, 720, 404, summarize_boxes([("nmb", 0.7)], 0.6), {"blur_laplacian_var": 12.3, "brightness": 99.0})
        for needle in ("frame_index=7", "size=720x404", "aspect=1.782", "raw_boxes=1", "above_threshold=1", "blur_laplacian_var=12.3"):
            self.assertIn(needle, line)


class _Arr:
    def __init__(self, v):
        self._v = np.array(v)

    def __getitem__(self, i):
        return self._v[i]


class _Box:
    def __init__(self, xyxy, conf, cls):
        self.xyxy, self.conf, self.cls = np.array([xyxy]), np.array([conf]), np.array([cls])


class _Result:
    names = {0: "nmb", 1: "tube"}
    orig_shape = (404, 720)

    def __init__(self, boxes):
        self.boxes = boxes


class _FakeModel:
    def predict(self, image, verbose=False):
        return [_Result([_Box([10, 10, 50, 40], 0.92, 0), _Box([100, 100, 160, 150], 0.41, 1), _Box([200, 50, 260, 90], 0.74, 1)])]


def _jpeg(width: int = 720, height: int = 404) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (width, height), (120, 120, 120)).save(buf, format="JPEG")
    return buf.getvalue()


def _pipeline(flag: bool) -> YoloAIPipeline:
    p = YoloAIPipeline()
    p._model = _FakeModel()
    p._model_loaded = True
    p._yolo_debug_log_enabled = flag
    return p


class DetectDiagnosticsTest(unittest.TestCase):
    def test_diag_off_by_default_and_detections_unchanged(self) -> None:
        p = YoloAIPipeline()
        self.assertFalse(p._yolo_debug_log_enabled)
        off, on = _pipeline(False), _pipeline(True)
        with self.assertNoLogs("app.services.ai_pipeline", level="INFO"):
            result_off = off.detect(_jpeg(), 1, 0.6)
        with self.assertLogs("app.services.ai_pipeline", level="INFO") as logs:
            result_on = on.detect(_jpeg(), 1, 0.6)
        # turning the diagnostics on must not change what is detected
        key = lambda r: [(d.label, round(d.confidence, 4), round(d.x, 4), round(d.y, 4)) for d in r.detections]
        self.assertEqual(key(result_off), key(result_on))
        self.assertEqual(len(result_on.detections), 2)  # 0.92 and 0.74 pass 0.6; 0.41 does not
        line = next(m for m in logs.output if "YOLO diag" in m)
        for needle in ("raw_boxes=3", "above_threshold=2", "below_threshold=1", "size=720x404", "threshold=0.60"):
            self.assertIn(needle, line)

    def test_zero_detections_are_still_diagnosed(self) -> None:
        p = _pipeline(True)
        p._model = type("M", (), {"predict": lambda self, image, verbose=False: [_Result([])]})()
        with self.assertLogs("app.services.ai_pipeline", level="INFO") as logs:
            result = p.detect(_jpeg(720, 539), 2, 0.6)
        self.assertEqual(result.detections, [])
        self.assertTrue(any("raw_boxes=0" in m and "size=720x539" in m for m in logs.output))


if __name__ == "__main__":
    unittest.main()
