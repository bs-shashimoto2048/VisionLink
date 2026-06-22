from __future__ import annotations

from dataclasses import dataclass
from hashlib import sha1
import io
import logging
import os
from pathlib import Path
from time import perf_counter
from typing import Any

os.environ.setdefault("FLAGS_use_mkldnn", "0")
os.environ.setdefault("FLAGS_enable_pir_api", "0")
os.environ.setdefault("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK", "True")

from ..schemas import DetectionBox, InspectionRowTemplate, OCRResult, PerformanceMetrics
from .mock_ai import run_ocr, run_ocr_results

try:
    from PIL import Image
except Exception:  # pragma: no cover - optional runtime dependency
    Image = None

try:
    import cv2
except Exception:  # pragma: no cover - optional runtime dependency
    cv2 = None

try:
    from ultralytics import YOLO
except Exception:  # pragma: no cover - optional runtime dependency
    YOLO = None

logger = logging.getLogger(__name__)

# 新仕様: センターラインより左の tube のみ 180°回転して OCR。nmb/label 系は一切回転しない。
ROTATE_TUBE_KEYWORDS = ("tube", "tube_l", "tube_r", "left_tube", "right_tube", "tube_left", "tube_right")
ROTATE_EXCLUDE_KEYWORDS = ("nmb", "label", "number", "terminal", "term", "no", "line")


DEFAULT_OCR_PREPROCESS_CONFIG: dict[str, Any] = {
    "preprocess": {
        "ratio_threshold": 1.6,
        "operations": {
            "threshold": {"type": "binary", "value": 90},
            "clahe": {"clip_limit": 2, "tile_grid_size": 2},
            "sharpen": {"enabled": True, "amount": 1, "sigma": 2},
            "gamma": {"enabled": False, "value": 1},
            "morph": {"enabled": False, "method": "close", "ksize": 3, "iterations": 1},
            "unsharp": {"enabled": False, "amount": 0.8, "radius": 1, "threshold": 0},
            "bilateral": {"enabled": False, "diameter": 5, "sigma_color": 50, "sigma_space": 50},
            "local_contrast": {"enabled": False, "clip_limit": 2, "tile_grid_size": 8},
            "crop_margin": {"enabled": False, "threshold": 245, "margin": 2},
            "hist_equalize": {"enabled": False},
            "stroke_boost": {"enabled": True, "method": "close", "ksize": 1, "iterations": 1},
            "denoise": {"method": "gaussian", "ksize": 1},
            "deskew": {"enabled": True},
            "resize": {"single": 64, "wide_height": 64, "keep_ratio": True},
        },
    }
}


@dataclass(frozen=True)
class DetectionResult:
    detections: list[DetectionBox]
    performance: PerformanceMetrics
    signature: str


@dataclass(frozen=True)
class OcrResult:
    text: str | None
    confidence: float
    bbox: list[float]
    success: bool
    reason: str | None
    performance: PerformanceMetrics


@dataclass(frozen=True)
class OcrResultsResult:
    ocr_results: list[OCRResult]
    performance: PerformanceMetrics
    source: str


class AIModelError(RuntimeError):
    pass


