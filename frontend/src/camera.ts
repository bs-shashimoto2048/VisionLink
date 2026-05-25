import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { CameraInfo, CameraState } from "./types";

type CameraFacing = "environment" | "user";

function describeCameraError(error: unknown) {
  if (error instanceof DOMException) {
    switch (error.name) {
      case "NotAllowedError":
        return {
          code: error.name,
          message: "Camera permission was denied",
          detail: "iPhone の Safari 設定とサイト権限を確認してください。",
          permissionDenied: true,
        };
      case "NotFoundError":
        return {
          code: error.name,
          message: "No camera device was found",
          detail: "背面カメラが見つからないか、デバイスが認識されていません。",
          permissionDenied: false,
        };
      case "NotReadableError":
        return {
          code: error.name,
          message: "Camera is already in use",
          detail: "他のアプリがカメラを使用中の可能性があります。",
          permissionDenied: false,
        };
      case "OverconstrainedError":
        return {
          code: error.name,
          message: "Requested camera settings are not supported",
          detail: "端末が指定条件に対応していません。カメラ切替または再接続を試してください。",
          permissionDenied: false,
        };
      case "SecurityError":
        return {
          code: error.name,
          message: "Camera access is blocked by browser security settings",
          detail: "HTTPS で開いているか、Safari の権限設定を確認してください。",
          permissionDenied: false,
        };
      case "AbortError":
        return {
          code: error.name,
          message: "Camera startup was aborted",
          detail: "端末のスリープ復帰直後は再接続を試してください。",
          permissionDenied: false,
        };
      default:
        return {
          code: error.name,
          message: "Camera could not be started",
          detail: error.message,
          permissionDenied: false,
        };
    }
  }
  if (error instanceof Error) {
    return {
      code: error.name || "Error",
      message: "Camera could not be started",
      detail: error.message,
      permissionDenied: false,
    };
  }
  return {
    code: "UnknownError",
    message: "Camera could not be started",
    detail: "Unknown camera error",
    permissionDenied: false,
  };
}

class CameraService {
  async listDevices(): Promise<CameraInfo[]> {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices
      .filter((device) => device.kind === "videoinput")
      .map((device, index) => ({
        deviceId: device.deviceId,
        label: device.label || `Camera ${index + 1}`,
      }));
  }

  async openStream(deviceId?: string, facingMode: CameraFacing = "environment") {
    return navigator.mediaDevices.getUserMedia({
      audio: false,
      video: deviceId
        ? { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } }
        : { facingMode: { ideal: facingMode }, width: { ideal: 1280 }, height: { ideal: 720 } },
    });
  }
}

export const cameraService = new CameraService();

