/**
 * Mode dial. AUTO: camera chooses everything; brightness is the only control. P: readout up, camera
 * meters. M: ISO and shutter held. Camera2 holds those two together, so there is no S or A, and the
 * mode is derived from what is held.
 */
import {
  DEFAULT_CAPTURE_SETTINGS,
  UNAVAILABLE,
  type CaptureCapabilities,
  type CaptureSettings,
  type MeterReading,
} from "./model";

export type CaptureMode = "auto" | "program" | "manual";

/** AUTO skips the histogram. */
export type CaptureDisplay = "plain" | "grid" | "histogram";

export interface CaptureChrome {
  readout: boolean;
  display: CaptureDisplay;
}

export const DEFAULT_CAPTURE_CHROME: CaptureChrome = { readout: false, display: "plain" };

const DISPLAYS: readonly CaptureDisplay[] = ["plain", "grid", "histogram"];

export const exposureHeld = (settings: CaptureSettings): boolean =>
  settings.iso !== "auto" || settings.shutterNs !== "auto";

/** M needs both ISO and shutter ranges. */
export function holdsExposure(caps: CaptureCapabilities): boolean {
  return caps.manualSensor && caps.iso !== UNAVAILABLE && caps.shutterNs !== UNAVAILABLE;
}

/** Keeps only brightness. */
export function autoModeSettings(settings: CaptureSettings): CaptureSettings {
  return { ...DEFAULT_CAPTURE_SETTINGS, ev: settings.ev };
}

const sameValue = (a: unknown, b: unknown): boolean => a === b || JSON.stringify(a) === JSON.stringify(b);

/**
 * A value is held that AUTO can't show, so the readout must stay up. Derived from
 * `autoModeSettings` so new settings are covered automatically.
 */
export function heldBeyondAuto(settings: CaptureSettings): boolean {
  const released = autoModeSettings(settings);
  return (Object.keys(released) as (keyof CaptureSettings)[]).some(
    (key) => !sameValue(settings[key], released[key]),
  );
}

export function captureModeOf(settings: CaptureSettings, readout: boolean): CaptureMode {
  if (exposureHeld(settings)) return "manual";
  return readout || heldBeyondAuto(settings) ? "program" : "auto";
}

/** Releases exposure; keeps colour, focus and locks. */
export function programSettings(settings: CaptureSettings): CaptureSettings {
  return exposureHeld(settings) ? { ...settings, iso: "auto", shutterNs: "auto" } : settings;
}

/**
 * Holds the last metered exposure so the picture doesn't jump; null before the first reading.
 * The meter can exceed the manual ISO range (Seeker: 20000 vs 11470), so the clamped difference
 * moves to the shutter.
 */
export function manualSettings(
  settings: CaptureSettings,
  meter: MeterReading | null,
  caps: CaptureCapabilities,
): CaptureSettings | null {
  if (exposureHeld(settings)) return settings;
  if (meter === null || meter.iso === null || meter.shutterNs === null) return null;
  const range = caps.iso === UNAVAILABLE ? null : caps.iso;
  const iso = range ? Math.min(Math.max(meter.iso, range.min), range.max) : meter.iso;
  return { ...settings, iso, shutterNs: Math.round(meter.shutterNs * (meter.iso / iso)) };
}

/** Restores what P/M held before AUTO, with AUTO's current brightness. */
export function settingsLeavingAuto(
  now: CaptureSettings,
  parked: CaptureSettings | null,
): CaptureSettings {
  return parked !== null && heldBeyondAuto(parked) ? { ...parked, ev: now.ev } : now;
}

export interface DialState {
  settings: CaptureSettings;
  readout: boolean;
  parked: CaptureSettings | null;
}

/**
 * Null when already there, or M has nothing to hold. Returns the same `settings` object when the
 * camera needn't change (e.g. AUTO → P); callers rely on this to skip the repeating request.
 */
export function turnDial(
  state: DialState,
  next: CaptureMode,
  reading: MeterReading | null,
  caps: CaptureCapabilities,
): DialState | null {
  const mode = captureModeOf(state.settings, state.readout);
  if (next === mode) return null;
  if (next === "auto") {
    return { settings: autoModeSettings(state.settings), readout: false, parked: state.settings };
  }
  const from = mode === "auto" ? settingsLeavingAuto(state.settings, state.parked) : state.settings;
  const settings = next === "program" ? programSettings(from) : manualSettings(from, reading, caps);
  return settings === null ? null : { settings, readout: true, parked: null };
}

/**
 * M has no brightness (native reads back 0), so entering M sets it aside and leaving restores it.
 * `next` is already clamped; `aside` is the previous return value.
 */
export function withBrightnessCarried(
  now: CaptureSettings,
  next: CaptureSettings,
  aside: number | null,
): { settings: CaptureSettings; aside: number | null } {
  const held = exposureHeld(now);
  const holding = exposureHeld(next);
  if (!held && holding) return { settings: next, aside: now.ev };
  if (held && !holding && aside !== null) return { settings: { ...next, ev: aside }, aside: null };
  return { settings: next, aside };
}

/** On AUTO, which position has something parked (shown on the dial). */
export function rememberedMode(parked: CaptureSettings | null): CaptureMode | null {
  if (parked === null || !heldBeyondAuto(parked)) return null;
  return exposureHeld(parked) ? "manual" : "program";
}

/** Drops stored `parked` unless on AUTO and `aside` unless exposure is held. */
export function rememberedFor(
  settings: CaptureSettings,
  readout: boolean,
  parked: CaptureSettings | null,
  aside: number | null,
): { parked: CaptureSettings | null; aside: number | null } {
  const onAuto = captureModeOf(settings, readout) === "auto";
  return {
    parked: onAuto && rememberedMode(parked) !== null ? parked : null,
    aside: exposureHeld(settings) ? aside : null,
  };
}

export function displayIn(display: CaptureDisplay, mode: CaptureMode): CaptureDisplay {
  return mode === "auto" && display === "histogram" ? "plain" : display;
}

export function nextDisplay(display: CaptureDisplay, mode: CaptureMode): CaptureDisplay {
  const shown = displayIn(display, mode);
  if (shown === "plain") return "grid";
  if (shown === "grid") return mode === "auto" ? "plain" : "histogram";
  return "plain";
}

export function parseCaptureChrome(raw: string | null): CaptureChrome {
  if (!raw) return DEFAULT_CAPTURE_CHROME;
  try {
    const parsed = JSON.parse(raw) as { readout?: unknown; display?: unknown; histogram?: unknown } | null;
    const display = DISPLAYS.find((one) => one === parsed?.display);
    return {
      readout: parsed?.readout === true,
      // Older records have only `histogram`.
      display: display ?? (parsed?.histogram === true ? "histogram" : "plain"),
    };
  } catch {
    return DEFAULT_CAPTURE_CHROME;
  }
}

/**
 * Values AUTO can't show latch the readout on, so releasing them leaves the dial on P. Returns the
 * same object when unchanged.
 */
export function chromeHolding(chrome: CaptureChrome, settings: CaptureSettings): CaptureChrome {
  return !chrome.readout && heldBeyondAuto(settings) ? { ...chrome, readout: true } : chrome;
}
