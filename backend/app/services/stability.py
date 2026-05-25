from __future__ import annotations

from dataclasses import dataclass

from ..schemas import DetectionBox


@dataclass(frozen=True)
class StabilityDecision:
    stable: bool
    reason: str


@dataclass
class OcrStabilityState:
    signature: str = ""
    stable_count: int = 0
    last_box: DetectionBox | None = None


def _box_distance(a: DetectionBox, b: DetectionBox) -> float:
    return abs(a.x - b.x) + abs(a.y - b.y) + abs(a.width - b.width) + abs(a.height - b.height)


def evaluate_ocr_stability(
    state: OcrStabilityState,
    signature: str,
    detections: list[DetectionBox],
    min_frames: int = 2,
    confidence_threshold: float = 0.75,
    position_threshold: float = 0.08,
) -> StabilityDecision:
    top_detection = detections[0] if detections else None
    if top_detection is None or top_detection.confidence < confidence_threshold:
        state.signature = signature
        state.stable_count = 0
        state.last_box = top_detection
        return StabilityDecision(stable=False, reason="low_confidence")

    if state.signature == signature and state.last_box is not None:
        distance = _box_distance(state.last_box, top_detection)
        if distance <= position_threshold:
            state.stable_count += 1
        else:
            state.stable_count = 1
    else:
        state.signature = signature
        state.stable_count = 1

    state.last_box = top_detection
    return StabilityDecision(stable=state.stable_count >= min_frames, reason="stable" if state.stable_count >= min_frames else "warming_up")

