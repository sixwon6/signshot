import { getBase64Decoder } from "@solana/kit";
import { serializedDataItemId } from "../arweave/dataItem";
import type { CoreDraft } from "../../publications/types";

/**
 * An export for a confirmed publication whose upload has not finished. The chain holds only the
 * metadata hash and URI; the canonical document and the print image exist only on this phone,
 * so this file is the one way to carry them off it. Nothing in the app reads a bundle back. The
 * native export call lives in the screen, keeping this module free of `react-native`.
 */

/** The bundle's own schema. Changing the shape means changing this. */
const PUBLICATION_BUNDLE_SCHEMA = "seedshot-publication-bundle/2" as const;

/**
 * Everything except the image bytes. The native side adds `printImage` after re-hashing the file
 * against `edition.imageHash`, so the verification happens where the file is.
 */
interface PublicationBundleDocument {
  schema: typeof PUBLICATION_BUNDLE_SCHEMA;
  exportedAtMs: number;
  /** Which chain the edition lives on. Taken from the draft, never from the current build. */
  cluster: CoreDraft["edition"]["cluster"];
  /** The publishing wallet. The same address `edition.creator` names; both are written. */
  wallet: string;
  /** The edition's candy machine. */
  edition: string;
  /** The program that owns it. */
  program: string;
  /** The canonical (JCS) metadata document, verbatim. Its bytes hash to `metadataHash`. */
  metadata: string;
  /** The Arweave data item id the on-chain `uri` names. */
  metadataId: string;
  /** The Arweave data item id the on-chain `image` field names. */
  imageId: string;
  /** What the on-chain `uri` resolves to once the upload completes. */
  uri: string;
  /**
   * The signed ANS-104 data items the ids above name, base64. The ids come from the upload key's
   * signatures, so only these bytes can complete the upload; they hold no key. Absent when this
   * phone could not rebuild them to those ids.
   */
  dataItems?: { metadata: string; image: string };
  /** The whole durable draft, unaltered. */
  draft: CoreDraft;
  /** What this file is, for whoever opens it outside the app. */
  note: string;
}

const NOTE =
  "Signshot publication bundle. The edition is on Solana; its metadata document and public " +
  "image have not finished uploading to Arweave. dataItems holds both as the signed data items " +
  "the chain names: POST each, base64-decoded, as application/octet-stream to " +
  "https://turbo.ardrive.io/tx to complete the upload. The app does not back them up and cannot " +
  "read this file back in. Keep it until the upload completes.";

/**
 * The document for this draft, with the signed items (`publicationDataItems`) when their ids are
 * the ones the chain names.
 */
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
    // Not data items at all: the bundle still carries the bytes.
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

/**
 * True when the publication is confirmed and its upload has not finished: before confirmation the
 * draft is discardable, and after upload the bytes are on Arweave.
 */
export function canExportPublicationBundle(draft: CoreDraft | null | undefined): boolean {
  return (
    !!draft &&
    draft.confirmedAt !== undefined &&
    draft.storage !== "available" &&
    typeof draft.imagePath === "string" &&
    draft.imagePath.length > 0
  );
}
