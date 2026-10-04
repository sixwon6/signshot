import {
  SolanaMobileWalletAdapterError,
  SolanaMobileWalletAdapterErrorCode,
  SolanaMobileWalletAdapterProtocolError,
  SolanaMobileWalletAdapterProtocolErrorCode,
} from "@solana-mobile/mobile-wallet-adapter-protocol";
/**
 * Did the user back out, rather than something breaking? A cancellation must never render as an
 * error. The shapes, and where each comes from:
 *
 *   ERROR_AUTHORIZATION_FAILED (-1)   protocol error: declined the authorize screen
 *   ERROR_NOT_SIGNED (-3)             protocol error: declined the signing prompt
 *   "Local association cancelled by user"
 *                                     dismissed the wallet picker (Android). The RN bridge puts the
 *                                     sentence in `error.code`, so both `code` and `message` are checked.
 *   ERROR_ASSOCIATION_CANCELLED       the same event on the WebSocket (browser) transport
 *   ERROR_SESSION_CLOSED              browser transport only; kept so the check is transport-agnostic
 *
 * wallet-ui retries `authorize` without a token after ERROR_AUTHORIZATION_FAILED, which the wallet
 * also returns for a decline, so a first decline re-prompts once before this sees the error.
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
 * Did the wallet simply take too long to answer? Seed Vault Wallet sends
 * `sign_and_send_transactions` immediately but replies only when its Success sheet is closed, and
 * the RN adapter rejects with "Timed out waiting for response" after 90 s (`CLIENT_TIMEOUT_MS`).
 *
 * Not a cancellation: the transaction has usually landed, so screens must say so and re-check
 * status rather than offer another approval. "Timed out waiting for local association to be
 * ready" and ERROR_SESSION_TIMEOUT are not matched: the wallet never opened, so nothing was sent.
 */
export function isWalletResponseTimeout(e: unknown): boolean {
  const code =
    e !== null && typeof e === "object" && "code" in e ? String((e as { code: unknown }).code) : "";
  const message = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  return `${code} ${message}`.toLowerCase().includes("timed out waiting for response");
}
