import type { CoreDraft } from "../../publications/types";

/**
 * An export for a confirmed publication whose upload has not finished. The chain holds only the
 * metadata hash and URI; the canonical document and the print image exist only on this phone,
 * so this file is the one way to carry them off it. Nothing in the app reads a bundle back.
 */

/** The bundle's own schema. Changing the shape means changing this. */
const PUBLICATION_BUNDLE_SCHEMA = "seedshot-publication-bundle/1" as const;

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
  /** The edition PDA. */
  edition: string;
  /** The program deployment that owns it. */
  program: string;
  /** The canonical (JCS) metadata document, verbatim. Its bytes hash to `metadataHash`. */
  metadata: string;
  /** The Arweave data item id the on-chain `uri` names. */
  metadataId: string;
  /** The Arweave data item id the on-chain `image` field names. */
  imageId: string;
  /** What the on-chain `uri` resolves to once the upload completes. */
  uri: string;
  /** The whole durable draft, unaltered. */
  draft: CoreDraft;
  /** What this file is, for whoever opens it outside the app. */
  note: string;
}

const NOTE =
  "Signshot publication bundle. The edition is on Solana; its metadata document and public " +
  "image have not finished uploading to Arweave. This file is the only copy of both: the app " +
  "does not back them up and cannot read this file back in. Keep it until the upload completes.";

/** The document for this draft. */
export function publicationBundleDocument(
  draft: CoreDraft,
  now: number,
): PublicationBundleDocument {
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
    draft,
    note: NOTE,
  };
}

// The native export call lives in the screen, keeping this module free of `react-native`.

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
