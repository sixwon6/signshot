/**
 * Shared publication types. Keep this module free of runtime dependencies. Protocol and schema
 * literals are persisted in drafts, so changing them breaks existing drafts.
 */

/** The protocol identifier, persisted in drafts. */
type Protocol = "metaplex-core-editions-v1";

export const CORE_PROTOCOL = "metaplex-core-editions-v1" as const;

/** The clusters this app has a use for. Spelt as the RPC cluster names, not the MWA chain ids. */
export type Cluster = "devnet" | "mainnet-beta";

/** The app's ceiling on `CoreDraft.royaltyBps`: 10%. */
export const MAX_ROYALTY_BPS = 1000;
/** A new draft's royalty, 5%, and its Seeker-only setting, on. */
export const DEFAULT_ROYALTY_BPS = 500;
export const DEFAULT_SEEKER_ONLY = true;

/**
 * The phone's own record of one publication; never published. The public document is built by
 * `metadata()` in `core/document.ts`: `name`, `description` and `image`, plus `attributes` and
 * `properties` when the phone attested the publication (`properties.seedshot`) or the publishing
 * wallet held a Seeker Genesis Token (`properties.genesisToken`).
 */
export interface CoreMetadata {
  cluster: Cluster;
  /** The Candy Machine program that owns the edition account. Never taken from a link. */
  program: string;
  /** The candy machine's address — the publication's identity. */
  edition: string;
  /** The Core `CollectionV1`. */
  collection: string;
  creator: string;
  /** 32 bytes of hex; see the domain-separated derivation in `src/prints/creator.ts`. */
  nonce: string;
  title: string;
  supply: number;
  /** The print's own `https://arweave.net/<id>` URL; the document's `image`. */
  image: string;
  /** sha256 hex of the print bytes; the candy machine's hidden-settings hash. */
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
   * hardware attestation, and when the recorded evidence did not
   * check out (then `attestationProblem` says why). Not yet a device claim: a screen names the
   * device only after `deviceVerdict` has checked the app, the boot state, revocation and the
   * certificates' dates at publication.
   */
  attestation?: AttestationSummary;
  /** Why a recorded attestation was set aside, for the Proof sheet. Never set beside `attestation`. */
  attestationProblem?: string;
  /**
   * The Seeker Genesis Token mint the document names (`publications/core/genesisToken.ts`). A
   * CLAIM, read from the document at the edition's URI and never from a saved copy: a screen says it is
   * held only after `verifyGenesisToken` has checked it against mainnet. Absent when the
   * publishing wallet held none, or mainnet could not be asked, when the document was made.
   */
  genesisMint?: string;
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

/** A stand-alone storage payment, persisted before opening a wallet. */
export interface StorageTopUp {
  lastValidBlockHeight: string;
  /** Absent: the wallet did not return it, so whether it was sent is unknown. */
  signature?: string;
  quoteId: string;
  blockhash: string;
  slot: number;
  /** Lamports paid to Turbo, as a decimal string. */
  lamports: string;
}

/** Storage failure details retained with a publication draft. */
export interface PublicationStorageProblem {
  kind: "quota" | "size" | "integrity" | "unavailable";
  message: string;
  retryable: boolean;
}

/**
 * The persisted draft, under `es.candy.v1:${cluster}:${baseName}`. The edition is a Metaplex Core
 * Candy Machine (`publications/candy`): `edition.edition` is the candy machine, `edition.collection`
 * the Core collection, `edition.program` the Candy Machine program.
 */
export interface CoreDraft {
  version: 2;
  protocol: typeof CORE_PROTOCOL;
  edition: CoreMetadata;
  /** The canonical (JCS) metadata document; its Arweave id is `metadataId`. */
  metadata: string;
  /** Arweave id of that document; every copy's `uri` is `https://arweave.net/${metadataId}`. */
  metadataId: string;
  imagePath: string;
  sourceHash: string;
  genesisUnchecked?: true;
  /** A SOL price per copy in LAMPORTS, as a decimal string; absent (or "0") is free. */
  price?: string;
  /** A token price per copy (SKR, or the devnet stand-in): classic SPL mint and amount in base units. */
  tokenPrice?: { mint: string; amount: string };
  /** Royalty on resales in basis points, 0–`MAX_ROYALTY_BPS`. */
  royaltyBps: number;
  /** Only Seeker Genesis Token holders may claim, one copy per token, through the co-signer. */
  seekerOnly: boolean;
  /** The co-signer's key a Seeker-only edition's guard names. */
  cosigner?: string;
  /**
   * The phone's own keypairs (ed25519 seeds, hex): the collection, the candy machine (the
   * edition's address and its guard's base) and copy 1. They hold no power once published.
   */
  seeds: { collection: string; candyMachine: string; copy: string };
  /**
   * Both publish transactions as signed by the wallet and finished here (base64 wire), kept so
   * "Continue" can re-send them until `lastValidBlockHeight`.
   */
  signed?: { first: string; second: string; lastValidBlockHeight: string };
  /** When both transactions were seen confirmed. */
  confirmedAt?: number;
  storage?: "local" | "pending" | "available";
  storageError?: PublicationStorageProblem;
  storageFunding?: "credit" | "free";
  storageSettling?: { tx: string; since: number };
  storageTopUp?: StorageTopUp;
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
