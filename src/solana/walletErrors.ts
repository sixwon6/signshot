import {
  SolanaMobileWalletAdapterError,
  SolanaMobileWalletAdapterErrorCode,
  SolanaMobileWalletAdapterProtocolError,
  SolanaMobileWalletAdapterProtocolErrorCode,
} from "@solana-mobile/mobile-wallet-adapter-protocol";
/**
 * User backed out; must never render as an error.
 *   ERROR_AUTHORIZATION_FAILED (-1)   declined authorize
 *   ERROR_NOT_SIGNED (-3)             declined signing
 *   "Local association cancelled by user"
 *                                     dismissed the wallet picker; the RN bridge puts it in `code`
 *   ERROR_ASSOCIATION_CANCELLED       same, WebSocket transport
 *   ERROR_SESSION_CLOSED              WebSocket transport only
 * wallet-ui retries `authorize` once without a token after ERROR_AUTHORIZATION_FAILED, so a first
 * decline re-prompts before reaching here.
 */
export function isUserCancellation(e: unknown): boolean {
  if (e instanceof SolanaMobileWalletAdapterProtocolError) {
    return (
      e.code === SolanaMobileWalletAdapterProtocolErrorCode.ERROR_AUTHORIZATION_FAILED ||
      e.code === SolanaMobileWalletAdapterProtocolErrorCode.ERROR_NOT_SIGNED
    );
  }
  if (
    e instanceof SolanaMobileWalletAdapterError &&
    e.code === SolanaMobileWalletAdapterErrorCode.ERROR_SESSION_CLOSED
  ) {
    return true;
  }
  const code =
    e !== null && typeof e === "object" && "code" in e ? String((e as { code: unknown }).code) : "";
  const message = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  return (
    code === "ERROR_ASSOCIATION_CANCELLED" ||
    code.includes("Local association cancelled by user") ||
    message.includes("Local association cancelled by user") ||
    message.includes("CancellationException")
  );
}

/**
 * Seed Vault Wallet sends `sign_and_send_transactions` at once but replies only when its Success
 * sheet closes; the RN adapter gives up after 90 s (`CLIENT_TIMEOUT_MS`). The transaction has
 * usually landed: re-check status, don't re-prompt. Association timeouts are excluded (nothing sent).
 */
export function isWalletResponseTimeout(e: unknown): boolean {
  const code =
    e !== null && typeof e === "object" && "code" in e ? String((e as { code: unknown }).code) : "";
  const message = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  return `${code} ${message}`.toLowerCase().includes("timed out waiting for response");
}
