// Run with: npm test   (node:test + Node's built-in TypeScript type stripping; no extra dependency)
// Position beats the detector class: any box straddling the center guide is a terminal number (label).
import assert from "node:assert/strict";
import { test } from "node:test";
import { isBoxOnGuide, reconcileCheckRows } from "../src/checkReconcile.ts";

type Row = Parameters<typeof reconcileCheckRows>[0]["rows"][number];
type Ocr = Parameters<typeof reconcileCheckRows>[0]["ocrResults"][number];

const row = (label: string, tubeL = `T${label}`, tubeR = tubeL): Row => ({ tube_l: tubeL, label, tube_r: tubeR });
// straddles the guide (x = 0.5): left 0.47 .. right 0.53
const onGuide = (text: string, y: number, cls = "tube"): Ocr => ({ text, label: cls, role: cls, confidence: 0.9, bbox: [0.47, y, 0.06, 0.05] });
const nmbOffGuide = (text: string, y: number): Ocr => ({ text, label: "nmb", role: "label", confidence: 0.9, bbox: [0.7, y, 0.05, 0.05] });
const nmbOnGuide = (text: string, y: number): Ocr => onGuide(text, y, "nmb");
const leftTube = (text: string, y: number): Ocr => ({ text, label: "tube", role: "tube", side: "left", confidence: 0.9, bbox: [0.1, y, 0.2, 0.05] });
const rightTube = (text: string, y: number): Ocr => ({ text, label: "tube", role: "tube", side: "right", confidence: 0.9, bbox: [0.7, y, 0.2, 0.05] });
const run = (rows: Row[], ocrResults: Ocr[], yoloResults: Parameters<typeof reconcileCheckRows>[0]["yoloResults"] = []) =>
  reconcileCheckRows({ rows, yoloResults, ocrResults, guideX: 0.5 });
const byLabel = (rows: Row[], label: string) => rows.find((r) => r.label === label)!;
const ROWS_123 = () => [row("1"), row("2"), row("3")];

test("isBoxOnGuide: intersection with the guide line (not center); touching edges count", () => {
  assert.equal(isBoxOnGuide({ x: 0.47, y: 0, width: 0.06, height: 0.05 }, 0.5), true);
  assert.equal(isBoxOnGuide({ x: 0.5, y: 0, width: 0.05, height: 0.05 }, 0.5), true); // left edge on the guide
  assert.equal(isBoxOnGuide({ x: 0.45, y: 0, width: 0.05, height: 0.05 }, 0.5), true); // right edge on the guide
  assert.equal(isBoxOnGuide({ x: 0.5, y: 0, width: 0, height: 0.05 }, 0.5), true);
  assert.equal(isBoxOnGuide({ x: 0.51, y: 0, width: 0.05, height: 0.05 }, 0.5), false); // entirely right
  assert.equal(isBoxOnGuide({ x: 0.4, y: 0, width: 0.09, height: 0.05 }, 0.5), false); // entirely left
  assert.equal(isBoxOnGuide({ x: 0.1, y: 0, width: 0.2, height: 0.05 }, 0.5), false);
});

test('1) tube-class box straddling the guide with OCR "1" is a label: row 1 is matched', () => {
  const next = run(ROWS_123(), [onGuide("1", 0.1, "tube"), nmbOffGuide("2", 0.2), nmbOffGuide("3", 0.3)]);
  assert.equal(byLabel(next, "1").label_status, "OK");
  // the guide box is the label, not a tube: it must not be reusable as a tube candidate either
  assert.notEqual(byLabel(next, "1").tube_l_status, "OK");
});

test('2) tube-class "0" on the guide above a guide "2" => PR #29 rule reads it as "1" (row 1 matched)', () => {
  const next = run(ROWS_123(), [onGuide("0", 0.1, "tube"), onGuide("2", 0.2, "tube"), onGuide("3", 0.3, "tube")]);
  assert.equal(byLabel(next, "1").label_status, "OK");
  assert.equal(byLabel(next, "2").label_status, "OK");
  assert.equal(byLabel(next, "3").label_status, "OK");
  // sanity: the same tube-class "0" / "2" / "3" boxes OFF the guide are not label-detections, so "0" is not
  // read as "1" and row 1 stays untouched (position, not class, is what enables the rule)
  const off = (text: string, y: number): Ocr => ({ text, label: "tube", role: "tube", confidence: 0.9, bbox: [0.1, y, 0.06, 0.05] });
  const nextOff = run(ROWS_123(), [off("0", 0.1), off("2", 0.2), off("3", 0.3)]);
  assert.equal(byLabel(nextOff, "1").label_status, undefined);
});

