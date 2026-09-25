/**
 * Shared publication types. Keep this module free of runtime dependencies. Protocol and schema
 * literals are persisted in drafts, so changing them breaks existing drafts.
 */

/** The protocol identifier, persisted in drafts. */
type Protocol = "metaplex-core-editions-v1";

export const CORE_PROTOCOL = "metaplex-core-editions-v1" as const;

/** The clusters this app has a use for. Spelt as the RPC cluster names, not the MWA chain ids. */
export type Cluster = "devnet" | "mainnet-beta";

/**
 * The phone's own record of one publication; never published. The public document is built by
 * `metadata()` in `core/protocol.ts`: `name`, `description` and `image`, plus `attributes` and
 * `properties` when the phone attested the publication (`properties.seedshot`) or the publishing
 * wallet held a Seeker Genesis Token (`properties.genesisToken`).
 */
export interface CoreMetadata {
  cluster: Cluster;
  /** The `era_editions` deployment that owns the edition account. Never taken from a link. */
  program: string;
  /** `["edition", creator, nonce]` PDA — the publication's identity. */
  edition: string;
  /** The Core `CollectionV1`, `["collection", edition]`. */
  collection: string;
  creator: string;
  /** 32 bytes of hex; see the domain-separated derivation in `src/prints/creator.ts`. */
  nonce: string;
  title: string;
  supply: number;
  /** The print's own `https://arweave.net/<id>` URL; the document's `image`. */
  image: string;
  /** sha256 hex of the print bytes; the on-chain `image_hash`. */
  imageHash: string;
  /** The print's pixel size, read from the JPEG itself. Layout only. */
  width: number;
  height: number;
  /** The Moment caption as typed and trimmed, or `""`; the document's `description`. */
  description: string;
  /**
   * What the phone's keystore attested when the document was made, derived from the certificate
   * chain inside the document (`publications/core/attestation.ts`) after that chain verified down
   * to a Google attestation root; never copied from a claim. Absent for a publication made without
   * hardware attestation, for every earlier document, and when the recorded evidence did not
   * check out (then `attestationProblem` says why).
   */
  attestation?: AttestationSummary;
  /** Why a recorded attestation was set aside, for the Proof sheet. Never set beside `attestation`. */
  attestationProblem?: string;
  /**
   * The Seeker Genesis Token mint the document names (`publications/core/genesisToken.ts`). A
   * CLAIM, read from the hash-bound document and never from a saved copy: a screen says it is
   * held only after `verifyGenesisToken` has checked it against mainnet. Absent when the
   * publishing wallet held none, or none could be found, when the document was made.
   */
  genesisMint?: string;
  /**
   * The edition program verified that mint at publish — Solana Mobile's three properties and the
   * creator's balance — and sealed it into the collection's locked attributes. Read from the chain
   * on every load (`sealedGenesisMint`), never from a saved copy; never set without `genesisMint`.
   */
  genesisSealed?: boolean;
}

/** Mirrors what `core/attestation.ts` derives; repeated here to keep this module runtime-free. */
export interface AttestationSummary {
  securityLevel: "tee" | "strongbox";
  manufacturer: string;
  model: string;
  brand: string;
  verifiedBoot: "verified" | "self-signed" | "unverified" | "failed";
  deviceLocked: boolean;
  /** Every package the keystore daemon attested for the calling UID, and every signer digest. */
  packageNames: string[];
  signerDigests: string[];
}

/**
 * Persisted before opening a wallet. A missing signature leaves submission uncertain.
 */
export interface PublicationAttempt {
  lastValidBlockHeight: string;
  signature?: string;
}

/** Storage failure details retained with a publication draft. */
export interface PublicationStorageProblem {
  kind: "quota" | "size" | "integrity" | "unavailable";
  message: string;
  retryable: boolean;
}

/**
 * The persisted draft, under `es.core.v1:${cluster}:${baseName}`. Bound to the cluster and
 * program recorded inside it, so a configuration change cannot repoint an existing publication.
 */
export interface CoreDraft {
  version: 1;
  protocol: typeof CORE_PROTOCOL;
  edition: CoreMetadata;
  /** The canonical (JCS) metadata document whose bytes hash to the on-chain `metadata_hash`. */
  metadata: string;
  /** Arweave id of that document; the on-chain `uri` is `https://arweave.net/${metadataId}`. */
  metadataId: string;
  imagePath: string;
  sourceHash: string;
  /**
   * The Core `GroupV1` to join (selects `publish_in_album`) and its name when the draft was made,
   * a local label only. Kept out of the hashed document because the group's name is mutable.
   */
  album?: string;
  albumName?: string;
  /**
   * The price of a copy in LAMPORTS, written as a decimal integer string: "100000000" is 0.1 SOL.
   *
   * A string because a draft is JSON and `JSON.stringify` throws on a bigint, and because the
   * the amount must be preserved EXACTLY through review, signing and recovery — a
   * JSON number is a double, so a price above 2^53 lamports would come back a different price.
   * Absent or "0" means free, which is also what having no `Offer` account means; a present,
   * non-zero value makes `prepareSetup` append `set_offer` to the publication transaction.
   *
   * Not part of the hashed metadata document and not publication evidence: the edition commitment
   * is sealed, the distribution offer beside it is not.
   */
  price?: string;
  attempt?: PublicationAttempt;
  /** Last confirmation time, shown as cached when the network cannot be checked. */
  confirmedAt?: number;
  storage?: "local" | "pending" | "available";
  storageError?: PublicationStorageProblem;
}

/**
 * What every screen renders. `container` is the Core `CollectionV1`, `creatorAsset` is print #1,
 * `supply` is edition size (not issued count) and `creator` is the publisher (not the owner).
 */
export interface PublicationView {
  protocol: Protocol;
  cluster: Cluster;
  program: string;
  edition: string;
  container: string;
  creatorAsset: string;
  creator: string;
  title: string;
  supply: number;
  image: string;
  imageHash: string;
  metadataId: string;
  metadataHash: string;
  width: number;
  height: number;
  publicUrl: string;
  explorerUrl: string;
}
