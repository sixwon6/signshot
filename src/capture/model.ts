/**
 * Manual camera settings as native understands them; `"auto"` is a value, not a missing field.
 * Clamped here to `CameraCharacteristics` ranges and again in native. ISO and shutter go manual
 * together; `CaptureControls.kt` fills the other from the last AE result.
 */
import type {
  CaptureCapabilities,
  CaptureSettings,
  EffectiveCaptureSettings,
  MeterReading,
  NumericRange,
} from "../../modules/seeker-camera";

export type { CaptureCapabilities, CaptureSettings, EffectiveCaptureSettings, MeterReading };

/** Native's spelling for an absent device range. */
export const UNAVAILABLE = "unavailable";

export const AUTO_LABEL = "AUTO";

export const DEFAULT_CAPTURE_SETTINGS: CaptureSettings = {
  iso: "auto",
  shutterNs: "auto",
  ev: 0,
  aeLock: false,
  whiteBalance: "auto",
  awbLock: false,
  focus: "auto",
};

/** Camera2 holds ISO and shutter together. Never label the companion value as automatic. */
export function settingsFromEffective(effective: EffectiveCaptureSettings): CaptureSettings {
  const { manualExposure, ...settings } = effective;
  return {
    ...settings,
    iso: manualExposure ? effective.iso : "auto",
    shutterNs: manualExposure ? effective.shutterNs : "auto",
  };
}

/**
 * Whether the readout strip would change (histogram excluded). Gates re-renders: readings arrive
 * ~10 per second.
 */
export function readoutChanged(now: MeterReading | null, next: MeterReading): boolean {
  return (
    now === null ||
    now.iso !== next.iso ||
    now.shutterNs !== next.shutterNs ||
    now.ev !== next.ev ||
    now.focusDistance !== next.focusDistance ||
    now.awbMode !== next.awbMode ||
    now.manualExposure !== next.manualExposure
  );
}

const NS_PER_S = 1_000_000_000;

const clamp = (value: number, low: number, high: number): number =>
  value < low ? low : value > high ? high : value;

const finite = (value: number, fallback: number): number =>
  Number.isFinite(value) ? value : fallback;

const rangeOf = (range: NumericRange | typeof UNAVAILABLE | undefined): NumericRange | null =>
  range && range !== UNAVAILABLE ? range : null;

/** Third-stop ISO ladder (100, 125, 160…), repeated per decade to avoid rounding drift. */
export const ISO_LADDER: readonly number[] = (() => {
  const decade = [100, 125, 160, 200, 250, 320, 400, 500, 640, 800];
  const out: number[] = [25, 32, 40, 50, 64, 80];
  for (let power = 0; power <= 3; power++) {
    const scale = 10 ** power;
    for (const step of decade) out.push(step * scale);
  }
  return out;
})();

/** Full-stop shutter ladder, 1/8000 s to 30 s, in nanoseconds. */
export const SHUTTER_LADDER_NS: readonly number[] = (() => {
  const fractions = [8000, 4000, 2000, 1000, 500, 250, 125, 60, 30, 15, 8, 4, 2];
  const seconds = [1, 2, 4, 8, 15, 30];
  return [
    ...fractions.map((denominator) => Math.round(NS_PER_S / denominator)),
    ...seconds.map((value) => value * NS_PER_S),
  ];
})();

/** Clamp, not snap: a companion value held from the meter may sit between ladder steps. */
function clampIso(value: number, caps: CaptureCapabilities): number {
  const range = rangeOf(caps.iso);
  const low = range ? range.min : ISO_LADDER[0];
  const high = range ? range.max : ISO_LADDER[ISO_LADDER.length - 1];
  return clamp(Math.round(finite(value, low)), low, high);
}

function clampShutterNs(value: number, caps: CaptureCapabilities): number {
  const range = rangeOf(caps.shutterNs);
  const low = range ? range.min : SHUTTER_LADDER_NS[0];
  const high = range ? range.max : SHUTTER_LADDER_NS[SHUTTER_LADDER_NS.length - 1];
  return clamp(Math.round(finite(value, low)), low, high);
}

/** EV compensation is in whole device steps, not stops. */
function snapEvSteps(steps: number, caps: CaptureCapabilities): number {
  const range = rangeOf(caps.ev);
  if (!range) return 0;
  return clamp(Math.round(finite(steps, 0)), range.min, range.max);
}

function evStops(steps: number, caps: CaptureCapabilities): number {
  const range = caps.ev === UNAVAILABLE ? null : caps.ev;
  return range ? steps * range.step : 0;
}

