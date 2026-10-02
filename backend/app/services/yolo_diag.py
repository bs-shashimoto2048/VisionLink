"""Opt-in diagnostics for YOLO detection (YOLO_DEBUG_LOG_ENABLED=true). Pure helpers; no behaviour change when off.

Why: `detect()` only keeps boxes whose confidence is >= the request threshold (default 0.6), and the normal logs
show only those. To tell "the camera is not looking at the terminal block" apart from "boxes exist but sit just
under the threshold", we need the box count / confidence *before* the threshold, plus frame quality.
"""
from __future__ import annotations

from collections import Counter
from typing import Any, Iterable

_EDGES = (0.25, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.01)


def summarize_boxes(boxes: Iterable[tuple[str, float]], threshold: float) -> dict[str, Any]:
    """boxes: (class label, confidence) for every box the model returned (ultralytics already drops < 0.25)."""
    items = [(str(label), float(conf)) for label, conf in boxes]
    confs = [c for _, c in items]
    hist: Counter[str] = Counter()
    for conf in confs:
        for lo, hi in zip(_EDGES, _EDGES[1:]):
            if lo <= conf < hi:
                hist[f"{lo:.2f}-{min(hi, 1.0):.2f}"] += 1
                break
    kept = [(l, c) for l, c in items if c >= threshold]
    return {
        "raw_boxes": len(items),
        "above_threshold": len(kept),
        "below_threshold": len(items) - len(kept),
        "threshold": threshold,
        "max_conf": max(confs) if confs else 0.0,
        "classes_raw": dict(Counter(l for l, _ in items)),
        "classes_kept": dict(Counter(l for l, _ in kept)),
        "conf_hist": dict(hist),
    }


def frame_quality(gray: Any) -> dict[str, float]:
    """gray: 2-D numpy array (uint8/float). Returns blur (variance of the Laplacian: low = blurry) and brightness."""
    import numpy as np

    g = np.asarray(gray, dtype=np.float32)
    if g.ndim != 2 or g.shape[0] < 3 or g.shape[1] < 3:
        return {"blur_laplacian_var": 0.0, "brightness": float(g.mean()) if g.size else 0.0}
    lap = -4.0 * g[1:-1, 1:-1] + g[:-2, 1:-1] + g[2:, 1:-1] + g[1:-1, :-2] + g[1:-1, 2:]
    return {"blur_laplacian_var": float(lap.var()), "brightness": float(g.mean())}


def format_diag(frame_index: int, width: int, height: int, summary: dict[str, Any], quality: dict[str, float]) -> str:
    aspect = (width / height) if height else 0.0
    return (
        "YOLO diag frame_index=%s size=%sx%s aspect=%.3f raw_boxes=%s above_threshold=%s below_threshold=%s "
        "threshold=%.2f max_conf=%.2f classes_raw=%s classes_kept=%s conf_hist=%s blur_laplacian_var=%.1f brightness=%.1f"
        % (
            frame_index, width, height, aspect, summary["raw_boxes"], summary["above_threshold"], summary["below_threshold"],
            summary["threshold"], summary["max_conf"], summary["classes_raw"], summary["classes_kept"], summary["conf_hist"],
            quality["blur_laplacian_var"], quality["brightness"],
        )
    )
