import { requireNativeModule } from "expo-modules-core";
import { requireNativeViewManager } from "expo-modules-core";
import * as React from "react";
import { ViewProps } from "react-native";


export interface CaptureOutput {
  baseName: string;
  cleanUri: string;
  styledUri: string;
  cleanSha256: string;
  styledSha256: string;
  captureResult: string;
  capturePipelineId: string;
  totalMs: number;
}

/** Result of `editPhoto`: a separate edited JPEG derived from the clean frame. */
export interface PhotoEdit {
  uri: string;
  sha256: string;
  sourceHash: string;
  pipelineId: string;
  width: number;
  height: number;
  profileId: string;
  profileVersion: number;
  intensity: number;
}

export interface CaptureRecord {
  v: number;
  baseName: string;
  capturedAtMs: number;
  sensorTimestamp: string | null;
  profileId: string;
  profileVersion: number;
  capturePipelineId: string;
  /** Style intensity as an INTEGER 0..100 (the profile curve domain), snapshotted at shutter. */
  intensity: number;
  captureResult: Record<string, unknown>;
  clean: { path: string; sha256: string };
  styled: { path: string; sha256: string };
  cleanUri: string;
  styledUri: string;
}

/** An absent device range. The same sentinel the capture record uses for unknown telemetry. */
export const UNAVAILABLE = "unavailable";
export type Unavailable = typeof UNAVAILABLE;

export interface NumericRange {
  min: number;
  max: number;
}

/**
 * What camera "0" can actually do, from `CameraCharacteristics`. Every range may be
 * `"unavailable"`: a missing range is a missing control, never an error.
 */
export interface CaptureCapabilities {
  /** REQUEST_AVAILABLE_CAPABILITIES — manual ISO, shutter and focus need this. */
  manualSensor: boolean;
  /** MANUAL_POST_PROCESSING — white balance in kelvin needs this. */
  manualPostProcessing: boolean;
  iso: NumericRange | Unavailable;
  shutterNs: NumericRange | Unavailable;
  /** `min`/`max` are compensation STEPS; `step` is the EV each one is worth (e.g. 1/3). */
  ev: (NumericRange & { step: number }) | Unavailable;
  aeLock: boolean;
  awbLock: boolean;
  /** CONTROL_AWB_AVAILABLE_MODES by name: `auto`, `daylight`, `shade`, … */
  awbModes: string[];
  afModes: string[];
  /**
   * Manual focus in dioptres (0 = infinity). `calibration` is `uncalibrated` on the Seeker, so a
   * value is a lens position, not a distance; show it as relative.
   */
  focus: { minDiopters: number; maxDiopters: number; calibration: string } | Unavailable;
  /** The kelvin band offered when `manualPostProcessing` is true. */
  kelvin: NumericRange | Unavailable;
}

/**
 * The manual controls. `"auto"` is a value, not an absence. If either ISO or shutter is a number,
 * AE is off and the one left on `"auto"` is taken from the last AE result.
 */
export interface CaptureSettings {
  iso: "auto" | number;
  shutterNs: "auto" | number;
  /** Exposure compensation in device STEPS (not stops), and only while AE is on. */
  ev: number;
  aeLock: boolean;
  /** `"auto"`, a name from `awbModes`, or a temperature (MANUAL_POST_PROCESSING only). */
  whiteBalance: "auto" | string | { kelvin: number };
  awbLock: boolean;
  /** Dioptres, clamped to the device's focus range. */
  focus: "auto" | number;
}

/** What was actually applied: the same shape, every number clamped to the device range. */
export interface EffectiveCaptureSettings extends CaptureSettings {
  /** AE is off and ISO and shutter are both being held. */
  manualExposure: boolean;
}

/** One `onMeter` reading. Every 3A field is null until the camera reports it. */
export interface MeterReading {
  iso: number | null;
  shutterNs: number | null;
  /** Compensation steps the HAL reports as applied. */
  ev: number | null;
  /** Dioptres, UNCALIBRATED on this device: a position, not a distance. */
  focusDistance: number | null;
  awbMode: string | null;
  aeState: string;
  afState: string;
  manualExposure: boolean;
  /** 64 bins of preview luma, 8-bit code 0..255 over limited-range BT.601. */
  histogram: number[];
  /** Pixels the histogram counted (the preview frame is subsampled). */
  sampled: number;
  /** Fraction of sampled pixels at or below code 16 / at or above code 235. */
  clippedBlack: number;
  clippedWhite: number;
}

