/**
 * The one call into the native QR scanner, behind a runtime guard: a native build without
 * `SeekerCamera.scanQrCode()` would otherwise throw on the first Scan tap. `scanQrAvailable()`
 * decides whether the pill is offered, and `scanQr()` returns null rather than crash if the
 * function has gone since (a dev-client reload can swap the native module).
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
