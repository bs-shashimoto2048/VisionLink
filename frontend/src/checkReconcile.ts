import type { CheckDataStatus, CheckRow, OCRResult } from "./types";

export function normalizeCheckText(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "")
    .replace(/O/g, "0");
}

// Tube-only comparison key: additionally treats digit "1", letter "l"/"L" and capital "I" as the same
// character (normalizeCheckText() upper-cases first, so lower-case "l" is already "L" here).
// "|" is intentionally NOT folded. Used only when matching left/right tube text; label/nmb matching and
// detection classification keep using normalizeCheckText(). Displayed / raw OCR text is never rewritten.
export function normalizeTubeCheckText(value: unknown): string {
  return normalizeCheckText(value).replace(/[LI]/g, "1");
}

function getOcrText(result: OCRResult | undefined): string {
  return normalizeCheckText(result?.text ?? result?.ocr_text ?? result?.value ?? result?.label ?? "");
}

type Box = { x: number; y: number; width: number; height: number };
export type OCRItem = { result: OCRResult; box: Box; text: string };
type RowBand = { top: number; bottom: number };

function getBox(result: OCRResult | undefined): Box | null {
  const bbox = result?.bbox;
  if (!Array.isArray(bbox) || bbox.length < 4) return null;
  const [x, y, width, height] = bbox.map(Number);
  if (![x, y, width, height].every(Number.isFinite)) return null;
  return { x, y, width, height };
}

function centerX(box: Box): number { return box.x + box.width / 2; }

// The terminal-number column sits on the center guide. A (normalized) box that straddles the guide line is a
// terminal number (label / nmb) no matter how the detector classified it; the position takes priority.
// Intersection, not center: left <= guideX <= right.
export function isBoxOnGuide(box: Box, guideX: number): boolean {
  return box.x <= guideX && guideX <= box.x + box.width;
}
function centerY(box: Box): number { return box.y + box.height / 2; }

function detectionText(value: { label?: string | null; class_name?: string | null; role?: string | null; name?: string | null }): string {
  return [value.label, value.class_name, value.role, value.name].map(normalizeCheckText).join(" ");
}

function isLabelDetection(value: { label?: string | null; class_name?: string | null; role?: string | null; name?: string | null }): boolean {
  const text = detectionText(value);
  if (!text) return false;
  if (["TUBE", "TUBE_L", "TUBE_R", "LEFT_TUBE", "RIGHT_TUBE", "TUBE_LEFT", "TUBE_RIGHT"].some((token) => text.includes(token))) return false;
  return ["NMB", "LABEL", "NUMBER", "TERMINAL", "TERM", "NO", "LINE"].some((token) => text.includes(token));
}

function isTubeDetection(value: { label?: string | null; class_name?: string | null; role?: string | null; name?: string | null }): boolean {
  const text = detectionText(value);
  if (!text) return false;
  if (["NMB", "LABEL", "NUMBER", "TERMINAL", "TERM", "NO", "LINE"].some((token) => text.includes(token))) return false;
  return ["TUBE", "TUBE_L", "TUBE_R", "LEFT_TUBE", "RIGHT_TUBE", "TUBE_LEFT", "TUBE_RIGHT"].some((token) => text.includes(token));
}

function isGoodStatus(status?: CheckDataStatus): boolean { return status === "OK"; }

function uniqueLabelsByPosition(labels: OCRItem[]): OCRItem[] {
  const sorted = [...labels].sort((a, b) => centerY(a.box) - centerY(b.box));
  const unique: OCRItem[] = [];
  for (const label of sorted) {
    const duplicate = unique.some((existing) =>
      Math.abs(centerX(existing.box) - centerX(label.box)) < 0.0001 &&
      Math.abs(centerY(existing.box) - centerY(label.box)) < 0.0001
    );
    if (!duplicate) unique.push(label);
  }
  return unique;
}

