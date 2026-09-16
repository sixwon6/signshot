/**
 * The one call into the native QR scanner, behind a runtime guard.
 *
 * A dev client whose native side predates `SeekerCamera.scanQrCode()` would throw `undefined is
 * not a function` the first time the Scan pill is tapped, so every caller goes through here
 * instead: `scanQrAvailable()` decides whether the pill is offered at all, and `scanQr()` refuses
 * rather than crashing if the function disappears between the two (a dev-client reload can swap
 * the native module underneath us).
 *
 * Resolves the decoded text, or null when the person backed out of the scanner.
 */

import { SeekerCamera } from "../../modules/seeker-camera";

/** The shape this module needs, independent of what the native module declares today. */
type Scanner = { scanQrCode?: () => Promise<string | null> };

/** Is the native function actually present in THIS build? Read fresh; never cached. */
export function scanQrAvailable(): boolean {
  return typeof (SeekerCamera as unknown as Scanner).scanQrCode === "function";
}

/**
 * Scan one QR code. Null means cancelled — the caller must treat it as "nothing happened", not
 * as a failure. Throws only when the scanner itself fails, so the sheet can show the reason.
 */
export async function scanQr(): Promise<string | null> {
  const scanner = SeekerCamera as unknown as Scanner;
  if (typeof scanner.scanQrCode !== "function") return null;
  return await scanner.scanQrCode();
}
