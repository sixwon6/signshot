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
  /** Present only for a document whose certificate chain and signature were checked here. */
  attestation?: AttestationSummary;
  /** An attested-format document whose evidence did not check out: the photo still loads. */
  attestationProblem?: string;
  /** The Seeker Genesis Token mint the document claims. Unchecked: see `verifyGenesisToken`. */
  genesisMint?: string;
};
/**
 * A document read against what the chain holds (`expected`): it must repeat it exactly.
 * `serialized` is the document's exact text when the caller has it: an attested document must
 * then be canonical, so no reader anywhere can see a duplicate-key value this one did not check.
 */
export function readPhotoMetadata(json: unknown, expected: Commitment, serialized?: string): PhotoDocument {
  const doc = object(json);
  if (!doc || doc.name !== expected.title || typeof doc.image !== "string" || !ARWEAVE_IMAGE.test(doc.image))
    throw new Error(MISMATCH);
  let description: string;
  try { description = readDescription(doc.description); }
  catch { throw new Error(MISMATCH); }
  // The document (`metadata()`): the plain three fields, the edition's collect link as
  // `external_url`, Metaplex `attributes`, and `properties` holding exactly the one image file and
  // its category. Under `properties` either may carry the keystore's attestation (`seedshot`), the publishing wallet's
  // Seeker Genesis Token (`genesisToken`), or both. Evidence that fails `readAttestationBundle` or
  // `checkAttributes` is SET ASIDE, not fatal: the photograph is still a valid
  // publication with no device claim, and the Proof sheet says why. Refusing it would add no safety
  // and would make an immutable document unviewable if a keystore format outgrew this reader.
  const current = exactKeys(doc, ["name", "description", "image", "external_url", "attributes", "properties"]);
  if (current) {
    const properties = object(doc.properties);
    const keys = properties ? Object.keys(properties) : [];
    const evidence = keys.filter((k) => k === "seedshot" || k === "genesisToken");
    if (!properties || keys.length !== evidence.length + 2)
      throw new Error(MISMATCH);
    const files = Array.isArray(properties.files) && properties.files.length === 1 ? object(properties.files[0]) : null;
    if (doc.external_url !== collectUrl(expected.edition, expected.cluster) || properties.category !== "image" ||
        !files || !exactKeys(files, ["uri", "type"]) || files.uri !== doc.image || files.type !== "image/jpeg")
      throw new Error(MISMATCH);
    if (serialized !== undefined && canonicalize(json as JcsValue) !== serialized)
      throw new Error(MISMATCH);

    // The Seeker Genesis Token claim (`genesisToken.ts`): a mint address and the one attribute
    // that repeats it, always the document's last. The format is this app's own, so a claim that
    // is not exactly it is a mismatch. It is only a claim here; holding it is checked on mainnet.
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
    if (!Object.hasOwn(properties, "seedshot")) {
      if (!Array.isArray(attributes) || attributes.length !== 0) throw new Error(MISMATCH);
      return { image: doc.image, description, ...genesis };
    }
    try {
      const read = readAttestationBundle(properties.seedshot, expected);
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

/**
 * What a draft's own document already carries, for resealing it before it is sent: whether it is
 * in the current format, the attestation bundle it holds, and whether it names the device. Only
 * for a document `readSavedPhotoMetadata` accepted.
 */
export function sealedEvidence(serialized: string): { current: boolean; bundle?: unknown; namesDevice: boolean } {
  const doc = object(JSON.parse(serialized));
  const attributes: unknown[] = Array.isArray(doc?.attributes) ? doc.attributes : [];
  const bundle = object(doc?.properties)?.seedshot;
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
    // The attestation summary and the Genesis Token claim are whatever the document itself
    // supports, never the saved copy.
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
