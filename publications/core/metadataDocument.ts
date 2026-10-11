import { type AttestationSummary, type Cluster, type CoreMetadata } from "../types";
import { readDescription } from "./details";
import { checkAttributes, exactKeys, object, readAttestationBundle } from "./attestation";
import { genesisAttributes, readGenesisClaim } from "./genesisToken";
import { collectUrl } from "./links";
import { canonicalize, type JcsValue } from "../../src/jcs";

const MISMATCH = "Photo metadata does not match the published edition";
const ARWEAVE_IMAGE = /^https:\/\/arweave\.net\/[A-Za-z0-9_-]{43}$/;

type Commitment = {
  cluster: Cluster; program: string; edition: string; collection: string;
  creator: string; nonce: string; title: string; supply: number; imageHash: string;
};
type PhotoDocument = {
  image: string;
  description: string;
  dimensions?: { width: number; height: number };
  /** Only when the chain and signature checked out. */
  attestation?: AttestationSummary;
  /** Attestation present but failed; the photo still loads. */
  attestationProblem?: string;
  /** Claimed, unchecked; see `verifyGenesisToken`. */
  genesisMint?: string;
};
/**
 * Read a document that must repeat `expected` (chain state) exactly. With `serialized`, the text
 * must be canonical, so no other parser can see a duplicate-key value this one did not check.
 */
export function readPhotoMetadata(json: unknown, expected: Commitment, serialized?: string): PhotoDocument {
  const doc = object(json);
  if (!doc || doc.name !== expected.title || typeof doc.image !== "string" || !ARWEAVE_IMAGE.test(doc.image))
    throw new Error(MISMATCH);
  let description: string;
  try { description = readDescription(doc.description); }
  catch { throw new Error(MISMATCH); }
  // Shape of `metadata()`; `properties` may add `signshot` and/or `genesisToken`. Failed
  // attestation is set aside, not fatal: the photo stays viewable with no device claim.
  const current = exactKeys(doc, ["name", "description", "image", "external_url", "attributes", "properties"]);
  if (current) {
    const properties = object(doc.properties);
    const keys = properties ? Object.keys(properties) : [];
    const evidence = keys.filter((k) => k === "signshot" || k === "genesisToken");
    if (!properties || keys.length !== evidence.length + 2)
      throw new Error(MISMATCH);
    const files = Array.isArray(properties.files) && properties.files.length === 1 ? object(properties.files[0]) : null;
    if (doc.external_url !== collectUrl(expected.edition, expected.cluster) || properties.category !== "image" ||
        !files || !exactKeys(files, ["uri", "type"]) || files.uri !== doc.image || files.type !== "image/jpeg")
      throw new Error(MISMATCH);
    if (serialized !== undefined && canonicalize(json as JcsValue) !== serialized)
      throw new Error(MISMATCH);

    // Genesis claim plus its repeating attribute (always last). Malformed is a mismatch.
    let genesisMint: string | undefined;
    let attributes: unknown = doc.attributes;
    if (Object.hasOwn(properties, "genesisToken")) {
      try {
        genesisMint = readGenesisClaim(properties.genesisToken);
        const last = Array.isArray(attributes) ? attributes.slice(-1) : [];
        if (canonicalize(last as JcsValue) !== canonicalize(genesisAttributes(genesisMint)))
          throw new Error(MISMATCH);
      } catch { throw new Error(MISMATCH); }
      attributes = (attributes as unknown[]).slice(0, -1);
    }
    const genesis = genesisMint ? { genesisMint } : {};
    if (!Object.hasOwn(properties, "signshot")) {
      if (!Array.isArray(attributes) || attributes.length !== 0) throw new Error(MISMATCH);
      return { image: doc.image, description, ...genesis };
    }
    try {
      const read = readAttestationBundle(properties.signshot, expected);
      checkAttributes(attributes, read.summary);
      return {
        image: doc.image,
        description,
        dimensions: { width: read.bundle.manifest.width, height: read.bundle.manifest.height },
        attestation: read.summary,
        ...genesis,
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message.replace(/^attestation: /, "") : "unreadable";
      return { image: doc.image, description, attestationProblem: reason, ...genesis };
    }
  }

  throw new Error(MISMATCH);
}

/** A draft document's evidence, for resealing before send. Input must have passed `readSavedPhotoMetadata`. */
export function sealedEvidence(serialized: string): { current: boolean; bundle?: unknown; namesDevice: boolean } {
  const doc = object(JSON.parse(serialized));
  const attributes: unknown[] = Array.isArray(doc?.attributes) ? doc.attributes : [];
  const bundle = object(doc?.properties)?.signshot;
  return {
    current: !!doc && Object.hasOwn(doc, "external_url"),
    ...(bundle === undefined ? {} : { bundle }),
    namesDevice: attributes.some((a) => object(a)?.trait_type === "Device"),
  };
}

/** Validate a saved intent without regenerating the immutable document in today's format. */
export function readSavedPhotoMetadata(serialized: string, edition: CoreMetadata): CoreMetadata {
  try {
    const doc = JSON.parse(serialized) as JcsValue;
    if (canonicalize(doc) !== serialized) throw new Error(MISMATCH);
    const parsed = readPhotoMetadata(doc, edition, serialized);
    const description = readDescription(edition.description);
    if (parsed.image !== edition.image || parsed.description !== description ||
        (parsed.dimensions && (parsed.dimensions.width !== edition.width || parsed.dimensions.height !== edition.height)))
      throw new Error(MISMATCH);
    // Attestation and Genesis claim come from the document, never the saved copy.
    const { attestation: _saved, attestationProblem: _problem, genesisMint: _mint, ...saved } = edition;
    const rest = parsed.genesisMint ? { ...saved, genesisMint: parsed.genesisMint } : saved;
    return parsed.attestation
      ? { ...rest, description, attestation: parsed.attestation }
      : parsed.attestationProblem
        ? { ...rest, description, attestationProblem: parsed.attestationProblem }
        : { ...rest, description };
  } catch {
    throw new Error("Saved edition metadata does not match this photo.");
  }
}