function rowBandForLabel(label: OCRItem, labels: OCRItem[]): RowBand {
  const ordered = uniqueLabelsByPosition(labels);
  const currentY = centerY(label.box);
  const index = ordered.findIndex((candidate) =>
    Math.abs(centerX(candidate.box) - centerX(label.box)) < 0.0001 &&
    Math.abs(centerY(candidate.box) - currentY) < 0.0001
  );

  if (index < 0 || ordered.length === 1) {
    const fallbackHalfHeight = label.box.height * 3.5;
    return { top: currentY - fallbackHalfHeight, bottom: currentY + fallbackHalfHeight };
  }

  const previous = index > 0 ? ordered[index - 1] : undefined;
  const next = index < ordered.length - 1 ? ordered[index + 1] : undefined;
  const previousY = previous ? centerY(previous.box) : undefined;
  const nextY = next ? centerY(next.box) : undefined;

  let top: number;
  let bottom: number;

  if (previousY != null) {
    top = (previousY + currentY) / 2;
  } else if (nextY != null) {
    top = currentY - (nextY - currentY) / 2;
  } else {
    top = currentY - label.box.height * 3.5;
  }

  if (nextY != null) {
    bottom = (currentY + nextY) / 2;
  } else if (previousY != null) {
    bottom = currentY + (currentY - previousY) / 2;
  } else {
    bottom = currentY + label.box.height * 3.5;
  }

  return { top, bottom };
}

function findMatchingTube(
  label: OCRItem,
  labels: OCRItem[],
  tubes: OCRItem[],
  side: "left" | "right",
  expectedText: string
) {
  const labelX = centerX(label.box);
  const band = rowBandForLabel(label, labels);
  const candidates = tubes
    .filter(({ box }) => {
      const x = centerX(box);
      const y = centerY(box);
      const inRowBand = y >= band.top && y < band.bottom;
      if (!inRowBand) return false;
      return side === "left" ? x < labelX : x > labelX;
    })
    .sort((a, b) => Math.abs(centerX(a.box) - labelX) - Math.abs(centerX(b.box) - labelX));

  const expectedKey = normalizeTubeCheckText(expectedText);
  return candidates.find((candidate) => normalizeTubeCheckText(candidate.text) === expectedKey);
}

// PaddleOCR sometimes reads the terminal number "1" as a lone "0". A lone "0" is never a real terminal
// number, so a nmb/label candidate whose text is "0" is read as "1" -- but ONLY when the position proves it:
// it sits above a "2" candidate (centerY(0) < centerY(2)), the table has rows "1" and "2", and no proper "1"
// was read in the same frame. Only the label comparison key is changed: the raw OCR result (and whatever is
// displayed / logged) keeps "0", tube OCR is never touched, and "10" / "20" etc. are never altered.
export function resolveLabelTextByPosition(items: OCRItem[], rowLabels: Set<string>, guideX = 0.5): OCRItem[] {
  if (!rowLabels.has("1") || !rowLabels.has("2")) return items;
  if (items.some((item) => item.text === "1")) return items; // a proper "1" wins; no double matching
  // label-class detections, or any box on the center guide (position beats the detector class)
  const isLabelItem = (item: OCRItem) => isLabelDetection(item.result) || isBoxOnGuide(item.box, guideX);
  const twos = items.filter((item) => item.text === "2" && isLabelItem(item));
  const zeros = items.filter((item) => item.text === "0" && isLabelItem(item));
  if (!twos.length || !zeros.length) return items;

  // The "1" is the zero that sits directly above a "2": take the zero closest above any "2".
  let chosenY: number | null = null;
  for (const zero of zeros) {
    const zy = centerY(zero.box);
    if (twos.some((two) => zy < centerY(two.box)) && (chosenY === null || zy > chosenY)) chosenY = zy;
  }
  if (chosenY === null) return items;
  const target = chosenY;
  // duplicate reads of the same physical label (same position) are resolved together
  return items.map((item) =>
    zeros.includes(item) && Math.abs(centerY(item.box) - target) < 0.0001 ? { ...item, text: "1" } : item
  );
}

