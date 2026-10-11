import { getBase64Decoder } from "@solana/kit";
import { serializedDataItemId } from "../arweave/dataItem";
import type { CoreDraft } from "../../publications/types";

/**
 * Export for a confirmed publication whose upload has not finished: the document and image exist
 * only on this phone until then. Write-only; nothing reads a bundle back. Kept free of
 * `react-native`; the screen does the native export.
 */

/** Bump when the shape changes. */
const PUBLICATION_BUNDLE_SCHEMA = "signshot-publication-bundle/2" as const;

/** Everything but the image; native adds `printImage` after re-hashing it against `edition.imageHash`. */
interface PublicationBundleDocument {
  schema: typeof PUBLICATION_BUNDLE_SCHEMA;
  exportedAtMs: number;
  /** From the draft, never the current build. */
  cluster: CoreDraft["edition"]["cluster"];
  /** Same as `edition.creator`. */
  wallet: string;
  /** Candy machine address. */
  edition: string;
  program: string;
  /** JCS metadata document, verbatim. */
  metadata: string;
  /** Data item id named by the on-chain `uri`. */
  metadataId: string;
  /** Data item id named by the on-chain `image`. */
  imageId: string;
  uri: string;
  /**
   * Signed ANS-104 items for the ids above, base64. Only these bytes match the ids; they hold no
   * key. Absent when they could not be rebuilt to those ids.
   */
  dataItems?: { metadata: string; image: string };
  draft: CoreDraft;
  note: string;
}

const NOTE =
  "Signshot publication bundle. The edition is on Solana; its metadata document and public " +
  "image have not finished uploading to Arweave. dataItems holds both as the signed data items " +
  "the chain names: POST each, base64-decoded, as application/octet-stream to " +
  "https://turbo.ardrive.io/tx to complete the upload. The app does not back them up and cannot " +
  "read this file back in. Keep it until the upload completes.";

/** Includes the signed items (`publicationDataItems`) only when their ids match the chain's. */
export function publicationBundleDocument(
  draft: CoreDraft,
  now: number,
  items?: { metadata: Uint8Array; image: Uint8Array },
): PublicationBundleDocument {
  let dataItems: PublicationBundleDocument["dataItems"];
  try {
    if (items && serializedDataItemId(items.metadata) === draft.metadataId &&
      `https://arweave.net/${serializedDataItemId(items.image)}` === draft.edition.image) {
      const base64 = getBase64Decoder();
      dataItems = { metadata: base64.decode(items.metadata), image: base64.decode(items.image) };
    }
  } catch {
    // Not valid data items; export without them.
  }
  return {
    schema: PUBLICATION_BUNDLE_SCHEMA,
    exportedAtMs: now,
    cluster: draft.edition.cluster,
    wallet: draft.edition.creator,
    edition: draft.edition.edition,
    program: draft.edition.program,
    metadata: draft.metadata,
    metadataId: draft.metadataId,
    imageId: draft.edition.image,
    uri: `https://arweave.net/${draft.metadataId}`,
    ...(dataItems ? { dataItems } : {}),
    draft,
    note: NOTE,
  };
}

/** Confirmed but not yet uploaded: before that the draft is discardable, after it Arweave has it. */
export function canExportPublicationBundle(draft: CoreDraft | null | undefined): boolean {
  return (
    !!draft &&
    draft.confirmedAt !== undefined &&
    draft.storage !== "available" &&
    typeof draft.imagePath === "string" &&
    draft.imagePath.length > 0
  );
}
