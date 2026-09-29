/**
 * The deployment record (`programs/editions/scripts/deployment-record.schema.json`) and the lines
 * a person pastes into `publications/deployments.ts`. This tooling never edits that file: it is
 * the reviewed allow-list of programs the app talks to.
 */
import type { Cluster } from "../types";

export interface DeploymentRecord {
  address: string;
  cluster: Cluster;
  elfSha256: string;
  deployedSlot: number;
  authority: string;
  policy: "multisig" | "final";
  reviewedBy: string[];
  date: string;
  programData?: string;
  signature?: string;
  bytes?: number;
  notes?: string;
}

type Schema = {
  type?: string;
  enum?: unknown[];
  const?: unknown;
  pattern?: string;
  minimum?: number;
  minItems?: number;
  minLength?: number;
  items?: Schema;
  oneOf?: Schema[];
  required?: string[];
  properties?: Record<string, Schema>;
  additionalProperties?: boolean;
};

/**
 * Every way `value` breaks `schema`, for the keywords the deployment-record schema uses; empty when
 * it conforms. Unknown keywords are refused, so a schema change cannot be silently skipped.
 */
export function schemaErrors(value: unknown, schema: Schema, at = "record"): string[] {
  const known = new Set(["$schema", "$id", "title", "description", "type", "enum", "const",
    "pattern", "minimum", "minItems", "minLength", "items", "oneOf", "required", "properties",
    "additionalProperties"]);
  const unknown = Object.keys(schema).filter((key) => !known.has(key) && !key.startsWith("x-"));
  if (unknown.length) return [`${at}: schema keyword ${unknown.join(", ")} is not checked here`];
  const errors: string[] = [];
  if (schema.oneOf) {
    const passing = schema.oneOf.filter((option) => schemaErrors(value, option, at).length === 0);
    if (passing.length !== 1) errors.push(`${at}: matches ${passing.length} of oneOf`);
  }
  if ("const" in schema && value !== schema.const) errors.push(`${at}: must be ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${at}: not one of ${schema.enum.join(", ")}`);
  switch (schema.type) {
    case undefined: break;
    case "string": if (typeof value !== "string") return [...errors, `${at}: not a string`]; break;
    case "integer": if (!Number.isSafeInteger(value)) return [...errors, `${at}: not an integer`]; break;
    case "array": if (!Array.isArray(value)) return [...errors, `${at}: not an array`]; break;
    case "object":
      if (!value || typeof value !== "object" || Array.isArray(value)) return [...errors, `${at}: not an object`];
      break;
    default: return [`${at}: type ${schema.type} is not checked here`];
  }
  if (typeof value === "string") {
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${at}: does not match ${schema.pattern}`);
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${at}: too short`);
  }
  if (typeof value === "number" && schema.minimum !== undefined && value < schema.minimum)
    errors.push(`${at}: below ${schema.minimum}`);
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${at}: too few items`);
    if (schema.items) value.forEach((item, i) => errors.push(...schemaErrors(item, schema.items!, `${at}[${i}]`)));
  }
  if (schema.type === "object") {
    const record = value as Record<string, unknown>;
    for (const key of schema.required ?? []) if (!(key in record)) errors.push(`${at}.${key}: missing`);
    for (const [key, item] of Object.entries(record)) {
      const property = schema.properties?.[key];
      if (property) errors.push(...schemaErrors(item, property, `${at}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${at}.${key}: not allowed`);
    }
  }
  return errors;
}

const grouped = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, "_");

/** The exact lines for `publications/deployments.ts`, from what was read on chain. */
export function deploymentsLines(entry: {
  cluster: Cluster;
  address: string;
  sha256: string;
  bytes: number;
  upgradeAuthority: string;
  source: string;
}): string {
  const { cluster, address } = entry;
  const key = cluster === "devnet" ? "devnet" : `"mainnet-beta"`;
  const select = cluster === "devnet"
    ? `4. Select it in .env.local (gitignored); DEPLOYMENTS.devnet stays "":

EXPO_PUBLIC_EDITIONS_DEVNET_PROGRAM=${address}`
    : `4. DEPLOYMENTS — the program new publications use, last, once the record is committed:

  "mainnet-beta": "${address}",

5. Regenerate programs/editions/idl.json with this address (programs/editions/README.md, "idl.json").`;
  return `
================ PASTE INTO publications/deployments.ts ================

1. HISTORICAL.${cluster === "devnet" ? "devnet" : `"mainnet-beta"`} — add the address (keep any already there):

  ${key}: [
    "${address}",
  ],

2. PROGRAM_IMAGES.${cluster === "devnet" ? "devnet" : `"mainnet-beta"`} — the digest and length of the deployed ProgramData tail, read on chain:

    "${address}": {
      sha256: "${entry.sha256}",
      bytes: ${grouped(entry.bytes)},
      upgradeAuthority: "${entry.upgradeAuthority}",
      source: "${entry.source}",
    },

3. Leave the LEGACY_WITHOUT_* lists as they are: a new address already has every feature.

${select}

=======================================================================
`;
}
