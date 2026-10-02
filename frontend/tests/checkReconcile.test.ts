// Run with: npm test   (node:test + Node's built-in TypeScript type stripping; no extra dependency)
import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeCheckText, normalizeTubeCheckText, reconcileCheckRows } from "../src/checkReconcile.ts";

type Row = Parameters<typeof reconcileCheckRows>[0]["rows"][number];
type Ocr = Parameters<typeof reconcileCheckRows>[0]["ocrResults"][number];

// One label in the middle; left tube is left of the label, right tube is right of it (same row band).
const labelOcr = (text: string): Ocr => ({ text, label: "nmb", role: "label", confidence: 0.9, bbox: [0.5, 0.5, 0.05, 0.05] });
const leftTubeOcr = (text: string): Ocr => ({ text, label: "tube", role: "tube", side: "left", confidence: 0.9, bbox: [0.1, 0.5, 0.2, 0.05] });
const rightTubeOcr = (text: string): Ocr => ({ text, label: "tube", role: "tube", side: "right", confidence: 0.9, bbox: [0.7, 0.5, 0.2, 0.05] });

const makeRow = (tubeL: string, label: string, tubeR: string, extra: Partial<Row> = {}): Row => ({ tube_l: tubeL, label, tube_r: tubeR, ...extra });

function run(row: Row, ocrResults: Ocr[]): Row {
  const [next] = reconcileCheckRows({ rows: [row], yoloResults: [], ocrResults, guideX: 0.5 });
  return next;
}

// expected value vs OCR text, matched on one side only (the other side is left unreadable)
const leftOnly = (expected: string, ocr: string) => run(makeRow(expected, "7", "ZZZ9"), [labelOcr("7"), leftTubeOcr(ocr)]).tube_l_status;
const rightOnly = (expected: string, ocr: string) => run(makeRow("ZZZ9", "7", expected), [labelOcr("7"), rightTubeOcr(ocr)]).tube_r_status;

const EQUIVALENT: Array<[string, string]> = [
  ["1", "1"],
  ["1", "l"],
  ["1", "L"],
  ["l", "1"],
  ["L", "1"],
  ["12", "l2"],
  ["A1", "Al"],
];

for (const [expected, ocr] of EQUIVALENT) {
  test(`left tube: expected ${expected} / OCR ${ocr} => OK`, () => {
    assert.equal(leftOnly(expected, ocr), "OK");
  });
  test(`right tube: expected ${expected} / OCR ${ocr} => OK`, () => {
    assert.equal(rightOnly(expected, ocr), "OK");
  });
}

test("ordinary matches still work (both sides, O/0 equivalence kept)", () => {
  const row = run(makeRow("A3S7N2D", "7", "K0P8"), [labelOcr("7"), leftTubeOcr("a3s7n2d"), rightTubeOcr("KOP8")]);
  assert.equal(row.tube_l_status, "OK");
  assert.equal(row.tube_r_status, "OK");
  assert.equal(row.completed, true);
});

test("unrelated strings do not match", () => {
  for (const [expected, ocr] of [["ABC", "ABD"], ["1", "7"], ["12", "13"], ["A1", "B1"], ["L", "2"]]) {
    assert.notEqual(leftOnly(expected, ocr), "OK", `left ${expected}/${ocr}`);
    assert.notEqual(rightOnly(expected, ocr), "OK", `right ${expected}/${ocr}`);
  }
});

test('only 1 and l/L are unified: "I" (capital i) and "|" are NOT treated as 1', () => {
  assert.notEqual(leftOnly("1", "I"), "OK");
  assert.notEqual(leftOnly("1", "|"), "OK");
  assert.notEqual(rightOnly("I", "1"), "OK");
});

test("label matching is not affected (label 1 does not match OCR label l)", () => {
  // The row's label is "1"; the label OCR reads "l" => no row is anchored, so the row is untouched.
  const row = makeRow("A1", "1", "A1");
  const next = run(row, [labelOcr("l"), leftTubeOcr("A1"), rightTubeOcr("A1")]);
  assert.equal(next.label_status, undefined);
  assert.equal(next.tube_l_status, undefined);
  assert.equal(next.completed, undefined);
  // and the exact label still anchors the row
  const anchored = run(row, [labelOcr("1"), leftTubeOcr("Al"), rightTubeOcr("A1")]);
  assert.equal(anchored.completed, true);
});

test("normalizeCheckText is unchanged (no 1/l folding) while the tube key folds it", () => {
  assert.equal(normalizeCheckText(" l o "), "L0");
  assert.equal(normalizeCheckText("1"), "1");
  assert.equal(normalizeTubeCheckText(" l o "), "10");
  assert.equal(normalizeTubeCheckText("L1"), "11");
});

test("display values are not rewritten", () => {
  const ocr = [labelOcr("7"), leftTubeOcr("l2"), rightTubeOcr("Al")];
  const before = JSON.stringify(ocr);
  const row = makeRow("12", "7", "A1");
  const next = run(row, ocr);
  assert.equal(next.tube_l, "12");
  assert.equal(next.tube_r, "A1");
  assert.equal(JSON.stringify(ocr), before);
});

test("latched OK and MANUAL rows are kept as-is", () => {
  // latched: a side already OK stays OK even if nothing is read afterwards
  const latched = run(makeRow("1", "7", "ZZ", { tube_l_status: "OK" }), [labelOcr("7")]);
  assert.equal(latched.tube_l_status, "OK");
  // MANUAL-confirmed rows are not changed by later inference
  const manual = makeRow("1", "7", "1", { manual_confirmed: true, tube_l_status: "PENDING", tube_r_status: "PENDING" });
  const next = run(manual, [labelOcr("7"), leftTubeOcr("l"), rightTubeOcr("l")]);
  assert.equal(next.tube_l_status, "PENDING");
  assert.equal(next.tube_r_status, "PENDING");
  assert.equal(next.completed, undefined);
});
