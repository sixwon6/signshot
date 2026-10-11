/**
 * RFC 8785 (JCS). Keys sort by UTF-16 code unit (never localeCompare); unpaired surrogates are
 * rejected (no UTF-8 encoding). Returns a JS string; the caller encodes UTF-8.
 *
 * DELIBERATE SUBSET: safe integers only. 8785's double serialization is not implemented, so
 * non-integers throw rather than produce bytes another implementation might not reproduce.
 */

export type JcsValue =
  | null
  | boolean
  | string
  | number
  | JcsValue[]
  | JcsObject;

interface JcsObject {
  [key: string]: JcsValue;
}

/** RFC 8785 sort order; JS `<` on strings compares UTF-16 code units. */
function compareCodeUnits(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** Rejects unpaired surrogates. */
function serializeString(s: string, path: string): string {
  for (let i = 0; i < s.length; i += 1) {
    const unit = s.charCodeAt(i);
    if (unit < 0xd800 || unit > 0xdfff) continue;
    const isHigh = unit <= 0xdbff;
    const next = isHigh ? s.charCodeAt(i + 1) : NaN;
    if (isHigh && next >= 0xdc00 && next <= 0xdfff) {
      i += 1;
      continue;
    }
    throw new Error(
      `JCS: ${path} contains an unpaired surrogate (U+${unit
        .toString(16)
        .toUpperCase()} at index ${i}); such a string has no UTF-8 encoding`,
    );
  }
  // ECMAScript QuoteJSONString == the RFC 8785 string production.
  return JSON.stringify(s);
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function serializeNumber(n: number, path: string): string {
  if (!Number.isFinite(n)) {
    throw new Error(
      `JCS: ${path} is ${String(n)}; JSON has no representation for it`,
    );
  }
  if (!Number.isSafeInteger(n)) {
    throw new Error(
      `JCS: ${path} is ${String(n)}; this canonicalizer accepts safe integers only ` +
        `(see the DELIBERATE SUBSET note in jcs.ts)`,
    );
  }
  // For safe integers String() matches RFC 8785 exactly; String(-0) is "0".
  return String(n);
}

function serialize(input: JcsValue, path: string): string {
  // Callers cast untyped data to JcsValue, so these guards must be real runtime checks.
  const value: unknown = input;

  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return serializeNumber(value, path);
  if (typeof value === "string") return serializeString(value, path);

  if (value === undefined) {
    throw new Error(
      `JCS: ${path} is undefined; the bundle schema is optional-free ` +
        `(backend) — use an explicit "unavailable" sentinel`,
    );
  }

  if (typeof value !== "object") {
    throw new Error(`JCS: ${path} is a ${typeof value}, which is not JSON`);
  }

  if (Array.isArray(value)) {
    const items = value.map((item: unknown, i) =>
      serialize(item as JcsValue, `${path}[${i}]`),
    );
    return `[${items.join(",")}]`;
  }

  if (!isPlainObject(value)) {
    throw new Error(
      `JCS: ${path} is a ${value.constructor?.name ?? "non-plain"} object; ` +
        `only plain objects and arrays can be canonicalized`,
    );
  }

  const record = value as JcsObject;
  const keys = Object.keys(record).sort(compareCodeUnits);
  const members = keys.map(
    (key) =>
      `${serializeString(key, `${path}.${key} (key)`)}:${serialize(
        record[key],
        `${path}.${key}`,
      )}`,
  );
  return `{${members.join(",")}}`;
}

/** Throws on anything it cannot represent exactly. */
export function canonicalize(value: JcsValue): string {
  return serialize(value, "$");
}
