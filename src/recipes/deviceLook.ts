/**
 * The look that adds nothing is the phone's own camera, so it carries the phone's name, as the
 * other looks carry theirs: SEEKER beside DIGICAM, DISPOSABLE, CAMCORDER. Android reports a model
 * (`Build.MODEL`) and a brand; there is no marketing-name lookup on the device, so a model that
 * reads as a code ("SM-S918B", "CPH2581", "23127PN0CC") gives way to the brand, and a phone that
 * offers neither keeps the shipped name.
 *
 * Imported for its effect by index.js, ahead of the app: the list of looks is built when its
 * module is first read, and must find the name already set.
 */
import { Platform } from "react-native";
import { setNeutralName } from "./model";

/** As wide as the longest built-in look; a longer name would crowd the look row. */
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
