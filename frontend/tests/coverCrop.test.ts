// Run with: npm test   (node:test + Node's built-in TypeScript type stripping; no extra dependency)
import assert from "node:assert/strict";
import { test } from "node:test";
import { computeCoverCrop } from "../src/coverCrop.ts";

const ratio = (c: { sw: number; sh: number }) => c.sw / c.sh;

test("720x1280 (iPhone portrait) -> 16:9: full width, top/bottom cropped symmetrically around the center", () => {
  const c = computeCoverCrop(720, 1280, 16, 9);
  assert.deepEqual(c, { sx: 0, sy: 438, sw: 720, sh: 405 });
  // symmetric: space above == space below (within 1px rounding)
  const above = c.sy, below = 1280 - (c.sy + c.sh);
  assert.ok(Math.abs(above - below) <= 1, `above=${above} below=${below}`);
  assert.ok(Math.abs(ratio(c) - 16 / 9) < 0.01);
  // only ~32% of the height is visible
  assert.ok(Math.abs(c.sh / 1280 - 0.3164) < 0.001);
});

test("1280x720 -> 16:9: no crop", () => {
  assert.deepEqual(computeCoverCrop(1280, 720, 16, 9), { sx: 0, sy: 0, sw: 1280, sh: 720 });
  // a real layout size (349 x 196.3 css px) behaves like 16:9 up to rounding
  assert.deepEqual(computeCoverCrop(1280, 720, 349, 196.3), { sx: 0, sy: 0, sw: 1280, sh: 720 });
});

test("640x480 -> 16:9: top/bottom cropped", () => {
  const c = computeCoverCrop(640, 480, 16, 9);
  assert.deepEqual(c, { sx: 0, sy: 60, sw: 640, sh: 360 });
  assert.ok(Math.abs(ratio(c) - 16 / 9) < 0.01);
});

test("wide source -> tall target: left/right cropped symmetrically", () => {
  const c = computeCoverCrop(1280, 720, 9, 16);
  assert.equal(c.sy, 0);
  assert.equal(c.sh, 720);
  assert.equal(c.sw, 405);
  assert.ok(Math.abs(c.sx - (1280 - c.sx - c.sw)) <= 1);
  assert.ok(Math.abs(ratio(c) - 9 / 16) < 0.01);
});

test("same aspect => whole frame; any scale of the target box gives the same crop", () => {
  assert.deepEqual(computeCoverCrop(640, 480, 4, 3), { sx: 0, sy: 0, sw: 640, sh: 480 });
  const a = computeCoverCrop(720, 1280, 349, 196.3125), b = computeCoverCrop(720, 1280, 1600, 900);
  assert.ok(Math.abs(a.sh - b.sh) <= 1 && a.sy === b.sy);
});

test("crop always stays inside the source", () => {
  for (const [sw, sh, tw, th] of [[720, 1280, 16, 9], [1280, 720, 9, 16], [641, 479, 349, 196], [1, 1, 16, 9], [3, 7, 5, 2]]) {
    const c = computeCoverCrop(sw, sh, tw, th);
    assert.ok(c.sx >= 0 && c.sy >= 0 && c.sw >= 1 && c.sh >= 1, JSON.stringify([sw, sh, tw, th, c]));
    assert.ok(c.sx + c.sw <= sw && c.sy + c.sh <= sh, JSON.stringify([sw, sh, tw, th, c]));
  }
});

test("zero / invalid sizes are handled safely", () => {
  // invalid source => zero rect (the caller skips the frame)
  for (const bad of [[0, 0, 16, 9], [0, 1280, 16, 9], [720, 0, 16, 9], [NaN, 1280, 16, 9], [Infinity, 1280, 16, 9], [-5, 10, 16, 9]]) {
    assert.deepEqual(computeCoverCrop(bad[0], bad[1], bad[2], bad[3]), { sx: 0, sy: 0, sw: 0, sh: 0 }, JSON.stringify(bad));
  }
  // invalid target (e.g. video element not laid out yet) => whole frame, no crop
  for (const bad of [[720, 1280, 0, 0], [720, 1280, 0, 9], [720, 1280, 16, 0], [720, 1280, NaN, 9], [720, 1280, -1, 9]]) {
    assert.deepEqual(computeCoverCrop(bad[0], bad[1], bad[2], bad[3]), { sx: 0, sy: 0, sw: 720, sh: 1280 }, JSON.stringify(bad));
  }
});