export function useCamera() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [cameraRunning, setCameraRunning] = useState(false);
  const [cameraState, setCameraState] = useState<CameraState>({
    connected: false,
    running: false,
    permissionDenied: false,
    error: null,
    activeDeviceId: null,
    devices: [],
  });
  const activeDeviceRef = useRef<string | null>(null);
  const activeFacingRef = useRef<CameraFacing>("environment");

  const syncState = useCallback((patch: Partial<CameraState>) => {
    setCameraState((current) => ({ ...current, ...patch }));
  }, []);

  const stopCamera = useCallback(() => {
    stream?.getTracks().forEach((track) => track.stop());
    setStream(null);
    setCameraRunning(false);
    setCameraError(null);
    syncState({ connected: false, running: false });
  }, [stream, syncState]);

  const connectCamera = useCallback(
    async (deviceId?: string, facingMode: CameraFacing = "environment") => {
      try {
        setCameraError(null);
        syncState({ error: null, permissionDenied: false });
        const mediaStream = await cameraService.openStream(deviceId, facingMode);
        const devices = await cameraService.listDevices().catch(() => []);
        const activeTrack = mediaStream.getVideoTracks()[0];
        const activeId = activeTrack?.getSettings().deviceId ?? deviceId ?? null;
        activeDeviceRef.current = activeId;
        activeFacingRef.current = facingMode;
        setStream(mediaStream);
        setCameraRunning(true);
        syncState({
          connected: true,
          running: true,
          activeDeviceId: activeId,
          devices,
        });
        if (videoRef.current) {
          videoRef.current.srcObject = mediaStream;
          await videoRef.current.play();
        }
    } catch (error) {
        const failure = describeCameraError(error);
        setCameraRunning(false);
        setCameraError(`${failure.message}${failure.detail ? `: ${failure.detail}` : ""}`);
        syncState({
          connected: false,
          running: false,
          permissionDenied: failure.permissionDenied,
          error: failure.message,
          errorCode: failure.code,
          errorDetail: failure.detail,
        });
      }
    },
    [syncState, videoRef]
  );

  const reconnectCamera = useCallback(async () => {
    await connectCamera(activeDeviceRef.current ?? undefined, activeFacingRef.current);
  }, [connectCamera]);

  const switchCamera = useCallback(async () => {
    const devices = cameraState.devices.length ? cameraState.devices : await cameraService.listDevices().catch(() => []);
    if (devices.length < 2) {
      return;
    }
    const currentIndex = Math.max(0, devices.findIndex((device) => device.deviceId === activeDeviceRef.current));
    const nextDevice = devices[(currentIndex + 1) % devices.length];
    await connectCamera(nextDevice.deviceId, activeFacingRef.current);
  }, [cameraState.devices, connectCamera]);

  const captureFrame = useCallback(async (): Promise<Blob | null> => {
    const video = videoRef.current;
    if (!video || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      return null;
    }
    const width = video.videoWidth;
    const height = video.videoHeight;
    if (!width || !height) {
      return null;
    }
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) {
      return null;
    }
    context.drawImage(video, 0, 0, width, height);
    return await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, "image/jpeg", 0.72);
    });
  }, []);

  useEffect(() => {
    return () => {
      stream?.getTracks().forEach((track) => track.stop());
    };
  }, [stream]);

  useEffect(() => {
    void cameraService.listDevices().then((devices) => syncState({ devices })).catch(() => undefined);
  }, [syncState]);

  const state = useMemo(
    () => ({
      ...cameraState,
      connected: cameraState.connected && !!stream,
      running: cameraRunning,
      error: cameraError ?? cameraState.error,
      errorCode: cameraState.errorCode,
      errorDetail: cameraState.errorDetail,
      activeDeviceId: activeDeviceRef.current,
    }),
    [cameraRunning, cameraError, cameraState, stream]
  );

  return {
    videoRef,
    startCamera: () => connectCamera(activeDeviceRef.current ?? undefined, activeFacingRef.current),
    stopCamera,
    reconnectCamera,
    switchCamera,
    captureFrame,
    cameraState: state,
    cameraError,
    setCameraError,
  };
}

export function useFrameSampler({
  videoRef,
  enabled,
  fps,
  onFrame,
}: {
  videoRef: RefObject<HTMLVideoElement | null>;
  enabled: boolean;
  fps: number;
  onFrame: (frame: Blob, frameIndex: number) => Promise<void>;
}) {
  const onFrameRef = useRef(onFrame);
  const inFlightRef = useRef(false);
  const frameIndexRef = useRef(0);

  useEffect(() => {
    onFrameRef.current = onFrame;
  }, [onFrame]);

  useEffect(() => {
    if (!enabled) {
      frameIndexRef.current = 0;
      return;
    }
    const interval = Math.max(200, Math.round(1000 / Math.max(1, Math.min(5, fps))));
    const timer = window.setInterval(() => {
      void (async () => {
        if (inFlightRef.current) {
          return;
        }
        const video = videoRef.current;
        if (!video || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
          return;
        }
        const width = video.videoWidth;
        const height = video.videoHeight;
        if (!width || !height) {
          return;
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d");
        if (!context) {
          return;
        }
        context.drawImage(video, 0, 0, width, height);
        const blob = await new Promise<Blob | null>((resolve) => {
          canvas.toBlob(resolve, "image/jpeg", 0.72);
        });
        if (!blob) {
          return;
        }
        inFlightRef.current = true;
        try {
          await onFrameRef.current(blob, frameIndexRef.current++);
        } finally {
          inFlightRef.current = false;
        }
      })();
    }, interval);

    return () => window.clearInterval(timer);
  }, [enabled, fps, videoRef]);
}