interface SeekerCameraModuleType {
  /** Style intensity as a FLOAT 0..1 (clamped natively). CaptureRecord.intensity is 0..100. */
  setIntensity(value: number): void;
  editPhoto(baseName: string, manifest: string, lut: string | null, strength: number): Promise<PhotoEdit>;
  /** Returns the capture_pipeline_id now in force. */
  applyProfile(manifestJson: string, lutBase64: string | null): Promise<string>;
  capture(): Promise<CaptureOutput>;
  /** The device's manual-control ranges. Works with no camera view mounted. Call through `src/capture/apply.ts`. */
  captureCapabilities(): Promise<CaptureCapabilities>;
  /**
   * Applies `json` (a {@link CaptureSettings}) to the preview and the next still and resolves what
   * is in force. Rejects only for a control this camera lacks; out-of-range values come back clamped.
   */
  setCaptureSettings(json: string): Promise<EffectiveCaptureSettings>;
  /** Newest-first. Works with no camera view mounted. Corrupt sidecars are skipped. */
  listCaptures(): Promise<CaptureRecord[]>;
  /**
   * Removes the frames, the sidecar, the upload thumbnail and any thumbnail scratch file an
   * interrupted record write left behind. Gallery copies are left alone.
   */
  deleteCapture(baseName: string): Promise<boolean>;
  /** Writes `<baseName>-print-<expectedHash>.jpg` from the selected version, which must hash to `expectedHash`. */
  preparePrintImage(baseName: string, sourceUri: string, expectedHash: string): Promise<{ path: string; sha256: string; bytes: number; width: number; height: number }>;
  /**
   * Removes one print derivative and its scratch file; resolves whether it existed. The print is
   * written at the estimate step, so discarding a draft must remove it.
   */
  deletePrintImage(baseName: string, sha256: string): Promise<boolean>;
  sharePrintCard(baseName: string, sourceHash: string, title: string, count: number, modules: string, size: number): Promise<string>;
  /**
   * Copies the styled frame into `Pictures/Signshot` as `<base>.jpg` and resolves its `content://`
   * URI. Idempotent by content. Call through {@link saveToGallery}.
   */
  exportToGallery(baseName: string): Promise<string>;
  exportEditToGallery(baseName: string, sourceUri: string, expectedHash: string): Promise<string>;
  /** Stamps a share copy of the selected JPEG after checking it hashes to `expectedHash`. */
  stampSelectedShareCopy(baseName: string, sourceUri: string, expectedHash: string, text: string): Promise<string>;
  /**
   * Unstamped share copy of the selected version, fingerprint-checked and re-encoded into
   * `cacheDir/share`. Shares always go through a cache copy because that is the sharing
   * FileProvider's only root, so `filesDir/captures` is never exposed.
   */
  shareCopy(baseName: string, sourceUri: string, expectedHash: string): Promise<string>;
  /**
   * Writes `cacheDir/share/<baseName>-publication-bundle.json`: `documentJson` plus a `printImage`
   * (name, sha256, bytes, base64) that must hash to `expectedHash`. Lets an unuploaded
   * publication's bytes leave the phone; there is no import path.
   */
  exportPublicationBundle(baseName: string, sourceUri: string, expectedHash: string, documentJson: string): Promise<string>;
  /**
   * Lowercase-hex SHA-256 of both private frames as currently on disk, read from the sidecar's
   * paths, for comparison with the hashes recorded at capture time.
   */
  hashCaptureFrames(baseName: string): Promise<{ clean: string; styled: string }>;
  /**
   * Opens a scanner, resolves the decoded text of the first QR code, or null when the person
   * cancels. Rejects with a readable message when scanning is unavailable on this device.
   *
   * Reads a collect link off another phone's screen or a printed card. The text comes back exactly
   * as the symbol carried it; parsing and validating the link is the caller's job.
   *
   * The scanner opens the back camera itself, so it must not run while `SeekerCameraView` is
   * mounted — it rejects if one is. Call it from the Collection tab, where no camera view is up.
   */
  scanQrCode(): Promise<string | null>;
  /**
   * Tap to focus: `u`,`v` are 0..1 across the picture as displayed. Focus and exposure meter on
   * that point and continuous focus locks there until a photo is taken, `releaseFocusPoint`, or
   * manual focus. Rejects only with no camera view up.
   */
  focusAt(u: number, v: number): Promise<void>;
  releaseFocusPoint(): Promise<void>;
  /**
   * Hardware key attestation of one publication. Generates a fresh Android Keystore P-256 key
   * whose attestation challenge is the SHA-256 of `manifestJson` (StrongBox first, then the
   * TEE), signs those exact bytes with it, returns the certificate chain and signature, and
   * deletes the key. Never rejects for a device that cannot attest: that is `available: false`
   * with a reason, and the publication goes ahead without evidence.
   */
  attestPublication(manifestJson: string): Promise<PublicationAttestationResult>;
}

export type PublicationAttestationResult =
  | {
      available: true;
      /** Diagnostic only: whether StrongBox was REQUESTED. The certificate's security level is the evidence. */
      strongBox: boolean;
      /** DER ECDSA over the manifest bytes, base64. */
      signature: string;
      /** DER certificates, base64, leaf first. */
      certificates: string[];
    }
  | { available: false; reason: string };

export const SeekerCamera =
  requireNativeModule<SeekerCameraModuleType>("SeekerCamera");

/** Needs no storage permission: scoped storage lets the app write its own gallery rows. */
export async function saveToGallery(baseName: string, edit?: PhotoEdit): Promise<string> {
  return edit ? SeekerCamera.exportEditToGallery(baseName, edit.uri, edit.sha256) : SeekerCamera.exportToGallery(baseName);
}

export interface SeekerCameraViewProps extends ViewProps {
  onSessionError?: (e: { nativeEvent: { message: string } }) => void;
  /**
   * The live meter: the 3A readout and a 64-bin luma histogram of the preview frame, at most ten
   * times a second. Chrome only — nothing here reaches a capture or a record.
   */
  onMeter?: (e: { nativeEvent: MeterReading }) => void;
}

const NativeView: React.ComponentType<SeekerCameraViewProps> =
  requireNativeViewManager("SeekerCamera");

export function SeekerCameraView(props: SeekerCameraViewProps) {
  return React.createElement(NativeView, props);
}
