// Run with: npm test   (node:test + Node's built-in TypeScript type stripping; no extra dependency)
// A lone "0" read for terminal number "1" is resolved to "1" ONLY by position (above a "2").
import assert from "node:assert/strict";
import { test } from "node:test";
import { reconcileCheckRows } from "../src/checkReconcile.ts";

type Row = Parameters<typeof reconcileCheckRows>[0]["rows"][number];
type Ocr = Parameters<typeof reconcileCheckRows>[0]["ocrResults"][number];

const row = (label: string, tube = `T${label}`): Row => ({ tube_l: tube, label, tube_r: tube });
const labelAt = (text: string, y: number): Ocr => ({ text, label: "nmb", role: "label", confidence: 0.9, bbox: [0.5, y, 0.05, 0.05] });
const leftTube = (text: string, y: number): Ocr => ({ text, label: "tube", role: "tube", side: "left", confidence: 0.9, bbox: [0.1, y, 0.2, 0.05] });
const rightTube = (text: string, y: number): Ocr => ({ text, label: "tube", role: "tube", side: "right", confidence: 0.9, bbox: [0.7, y, 0.2, 0.05] });
const run = (rows: Row[], ocrResults: Ocr[]) => reconcileCheckRows({ rows, yoloResults: [], ocrResults, guideX: 0.5 });
const byLabel = (rows: Row[], label: string) => rows.find((r) => r.label === label)!;

const ROWS_123 = () => [row("1"), row("2"), row("3")];

test("0 above 2 is read as 1: row 1 label becomes OK", () => {
  const next = run(ROWS_123(), [labelAt("0", 0.1), labelAt("2", 0.2), labelAt("3", 0.3)]);
  assert.equal(byLabel(next, "1").label_status, "OK");
  assert.equal(byLabel(next, "2").label_status, "OK");
  assert.equal(byLabel(next, "3").label_status, "OK");
});

test("the spec example: 0 (y=0.20) / 2 (y=0.30) / 3 (y=0.40) => 0 is key '1'", () => {
  const next = run(ROWS_123(), [labelAt("0", 0.2), labelAt("2", 0.3), labelAt("3", 0.4)]);
  assert.equal(byLabel(next, "1").label_status, "OK");
});

test("with matching tubes, the '0' row completes (AUTO) via left and right tube", () => {
  const rows = [row("1", "A1X"), row("2", "B2Y"), row("3", "C3Z")];
  const next = run(rows, [
    labelAt("0", 0.1), labelAt("2", 0.2), labelAt("3", 0.3),
    leftTube("AIX", 0.1), rightTube("A1X", 0.1), // 1/I tube normalization still works alongside
    leftTube("B2Y", 0.2), rightTube("B2Y", 0.2),
  ]);
  const r1 = byLabel(next, "1");
  assert.equal(r1.label_status, "OK");
  assert.equal(r1.tube_l_status, "OK");
  assert.equal(r1.tube_r_status, "OK");
  assert.equal(r1.completed, true);
  assert.equal(r1.all_status, "OK");
});

test("0 BELOW 2 is not converted", () => {
  const next = run(ROWS_123(), [labelAt("2", 0.1), labelAt("0", 0.2), labelAt("3", 0.3)]);
  assert.equal(byLabel(next, "1").label_status, undefined);
});

test('"10" is not changed (and does not anchor row 1)', () => {
  const rows = [row("1"), row("2"), row("10")];
  const next = run(rows, [labelAt("10", 0.1), labelAt("2", 0.2)]);
  assert.equal(byLabel(next, "1").label_status, undefined);
  assert.equal(byLabel(next, "10").label_status, "OK"); // exact match as before
});

test('"20" is not changed', () => {
  const rows = [row("1"), row("2"), row("20")];
  const next = run(rows, [labelAt("20", 0.1), labelAt("2", 0.2)]);
  assert.equal(byLabel(next, "1").label_status, undefined);
  assert.equal(byLabel(next, "20").label_status, "OK");
  // and a "20" above a "2" never turns into "1" / "2"
  assert.equal(byLabel(next, "2").label_status, "OK");
});

