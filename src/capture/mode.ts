/**
 * The mode dial. AUTO is the point-and-shoot: the camera chooses everything and brightness is the
 * one control on the picture. P and M are the same camera with the readout up: P while the camera
 * meters, M while ISO and shutter are held. Camera2 holds those two together, so the dial has no
 * S and no A, and M is never chosen apart from the exposure: the dial follows what is held.
 */
import {
  DEFAULT_CAPTURE_SETTINGS,
  UNAVAILABLE,
  type CaptureCapabilities,
  type CaptureSettings,
  type MeterReading,
} from "./model";

export type CaptureMode = "auto" | "program" | "manual";

/** What DISP cycles over the picture. The histogram belongs to the readout, so AUTO skips it. */
export type CaptureDisplay = "plain" | "grid" | "histogram";

/** What is remembered of the chrome: whether the dial is off AUTO, and what DISP shows. */
export interface CaptureChrome {
  readout: boolean;
  display: CaptureDisplay;
}

export const DEFAULT_CAPTURE_CHROME: CaptureChrome = { readout: false, display: "plain" };

const DISPLAYS: readonly CaptureDisplay[] = ["plain", "grid", "histogram"];

export const exposureHeld = (settings: CaptureSettings): boolean =>
  settings.iso !== "auto" || settings.shutterNs !== "auto";

/**
 * Whether this camera has an M. ISO and shutter are one pair: a camera that cannot report both
 * ranges has neither cell on the readout and no M on the dial.
 */
export function holdsExposure(caps: CaptureCapabilities): boolean {
  return caps.manualSensor && caps.iso !== UNAVAILABLE && caps.shutterNs !== UNAVAILABLE;
}

/** AUTO keeps brightness, the one control it shows, and hands everything else back. */
export function autoModeSettings(settings: CaptureSettings): CaptureSettings {
  return { ...DEFAULT_CAPTURE_SETTINGS, ev: settings.ev };
}

const sameValue = (a: unknown, b: unknown): boolean => a === b || JSON.stringify(a) === JSON.stringify(b);

/**
 * Something is held that AUTO has no cell for. A held value is never hidden, so the readout is up.
 * Read off `autoModeSettings` rather than listed again: whatever AUTO would release is exactly
 * what it cannot show, and a setting added later is covered without being named here.
 */
export function heldBeyondAuto(settings: CaptureSettings): boolean {
  const released = autoModeSettings(settings);
  return (Object.keys(released) as (keyof CaptureSettings)[]).some(
    (key) => !sameValue(settings[key], released[key]),
  );
}

/** Where the dial sits. `readout` is the photographer's choice between AUTO and the rest. */
export function captureModeOf(settings: CaptureSettings, readout: boolean): CaptureMode {
  if (exposureHeld(settings)) return "manual";
  return readout || heldBeyondAuto(settings) ? "program" : "auto";
}

/** P hands exposure back to the camera and keeps colour, focus and the locks. */
export function programSettings(settings: CaptureSettings): CaptureSettings {
  return exposureHeld(settings) ? { ...settings, iso: "auto", shutterNs: "auto" } : settings;
}

/**
 * M. An exposure already held stays as it is. Otherwise M holds the one the camera last metered,
 * so the picture does not change as the dial turns. Null before the first reading: there is
 * nothing to hold yet.
 *
 * In the dark the meter reads past what the sensor will hold by hand (the Seeker meters ISO 20000
 * over a manual range that ends at 11470). Holding the clamped ISO alone would darken the picture
 * most of a stop, so the difference goes to the shutter and the exposure stays what was metered.
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

/**
 * Leaving AUTO. What P and M held when the dial went to AUTO comes back with it, like a camera's,
 * under the brightness AUTO has now: that is the one control the two share.
 */
export function settingsLeavingAuto(
  now: CaptureSettings,
  parked: CaptureSettings | null,
): CaptureSettings {
  return parked !== null && heldBeyondAuto(parked) ? { ...parked, ev: now.ev } : now;
}

/** What the dial turns: the settings in force, whether the readout is up, and what AUTO set aside. */
export interface DialState {
  settings: CaptureSettings;
  readout: boolean;
  parked: CaptureSettings | null;
}

/**
 * The dial turned to `next`; `reading` is the camera's newest. Null when the turn is refused:
 * the dial is already there, or M has neither a held exposure nor a reading to hold.
 *
 * `settings` comes back as the state's own object when the turn changes nothing in the camera
 * (AUTO to P with nothing set aside). That is the contract a caller relies on to leave the
 * camera's repeating request alone.
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
 * Brightness steers the meter, so M has none and native reads it back as 0. A camera's
 * compensation dial stays where it was set: the value M set aside returns with the meter.
 * `next` is already clamped; `aside` is what the last call returned.
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

/**
 * Which position is holding something for the photographer while the dial is on AUTO: M when an
 * exposure was set aside, P for anything else, null when AUTO set nothing aside. The dial shows
 * it, so what comes back with a turn is never a surprise.
 */
export function rememberedMode(parked: CaptureSettings | null): CaptureMode | null {
  if (parked === null || !heldBeyondAuto(parked)) return null;
  return exposureHeld(parked) ? "manual" : "program";
}

/**
 * What was stored beside the settings, made fit to believe: AUTO's set-aside settings only while
 * the dial is on AUTO, and M's set-aside brightness only while an exposure is held.
 */
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

/** What the picture carries in this mode: AUTO never draws the histogram. */
export function displayIn(display: CaptureDisplay, mode: CaptureMode): CaptureDisplay {
  return mode === "auto" && display === "histogram" ? "plain" : display;
}

/** One press of DISP. */
export function nextDisplay(display: CaptureDisplay, mode: CaptureMode): CaptureDisplay {
  const shown = displayIn(display, mode);
  if (shown === "plain") return "grid";
  if (shown === "grid") return mode === "auto" ? "plain" : "histogram";
  return "plain";
}

/** The stored chrome, read soft: anything unreadable is AUTO and a plain picture. */
export function parseCaptureChrome(raw: string | null): CaptureChrome {
  if (!raw) return DEFAULT_CAPTURE_CHROME;
  try {
    const parsed = JSON.parse(raw) as { readout?: unknown; display?: unknown; histogram?: unknown } | null;
    const display = DISPLAYS.find((one) => one === parsed?.display);
    return {
      readout: parsed?.readout === true,
      // A record from before DISP said only whether the histogram was on.
      display: display ?? (parsed?.histogram === true ? "histogram" : "plain"),
    };
  } catch {
    return DEFAULT_CAPTURE_CHROME;
  }
}

/**
 * Stored settings that hold something AUTO cannot show put the readout up for good, not only
 * while they are held: releasing the last of them leaves the dial on P, where it was released.
 * The same object comes back when there is nothing to change, so a caller can tell.
 */
export function chromeHolding(chrome: CaptureChrome, settings: CaptureSettings): CaptureChrome {
  return !chrome.readout && heldBeyondAuto(settings) ? { ...chrome, readout: true } : chrome;
}
