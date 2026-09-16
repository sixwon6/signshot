import { useSyncExternalStore } from "react";
import { AppState } from "react-native";

const subscribe = (notify: () => void) => {
  const subscription = AppState.addEventListener("change", notify);
  return () => subscription.remove();
};
const getSnapshot = () => AppState.currentState === "active";

/** Navigation focus survives backgrounding; resource work also needs an active app. */
export function useAppActive(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
