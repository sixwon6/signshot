/**
 * Runtime-guarded: a native build without `SeekerCamera.scanQrCode()` would throw on Scan, and a
 * dev-client reload can swap the native module after the pill was offered.
 */

import { SeekerCamera } from "../../modules/seeker-camera";

/** Declared here; the native module's types may not include it. */
type Scanner = { scanQrCode?: () => Promise<string | null> };

/** Read fresh, never cached. */
export function scanQrAvailable(): boolean {
  return typeof (SeekerCamera as unknown as Scanner).scanQrCode === "function";
}

/** Null means cancelled, not a failure. Throws only when the scanner itself fails. */
export async function scanQr(): Promise<string | null> {
  const scanner = SeekerCamera as unknown as Scanner;
  if (typeof scanner.scanQrCode !== "function") return null;
  return await scanner.scanQrCode();
}
