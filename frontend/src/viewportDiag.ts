// On-screen viewport / camera diagnostics (shown only with `?diag=1`). Pure builder so it can be unit-tested.
// Purpose: on a phone, read in one glance why the camera stage is 16:9 or 4:3 (see Issue "iPhone camera viewport").

export type ViewportDiagInput = {
  innerWidth: number;
  innerHeight: number;
  visualViewport: { width: number; height: number } | null;
  screen: { width: number; height: number };
  devicePixelRatio: number;
  orientation: string | null;
  mq: { maxWidth600: boolean; coarse: boolean; hoverNone: boolean };
  maxTouchPoints: number;
  userAgent: string;
  video: { videoWidth: number; videoHeight: number; clientWidth: number; clientHeight: number } | null;
  stage: { width: number; height: number } | null;
  capture: { width: number; height: number } | null;
};

const f = (n: number, d = 0) => (Number.isFinite(n) ? n.toFixed(d) : "?");
const aspect = (w: number, h: number) => (h > 0 ? f(w / h, 3) : "?");
const is16x9 = (w: number, h: number) => h > 0 && Math.abs(w / h - 16 / 9) < 0.03;

export function buildViewportDiag(i: ViewportDiagInput): string[] {
  const desktopUa = /Macintosh|Windows NT|X11|CrOS/.test(i.userAgent);
  // A phone-size screen whose layout viewport is wider than the 600px breakpoint => "desktop site" mode (or a wide window).
  const desktopSiteSuspected = i.maxTouchPoints > 0 && Math.min(i.screen.width, i.screen.height) <= 500 && i.innerWidth > 600;
  const lines = [
    `inner ${f(i.innerWidth)}x${f(i.innerHeight)}  visualViewport ${i.visualViewport ? `${f(i.visualViewport.width)}x${f(i.visualViewport.height)}` : "n/a"}  screen ${f(i.screen.width)}x${f(i.screen.height)}  dpr ${f(i.devicePixelRatio, 2)}  ${i.orientation ?? "orientation n/a"}`,
    `media: (max-width:600px)=${i.mq.maxWidth600}  (pointer:coarse)=${i.mq.coarse}  (hover:none)=${i.mq.hoverNone}  touchPoints=${i.maxTouchPoints}  desktopUA=${desktopUa}`,
  ];
  if (i.stage) lines.push(`stage ${f(i.stage.width, 1)}x${f(i.stage.height, 1)} aspect ${aspect(i.stage.width, i.stage.height)} ${is16x9(i.stage.width, i.stage.height) ? "(16:9)" : "(NOT 16:9)"}`);
  else lines.push("stage n/a");
  if (i.video) lines.push(`video ${f(i.video.videoWidth)}x${f(i.video.videoHeight)} (aspect ${aspect(i.video.videoWidth, i.video.videoHeight)})  element ${f(i.video.clientWidth)}x${f(i.video.clientHeight)}`);
  else lines.push("video n/a (camera not started)");
  lines.push(i.capture && i.capture.width > 0 ? `last capture sent to AI: ${f(i.capture.width)}x${f(i.capture.height)} aspect ${aspect(i.capture.width, i.capture.height)} ${is16x9(i.capture.width, i.capture.height) ? "(16:9)" : "(NOT 16:9)"}` : "last capture: none yet");
  if (desktopSiteSuspected) lines.push("WARNING: desktop-site mode suspected (layout width > 600 on a phone-size screen). Use the normal mobile view.");
  return lines;
}
