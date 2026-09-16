/**
 * The Moment caption (the document's `description`) and the unsafe-character class every
 * published string is held to. Only `trim()` is applied, no Unicode normalization: the stored
 * bytes are hashed on chain and must be exactly what the publisher reviewed.
 */

/** Bound in Unicode code points, so an emoji or a CJK character costs the writer one. */
export const DESCRIPTION_LIMIT = 280;

/**
 * Control, zero-width, bidi and invisible code points, including newline and tab. At least as
 * strict as the program's `char::is_control`. `readEdition` applies this to immutable on-chain
 * titles, so adding a range can make a published edition unreadable: check published records first.
 * Written as ranges so this source file stays printable ASCII.
 */
const UNSAFE_RANGES: readonly (readonly [number, number])[] = [
  [0x0000, 0x001f],
  [0x007f, 0x009f],
  // Soft hyphen (and U+2060-2064 below): invisible characters `validate_album` refuses.
  [0x00ad, 0x00ad],
  // ARABIC LETTER MARK, a bidi formatting mark like LRM/RLM (UAX #9).
  [0x061c, 0x061c],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x2064],
  [0x2066, 0x2069],
  // LINE and PARAGRAPH SEPARATOR: not `Cc`, so the program allows them, but they render as line
  // breaks in fields that must stay on one line.
  [0x2028, 0x2029],
  [0xfeff, 0xfeff],
];

/** True when `value` holds any control, zero-width or bidi character. */
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

/**
 * Validate what a person typed and produce what may be stored: trimmed and bounded. Blank is
 * `""`. Throws a sentence the publishing sheet can show. Called before a draft is written, so
 * nothing invalid can reach the hash.
 */
export function normalizeDescription(input: string | null | undefined): string {
  if (input === undefined || input === null) return "";
  if (typeof input !== "string") throw new Error("The Moment must be text.");
  const value = input.trim();
  if (hasUnsafeText(value) || points(value) > DESCRIPTION_LIMIT) throw new Error(WRITE_ERROR);
  return value;
}

/**
 * The reader's half: a published `description` must already be normalized (trimmed, bounded,
 * safe) or `""`. Fails closed, because what this accepts a public page renders.
 */
export function readDescription(value: unknown): string {
  if (typeof value !== "string" || value !== value.trim()) throw new Error(READ_ERROR);
  if (hasUnsafeText(value) || points(value) > DESCRIPTION_LIMIT) throw new Error(READ_ERROR);
  return value;
}
