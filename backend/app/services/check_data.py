from __future__ import annotations

import csv
from pathlib import Path

from ..config import CHECK_DATA_ROOT
from ..schemas import CheckDataRow, CheckDataTableResponse

REQUIRED_COLUMNS = {"tube_l", "label", "tube_r"}


class CheckDataError(ValueError):
    pass


def _validate_part(value: str, name: str, *, allow_csv_suffix: bool = False) -> str:
    normalized = value[:-4] if allow_csv_suffix and value.lower().endswith(".csv") else value
    if not normalized or ".." in normalized or "/" in normalized or "\\" in normalized:
        raise CheckDataError(f"invalid {name}")
    if normalized.lower().endswith(".csv"):
        raise CheckDataError(f"{name} must not include .csv")
    return normalized


def _ensure_under_root(path: Path) -> Path:
    root = CHECK_DATA_ROOT.resolve()
    resolved = path.resolve()
    if resolved != root and root not in resolved.parents:
        raise CheckDataError("resolved path is outside CHECK_DATA_ROOT")
    return resolved


def _list_dirs(path: Path) -> list[str]:
    resolved = _ensure_under_root(path)
    if not resolved.exists():
        return []
    if not resolved.is_dir():
        raise CheckDataError("check data path is not a directory")
    return sorted(item.name for item in resolved.iterdir() if item.is_dir())


def list_serials() -> list[str]:
    return _list_dirs(CHECK_DATA_ROOT)


def list_boards(serial: str) -> list[str]:
    serial_name = _validate_part(serial, "serial")
    return _list_dirs(CHECK_DATA_ROOT / serial_name)


def list_terminals(serial: str, board: str) -> list[str]:
    serial_name = _validate_part(serial, "serial")
    board_name = _validate_part(board, "board")
    board_dir = _ensure_under_root(CHECK_DATA_ROOT / serial_name / board_name)
    if not board_dir.exists():
        return []
    if not board_dir.is_dir():
        raise CheckDataError("board path is not a directory")
    return sorted(item.stem for item in board_dir.iterdir() if item.is_file() and item.suffix.lower() == ".csv")


def load_table(serial: str, board: str, terminal: str) -> CheckDataTableResponse:
    serial_name = _validate_part(serial, "serial")
    board_name = _validate_part(board, "board")
    terminal_name = _validate_part(terminal, "terminal", allow_csv_suffix=True)
    csv_path = _ensure_under_root(CHECK_DATA_ROOT / serial_name / board_name / f"{terminal_name}.csv")
    if not csv_path.exists():
        raise FileNotFoundError(f"CSV not found: {terminal_name}.csv")
    if not csv_path.is_file():
        raise CheckDataError("terminal path is not a file")

    rows: list[CheckDataRow] = []
    with csv_path.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        fieldnames = set(reader.fieldnames or [])
        missing = REQUIRED_COLUMNS - fieldnames
        if missing:
            raise CheckDataError(f"required columns missing: {', '.join(sorted(missing))}")
        for row in reader:
            tube_l = (row.get("tube_l") or "").strip()
            label = (row.get("label") or "").strip()
            tube_r = (row.get("tube_r") or "").strip()
            if not tube_l and not label and not tube_r:
                continue
            rows.append(CheckDataRow(tube_l=tube_l, label=label, tube_r=tube_r))

    return CheckDataTableResponse(serial=serial_name, board=board_name, terminal=terminal_name, rows=rows)
