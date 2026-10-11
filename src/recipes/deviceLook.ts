/**
 * Names the neutral look after the phone. Android has no marketing-name lookup, so a model that
 * reads as a code ("SM-S918B") falls back to the brand, then to the shipped name.
 * Side-effect import in index.js, ahead of the app: the look list is built at module load.
 */
import { Platform } from "react-native";
import { setNeutralName } from "./model";

/** Longest built-in look name. */
const MAX_LENGTH = 12;

/** A name has a lower-case letter in it ("Seeker", "Pixel 8 Pro"); a model code does not. */
const readsAsName = (text: string): boolean => /[a-z]/.test(text) && text.length <= MAX_LENGTH;

export function deviceLookName(): string | null {
  if (Platform.OS !== "android") return null;
  const model = Platform.constants.Model?.trim() ?? "";
  if (readsAsName(model)) return model;
  const brand = Platform.constants.Brand?.trim() ?? "";
  return brand.length > 0 && brand.length <= MAX_LENGTH ? brand : null;
}

setNeutralName(deviceLookName());
