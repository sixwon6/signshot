/**
 * Byte codecs for Arweave — base58, base64url, hex, UTF-8, concat.
 *
 * Free of `@solana/kit` and `Buffer` so `src/arweave/` runs under plain Node.
 */

/** Bitcoin/Solana base58 alphabet. */
const B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** RFC 4648 §5 URL-safe alphabet. Arweave ids are this, unpadded. */
const B64URL_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export { concatBytes, bytesToHex as toHex, hexToBytes as fromHex, utf8ToBytes as utf8 } from "@noble/hashes/utils.js";

/**
 * Unpadded URL-safe base64 — the Arweave id encoding (`base64url.encode` in arbundles, which is
 * Node's `digest("base64url")`: no `=` padding).
 */
export function base64UrlEncode(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] as number;
    const has1 = i + 1 < bytes.length;
    const has2 = i + 2 < bytes.length;
    const b1 = has1 ? (bytes[i + 1] as number) : 0;
    const b2 = has2 ? (bytes[i + 2] as number) : 0;

    out += B64URL_ALPHABET[b0 >> 2];
    out += B64URL_ALPHABET[((b0 & 0x03) << 4) | (b1 >> 4)];
    if (!has1) break;
    out += B64URL_ALPHABET[((b1 & 0x0f) << 2) | (b2 >> 6)];
    if (!has2) break;
    out += B64URL_ALPHABET[b2 & 0x3f];
  }
  return out;
}

/**
 * base58 (Bitcoin alphabet), used for the upload key's public key. Carried through a digit array
 * so nothing exceeds 2^53; leading zero bytes become leading "1"s, or two keys could share a string.
 */
export function base58Encode(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros += 1;

  // log(256)/log(58) = 1.365..., so 138/100 is a safe upper bound on the digit count.
  const size = Math.floor(((bytes.length - zeros) * 138) / 100) + 1;
  const digits = new Uint8Array(size);
  let length = 0;

  for (let i = zeros; i < bytes.length; i += 1) {
    let carry = bytes[i] as number;
    let j = 0;
    for (let k = size - 1; (carry !== 0 || j < length) && k >= 0; k -= 1, j += 1) {
      carry += 256 * (digits[k] as number);
      digits[k] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    length = j;
  }

  let at = size - length;
  while (at < size && digits[at] === 0) at += 1;

  let out = "1".repeat(zeros);
  for (; at < size; at += 1) out += B58_ALPHABET[digits[at] as number];
  return out;
}