/** AUTO's brightness range in device steps: ±2 stops within the device range. P gets the full range. */
export function autoEvSpan(caps: CaptureCapabilities): { min: number; max: number } | null {
  const range = caps.ev === UNAVAILABLE ? null : caps.ev;
  if (!range || range.step <= 0) return null;
  const two = Math.round(2 / range.step);
  const span = { min: Math.max(range.min, -two), max: Math.min(range.max, two) };
  return span.max > span.min ? span : null;
}

function clampKelvin(kelvin: number, caps: CaptureCapabilities): number {
  const range = rangeOf(caps.kelvin);
  if (!range) return Math.round(finite(kelvin, 6500));
  return clamp(Math.round(finite(kelvin, range.min)), range.min, range.max);
}

/** Dioptres: 0 is infinity, `maxDiopters` the closest focus. */
export function clampFocus(diopters: number, caps: CaptureCapabilities): number {
  const focus = caps.focus;
  if (focus === UNAVAILABLE) return 0;
  return clamp(finite(diopters, 0), focus.minDiopters, focus.maxDiopters);
}

/**
 * Mirrors native's `resolve` so the UI shows the applied value. Unsupported controls fall back to
 * auto here because native rejects them outright.
 */
export function clampSettings(
  settings: CaptureSettings,
  caps: CaptureCapabilities,
): CaptureSettings {
  const manualExposure = caps.manualSensor && (settings.iso !== "auto" || settings.shutterNs !== "auto");
  const whiteBalance = clampWhiteBalance(settings.whiteBalance, caps);
  return {
    iso: manualExposure && settings.iso !== "auto" ? clampIso(settings.iso, caps) : "auto",
    shutterNs:
      manualExposure && settings.shutterNs !== "auto" ? clampShutterNs(settings.shutterNs, caps) : "auto",
    ev: manualExposure ? 0 : snapEvSteps(settings.ev, caps),
    aeLock: settings.aeLock && caps.aeLock && !manualExposure,
    whiteBalance,
    awbLock: settings.awbLock && caps.awbLock && typeof whiteBalance === "string",
    focus:
      settings.focus === "auto" || caps.focus === UNAVAILABLE
        ? "auto"
        : clampFocus(settings.focus, caps),
  };
}

function clampWhiteBalance(
  whiteBalance: CaptureSettings["whiteBalance"],
  caps: CaptureCapabilities,
): CaptureSettings["whiteBalance"] {
  if (whiteBalance === "auto") return "auto";
  if (typeof whiteBalance === "string") {
    return caps.awbModes.includes(whiteBalance) ? whiteBalance : "auto";
  }
  if (!caps.manualPostProcessing) return "auto";
  return { kelvin: clampKelvin(whiteBalance.kelvin, caps) };
}

// Readouts

export function formatIso(iso: CaptureSettings["iso"]): string {
  return iso === "auto" ? AUTO_LABEL : `ISO ${Math.round(iso)}`;
}

/** `1/250` under a second, `2 s` at or over. */
export function formatShutter(shutterNs: CaptureSettings["shutterNs"]): string {
  if (shutterNs === "auto") return AUTO_LABEL;
  const ns = Math.max(1, Math.round(shutterNs));
  if (ns >= NS_PER_S) {
    const seconds = ns / NS_PER_S;
    const shown = seconds >= 10 ? Math.round(seconds) : Math.round(seconds * 10) / 10;
    return `${shown} s`;
  }
  return `1/${Math.round(NS_PER_S / ns)}`;
}

/** In EV, not steps: `0`, `+0.7`, `-1.3`. */
export function formatEv(steps: number, caps: CaptureCapabilities): string {
  const stops = evStops(steps, caps);
  const rounded = Math.round(stops * 10) / 10;
  if (rounded === 0) return "0";
  return `${rounded > 0 ? "+" : "-"}${Math.abs(rounded).toFixed(1)}`;
}

export function formatKelvin(kelvin: number): string {
  return `${Math.round(kelvin)} K`;
}

/**
 * Relative position, 0% = infinity, 100% = closest. Never a distance: the Seeker reports
 * `LENS_INFO_FOCUS_DISTANCE_CALIBRATION` as UNCALIBRATED.
 */
export function formatFocus(focus: CaptureSettings["focus"], caps: CaptureCapabilities): string {
  if (focus === "auto") return AUTO_LABEL;
  const range = caps.focus;
  if (range === UNAVAILABLE || range.maxDiopters <= 0) return AUTO_LABEL;
  return `${Math.round((clampFocus(focus, caps) / range.maxDiopters) * 100)}%`;
}