class YoloAIPipeline:
    def __init__(self) -> None:
        root = Path(__file__).resolve().parents[3]
        self._model_path = root / "model" / "yolo" / "TrmRead_yolo26s_20260401.pt"
        self._ocr_rec_model_dir = root / "model" / "paddleocr" / "en_PP-OCRv3_rec_infer" / "en_PP-OCRv3_rec_infer"
        self._ocr_v5_rec_model_dir = root / "model" / "paddleocr" / "en_PP-OCRv5_mobile_rec"
        self._model = None
        self._model_loaded = False
        self._model_error: str | None = None
        self._ocr = None
        self._ocr_loaded = False
        self._ocr_error: str | None = None
        self._paddleocr_version: str | None = None
        self._ocr_preprocess_config = DEFAULT_OCR_PREPROCESS_CONFIG
        self._ocr_preprocess_enabled = os.environ.get("OCR_PREPROCESS_ENABLED", "false").lower() == "true"
        self._ocr_debug_log_enabled = os.environ.get("OCR_DEBUG_LOG_ENABLED", "false").lower() == "true"

    def _fallback_signature(self, frame_bytes: bytes, frame_index: int) -> str:
        return sha1(frame_bytes + str(frame_index).encode("utf-8")).hexdigest()[:16]

    def _ensure_model(self) -> None:
        if self._model_loaded:
            if self._model is None:
                raise AIModelError(self._model_error or "YOLO model is not available")
            return
        self._model_loaded = True
        if YOLO is None or Image is None:
            self._model_error = "YOLO dependencies are not installed. Run: pip install -r backend/requirements.txt"
            raise AIModelError(self._model_error)
        if not self._model_path.exists():
            self._model_error = f"YOLO model file not found: {self._model_path}"
            raise AIModelError(self._model_error)
        try:
            self._model = YOLO(str(self._model_path))
        except Exception as exc:  # pragma: no cover
            self._model_error = f"Failed to load YOLO model: {exc}"
            raise AIModelError(self._model_error) from exc

    def _ensure_ocr(self) -> None:
        if self._ocr_loaded:
            if self._ocr is None and self._ocr_error:
                raise AIModelError(self._ocr_error)
            return
        self._ocr_loaded = True
        try:
            paddle = __import__("paddle")
            logger.info(
                "paddlepaddle import success version=%s FLAGS_use_mkldnn=%s FLAGS_enable_pir_api=%s",
                getattr(paddle, "__version__", "unknown"),
                os.environ.get("FLAGS_use_mkldnn"),
                os.environ.get("FLAGS_enable_pir_api"),
            )
        except Exception as exc:
            logger.info("paddlepaddle import failed reason=%s", str(exc))
            self._ocr_error = "paddlepaddle is not installed. Run: python -m pip install paddlepaddle"
            raise AIModelError(self._ocr_error) from exc
        try:
            paddleocr_module = __import__("paddleocr", fromlist=["PaddleOCR"])
            self._paddleocr_version = str(getattr(paddleocr_module, "__version__", "unknown"))
            logger.info("paddleocr import success version=%s", self._paddleocr_version)
        except Exception as exc:
            logger.info("paddleocr import failed reason=%s", str(exc))
            self._ocr_error = "PaddleOCR is not installed or failed to import. Reinstall paddleocr==2.7.3 and paddlepaddle==2.6.2."
            raise AIModelError(self._ocr_error) from exc
        if not self._ocr_rec_model_dir.exists():
            self._ocr_error = f"PaddleOCR rec model not found: {self._ocr_rec_model_dir}"
            raise AIModelError(self._ocr_error)
        has_params = (self._ocr_rec_model_dir / "inference.pdiparams").exists()
        has_graph = (self._ocr_rec_model_dir / "inference.pdmodel").exists()
        if not (has_params and has_graph):
            self._ocr_error = (
                f"Invalid PaddleOCR rec model files in {self._ocr_rec_model_dir}. "
                "Required for PaddleOCR 2.x: inference.pdiparams and inference.pdmodel."
            )
            raise AIModelError(self._ocr_error)
        try:
            utility_module = __import__("paddleocr.tools.infer.utility", fromlist=["parse_args"])
            rec_module = __import__("paddleocr.tools.infer.predict_rec", fromlist=["TextRecognizer"])
            args = utility_module.init_args().parse_args([])
            args.use_gpu = False
            args.show_log = False
            args.rec_model_dir = str(self._ocr_rec_model_dir)
            args.rec_algorithm = "SVTR_LCNet"
            args.rec_image_shape = "3,48,320"
            args.rec_batch_num = 1
            args.rec_char_dict_path = str(Path(paddleocr_module.__file__).resolve().parent / "ppocr" / "utils" / "en_dict.txt")
            args.use_space_char = True
            args.benchmark = False
            args.use_onnx = False
            args.enable_mkldnn = False
            args.ir_optim = True
            self._ocr = rec_module.TextRecognizer(args)
            logger.info(
                "PaddleOCR recognizer loaded version=%s rec_model_dir=%s rec_algorithm=%s rec_image_shape=%s",
                self._paddleocr_version,
                str(self._ocr_rec_model_dir),
                args.rec_algorithm,
                args.rec_image_shape,
            )
        except ModuleNotFoundError as exc:
            if "paddleocr.tools" not in str(exc):
                self._ocr = None
                self._ocr_error = f"Failed to load PaddleOCR rec model: {exc}"
                raise AIModelError(self._ocr_error) from exc
            if not self._ocr_v5_rec_model_dir.exists():
                self._ocr = None
                self._ocr_error = f"PaddleOCR 3.x rec model not found: {self._ocr_v5_rec_model_dir}"
                raise AIModelError(self._ocr_error) from exc
            try:
                text_recognition = getattr(paddleocr_module, "TextRecognition")
                self._ocr = text_recognition(
                    model_name="en_PP-OCRv5_mobile_rec",
                    model_dir=str(self._ocr_v5_rec_model_dir),
                )
                logger.info(
                    "PaddleOCR TextRecognition loaded version=%s rec_model_dir=%s",
                    self._paddleocr_version,
                    str(self._ocr_v5_rec_model_dir),
                )
            except Exception as v5_exc:
                self._ocr = None
                self._ocr_error = f"Failed to load PaddleOCR TextRecognition model: {v5_exc}"
                raise AIModelError(self._ocr_error) from v5_exc
        except Exception as exc:
            self._ocr = None
            self._ocr_error = f"Failed to load PaddleOCR rec model: {exc}"
            raise AIModelError(self._ocr_error) from exc

    def detect(self, frame_bytes: bytes, frame_index: int, confidence_threshold: float = 0.25) -> DetectionResult:
        start = perf_counter()
        detections: list[DetectionBox] = []
        signature = self._fallback_signature(frame_bytes, frame_index)
        self._ensure_model()
        image = Image.open(io.BytesIO(frame_bytes)).convert("RGB")
        result = self._model.predict(image, verbose=False)[0]
        names = result.names if hasattr(result, "names") else {}
        width = float(result.orig_shape[1])
        height = float(result.orig_shape[0])
        boxes = result.boxes
        if boxes is not None:
            for b in boxes:
                xyxy = b.xyxy[0].tolist()
                conf = float(b.conf[0])
                cls_id = int(b.cls[0])
                x1, y1, x2, y2 = xyxy
                nx = max(0.0, min(1.0, x1 / width))
                ny = max(0.0, min(1.0, y1 / height))
                nw = max(0.0, min(1.0, (x2 - x1) / width))
                nh = max(0.0, min(1.0, (y2 - y1) / height))
                if conf < confidence_threshold:
                    continue
                detections.append(
                    DetectionBox(
                        label=str(names.get(cls_id, cls_id)),
                        confidence=conf,
                        x=nx,
                        y=ny,
                        width=nw,
                        height=nh,
                    )
                )
        if detections:
            top = detections[0]
            signature = f"{top.label}:{round(top.x,3)}:{round(top.y,3)}:{round(top.width,3)}:{round(top.height,3)}"
        elapsed = int((perf_counter() - start) * 1000)
        return DetectionResult(
            detections=detections,
            performance=PerformanceMetrics(yolo_ms=elapsed, ocr_ms=0, total_ms=elapsed),
            signature=signature,
        )

    def ocr_detections(
        self,
        frame_bytes: bytes,
        detections: list[DetectionBox],
        ocr_confidence_threshold: float = 0.5,
        rotate_left_tube_ocr: bool = False,
    ) -> PerformanceMetrics:
        start = perf_counter()
        if not detections:
            return PerformanceMetrics(yolo_ms=0, ocr_ms=0, total_ms=0)
        if Image is None:
            return PerformanceMetrics(yolo_ms=0, ocr_ms=0, total_ms=0)
        self._ensure_ocr()
        image = Image.open(io.BytesIO(frame_bytes)).convert("RGB")
        width, height = image.size
        for det in detections:
            x1 = int(max(0, min(width - 1, det.x * width)))
            y1 = int(max(0, min(height - 1, det.y * height)))
            x2 = int(max(x1 + 1, min(width, (det.x + det.width) * width)))
            y2 = int(max(y1 + 1, min(height, (det.y + det.height) * height)))
            crop = image.crop((x1, y1, x2, y2))
            bbox_pixel = {"x": x1, "y": y1, "w": x2 - x1, "h": y2 - y1}
            rotated, _rotate_reason = self._should_rotate_left_tube(det, bbox_pixel, width, rotate_left_tube_ocr, is_debug_crop=False)
            if rotated:
                crop = crop.transpose(Image.Transpose.ROTATE_180)
                det.role = det.role or "tube"
                det.side = det.side or "left"
            try:
                result = self._ocr.ocr(__import__("numpy").array(crop), cls=False)
                text_parts: list[str] = []
                if result and result[0]:
                    for line in result[0]:
                        if len(line) >= 2 and line[1]:
                            score = float(line[1][1]) if len(line[1]) > 1 else 0.0
                            if score >= ocr_confidence_threshold:
                                text_parts.append(str(line[1][0]))
                det.ocr_text = " ".join(text_parts).strip() or None
            except Exception:
                det.ocr_text = None
        elapsed = int((perf_counter() - start) * 1000)
        return PerformanceMetrics(yolo_ms=0, ocr_ms=elapsed, total_ms=elapsed)

    def ocr_results(
        self,
        frame_bytes: bytes,
        detections: list[DetectionBox],
        target_row: InspectionRowTemplate | None,
        frame_index: int,
        ocr_confidence_threshold: float = 0.5,
        rotate_left_tube_ocr: bool = False,
    ) -> OcrResultsResult:
        logger.debug("ENTER pipeline.ocr_results")
        start = perf_counter()
        try:
            paddle_results = self._ocr_results_with_paddleocr(
                frame_bytes,
                detections,
                frame_index,
                ocr_confidence_threshold=ocr_confidence_threshold,
                rotate_left_tube_ocr=rotate_left_tube_ocr,
            )
            elapsed = int((perf_counter() - start) * 1000)
            if paddle_results:
                logger.info("source=paddleocr count=%s", len(paddle_results))
                return OcrResultsResult(
                    ocr_results=paddle_results,
                    performance=PerformanceMetrics(yolo_ms=0, ocr_ms=elapsed, total_ms=elapsed),
                    source="paddleocr",
                )
            logger.info("source=paddleocr empty; fallback=mock_ai")
        except AIModelError as exc:
            logger.info("source=paddleocr failed reason=%s; fallback=mock_ai", str(exc))
        except Exception as exc:
            logger.info("source=paddleocr failed reason=%s; fallback=mock_ai", str(exc))

        mock_start = perf_counter()
        results = run_ocr_results(detections, target_row, frame_index)
        filtered = [result for result in results if result.text and result.confidence >= ocr_confidence_threshold]
        elapsed = int((perf_counter() - mock_start) * 1000)
        logger.info("source=mock_ai count=%s", len(filtered))
        return OcrResultsResult(
            ocr_results=filtered,
            performance=PerformanceMetrics(yolo_ms=0, ocr_ms=elapsed, total_ms=elapsed),
            source="mock_ai",
        )

    def ocr(
        self,
        frame_bytes: bytes,
        target_row: InspectionRowTemplate,
        stable_count: int,
        frame_index: int,
    ) -> OcrResult:
        """安定化した対象行(target_row)に対する行OCR。session_manager の should_ocr 経路で使用。"""
        start = perf_counter()
        result = run_ocr(frame_bytes, target_row, stable_count, frame_index)
        elapsed = int((perf_counter() - start) * 1000)
        return OcrResult(
            text=result.text,
            confidence=result.confidence,
            bbox=result.bbox,
            success=result.success,
            reason=result.reason,
            performance=PerformanceMetrics(yolo_ms=0, ocr_ms=elapsed, total_ms=elapsed),
        )

    def _ocr_results_with_paddleocr(
        self,
        frame_bytes: bytes,
        detections: list[DetectionBox],
        frame_index: int,
        ocr_confidence_threshold: float = 0.5,
        rotate_left_tube_ocr: bool = False,
    ) -> list[OCRResult]:
        logger.debug("ENTER _ocr_results_with_paddleocr")
        if Image is None:
            raise AIModelError("Pillow is not installed. Run: pip install -r backend/requirements.txt")
        self._ensure_ocr()
        if self._ocr is None:
            raise AIModelError(self._ocr_error or "PaddleOCR is not available")

        image = Image.open(io.BytesIO(frame_bytes)).convert("RGB")
        image_width, image_height = image.size
        crop_targets = detections or self._debug_ocr_crop_targets()
        debug_crop_used = not detections
        logger.info(
            "PaddleOCR check detections_count=%s debug_crop=%s crop_count=%s",
            len(detections),
            debug_crop_used,
            len(crop_targets),
        )
        results: list[OCRResult] = []
        for detection_index, det in enumerate(crop_targets):
            fields_text = self._detection_text_fields(det)
            is_rotate_tube = self._is_rotate_tube_detection(det)
            x1 = int(max(0, min(image_width - 1, det.x * image_width)))
            y1 = int(max(0, min(image_height - 1, det.y * image_height)))
            x2 = int(max(x1 + 1, min(image_width, (det.x + det.width) * image_width)))
            y2 = int(max(y1 + 1, min(image_height, (det.y + det.height) * image_height)))
            crop = image.crop((x1, y1, x2, y2))
            bbox_pixel = {"x": x1, "y": y1, "w": x2 - x1, "h": y2 - y1}
            is_left_of_guide = self._center_x_of_detection(det, image_width) < image_width * 0.5
            rotated, reason = self._should_rotate_left_tube(
                det,
                bbox_pixel,
                image_width,
                rotate_left_tube_ocr,
                is_debug_crop=debug_crop_used,
            )
            crop_shape_before = self._shape_of(crop)
            if rotated:
                crop = crop.transpose(Image.Transpose.ROTATE_180)
                det.role = det.role or "tube"
                det.side = det.side or "left"
            crop_shape_after_rotate = self._shape_of(crop)
            crop_array = __import__("numpy").array(crop)
            preprocessed_crop, applied_ops = (
                preprocess_ocr_crop(crop_array, self._ocr_preprocess_config)
                if self._ocr_preprocess_enabled
                else (crop_array, [])
            )
            crop_shape_after_preprocess = self._shape_of(preprocessed_crop)
            ratio = self._ratio_of(crop_array)
            if self._ocr_debug_log_enabled:
                logger.info(
                    "PaddleOCR preprocess rotate_left_tube_ocr=%s detection_index=%s class_name=%s role=%s side=%s fields_text=%s bbox_raw=%s bbox_pixel=%s guide_x=%s center_x=%s image_center_x=%s is_rotate_tube=%s is_left_of_guide=%s is_debug_crop=%s rotated=%s reason=%s crop_shape_before=%s crop_shape_after_rotate=%s crop_shape_after_preprocess=%s ratio=%.3f ops=%s",
                    rotate_left_tube_ocr,
                    detection_index,
                    self._class_name(det),
                    det.role,
                    det.side,
                    fields_text,
                    [det.x, det.y, det.width, det.height],
                    [x1, y1, x2, y2],
                    0.5,
                    self._center_x_of_detection(det, image_width),
                    image_width * 0.5,
                    is_rotate_tube,
                    is_left_of_guide,
                    debug_crop_used,
                    rotated,
                    reason,
                    crop_shape_before,
                    crop_shape_after_rotate,
                    crop_shape_after_preprocess,
                    ratio,
                    applied_ops,
                )
            self._maybe_save_debug_crop(
                preprocessed_crop,
                frame_bytes,
                det,
                frame_index=frame_index,
                detection_index=detection_index,
                rotated=rotated,
            )
            try:
                paddle_output = self._run_paddle_ocr(preprocessed_crop)
            except Exception:
                logger.exception("PaddleOCR failed")
                raise
            if self._ocr_debug_log_enabled:
                logger.info(
                    "PaddleOCR crop rotate_left_tube_ocr=%s detection_index=%s class_name=%s role=%s side=%s fields_text=%s bbox_raw=%s bbox_pixel=%s is_rotate_tube=%s is_left_of_guide=%s rotated=%s reason=%s",
                    rotate_left_tube_ocr,
                    detection_index,
                    self._class_name(det),
                    det.role,
                    det.side,
                    fields_text,
                    [det.x, det.y, det.width, det.height],
                    [x1, y1, x2, y2],
                    is_rotate_tube,
                    is_left_of_guide,
                    rotated,
                    reason,
                )
                logger.debug(
                    "PaddleOCR raw output detection_index=%s bbox=%s output=%s",
                    detection_index,
                    [det.x, det.y, det.width, det.height],
                    paddle_output,
                )
            for text, score in self._extract_paddle_text_scores(paddle_output):
                if not text or score < ocr_confidence_threshold:
                    continue
                results.append(
                    OCRResult(
                        text=text,
                        confidence=score,
                        bbox=[det.x, det.y, det.width, det.height],
                        source="paddleocr",
                        rotated=rotated,
                        rotation_deg=180 if rotated else 0,
                        side="left" if rotated else det.side,
                        role="tube" if rotated else det.role,
                    )
                )
        return results

    def _maybe_save_debug_crop(
        self,
        crop: object,
        frame_bytes: bytes,
        detection: DetectionBox,
        frame_index: int,
        detection_index: int,
        rotated: bool,
    ) -> None:
        if os.environ.get("OCR_DEBUG_SAVE_CROPS", "").lower() != "true":
            return
        if Image is None:
            return
        debug_dir = Path(__file__).resolve().parents[2] / "debug_ocr_crops"
        debug_dir.mkdir(parents=True, exist_ok=True)
        image = Image.fromarray(crop if hasattr(crop, "shape") else __import__("numpy").array(crop))
        frame_sig = self._fallback_signature(frame_bytes, frame_index)
        safe_label = detection.label.replace("/", "_").replace("\\", "_")
        suffix = "rotated" if rotated else "normal"
        path = debug_dir / f"frame{frame_index:04d}_det{detection_index:02d}_{frame_sig}_{safe_label}_{suffix}.png"
        try:
            image.save(path)
        except Exception:
            logger.debug("Failed to save debug crop path=%s", path, exc_info=True)

    def _shape_of(self, image: object) -> list[int]:
        shape = getattr(image, "shape", None)
        if not shape:
            return []
        return [int(value) for value in shape]

    def _ratio_of(self, image: object) -> float:
        shape = getattr(image, "shape", None)
        if not shape or len(shape) < 2:
            return 0.0
        height = float(shape[0])
        width = float(shape[1])
        return width / height if height else 0.0

    def _class_name(self, detection: DetectionBox) -> str:
        return detection.label or ""

    def _center_x_of_detection(self, detection: DetectionBox, image_width: int | float) -> float:
        return (detection.x + detection.width / 2) * float(image_width)

    def _bbox_center_x(self, bbox_pixel: object) -> float:
        if isinstance(bbox_pixel, dict):
            return float(bbox_pixel["x"]) + float(bbox_pixel["w"]) / 2
        if hasattr(bbox_pixel, "x") and hasattr(bbox_pixel, "w"):
            return float(bbox_pixel.x) + float(bbox_pixel.w) / 2
        x, y, w, h = bbox_pixel
        return float(x) + float(w) / 2

    def _detection_text_fields(self, detection: DetectionBox | dict[str, Any]) -> str:
        values: list[Any] = []
        if isinstance(detection, dict):
            values.extend(
                [
                    detection.get("label"),
                    detection.get("class_name"),
                    detection.get("role"),
                    detection.get("name"),
                    detection.get("side"),
                ]
            )
        else:
            values.extend(
                [
                    getattr(detection, "label", None),
                    getattr(detection, "class_name", None),
                    getattr(detection, "role", None),
                    getattr(detection, "name", None),
                    getattr(detection, "side", None),
                ]
            )
        return " ".join(str(value).lower() for value in values if value)

    def _is_rotate_tube_detection(self, detection: DetectionBox | dict[str, Any]) -> bool:
        text = self._detection_text_fields(detection)
        if not text:
            return False
        # nmb/label 系は除外。tube 系のみ回転対象。
        if any(token in text for token in ROTATE_EXCLUDE_KEYWORDS):
            return False
        return any(token in text for token in ROTATE_TUBE_KEYWORDS)

    def _should_rotate_left_tube(
        self,
        detection: DetectionBox | dict[str, Any],
        bbox_pixel: object,
        image_width: int | float,
        rotate_left_tube_ocr: bool,
        is_debug_crop: bool = False,
    ) -> tuple[bool, str]:
        if not rotate_left_tube_ocr:
            return False, "rotate_disabled"
        if is_debug_crop:
            return False, "debug_crop_no_rotate"
        if not self._is_rotate_tube_detection(detection):
            return False, "not_left_tube_target"
        center_x = self._bbox_center_x(bbox_pixel)
        if center_x >= image_width * 0.5:
            return False, "right_of_guide"
        return True, "rotate_left_tube"

    def _debug_ocr_crop_targets(self) -> list[DetectionBox]:
        return [
            DetectionBox(label="debug-full-frame", confidence=1.0, x=0.0, y=0.0, width=1.0, height=1.0),
            DetectionBox(label="debug-center-region", confidence=1.0, x=0.1, y=0.18, width=0.8, height=0.64),
        ]

    def _run_paddle_ocr(self, crop: object) -> object:
        numpy = __import__("numpy")
        image_array = numpy.array(crop)
        if hasattr(self._ocr, "__call__"):
            return self._ocr([image_array[:, :, ::-1].copy()])
        if hasattr(self._ocr, "ocr"):
            try:
                return self._ocr.ocr(image_array, cls=False)
            except TypeError:
                return self._ocr.ocr(image_array)
        if hasattr(self._ocr, "predict"):
            return self._ocr.predict(image_array)
        raise AIModelError("PaddleOCR runtime has neither ocr() nor predict()")

    def _extract_paddle_text_scores(self, output: object) -> list[tuple[str, float]]:
        pairs: list[tuple[str, float]] = []
        if not output:
            return pairs
        for item in output if isinstance(output, list) else [output]:
            if not item:
                continue
            if isinstance(item, tuple) and len(item) >= 2 and isinstance(item[0], str):
                pairs.append((item[0].strip(), float(item[1])))
                continue
            if isinstance(item, tuple):
                pairs.extend(self._extract_paddle_text_scores(list(item)))
                continue
            if isinstance(item, list):
                pairs.extend(self._extract_paddle_text_scores(item))
                continue
            if isinstance(item, dict):
                rec_texts = item.get("rec_texts")
                rec_scores = item.get("rec_scores")
                if isinstance(rec_texts, list):
                    for index, value in enumerate(rec_texts):
                        text = str(value or "").strip()
                        score = 0.0
                        if isinstance(rec_scores, list) and index < len(rec_scores):
                            score = float(rec_scores[index] or 0.0)
                        if text:
                            pairs.append((text, score))
                text = str(item.get("text") or item.get("rec_text") or "").strip()
                score = float(item.get("confidence") or item.get("score") or item.get("rec_score") or 0.0)
                if text:
                    pairs.append((text, score))
                continue
            json_data = getattr(item, "json", None)
            if isinstance(json_data, dict):
                pairs.extend(self._extract_paddle_text_scores(json_data))
                continue
            res_data = getattr(item, "res", None)
            if isinstance(res_data, dict):
                pairs.extend(self._extract_paddle_text_scores(res_data))
                continue
        return pairs


