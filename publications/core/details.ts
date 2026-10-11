/**
 * The Moment caption (`description`) and the unsafe-character check for published strings.
 * Only `trim()`, no Unicode normalization: the stored bytes are hashed on chain.
 */

/** In code points. */
export const DESCRIPTION_LIMIT = 280;

/**
 * Control (incl. newline, tab), zero-width, bidi and invisible code points. `readEdition` applies
 * this to immutable on-chain titles, so adding a range can make a published edition unreadable.
 */
const UNSAFE_RANGES: readonly (readonly [number, number])[] = [
  [0x0000, 0x001f],
  [0x007f, 0x009f],
  // Soft hyphen.
  [0x00ad, 0x00ad],
  // ARABIC LETTER MARK (bidi, UAX #9).
  [0x061c, 0x061c],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x2064],
  [0x2066, 0x2069],
  // LINE and PARAGRAPH SEPARATOR: not `Cc`, but render as line breaks.
  [0x2028, 0x2029],
  [0xfeff, 0xfeff],
];

export function hasUnsafeText(value: string): boolean {
  for (const character of value) {
    const point = character.codePointAt(0)!;
    for (const [low, high] of UNSAFE_RANGES)
      if (point >= low && point <= high) return true;
  }
  return false;
}

const points = (value: string) => [...value].length;

const WRITE_ERROR = `Use a Moment of up to ${DESCRIPTION_LIMIT} characters, on one line.`;
const READ_ERROR = "The published description is not valid text.";

/** Trimmed, bounded caption to store; blank is `""`. Throws a user-facing message. */
export function normalizeDescription(input: string | null | undefined): string {
  if (input === undefined || input === null) return "";
  if (typeof input !== "string") throw new Error("The Moment must be text.");
  const value = input.trim();
  if (hasUnsafeText(value) || points(value) > DESCRIPTION_LIMIT) throw new Error(WRITE_ERROR);
  return value;
}

/** A published `description` must already be normalized. Fails closed. */
export function readDescription(value: unknown): string {
  if (typeof value !== "string" || value !== value.trim()) throw new Error(READ_ERROR);
  if (hasUnsafeText(value) || points(value) > DESCRIPTION_LIMIT) throw new Error(READ_ERROR);
  return value;
}
