import { useEffect, useState } from "react";
import { captureStats } from "./camera";
import { buildViewportDiag } from "./viewportDiag";

// Shown only with `?diag=1` in the URL. Fixed overlay; does not affect the layout. Refreshes once a second.
export const DIAG_ENABLED = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("diag") === "1";

function collect(): string[] {
  const video = document.querySelector<HTMLVideoElement>("video.camera-video");
  const stage = document.querySelector<HTMLElement>(".video-stage")?.getBoundingClientRect() ?? null;
  const vv = window.visualViewport;
  return buildViewportDiag({
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    visualViewport: vv ? { width: vv.width, height: vv.height } : null,
    screen: { width: window.screen.width, height: window.screen.height },
    devicePixelRatio: window.devicePixelRatio,
    orientation: window.screen.orientation?.type ?? null,
    mq: {
      maxWidth600: window.matchMedia("(max-width: 600px)").matches,
      coarse: window.matchMedia("(pointer: coarse)").matches,
      hoverNone: window.matchMedia("(hover: none)").matches,
    },
    maxTouchPoints: navigator.maxTouchPoints ?? 0,
    userAgent: navigator.userAgent,
    video: video ? { videoWidth: video.videoWidth, videoHeight: video.videoHeight, clientWidth: video.clientWidth, clientHeight: video.clientHeight } : null,
    stage: stage ? { width: stage.width, height: stage.height } : null,
    capture: captureStats.width > 0 ? { width: captureStats.width, height: captureStats.height } : null,
  });
}

export function DiagPanel() {
  const [lines, setLines] = useState<string[]>(() => collect());
  useEffect(() => {
    const timer = window.setInterval(() => setLines(collect()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return <pre className="diag-panel" aria-hidden="true">{lines.join("\n")}</pre>;
}
