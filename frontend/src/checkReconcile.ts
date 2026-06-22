import type { CheckDataStatus, CheckRow, OCRResult } from "./types";

export function normalizeCheckText(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "");
}

function getOcrText(result: OCRResult | undefined): string {
  return normalizeCheckText(result?.text ?? result?.ocr_text ?? result?.value ?? result?.label ?? "");
}

function getBBoxCenterX(result: OCRResult | undefined): number | null {
  const bbox = result?.bbox;
  if (!Array.isArray(bbox) || bbox.length < 4) return null;
  const [x, _y, w, _h] = bbox.map(Number);
  if (![x, w].every(Number.isFinite)) return null;
  return x + w / 2;
}

function isRotateLabelDetection(value: { label?: string | null; class_name?: string | null; role?: string | null; name?: string | null }): boolean {
  const text = [value.label, value.class_name, value.role, value.name]
    .map(normalizeCheckText)
    .join(" ");
  if (!text) return false;
  if (["TUBE", "TUBE_L", "TUBE_R", "LEFT_TUBE", "RIGHT_TUBE", "TUBE_LEFT", "TUBE_RIGHT"].some((token) => text.includes(token))) {
    return false;
  }
  return ["NMB", "LABEL", "NUMBER", "TERMINAL", "TERM", "NO", "LINE"].some((token) => text.includes(token));
}

function isTubeDetection(value: { label?: string | null; class_name?: string | null; role?: string | null; name?: string | null }): boolean {
  const text = [value.label, value.class_name, value.role, value.name]
    .map(normalizeCheckText)
    .join(" ");
  if (!text) return false;
  if (["NMB", "LABEL", "NUMBER", "TERMINAL", "TERM", "NO", "LINE"].some((token) => text.includes(token))) {
    return false;
  }
  return ["TUBE", "TUBE_L", "TUBE_R", "LEFT_TUBE", "RIGHT_TUBE", "TUBE_LEFT", "TUBE_RIGHT"].some((token) => text.includes(token));
}

function isGoodStatus(status?: CheckDataStatus): boolean {
  return status === "OK";
}

export function reconcileCheckRows(args: {
  rows: CheckRow[];
  yoloResults: Array<{ label?: string | null; class_name?: string | null; role?: string | null; name?: string | null; side?: string | null; x?: number; width?: number; ocr_text?: string | null }>;
  ocrResults: OCRResult[];
  guideX: number;
  frameIndex?: number;
}): CheckRow[] {
  const { rows, yoloResults, ocrResults, guideX, frameIndex } = args;

  const labelTexts = new Set(
    ocrResults
      .filter((result) => {
        const matched = rows.some((row) => normalizeCheckText(row.label) === getOcrText(result));
        return matched || isRotateLabelDetection(result);
      })
      .map(getOcrText)
      .filter(Boolean)
  );

  const leftTubeTexts = new Set<string>();
  const rightTubeTexts = new Set<string>();
  const fallbackTubeTexts = new Set<string>();

  for (const result of ocrResults) {
    const text = getOcrText(result);
    if (!text) continue;
    const cx = getBBoxCenterX(result);
    if (isTubeDetection(result)) {
      if (cx !== null) {
        if (cx < guideX) {
          leftTubeTexts.add(text);
        } else {
          rightTubeTexts.add(text);
        }
      } else {
        fallbackTubeTexts.add(text);
      }
    }
  }

  const nextRows = rows.map((row): CheckRow => {
    if (row.completed || row.all_status === "OK") {
      return row;
    }

    // 各行の回答は1つ（チューブの期待値。CSV では tube_l == tube_r）。左右ともこの同じ回答と突合する。
    // 中央 label/nmb は消込判定に含めない。
    const answer = normalizeCheckText(row.tube_l) || normalizeCheckText(row.tube_r);
    const leftMatched = Boolean(answer) && (leftTubeTexts.has(answer) || fallbackTubeTexts.has(answer));
    const rightMatched = Boolean(answer) && (rightTubeTexts.has(answer) || fallbackTubeTexts.has(answer));

    // 一度 OK になった側はラッチ（保持）。リセットは行/テーブルの読み直し時のみ（= checkRows の作り直し）。
    const nextTubeLStatus: CheckDataStatus = isGoodStatus(row.tube_l_status) || leftMatched ? "OK" : "PENDING";
    const nextTubeRStatus: CheckDataStatus = isGoodStatus(row.tube_r_status) || rightMatched ? "OK" : "PENDING";

    const completed = nextTubeLStatus === "OK" && nextTubeRStatus === "OK";

    return {
      ...row,
      tube_l_status: nextTubeLStatus,
      tube_r_status: nextTubeRStatus,
      left_status: nextTubeLStatus,
      // label は判定に含めないため変更しない（既存値を維持）
      label_status: row.label_status ?? "PENDING",
      confirm_status: completed ? "OK" : (row.confirm_status ?? "PENDING"),
      all_status: completed ? "OK" : (row.all_status ?? "PENDING"),
      completed,
    };
  });

  console.debug("[VisionLink] check reconcile side sets", {
    frameIndex,
    labelTexts: Array.from(labelTexts),
    leftTubeTexts: Array.from(leftTubeTexts),
    rightTubeTexts: Array.from(rightTubeTexts),
    rows: nextRows.map((r) => ({
      label: r.label,
      tube_l: r.tube_l,
      tube_r: r.tube_r,
      tube_l_status: r.tube_l_status,
      tube_r_status: r.tube_r_status,
      label_status: r.label_status,
      all_status: r.all_status,
      completed: r.completed,
    })),
  });

  return nextRows;
}
