// Run with: npm test   (node:test + Node's built-in TypeScript type stripping; no extra dependency)
import assert from "node:assert/strict";
import { test } from "node:test";
import { INSPECTION_CONTROL_LABEL, inspectionControlMode } from "../src/inspectionControl.ts";

test("no session => start (a new session is created)", () => {
  assert.equal(inspectionControlMode(undefined), "start");
  assert.equal(inspectionControlMode(null), "start");
  assert.equal(INSPECTION_CONTROL_LABEL.start, "検査開始");
});

test("IN_PROGRESS => stop (pauses the same session)", () => {
  assert.equal(inspectionControlMode("IN_PROGRESS"), "stop");
  assert.equal(INSPECTION_CONTROL_LABEL.stop, "検査停止");
});

test("PAUSED => resume (never a new session)", () => {
  assert.equal(inspectionControlMode("PAUSED"), "resume");
  assert.equal(INSPECTION_CONTROL_LABEL.resume, "検査再開");
});

test("COMPLETED / ABORTED => start a new session", () => {
  assert.equal(inspectionControlMode("COMPLETED"), "start");
  assert.equal(inspectionControlMode("ABORTED"), "start");
});

test("the three modes have distinct labels", () => {
  assert.equal(new Set(Object.values(INSPECTION_CONTROL_LABEL)).size, 3);
});
