/**
 * The capture model: manual camera settings as native understands them. `"auto"` is a value, not a
 * missing field. Helpers clamp to the device's `CameraCharacteristics` ranges; native clamps again
 * and returns what it applied. ISO and shutter go manual together; native (`CaptureControls.kt`)
 * fills the other from the last AE result.
 */
import type {
  CaptureCapabilities,
  CaptureSettings,
  EffectiveCaptureSettings,
  MeterReading,
  NumericRange,
} from "../../modules/seeker-camera";

export type { CaptureCapabilities, CaptureSettings, EffectiveCaptureSettings, MeterReading };

/** An absent device range, as native spells it. */
export const UNAVAILABLE = "unavailable";

/** What a control shows when the camera is choosing. One word, like every other label. */
export const AUTO_LABEL = "AUTO";

/** Everything automatic. */
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
 * True when `next` would change anything the readout strip shows: the five metered values and
 * whether exposure is being held. The rest of a reading is the histogram, which is drawn from
 * every reading when it is drawn at all.
 *
 * The camera holds the last reading in state, so this is what decides whether ten readings a
 * second are ten renders of the screen or none.
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

/**
 * The ISO ladder in THIRD stops — the numbers printed on a film box and on every camera dial:
 * 100, 125, 160, 200… Each decade is the same ten values times ten, which is what makes the
 * ladder third-stops without any rounding drift.
 */
export const ISO_LADDER: readonly number[] = (() => {
  const decade = [100, 125, 160, 200, 250, 320, 400, 500, 640, 800];
  const out: number[] = [25, 32, 40, 50, 64, 80];
  for (let power = 0; power <= 3; power++) {
    const scale = 10 ** power;
    for (const step of decade) out.push(step * scale);
  }
  return out;
})();

/**
 * The shutter ladder, 1/8000 s to 30 s, in nanoseconds. Full stops, the ladder a shutter-speed
 * dial has: the thirds between them are for the camera to choose, not for a thumb on glass.
 */
export const SHUTTER_LADDER_NS: readonly number[] = (() => {
  const fractions = [8000, 4000, 2000, 1000, 500, 250, 125, 60, 30, 15, 8, 4, 2];
  const seconds = [1, 2, 4, 8, 15, 30];
  return [
    ...fractions.map((denominator) => Math.round(NS_PER_S / denominator)),
    ...seconds.map((value) => value * NS_PER_S),
  ];
})();

/** UI dials choose ladder values. Preserve a companion value held from the camera's meter. */
function clampIso(value: number, caps: CaptureCapabilities): number {
  const range = rangeOf(caps.iso);
  const low = range ? range.min : ISO_LADDER[0];
  const high = range ? range.max : ISO_LADDER[ISO_LADDER.length - 1];
  return clamp(Math.round(finite(value, low)), low, high);
}

/** Clamp to sensor limits without changing exposure when a different control moves. */
function clampShutterNs(value: number, caps: CaptureCapabilities): number {
  const range = rangeOf(caps.shutterNs);
  const low = range ? range.min : SHUTTER_LADDER_NS[0];
  const high = range ? range.max : SHUTTER_LADDER_NS[SHUTTER_LADDER_NS.length - 1];
  return clamp(Math.round(finite(value, low)), low, high);
}

/** Exposure compensation is counted in whole device STEPS; this is the rounding and the clamp. */
function snapEvSteps(steps: number, caps: CaptureCapabilities): number {
  const range = rangeOf(caps.ev);
  if (!range) return 0;
  return clamp(Math.round(finite(steps, 0)), range.min, range.max);
}

/** Compensation steps as EV, for a readout. */
function evStops(steps: number, caps: CaptureCapabilities): number {
  const range = caps.ev === UNAVAILABLE ? null : caps.ev;
  return range ? steps * range.step : 0;
}

function clampKelvin(kelvin: number, caps: CaptureCapabilities): number {
  const range = rangeOf(caps.kelvin);
  if (!range) return Math.round(finite(kelvin, 6500));
  return clamp(Math.round(finite(kelvin, range.min)), range.min, range.max);
}

/** Dioptres, clamped to the lens. 0 is infinity; `maxDiopters` is as close as it focuses. */
export function clampFocus(diopters: number, caps: CaptureCapabilities): number {
  const focus = caps.focus;
  if (focus === UNAVAILABLE) return 0;
  return clamp(finite(diopters, 0), focus.minDiopters, focus.maxDiopters);
}

/**
 * The whole settings object put through the device's ranges — the JS mirror of native's
 * `resolve`, so the UI shows the value that will be applied rather than the one that was asked
 * for. A control the camera does not have falls back to auto here; native REFUSES the same thing
 * with a reason, and this is what keeps that refusal off the screen.
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

// ---------------------------------------------------------------------------
// Readouts. One short token each; nothing here is a sentence.
// ---------------------------------------------------------------------------

export function formatIso(iso: CaptureSettings["iso"]): string {
  return iso === "auto" ? AUTO_LABEL : `ISO ${Math.round(iso)}`;
}

/** `1/250` under a second, `2 s` at or over it, `30 s` at the end of the ladder. */
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

/** `0`, `+0.7`, `-1.3` — the compensation in EV, not in steps. */
export function formatEv(steps: number, caps: CaptureCapabilities): string {
  const stops = evStops(steps, caps);
  const rounded = Math.round(stops * 10) / 10;
  if (rounded === 0) return "0";
  return `${rounded > 0 ? "+" : "-"}${Math.abs(rounded).toFixed(1)}`;
}

export function formatKelvin(kelvin: number): string {
  return `${Math.round(kelvin)} K`;
}

export function formatWhiteBalance(whiteBalance: CaptureSettings["whiteBalance"]): string {
  if (whiteBalance === "auto") return AUTO_LABEL;
  if (typeof whiteBalance === "string") return whiteBalance;
  return formatKelvin(whiteBalance.kelvin);
}

/**
 * Manual focus as a RELATIVE position, `0%` at infinity and `100%` at the closest the lens
 * focuses. Never a distance: the Seeker reports `LENS_INFO_FOCUS_DISTANCE_CALIBRATION` as
 * UNCALIBRATED, so the dioptre value it takes is a position on the lens and a
 * figure in metres would be an invention.
 */
export function formatFocus(focus: CaptureSettings["focus"], caps: CaptureCapabilities): string {
  if (focus === "auto") return AUTO_LABEL;
  const range = caps.focus;
  if (range === UNAVAILABLE || range.maxDiopters <= 0) return AUTO_LABEL;
  return `${Math.round((clampFocus(focus, caps) / range.maxDiopters) * 100)}%`;
}
