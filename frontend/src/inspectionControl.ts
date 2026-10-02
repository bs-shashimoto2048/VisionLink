import type { SessionStatus } from "./types";

/** What the single [検査 ...] button does for the current session state. */
export type InspectionControlMode = "start" | "stop" | "resume";

// Compared as plain strings so this module stays free of runtime imports (it is unit-tested under node).
export function inspectionControlMode(status: SessionStatus | null | undefined): InspectionControlMode {
  if (status === "IN_PROGRESS") return "stop"; // running -> pause
  if (status === "PAUSED") return "resume"; // paused -> resume the SAME session (never start a new one)
  return "start"; // no session (or COMPLETED / ABORTED) -> start a new session
}

export const INSPECTION_CONTROL_LABEL: Record<InspectionControlMode, string> = {
  start: "検査開始",
  stop: "検査停止",
  resume: "検査再開",
};
