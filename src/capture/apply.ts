import { SeekerCamera } from "../../modules/seeker-camera";
import {
  clampSettings,
  type CaptureCapabilities,
  type CaptureSettings,
  type EffectiveCaptureSettings,
} from "./model";

/** Sole bridge for manual controls. Clamped here too for same-frame display; native's clamp wins. */

let cached: Promise<CaptureCapabilities> | null = null;

/** Cached: `CameraCharacteristics` can't change while the app runs. */
export function captureCapabilities(): Promise<CaptureCapabilities> {
  if (!cached) {
    cached = SeekerCamera.captureCapabilities().catch((error: unknown) => {
      cached = null;
      throw error;
    });
  }
  return cached;
}

/** Applies to preview and next still; resolves the values actually in force. */
export async function applyCaptureSettings(
  settings: CaptureSettings,
): Promise<EffectiveCaptureSettings> {
  const caps = await captureCapabilities();
  return SeekerCamera.setCaptureSettings(JSON.stringify(clampSettings(settings, caps)));
}

/** Preview surface not up yet (cold start, view rebuild); retryable. Matches native's fixed message. */
export function isCameraViewNotReady(cause: unknown): boolean {
  const text = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "";
  return text.includes("no active camera view");
}
