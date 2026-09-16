import AsyncStorage from "@react-native-async-storage/async-storage";

/**
 * Whether the histogram is shown. Kept out of `src/capture/store.ts`, which mirrors the native
 * settings contract; the histogram never reaches native. An unreadable value means hidden.
 */
const CAPTURE_CHROME_KEY = "capture.chrome.v1";

/** Whether the histogram was left on. Hidden unless the store plainly says otherwise. */
export async function loadHistogramShown(): Promise<boolean> {
  try {
    const raw = await AsyncStorage.getItem(CAPTURE_CHROME_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw) as { histogram?: unknown };
    return parsed?.histogram === true;
  } catch {
    return false;
  }
}

export async function saveHistogramShown(shown: boolean): Promise<void> {
  await AsyncStorage.setItem(CAPTURE_CHROME_KEY, JSON.stringify({ v: 1, histogram: shown === true }));
}
