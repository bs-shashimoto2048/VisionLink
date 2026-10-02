// Run with: npm test   (node:test + Node's built-in TypeScript type stripping; no extra dependency)
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildViewportDiag, type ViewportDiagInput } from "../src/viewportDiag.ts";

const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Version/17.5 Mobile/15E148 Safari/604.1";
const DESKTOP_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.5 Safari/605.1.15";

const base = (over: Partial<ViewportDiagInput> = {}): ViewportDiagInput => ({
  innerWidth: 375, innerHeight: 667, visualViewport: { width: 375, height: 667 }, screen: { width: 375, height: 667 }, devicePixelRatio: 2,
  orientation: "portrait-primary", mq: { maxWidth600: true, coarse: true, hoverNone: true }, maxTouchPoints: 5, userAgent: IPHONE_UA,
  video: { videoWidth: 720, videoHeight: 1280, clientWidth: 349, clientHeight: 196 }, stage: { width: 349, height: 196.3 }, capture: { width: 720, height: 405 }, ...over,
});
const text = (i: ViewportDiagInput) => buildViewportDiag(i).join("\n");

test("normal iPhone view: 16:9 stage and capture, no warning", () => {
  const t = text(base());
  assert.match(t, /inner 375x667/);
  assert.match(t, /\(max-width:600px\)=true/);
  assert.match(t, /\(pointer:coarse\)=true/);
  assert.match(t, /stage 349\.0x196\.3 aspect 1\.778 \(16:9\)/);
  assert.match(t, /video 720x1280 \(aspect 0\.563\)  element 349x196/);
  assert.match(t, /last capture sent to AI: 720x405 aspect 1\.778 \(16:9\)/);
  assert.doesNotMatch(t, /WARNING/);
});

test("desktop-site mode on a phone is flagged (layout width 980 on a 375 screen, 4:3 stage)", () => {
  const t = text(base({ innerWidth: 980, innerHeight: 1740, visualViewport: { width: 980, height: 1740 }, mq: { maxWidth600: false, coarse: true, hoverNone: true }, userAgent: DESKTOP_UA,
    stage: { width: 938, height: 703.5 }, capture: { width: 720, height: 540 } }));
  assert.match(t, /\(max-width:600px\)=false/);
  assert.match(t, /desktopUA=true/);
  assert.match(t, /stage 938\.0x703\.5 aspect 1\.333 \(NOT 16:9\)/);
  assert.match(t, /last capture sent to AI: 720x540 aspect 1\.333 \(NOT 16:9\)/);
  assert.match(t, /WARNING: desktop-site mode suspected/);
});

test("a normal PC window (mouse, large screen) is not flagged", () => {
  const t = text(base({ innerWidth: 1280, innerHeight: 800, visualViewport: null, screen: { width: 1920, height: 1080 }, devicePixelRatio: 1, orientation: null,
    mq: { maxWidth600: false, coarse: false, hoverNone: false }, maxTouchPoints: 0, userAgent: DESKTOP_UA, video: null, stage: { width: 725.3, height: 544 }, capture: null }));
  assert.doesNotMatch(t, /WARNING/);
  assert.match(t, /visualViewport n\/a/);
  assert.match(t, /orientation n\/a/);
  assert.match(t, /video n\/a \(camera not started\)/);
  assert.match(t, /last capture: none yet/);
});

test("a touch tablet with a big screen in a wide layout is not flagged as desktop-site", () => {
  const t = text(base({ innerWidth: 1024, innerHeight: 768, screen: { width: 1024, height: 768 }, mq: { maxWidth600: false, coarse: true, hoverNone: true }, userAgent: DESKTOP_UA }));
  assert.doesNotMatch(t, /WARNING/);
});

test("missing stage / zero-size values do not throw", () => {
  const t = text(base({ stage: null, video: { videoWidth: 0, videoHeight: 0, clientWidth: 0, clientHeight: 0 }, capture: { width: 0, height: 0 } }));
  assert.match(t, /stage n\/a/);
  assert.match(t, /video 0x0 \(aspect \?\)/);
  assert.match(t, /last capture: none yet/);
});
