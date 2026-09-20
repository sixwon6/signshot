import AsyncStorage from "@react-native-async-storage/async-storage";
import { createSerialQueue } from "../serial";
import { DEFAULT_CAPTURE_SETTINGS, type CaptureSettings } from "./model";

/**
 * The last manual settings, on this phone under `capture.v1`, so reopening the camera keeps a
 * hand-set exposure. Reads fail soft to automatic. Store what native reports it applied, not the request.
 * Beside them, what the mode dial set aside: the settings AUTO parked, and the brightness M did.
 */

const CAPTURE_STORE_KEY = "capture.v1";

interface StoredState {
  v: 1;
  settings: CaptureSettings;
  parked?: CaptureSettings | null;
  aside?: number | null;
}

/** The settings in force, and what the dial is keeping for a later turn. */
export interface StoredCapture {
  settings: CaptureSettings;
  parked: CaptureSettings | null;
  aside: number | null;
}

const NOTHING_STORED: StoredCapture = { settings: DEFAULT_CAPTURE_SETTINGS, parked: null, aside: null };

/** Everything a stored settings object must be to be believed at all. */
function readSettings(value: unknown): CaptureSettings {
  if (typeof value !== "object" || value === null) return DEFAULT_CAPTURE_SETTINGS;
  const stored = value as Partial<CaptureSettings>;
  return {
    iso: number(stored.iso),
    shutterNs: number(stored.shutterNs),
    ev: Number.isFinite(stored.ev) ? Math.round(stored.ev as number) : 0,
    aeLock: stored.aeLock === true,
    whiteBalance: whiteBalance(stored.whiteBalance),
    awbLock: stored.awbLock === true,
    focus: number(stored.focus),
  };
}

const number = (value: unknown): "auto" | number =>
  typeof value === "number" && Number.isFinite(value) ? value : "auto";

function whiteBalance(value: unknown): CaptureSettings["whiteBalance"] {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "object" && value !== null) {
    const kelvin = (value as { kelvin?: unknown }).kelvin;
    if (typeof kelvin === "number" && Number.isFinite(kelvin)) return { kelvin: Math.round(kelvin) };
  }
  return "auto";
}

const serial = createSerialQueue();

/** What the camera should come up on. Automatic, with nothing set aside, when nothing readable is stored. */
export async function loadCapture(): Promise<StoredCapture> {
  let raw: string | null = null;
  try {
    raw = await AsyncStorage.getItem(CAPTURE_STORE_KEY);
  } catch {
    return NOTHING_STORED;
  }
  if (!raw) return NOTHING_STORED;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredState>;
    return {
      settings: readSettings(parsed?.settings),
      // A record from before the dial has neither, and reads as nothing set aside.
      parked: typeof parsed?.parked === "object" && parsed.parked !== null ? readSettings(parsed.parked) : null,
      aside: Number.isFinite(parsed?.aside) ? Math.round(parsed.aside as number) : null,
    };
  } catch {
    return NOTHING_STORED;
  }
}

/** Stores what the camera actually applied, and what the dial set aside. */
export function saveCapture(capture: StoredCapture): Promise<void> {
  return serial(async () => {
    const state: StoredState = {
      v: 1,
      settings: readSettings(capture.settings),
      parked: capture.parked === null ? null : readSettings(capture.parked),
      aside: capture.aside,
    };
    await AsyncStorage.setItem(CAPTURE_STORE_KEY, JSON.stringify(state));
  });
}
