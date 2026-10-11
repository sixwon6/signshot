import AsyncStorage from "@react-native-async-storage/async-storage";
import { DEFAULT_CAPTURE_CHROME, parseCaptureChrome, type CaptureChrome } from "../capture/mode";
import { createSerialQueue } from "../serial";

// JS-only camera chrome (readout, DISP). Kept out of src/capture/store.ts, which mirrors the
// native settings contract.
const CAPTURE_CHROME_KEY = "capture.chrome.v1";

export async function loadCaptureChrome(): Promise<CaptureChrome> {
  try {
    return parseCaptureChrome(await AsyncStorage.getItem(CAPTURE_CHROME_KEY));
  } catch {
    return DEFAULT_CAPTURE_CHROME;
  }
}

const serial = createSerialQueue();

/** Serialized; retries once because, unlike settings writes, nothing rewrites it soon after. */
export function saveCaptureChrome(chrome: CaptureChrome): Promise<void> {
  const record = JSON.stringify({ v: 1, readout: chrome.readout === true, display: chrome.display });
  return serial(async () => {
    try {
      await AsyncStorage.setItem(CAPTURE_CHROME_KEY, record);
    } catch {
      await AsyncStorage.setItem(CAPTURE_CHROME_KEY, record);
    }
  });
}
