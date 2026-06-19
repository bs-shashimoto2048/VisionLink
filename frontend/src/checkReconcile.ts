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

    const rowLabel = normalizeCheckText(row.label);
    const rowTubeL = normalizeCheckText(row.tube_l);
    const rowTubeR = normalizeCheckText(row.tube_r);
    const labelDetected = labelTexts.has(rowLabel);

    const tubeLDetected = leftTubeTexts.has(rowTubeL) || fallbackTubeTexts.has(rowTubeL);
    const tubeRDetected = rightTubeTexts.has(rowTubeR) || fallbackTubeTexts.has(rowTubeR);

    const nextTubeLStatus: CheckDataStatus = isGoodStatus(row.tube_l_status) || (labelDetected && tubeLDetected) ? "OK" : "PENDING";
    const nextTubeRStatus: CheckDataStatus = isGoodStatus(row.tube_r_status) || (labelDetected && tubeRDetected) ? "OK" : "PENDING";

    if (labelDetected && rowTubeL && rowTubeL === rowTubeR && (leftTubeTexts.has(rowTubeL) || rightTubeTexts.has(rowTubeR) || fallbackTubeTexts.has(rowTubeL))) {
      return {
        ...row,
        tube_l_status: "OK",
        tube_r_status: "OK",
        label_status: "OK",
        all_status: "OK",
        confirm_status: "OK",
        completed: true,
      };
    }

    if (nextTubeLStatus === "OK" && nextTubeRStatus === "OK") {
      return {
        ...row,
        tube_l_status: "OK",
        tube_r_status: "OK",
        label_status: "OK",
        all_status: "OK",
        confirm_status: "OK",
        completed: true,
      };
    }

    return {
      ...row,
      tube_l_status: nextTubeLStatus,
      tube_r_status: nextTubeRStatus,
      label_status: labelDetected ? "OK" : (row.label_status ?? "PENDING"),
      left_status: nextTubeLStatus,
      confirm_status: row.confirm_status ?? "PENDING",
      all_status: row.all_status ?? "PENDING",
      completed: row.completed ?? false,
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