test('a tube OCR "0" is never used (tube class is not a label candidate)', () => {
  const next = run(ROWS_123(), [{ text: "0", label: "tube", role: "tube", confidence: 0.9, bbox: [0.5, 0.1, 0.05, 0.05] }, labelAt("2", 0.2), labelAt("3", 0.3)]);
  assert.equal(byLabel(next, "1").label_status, undefined);
});

test('a "0" inside another string is never touched ("A0", "0A", "0O")', () => {
  for (const text of ["A0", "0A", "00"]) {
    const next = run(ROWS_123(), [labelAt(text, 0.1), labelAt("2", 0.2), labelAt("3", 0.3)]);
    assert.equal(byLabel(next, "1").label_status, undefined, text);
  }
});

test("a proper '1' is preferred: the '0' is not used (no double matching)", () => {
  const next = run(ROWS_123(), [labelAt("0", 0.05), labelAt("1", 0.1), labelAt("2", 0.2), labelAt("3", 0.3)]);
  assert.equal(byLabel(next, "1").label_status, "OK");
  // tubes next to the stray "0" must not satisfy row 1: only the proper "1" (y=0.1) anchors it
  const rows = [row("1", "AAA"), row("2", "BBB"), row("3", "CCC")];
  const next2 = run(rows, [labelAt("0", 0.02), labelAt("1", 0.12), labelAt("2", 0.22), labelAt("3", 0.32), leftTube("AAA", 0.02), leftTube("XXX", 0.12)]);
  assert.notEqual(byLabel(next2, "1").tube_l_status, "OK");
});

test("no '2' => the '0' is not converted (position cannot be established)", () => {
  const next = run(ROWS_123(), [labelAt("0", 0.1), labelAt("3", 0.3)]);
  assert.equal(byLabel(next, "1").label_status, undefined);
});

test("table without row 1 or row 2 => nothing is converted", () => {
  const next = run([row("2"), row("3")], [labelAt("0", 0.1), labelAt("2", 0.2), labelAt("3", 0.3)]);
  assert.equal(next.length, 2);
  assert.equal(byLabel(next, "2").label_status, "OK");
  const next2 = run([row("1"), row("3")], [labelAt("0", 0.1), labelAt("3", 0.3)]);
  assert.equal(byLabel(next2, "1").label_status, undefined);
});

test("raw OCR results are not mutated (text stays '0')", () => {
  const ocr = [labelAt("0", 0.1), labelAt("2", 0.2), labelAt("3", 0.3)];
  const before = JSON.stringify(ocr);
  run(ROWS_123(), ocr);
  assert.equal(JSON.stringify(ocr), before);
  assert.equal(ocr[0].text, "0");
});

test("only the zero directly above the 2 is converted when several zeros are read", () => {
  const next = run(ROWS_123(), [labelAt("0", 0.02), labelAt("0", 0.1), labelAt("2", 0.2), labelAt("3", 0.3)]);
  assert.equal(byLabel(next, "1").label_status, "OK"); // the nearest zero above "2" (y=0.1) carries the "1"
});

test("AUTO latch and MANUAL rows are unchanged", () => {
  // latched OK stays OK even when nothing is read
  const latched = run([row("1", "A"), row("2"), row("3")].map((r, i) => (i === 0 ? { ...r, tube_l_status: "OK" as const } : r)), [labelAt("0", 0.1), labelAt("2", 0.2)]);
  assert.equal(byLabel(latched, "1").tube_l_status, "OK");
  // a manually confirmed row is not changed by later inference
  const manual = run([{ ...row("1"), manual_confirmed: true }, row("2"), row("3")], [labelAt("0", 0.1), labelAt("2", 0.2), labelAt("3", 0.3)]);
  assert.equal(byLabel(manual, "1").label_status, undefined);
  assert.equal(byLabel(manual, "1").completed, undefined);
});
