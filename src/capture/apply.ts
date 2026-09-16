import { SeekerCamera } from "../../modules/seeker-camera";
import {
  clampSettings,
  type CaptureCapabilities,
  type CaptureSettings,
  type EffectiveCaptureSettings,
} from "./model";

/**
 * The only place manual controls cross into native. Settings are also clamped here so the screen
 * can show the applied value in the same frame, without waiting for the bridge; native's clamp decides.
 */

let cached: Promise<CaptureCapabilities> | null = null;

/**
 * What this camera can do. Read once and remembered: it comes from `CameraCharacteristics`,
 * which cannot change while the app is running.
 */
export function captureCapabilities(): Promise<CaptureCapabilities> {
  if (!cached) {
    cached = SeekerCamera.captureCapabilities().catch((error: unknown) => {
      cached = null;
      throw error;
    });
  }
  return cached;
}

/**
 * Applies the manual controls to the live preview and to the next still, and resolves what is
 * actually in force — every number clamped to the device's ranges. Rejects, naming the reason,
 * only for a control this camera does not have; that cannot happen for settings that have been
 * through {@link clampSettings} against the same capabilities.
 */
export async function applyCaptureSettings(
  settings: CaptureSettings,
): Promise<EffectiveCaptureSettings> {
  const caps = await captureCapabilities();
  return SeekerCamera.setCaptureSettings(JSON.stringify(clampSettings(settings, caps)));
}

/**
 * Did the bridge refuse only because the preview surface is not up yet? Native says so in one
 * fixed sentence; a cold start and a view rebuild both hit it, and both are worth retrying.
 * A classifier rather than a message read: the sentence is matched here and never rendered.
 */
export function isCameraViewNotReady(cause: unknown): boolean {
  const text = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "";
  return text.includes("no active camera view");
}
