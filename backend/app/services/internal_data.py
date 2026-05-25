from __future__ import annotations

from dataclasses import dataclass
from hashlib import sha1

from ..schemas import InternalDataLookupRequest, InternalDataLookupResponse, InspectionRowTemplate


@dataclass(frozen=True)
class InternalLookupResult:
    source: str
    order_no: str
    serial_no: str
    terminal_name: str
    rows: list[InspectionRowTemplate]

    def to_response(self) -> InternalDataLookupResponse:
        return InternalDataLookupResponse(
            source=self.source,
            order_no=self.order_no,
            serial_no=self.serial_no,
            terminal_name=self.terminal_name,
            rows=self.rows,
        )


def _build_rows(seed: int, count: int = 6) -> list[InspectionRowTemplate]:
    rows: list[InspectionRowTemplate] = []
    for index in range(1, count + 1):
        rows.append(
            InspectionRowTemplate(
                no=index,
                line_no=f"LN-{index:03d}",
                left_value=f"L-{seed % 90 + index:02d}",
                right_value=f"R-{seed % 70 + index:02d}",
            )
        )
    return rows


def lookup_internal_data(request: InternalDataLookupRequest) -> InternalLookupResult:
    if request.order_no or request.serial_no or request.terminal_name:
        order_no = request.order_no or "ORD-2401"
        serial_no = request.serial_no or "SN-1001"
        terminal_name = request.terminal_name or "TERMINAL-A"
        seed = int(sha1(f"{order_no}:{serial_no}:{terminal_name}".encode("utf-8")).hexdigest()[:8], 16)
        return InternalLookupResult(
            source="mock-manual",
            order_no=order_no,
            serial_no=serial_no,
            terminal_name=terminal_name,
            rows=_build_rows(seed),
        )

    qr_text = request.qr_text or "DEMO-0001"
    digest = sha1(qr_text.encode("utf-8")).hexdigest()
    seed = int(digest[:8], 16)
    return InternalLookupResult(
        source="mock-qr",
        order_no=f"ORD-{seed % 9000 + 1000:04d}",
        serial_no=f"SN-{(seed // 7) % 9000 + 1000:04d}",
        terminal_name="TERMINAL-A",
        rows=_build_rows(seed),
    )

