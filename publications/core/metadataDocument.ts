import { CORE_PROTOCOL, type AttestationSummary, type Cluster, type CoreMetadata } from "../types";
import { readDescription } from "./details";
import { checkAttributes, exactKeys, object, readAttestationBundle } from "./attestation";
import { canonicalize, type JcsValue } from "../../src/jcs";

const MISMATCH = "Photo metadata does not match the published edition";
const ARWEAVE_IMAGE = /^https:\/\/arweave\.net\/[A-Za-z0-9_-]{43}$/;
/** This earlier reviewed devnet deployment published the richer erashot-core/1 document. */
const LEGACY_PROGRAM = "BGEM8ZTk2pP2btuorG8EHzfHgQSaudjuZKVw6f74zAjq";

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
};
/**
 * Published documents also require checking their bytes against the on-chain metadata hash.
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
  if (exactKeys(doc, ["name", "description", "image"])) return { image: doc.image, description };

  // The attested document: the plain three fields plus Metaplex `attributes` and the evidence
  // under `properties.seedshot`. The bundle's manifest must name THIS publication, its challenge
  // must be the manifest's hash, its signature must verify, its chain must reach a Google root,
  // and the attributes must be exactly what the certificate supports. Evidence that fails any of
  // that is SET ASIDE, not fatal: the photograph is still a valid, hash-bound publication, it just
  // carries no device claim here, and the Proof sheet says why. (Refusing the whole photo would
  // add no safety and would make an immutable document unviewable if a future keystore format
  // ever outgrew this reader.)
  if (exactKeys(doc, ["name", "description", "image", "attributes", "properties"])) {
    const properties = object(doc.properties);
    if (!properties || !exactKeys(properties, ["seedshot"])) throw new Error(MISMATCH);
    if (serialized !== undefined && canonicalize(json as JcsValue) !== serialized)
      throw new Error(MISMATCH);
    try {
      const read = readAttestationBundle(properties.seedshot, expected);
      checkAttributes(doc.attributes, read.summary);
      return {
        image: doc.image,
        description,
        dimensions: { width: read.bundle.manifest.width, height: read.bundle.manifest.height },
        attestation: read.summary,
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message.replace(/^attestation: /, "") : "unreadable";
      return { image: doc.image, description, attestationProblem: reason };
    }
  }

  // Legacy metadata is still hash-bound. It cannot choose the network, program, ownership,
  // edition size or image fingerprint: every repeated claim must agree with verified state.
  if (expected.cluster !== "devnet" || expected.program !== LEGACY_PROGRAM ||
      !exactKeys(doc, ["name", "description", "image", "erashot", "properties"]))
    throw new Error(MISMATCH);
  const legacy = object(doc.erashot), properties = object(doc.properties);
  if (!legacy || legacy.schema !== "erashot-core/1" || legacy.protocol !== CORE_PROTOCOL ||
      legacy.image !== doc.image || !properties || properties.category !== "image" ||
      !exactKeys(properties, ["category", "files"]) || !Array.isArray(properties.files) || properties.files.length !== 1)
    throw new Error(MISMATCH);
  for (const key of ["cluster", "program", "edition", "collection", "creator", "nonce", "title", "supply", "imageHash"] as const)
    if (legacy[key] !== expected[key]) throw new Error(MISMATCH);
  const file = object(properties.files[0]);
  if (!file || !exactKeys(file, ["type", "uri"]) || file.type !== "image/jpeg" || file.uri !== doc.image ||
      typeof legacy.width !== "number" || !Number.isSafeInteger(legacy.width) || legacy.width <= 0 ||
      typeof legacy.height !== "number" || !Number.isSafeInteger(legacy.height) || legacy.height <= 0)
    throw new Error(MISMATCH);
  // Capture/source annotations are historical metadata, not proof of ownership or provenance.
  return { image: doc.image, description, dimensions: { width: legacy.width, height: legacy.height } };
}

/** Validate a saved intent without regenerating the immutable document in today's format. */
export function readSavedPhotoMetadata(serialized: string, edition: CoreMetadata): CoreMetadata {
  try {
    const doc = JSON.parse(serialized) as JcsValue;
    if (canonicalize(doc) !== serialized) throw new Error(MISMATCH);
    const parsed = readPhotoMetadata(doc, edition, serialized);
    // Only the validated legacy format predates the local caption field. Read its existing
    // caption into the local view; never rewrite the metadata bytes committed on chain.
    const description = edition.description === undefined && parsed.dimensions && !parsed.attestation
      ? parsed.description : readDescription(edition.description);
    if (parsed.image !== edition.image || parsed.description !== description ||
        (parsed.dimensions && (parsed.dimensions.width !== edition.width || parsed.dimensions.height !== edition.height)))
      throw new Error(MISMATCH);
    // The attestation summary is whatever the hash-bound document supports, never the saved copy.
    const { attestation: _saved, attestationProblem: _problem, ...rest } = edition;
    return parsed.attestation
      ? { ...rest, description, attestation: parsed.attestation }
      : parsed.attestationProblem
        ? { ...rest, description, attestationProblem: parsed.attestationProblem }
        : { ...rest, description };
  } catch {
    throw new Error("Saved edition metadata does not match this photo.");
  }
}
