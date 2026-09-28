/**
 * Shared publication types. Keep this module free of runtime dependencies. Protocol and schema
 * literals are persisted in drafts, so changing them breaks existing drafts.
 */

/** The protocol identifier, persisted in drafts. */
type Protocol = "metaplex-core-editions-v1";

export const CORE_PROTOCOL = "metaplex-core-editions-v1" as const;

/** The clusters this app has a use for. Spelt as the RPC cluster names, not the MWA chain ids. */
export type Cluster = "devnet" | "mainnet-beta";

/** The program's ceiling on `CoreDraft.royaltyBps`: 10% (`InvalidRoyalty`, 6010, above it). */
export const MAX_ROYALTY_BPS = 1000;
/** A new draft's royalty, 5%, and its Seeker-only setting, on. */
export const DEFAULT_ROYALTY_BPS = 500;
export const DEFAULT_SEEKER_ONLY = true;

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
   * check out (then `attestationProblem` says why). Not yet a device claim: a screen names the
   * device only after `deviceVerdict` has checked the app, the boot state, revocation and the
   * certificates' dates at publication.
   */
  attestation?: AttestationSummary;
  /** Why a recorded attestation was set aside, for the Proof sheet. Never set beside `attestation`. */
  attestationProblem?: string;
  /**
   * The Seeker Genesis Token mint the document names (`publications/core/genesisToken.ts`). A
   * CLAIM, read from the hash-bound document and never from a saved copy: a screen says it is
   * held only after `verifyGenesisToken` has checked it against mainnet. Absent when the
   * publishing wallet held none, or mainnet could not be asked, when the document was made.
   */
  genesisMint?: string;
  /**
   * The edition program verified that mint at publish — a Seeker Genesis Token, held by the
   * creator — and sealed it into the collection's locked attributes. Read from the chain
   * on every load (`sealedGenesisMint`), never from a saved copy; never set without `genesisMint`.
   * It counts on mainnet only (`genesisDisplay`).
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
  /**
   * Every certificate in the chain, leaf first: serial as lowercase hex without leading zeros and
   * the validity window in epoch milliseconds. What the revocation list and the publish-time
   * validity check (`deviceVerdict`) are asked about.
   */
  certificates: { serial: string; notBefore: number; notAfter: number }[];
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
   * Mainnet could not be asked for the wallet's Seeker Genesis Token when the draft was made, so
   * the document names none (`publisherGenesisMint`). The review says so. A local note only.
   */
  genesisUnchecked?: true;
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
  /**
   * The creator's royalty on resales in basis points, 0–`MAX_ROYALTY_BPS` (500 is 5%). Sealed at
   * publish into the collection's locked `Royalties` plugin, which names the creator alone, so
   * unlike the price it never changes afterwards. `DEFAULT_ROYALTY_BPS` unless the creator chose.
   * Always 0 on a program without `programFeatures().royaltiesAndSeekerOnly`, which cannot hold one.
   */
  royaltyBps: number;
  /**
   * Only a wallet holding a Seeker Genesis Token can collect, one copy per token. Sealed at
   * publish like the royalty. `DEFAULT_SEEKER_ONLY` unless the creator chose; always `false` on a
   * program without `programFeatures().royaltiesAndSeekerOnly`.
   */
  seekerOnly: boolean;
  attempt?: PublicationAttempt;
  /** Last confirmation time, shown as cached when the network cannot be checked. */
  confirmedAt?: number;
  storage?: "local" | "pending" | "available";
  storageError?: PublicationStorageProblem;
  /**
   * Mainnet: how the uploads are paid for once settled (`StorageFunding` in `storage.ts`), so a
   * resumed upload neither re-posts a credited payment nor waits out a refusal again.
   */
  storageFunding?: "credit" | "free";
  /** When the payment service first left the payment `tx` uncredited (`settleStoragePayment`). */
  storageSettling?: { tx: string; since: number };
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
