import AsyncStorage from "@react-native-async-storage/async-storage";
import { DEFAULT_CAPTURE_CHROME, parseCaptureChrome, type CaptureChrome } from "../capture/mode";
import { createSerialQueue } from "../serial";

/**
 * The camera's chrome: whether the readout is up (the dial is off AUTO) and what DISP shows. Kept
 * out of `src/capture/store.ts`, which mirrors the native settings contract; none of this reaches
 * native. An unreadable value means AUTO and a plain picture.
 */
const CAPTURE_CHROME_KEY = "capture.chrome.v1";

export async function loadCaptureChrome(): Promise<CaptureChrome> {
  try {
    return parseCaptureChrome(await AsyncStorage.getItem(CAPTURE_CHROME_KEY));
  } catch {
    return DEFAULT_CAPTURE_CHROME;
  }
}

const serial = createSerialQueue();

/**
 * Written once per change, in the order asked for. A settings write is repeated by the next
 * change a moment later; this one is not, so a write that fails is tried once more rather than
 * lost until the dial next turns.
 */
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