test("3) a guide box is never a tube candidate", () => {
  // row 2 expects tube "B2B" on both sides. A tube-class box ON the guide that reads "B2B" must not satisfy it.
  const rows = [row("1", "A1A"), row("2", "B2B"), row("3", "C3C")];
  const next = run(rows, [nmbOffGuide("1", 0.1), nmbOffGuide("2", 0.2), nmbOffGuide("3", 0.3), onGuide("B2B", 0.2, "tube")]);
  const r2 = byLabel(next, "2");
  assert.equal(r2.label_status, "OK");
  assert.notEqual(r2.tube_l_status, "OK");
  assert.notEqual(r2.tube_r_status, "OK");
});

test("4) / 5) tubes left of the guide stay LEFT and tubes right of it stay RIGHT", () => {
  const rows = [row("1", "LLL", "RRR"), row("2"), row("3")];
  const next = run(rows, [nmbOnGuide("1", 0.1), nmbOffGuide("2", 0.2), nmbOffGuide("3", 0.3), leftTube("LLL", 0.1), rightTube("RRR", 0.1)]);
  assert.equal(byLabel(next, "1").tube_l_status, "OK");
  assert.equal(byLabel(next, "1").tube_r_status, "OK");
  // crossed: the left text read on the right side (and vice versa) must not match
  const crossed = run(rows, [nmbOnGuide("1", 0.1), nmbOffGuide("2", 0.2), nmbOffGuide("3", 0.3), leftTube("RRR", 0.1), rightTube("LLL", 0.1)]);
  assert.notEqual(byLabel(crossed, "1").tube_l_status, "OK");
  assert.notEqual(byLabel(crossed, "1").tube_r_status, "OK");
});

test("6) ordinary labels that do not straddle the guide keep the class-based behaviour", () => {
  const next = run(ROWS_123(), [nmbOffGuide("1", 0.1), nmbOffGuide("2", 0.2), nmbOffGuide("3", 0.3)]);
  for (const l of ["1", "2", "3"]) assert.equal(byLabel(next, l).label_status, "OK", l);
  // an off-guide tube-class box that is NOT a row label text is still not a label
  const none = run(ROWS_123(), [{ text: "Q9Q", label: "tube", role: "tube", confidence: 0.9, bbox: [0.1, 0.1, 0.2, 0.05] }]);
  for (const l of ["1", "2", "3"]) assert.equal(byLabel(none, l).label_status, undefined, l);
});

test("7) raw OCR results and detection info are not mutated", () => {
  const ocr = [onGuide("0", 0.1, "tube"), onGuide("2", 0.2, "tube"), leftTube("AIX", 0.1)];
  const yolo = [{ label: "tube", role: "tube", x: 0.47, y: 0.3, width: 0.06, height: 0.05, ocr_text: "3" }];
  const before = JSON.stringify([ocr, yolo]);
  run([row("1", "A1X"), row("2"), row("3")], ocr, yolo);
  assert.equal(JSON.stringify([ocr, yolo]), before);
  assert.equal(ocr[0].text, "0");
  assert.equal(ocr[0].label, "tube"); // the class is not rewritten either
});

test("8) AUTO latch and MANUAL rows are kept", () => {
  const latched = run([{ ...row("1", "A"), tube_l_status: "OK" as const }, row("2"), row("3")], [onGuide("0", 0.1), onGuide("2", 0.2)]);
  assert.equal(byLabel(latched, "1").tube_l_status, "OK");
  const manual = run([{ ...row("1"), manual_confirmed: true }, row("2"), row("3")], [onGuide("1", 0.1), nmbOffGuide("2", 0.2)]);
  assert.equal(byLabel(manual, "1").label_status, undefined);
  assert.equal(byLabel(manual, "1").completed, undefined);
});

test("9) 1/I tube normalization still works next to guide labels", () => {
  const rows = [row("1", "1VTN"), row("2", "1CA"), row("3")];
  const next = run(rows, [onGuide("0", 0.1, "tube"), onGuide("2", 0.2, "tube"), nmbOffGuide("3", 0.3),
    leftTube("IVTN", 0.1), rightTube("1VTN", 0.1), leftTube("ICA", 0.2), rightTube("lCA", 0.2)]);
  assert.equal(byLabel(next, "1").completed, true); // label via 0-above-2, tubes via 1/I
  assert.equal(byLabel(next, "2").completed, true);
});

test("a proper '1' on the guide still wins over a stray '0' (no double matching)", () => {
  const rows = [row("1", "AAA"), row("2", "BBB"), row("3", "CCC")];
  const next = run(rows, [onGuide("0", 0.02, "tube"), onGuide("1", 0.12, "tube"), onGuide("2", 0.22, "tube"), onGuide("3", 0.32, "tube"), leftTube("AAA", 0.02), leftTube("XXX", 0.12)]);
  assert.notEqual(byLabel(next, "1").tube_l_status, "OK");
});
