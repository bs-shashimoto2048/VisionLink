import type { CheckDataStatus, CheckRow, OCRResult } from "./types";

export function normalizeCheckText(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "")
    .replace(/O/g, "0");
}

function getOcrText(result: OCRResult | undefined): string {
  return normalizeCheckText(result?.text ?? result?.ocr_text ?? result?.value ?? result?.label ?? "");
}

type Box = { x: number; y: number; width: number; height: number };

function getBox(result: OCRResult | undefined): Box | null {
  const bbox = result?.bbox;
  if (!Array.isArray(bbox) || bbox.length < 4) return null;
  const [x, y, width, height] = bbox.map(Number);
  if (![x, y, width, height].every(Number.isFinite)) return null;
  return { x, y, width, height };
}

function centerX(box: Box): number {
  return box.x + box.width / 2;
}

function centerY(box: Box): number {
  return box.y + box.height / 2;
}

function detectionText(value: { label?: string | null; class_name?: string | null; role?: string | null; name?: string | null }): string {
  return [value.label, value.class_name, value.role, value.name]
    .map(normalizeCheckText)
    .join(" ");
}

function isLabelDetection(value: { label?: string | null; class_name?: string | null; role?: string | null; name?: string | null }): boolean {
  const text = detectionText(value);
  if (!text) return false;
  if (["TUBE", "TUBE_L", "TUBE_R", "LEFT_TUBE", "RIGHT_TUBE", "TUBE_LEFT", "TUBE_RIGHT"].some((token) => text.includes(token))) {
    return false;
  }
  return ["NMB", "LABEL", "NUMBER", "TERMINAL", "TERM", "NO", "LINE"].some((token) => text.includes(token));
}

function isTubeDetection(value: { label?: string | null; class_name?: string | null; role?: string | null; name?: string | null }): boolean {
  const text = detectionText(value);
  if (!text) return false;
  if (["NMB", "LABEL", "NUMBER", "TERMINAL", "TERM", "NO", "LINE"].some((token) => text.includes(token))) {
    return false;
  }
  return ["TUBE", "TUBE_L", "TUBE_R", "LEFT_TUBE", "RIGHT_TUBE", "TUBE_LEFT", "TUBE_RIGHT"].some((token) => text.includes(token));
}

function isGoodStatus(status?: CheckDataStatus): boolean {
  return status === "OK";
}

function isSameRowBand(labelBox: Box, tubeBox: Box): boolean {
  const verticalDistance = Math.abs(centerY(labelBox) - centerY(tubeBox));
  const tolerance = Math.max(labelBox.height, tubeBox.height) * 2.5;
  const overlapsVertically =
    Math.max(labelBox.y, tubeBox.y) <= Math.min(labelBox.y + labelBox.height, tubeBox.y + tubeBox.height);
  return overlapsVertically || verticalDistance <= tolerance;
}

function nearestTube(
  labelBox: Box,
  tubes: Array<{ result: OCRResult; box: Box; text: string }>,
  side: "left" | "right",
  guideX: number
) {
  const labelX = centerX(labelBox);
  return tubes
    .filter(({ box }) => {
      const x = centerX(box);
      if (!isSameRowBand(labelBox, box)) return false;
      return side === "left" ? x < labelX && x < guideX : x > labelX && x >= guideX;
    })
    .sort((a, b) => Math.abs(centerX(a.box) - labelX) - Math.abs(centerX(b.box) - labelX))[0];
}

export function reconcileCheckRows(args: {
  rows: CheckRow[];
  yoloResults: Array<{ label?: string | null; class_name?: string | null; role?: string | null; name?: string | null; side?: string | null; x?: number; y?: number; width?: number; height?: number; ocr_text?: string | null }>;
  ocrResults: OCRResult[];
  guideX: number;
  frameIndex?: number;
}): CheckRow[] {
  const { rows, yoloResults, ocrResults, guideX, frameIndex } = args;

  // OCRResult が主経路。検出OCRのみ返った場合も Label/Tubes を失わないよう YOLO 結果を補助入力にする。
  const combinedResults: OCRResult[] = [...ocrResults];
  for (const detection of yoloResults) {
    const text = normalizeCheckText(detection.ocr_text);
    if (!text || detection.x == null || detection.y == null || detection.width == null || detection.height == null) continue;
    const alreadyPresent = combinedResults.some((result) => {
      const box = getBox(result);
      return box && Math.abs(box.x - detection.x!) < 0.0001 && Math.abs(box.y - detection.y!) < 0.0001;
    });
    if (!alreadyPresent) {
      combinedResults.push({
        text,
        confidence: 0,
        bbox: [detection.x, detection.y, detection.width, detection.height],
        label: detection.label,
        role: detection.role,
        side: detection.side,
        source: "detection_ocr",
      });
    }
  }

  const rowLabels = new Set(rows.map((row) => normalizeCheckText(row.label)).filter(Boolean));
  const labels = combinedResults
    .map((result) => ({ result, box: getBox(result), text: getOcrText(result) }))
    .filter((item): item is { result: OCRResult; box: Box; text: string } => Boolean(item.box && item.text))
    .filter(({ result, text }) => isLabelDetection(result) || rowLabels.has(text));

  const tubes = combinedResults
    .map((result) => ({ result, box: getBox(result), text: getOcrText(result) }))
    .filter((item): item is { result: OCRResult; box: Box; text: string } => Boolean(item.box && item.text))
    .filter(({ result }) => isTubeDetection(result));

  const nextRows = rows.map((row): CheckRow => ({ ...row }));

  for (const label of labels) {
    const rowIndex = nextRows.findIndex((row) => normalizeCheckText(row.label) === label.text);
    if (rowIndex < 0) {
      console.debug("[VisionLink] unmatched label", { frameIndex, label: label.text, bbox: label.result.bbox });
      continue;
    }

    const row = nextRows[rowIndex];
    if (row.completed || row.all_status === "OK") continue;

    const left = nearestTube(label.box, tubes, "left", guideX);
    const right = nearestTube(label.box, tubes, "right", guideX);
    const expectedLeft = normalizeCheckText(row.tube_l);
    const expectedRight = normalizeCheckText(row.tube_r);
    const leftMatched = Boolean(left && expectedLeft && left.text === expectedLeft);
    const rightMatched = Boolean(right && expectedRight && right.text === expectedRight);

    const nextLabelStatus: CheckDataStatus = "OK";
    const nextTubeLStatus: CheckDataStatus = isGoodStatus(row.tube_l_status) || leftMatched ? "OK" : (row.tube_l_status ?? "PENDING");
    const nextTubeRStatus: CheckDataStatus = isGoodStatus(row.tube_r_status) || rightMatched ? "OK" : (row.tube_r_status ?? "PENDING");
    const completed = nextLabelStatus === "OK" && nextTubeLStatus === "OK" && nextTubeRStatus === "OK";

    nextRows[rowIndex] = {
      ...row,
      label_status: nextLabelStatus,
      tube_l_status: nextTubeLStatus,
      tube_r_status: nextTubeRStatus,
      left_status: nextTubeLStatus,
      confirm_status: completed ? "OK" : (row.confirm_status ?? "PENDING"),
      all_status: completed ? "OK" : (row.all_status ?? "PENDING"),
      completed,
    };

    console.debug("[VisionLink] label anchored reconcile", {
      frameIndex,
      label: label.text,
      rowIndex,
      left: left?.text,
      expectedLeft,
      leftMatched,
      right: right?.text,
      expectedRight,
      rightMatched,
      completed,
    });
  }

  return nextRows;
}
