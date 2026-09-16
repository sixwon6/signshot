import AsyncStorage from "@react-native-async-storage/async-storage";
import { createSerialQueue } from "../serial";
import { DEFAULT_CAPTURE_SETTINGS, type CaptureSettings } from "./model";

/**
 * The last manual settings, on this phone under `capture.v1`, so reopening the camera keeps a
 * hand-set exposure. Reads fail soft to automatic. Store what native reports it applied, not the request.
 */

const CAPTURE_STORE_KEY = "capture.v1";

interface StoredState {
  v: 1;
  settings: CaptureSettings;
}

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

/** The settings the camera should come up on. Automatic when nothing readable is stored. */
export async function loadCaptureSettings(): Promise<CaptureSettings> {
  let raw: string | null = null;
  try {
    raw = await AsyncStorage.getItem(CAPTURE_STORE_KEY);
  } catch {
    return DEFAULT_CAPTURE_SETTINGS;
  }
  if (!raw) return DEFAULT_CAPTURE_SETTINGS;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredState>;
    return readSettings(parsed?.settings);
  } catch {
    return DEFAULT_CAPTURE_SETTINGS;
  }
}

/** Stores what the camera actually applied. */
export function saveCaptureSettings(settings: CaptureSettings): Promise<void> {
  return serial(async () => {
    const state: StoredState = { v: 1, settings: readSettings(settings) };
    await AsyncStorage.setItem(CAPTURE_STORE_KEY, JSON.stringify(state));
  });
}
