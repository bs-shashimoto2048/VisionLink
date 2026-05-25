from __future__ import annotations

from dataclasses import dataclass

from ..schemas import CheckStatus, InspectionRowTemplate


@dataclass(frozen=True)
class JudgementResult:
    status: CheckStatus
    reason: str


def _normalize(value: str) -> str:
    return value.replace(" ", "").replace("-", "").replace("_", "").upper()


def judge_row(target_row: InspectionRowTemplate, ocr_text: str | None) -> JudgementResult:
    if not ocr_text:
        return JudgementResult(status=CheckStatus.OCR_FAILED, reason="empty_ocr")

    normalized = _normalize(ocr_text)
    expected = _normalize(f"{target_row.line_no}|{target_row.left_value}|{target_row.right_value}")
    if normalized == expected:
        return JudgementResult(status=CheckStatus.OK, reason="exact_match")

    left = _normalize(target_row.left_value)
    right = _normalize(target_row.right_value)
    if left in normalized and right in normalized:
        return JudgementResult(status=CheckStatus.MISMATCH, reason="partial_match")

    return JudgementResult(status=CheckStatus.NG, reason="mismatch")


def effective_status(check_status: CheckStatus, manual_final_status: CheckStatus | None = None) -> CheckStatus:
    if check_status == CheckStatus.MANUAL_FIXED:
        return manual_final_status or CheckStatus.PENDING
    return check_status

