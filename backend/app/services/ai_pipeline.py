from __future__ import annotations

from dataclasses import dataclass
from hashlib import sha1
import io
import logging
import os
from pathlib import Path
from time import perf_counter

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
    from ultralytics import YOLO
except Exception:  # pragma: no cover - optional runtime dependency
    YOLO = None

logger = logging.getLogger(__name__)


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
            rotated = rotate_left_tube_ocr and self._is_left_tube_detection(det, width)
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

    def _ocr_results_with_paddleocr(
        self,
        frame_bytes: bytes,
        detections: list[DetectionBox],
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
        for det in crop_targets:
            x1 = int(max(0, min(image_width - 1, det.x * image_width)))
            y1 = int(max(0, min(image_height - 1, det.y * image_height)))
            x2 = int(max(x1 + 1, min(image_width, (det.x + det.width) * image_width)))
            y2 = int(max(y1 + 1, min(image_height, (det.y + det.height) * image_height)))
            crop = image.crop((x1, y1, x2, y2))
            is_left_tube = self._is_left_tube_detection(det, image_width)
            rotated = rotate_left_tube_ocr and is_left_tube
            if rotated:
                crop = crop.transpose(Image.Transpose.ROTATE_180)
                det.role = det.role or "tube"
                det.side = det.side or "left"
            try:
                paddle_output = self._run_paddle_ocr(crop)
            except Exception:
                logger.exception("PaddleOCR failed")
                raise
            logger.info(
                "PaddleOCR crop rotate_left_tube_ocr=%s bbox=%s pixel_bbox=%s is_left_tube=%s rotated=%s",
                rotate_left_tube_ocr,
                [det.x, det.y, det.width, det.height],
                [x1, y1, x2, y2],
                is_left_tube,
                rotated,
            )
            logger.debug("PaddleOCR raw output bbox=%s output=%s", [det.x, det.y, det.width, det.height], paddle_output)
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

    def _is_left_tube_detection(self, detection: DetectionBox, image_width: int | float) -> bool:
        label = detection.label.lower()
        role = (detection.role or "").lower()
        side = (detection.side or "").lower()
        if side == "left" or role in {"tube_l", "left_tube", "tube_left"}:
            return True
        if any(token in label for token in ("tube_l", "left_tube", "tube_left")):
            return True
        if "tube" in label and "right" not in label and "_r" not in label:
            return detection.x + detection.width / 2 < 0.5
        # TODO: Prefer explicit YOLO class/side/role metadata and CSV tube_l matching when available.
        return detection.x + detection.width / 2 < 0.5

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

    def ocr(
        self,
        frame_bytes: bytes,
        target_row: InspectionRowTemplate,
        stable_count: int,
        frame_index: int,
    ) -> OcrResult:
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


pipeline = YoloAIPipeline()