export function reconcileCheckRows(args: {
  rows: CheckRow[];
  yoloResults: Array<{ label?: string | null; class_name?: string | null; role?: string | null; name?: string | null; side?: string | null; x?: number; y?: number; width?: number; height?: number; ocr_text?: string | null }>;
  ocrResults: OCRResult[];
  guideX: number;
  frameIndex?: number;
}): CheckRow[] {
  const { rows, yoloResults, ocrResults, guideX, frameIndex } = args;
  const combinedResults: OCRResult[] = [...ocrResults];

  for (const detection of yoloResults) {
    const text = normalizeCheckText(detection.ocr_text);
    if (!text || detection.x == null || detection.y == null || detection.width == null || detection.height == null) continue;
    const alreadyPresent = combinedResults.some((result) => {
      const box = getBox(result);
      return box && Math.abs(box.x - detection.x!) < 0.0001 && Math.abs(box.y - detection.y!) < 0.0001;
    });
    if (!alreadyPresent) {
      combinedResults.push({ text, confidence: 0, bbox: [detection.x, detection.y, detection.width, detection.height], label: detection.label, role: detection.role, side: detection.side, source: "detection_ocr" });
    }
  }

  const rowLabels = new Set(rows.map((row) => normalizeCheckText(row.label)).filter(Boolean));
  const items: OCRItem[] = combinedResults
    .map((result) => ({ result, box: getBox(result), text: getOcrText(result) }))
    .filter((item): item is OCRItem => Boolean(item.box && item.text));
  // Position beats the detector class: anything straddling the center guide is a terminal number (label),
  // left of the guide is a LEFT tube candidate, right of it a RIGHT tube candidate. A guide box is never
  // reused as a tube.
  const labels: OCRItem[] = resolveLabelTextByPosition(
    items.filter((item) => isBoxOnGuide(item.box, guideX) || isLabelDetection(item.result) || rowLabels.has(item.text)),
    rowLabels,
    guideX
  );
  const tubes: OCRItem[] = items.filter((item) => isTubeDetection(item.result) && !isBoxOnGuide(item.box, guideX));

  const nextRows = rows.map((row): CheckRow => ({ ...row }));
  for (const label of labels) {
    const rowIndex = nextRows.findIndex((row) => normalizeCheckText(row.label) === label.text);
    if (rowIndex < 0) continue;
    const row = nextRows[rowIndex];
    // AUTO and MANUAL are mutually exclusive completion paths.
    // Once a worker confirms a row visually, keep the AI/OCR statuses as they
    // were at that moment and do not let later inference change the row.
    if (row.manual_confirmed || row.completed || row.all_status === "OK") continue;

    const expectedLeft = normalizeCheckText(row.tube_l);
    const expectedRight = normalizeCheckText(row.tube_r);
    const left = expectedLeft ? findMatchingTube(label, labels, tubes, "left", expectedLeft) : undefined;
    const right = expectedRight ? findMatchingTube(label, labels, tubes, "right", expectedRight) : undefined;
    const leftMatched = Boolean(left);
    const rightMatched = Boolean(right);
    const nextLabelStatus: CheckDataStatus = "OK";
    const nextTubeLStatus: CheckDataStatus = isGoodStatus(row.tube_l_status) || leftMatched ? "OK" : (row.tube_l_status ?? "PENDING");
    const nextTubeRStatus: CheckDataStatus = isGoodStatus(row.tube_r_status) || rightMatched ? "OK" : (row.tube_r_status ?? "PENDING");
    const completed = nextLabelStatus === "OK" && nextTubeLStatus === "OK" && nextTubeRStatus === "OK";
    const band = rowBandForLabel(label, labels);

    nextRows[rowIndex] = { ...row, label_status: nextLabelStatus, tube_l_status: nextTubeLStatus, tube_r_status: nextTubeRStatus, left_status: nextTubeLStatus, confirm_status: completed ? "OK" : (row.confirm_status ?? "PENDING"), all_status: completed ? "OK" : (row.all_status ?? "PENDING"), completed };
    console.debug("[VisionLink] label anchored reconcile", {
      frameIndex,
      label: label.text,
      rowIndex,
      band,
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
