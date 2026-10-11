import { useCallback, useEffect, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";

/** Per-device, off by default: a stamp names a person on a picture that leaves the phone. */
const KEY = "seeker.shareStamp.v1";

export function useShareStampPref(): {
  enabled: boolean;
  loaded: boolean;
  setEnabled(next: boolean): void;
} {
  const [enabled, setEnabledState] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let alive = true;
    AsyncStorage.getItem(KEY)
      .then((raw) => {
        if (alive) setEnabledState(raw === "1");
      })
      .catch(() => {})
      .finally(() => {
        if (alive) setLoaded(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  const setEnabled = useCallback((next: boolean) => {
    setEnabledState(next);
    AsyncStorage.setItem(KEY, next ? "1" : "0").catch(() => {});
  }, []);

  return { enabled, loaded, setEnabled };
}

