/**
 * Storage provider hosts. Images upload after the on-chain `uri` is fixed, so fallback hosts are
 * kept to avoid a stuck upload. `EXPO_PUBLIC_TURBO_*` overrides must be plain https origins and
 * are spelt out as literal `process.env.NAME` accesses so Metro inlines them.
 */

const VARIABLES = {
  host: "EXPO_PUBLIC_TURBO_HOST",
  upload: "EXPO_PUBLIC_TURBO_UPLOAD_HOST",
  payment: "EXPO_PUBLIC_TURBO_PAYMENT_HOST",
} as const;

const CONFIGURED = {
  host: process.env.EXPO_PUBLIC_TURBO_HOST,
  upload: process.env.EXPO_PUBLIC_TURBO_UPLOAD_HOST,
  payment: process.env.EXPO_PUBLIC_TURBO_PAYMENT_HOST,
};

/**
 * An `https://host` origin, or a configuration error. Paths, queries, fragments and credentials
 * are refused because the value is concatenated with fixed endpoint paths.
 */
function httpsOrigin(value: string, variable: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${variable} is not a URL: ${value}`);
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.pathname !== "/" && parsed.pathname !== "")
  )
    throw new Error(
      `${variable} must be a plain https origin such as https://turbo.ardrive.io, not ${value}`,
    );
  return parsed.origin;
}

const configured = (key: keyof typeof CONFIGURED): string | undefined => {
  const value = CONFIGURED[key];
  return value ? httpsOrigin(value, VARIABLES[key]) : undefined;
};

/** The documented unified endpoint, or whatever `EXPO_PUBLIC_TURBO_HOST` names instead. */
const TURBO_HOST = configured("host") ?? "https://turbo.ardrive.io";
/** Separate upload and payment hosts, used as fallbacks. */
export const LEGACY_UPLOAD_HOST = "https://upload.ardrive.io";
const LEGACY_PAYMENT_HOST = "https://payment.ardrive.io";

const unique = (hosts: readonly (string | undefined)[]) => [
  ...new Set(hosts.filter((host): host is string => Boolean(host))),
];

/** Upload-service origins, primary first. Used by `storage.ts` and `src/arweave/turbo.ts`. */
export const TURBO_UPLOAD_HOSTS: readonly string[] = unique([
  configured("upload"),
  TURBO_HOST,
  LEGACY_UPLOAD_HOST,
]);

/** Payment-service origins, primary first. */
export const TURBO_PAYMENT_HOSTS: readonly string[] = unique([
  configured("payment"),
  TURBO_HOST,
  LEGACY_PAYMENT_HOST,
]);