def preprocess_ocr_crop(crop: Any, config: dict[str, Any] | None = None) -> tuple[Any, list[str]]:
    if cv2 is None:
        return crop, []
    numpy = __import__("numpy")
    cfg = config or DEFAULT_OCR_PREPROCESS_CONFIG
    ops = cfg.get("preprocess", {}).get("operations", {})
    ratio_threshold = float(cfg.get("preprocess", {}).get("ratio_threshold", 1.6))
    applied: list[str] = []

    if crop is None:
        return crop, applied
    image = crop.copy()
    if getattr(image, "size", 0) == 0:
        return crop, applied
    if image.ndim == 2:
        gray = image
    elif image.ndim == 3 and image.shape[2] in (3, 4):
        if image.shape[2] == 4:
            image = cv2.cvtColor(image, cv2.COLOR_RGBA2RGB)
        gray = cv2.cvtColor(image, cv2.COLOR_RGB2GRAY)
    else:
        return crop, applied

    crop_margin = ops.get("crop_margin", {})
    if crop_margin.get("enabled"):
        threshold = int(crop_margin.get("threshold", 245))
        margin = int(crop_margin.get("margin", 2))
        mask = gray < threshold
        points = numpy.argwhere(mask)
        if points.size > 0:
            y0, x0 = points.min(axis=0)
            y1, x1 = points.max(axis=0) + 1
            y0 = max(0, y0 - margin)
            x0 = max(0, x0 - margin)
            y1 = min(gray.shape[0], y1 + margin)
            x1 = min(gray.shape[1], x1 + margin)
            image = image[y0:y1, x0:x1]
            gray = gray[y0:y1, x0:x1]
            applied.append("crop_margin")

    deskew = ops.get("deskew", {})
    if deskew.get("enabled") and gray.size:
        coords = numpy.column_stack(numpy.where(gray < 250))
        if coords.size > 0:
            try:
                angle = cv2.minAreaRect(coords)[-1]
            except Exception:
                angle = 0.0
            if angle < -45:
                angle = 90 + angle
            elif angle > 45:
                angle = angle - 90
            if abs(angle) >= 0.5:
                h, w = gray.shape[:2]
                mat = cv2.getRotationMatrix2D((w / 2, h / 2), angle, 1.0)
                image = cv2.warpAffine(image, mat, (w, h), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)
                gray = cv2.cvtColor(image, cv2.COLOR_RGB2GRAY) if image.ndim == 3 else image
                applied.append("deskew")

    if image.ndim == 3:
        gray = cv2.cvtColor(image, cv2.COLOR_RGB2GRAY)
        applied.append("grayscale")

    clahe = ops.get("clahe", {})
    if clahe:
        grid = max(1, int(clahe.get("tile_grid_size", 2)))
        clahe_impl = cv2.createCLAHE(clipLimit=float(clahe.get("clip_limit", 2)), tileGridSize=(grid, grid))
        gray = clahe_impl.apply(gray)
        applied.append("clahe")

    denoise = ops.get("denoise", {})
    if denoise.get("method") == "gaussian":
        ksize = max(1, int(denoise.get("ksize", 1)))
        if ksize > 1:
            gray = cv2.GaussianBlur(gray, (ksize | 1, ksize | 1), 0)
            applied.append("denoise")

    sharpen = ops.get("sharpen", {})
    if sharpen.get("enabled"):
        amount = float(sharpen.get("amount", 1))
        sigma = float(sharpen.get("sigma", 2))
        blurred = cv2.GaussianBlur(gray, (0, 0), sigma)
        gray = cv2.addWeighted(gray, 1 + amount, blurred, -amount, 0)
        applied.append("sharpen")

    stroke = ops.get("stroke_boost", {})
    if stroke.get("enabled"):
        ksize = max(1, int(stroke.get("ksize", 1)))
        if ksize > 1:
            kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (ksize, ksize))
            gray = cv2.morphologyEx(gray, cv2.MORPH_CLOSE, kernel, iterations=int(stroke.get("iterations", 1)))
        applied.append("stroke_boost")

    gamma = ops.get("gamma", {})
    if gamma.get("enabled"):
        value = max(0.1, float(gamma.get("value", 1)))
        inv = 1.0 / value
        table = numpy.array([((i / 255.0) ** inv) * 255 for i in range(256)]).astype("uint8")
        gray = cv2.LUT(gray, table)
        applied.append("gamma")

    threshold = ops.get("threshold", {})
    if threshold.get("type") == "binary":
        _, gray = cv2.threshold(gray, int(threshold.get("value", 90)), 255, cv2.THRESH_BINARY)
        applied.append("threshold")

    morph = ops.get("morph", {})
    if morph.get("enabled"):
        method = cv2.MORPH_CLOSE if str(morph.get("method", "close")).lower() == "close" else cv2.MORPH_OPEN
        ksize = max(1, int(morph.get("ksize", 3)))
        kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (ksize, ksize))
        gray = cv2.morphologyEx(gray, method, kernel, iterations=int(morph.get("iterations", 1)))
        applied.append("morph")

    resize = ops.get("resize", {})
    target_h = int(resize.get("wide_height", 64) if (gray.shape[1] / max(1, gray.shape[0])) > ratio_threshold else resize.get("single", 64))
    target_h = max(1, target_h)
    if resize.get("keep_ratio", True):
        h, w = gray.shape[:2]
        target_w = max(1, int(round(w * (target_h / max(1, h)))))
    else:
        target_w = max(1, int(resize.get("single", 64)))
    gray = cv2.resize(gray, (target_w, target_h), interpolation=cv2.INTER_CUBIC)
    applied.append("resize")

    if gray.ndim == 2:
        gray = cv2.cvtColor(gray, cv2.COLOR_GRAY2RGB)
    return gray, applied


pipeline = YoloAIPipeline()
