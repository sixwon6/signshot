/**
 * Shared publication types; no runtime dependencies. Protocol and schema literals are persisted
 * in drafts, so changing them breaks existing drafts.
 */

type Protocol = "metaplex-core-editions-v1";

export const CORE_PROTOCOL = "metaplex-core-editions-v1" as const;

/** RPC cluster names, not MWA chain ids. */
export type Cluster = "devnet" | "mainnet-beta";

/** 10%. */
export const MAX_ROYALTY_BPS = 1000;
/** New-draft defaults: 5% royalty, Seeker-only. */
export const DEFAULT_ROYALTY_BPS = 500;
export const DEFAULT_SEEKER_ONLY = true;

/** The phone's record of one publication; the public document is `metadata()` in `core/document.ts`. */
export interface CoreMetadata {
  cluster: Cluster;
  /** Candy Machine program owning the edition account. Never taken from a link. */
  program: string;
  /** Candy machine address; the publication's identity. */
  edition: string;
  /** Core `CollectionV1`. */
  collection: string;
  creator: string;
  /** 32 bytes hex; derivation in `src/prints/creator.ts`. */
  nonce: string;
  title: string;
  supply: number;
  /** `https://arweave.net/<id>`; the document's `image`. */
  image: string;
  /** sha256 hex of the print; the hidden-settings hash. */
  imageHash: string;
  /** From the JPEG header. Layout only. */
  width: number;
  height: number;
  /** Trimmed Moment caption or `""`; the document's `description`. */
  description: string;
  /**
   * Derived from the document's verified certificate chain, never copied from a claim. Not yet a
   * device claim: screens name the device only after `deviceVerdict`.
   */
  attestation?: AttestationSummary;
  /** Why the attestation was set aside. Never set beside `attestation`. */
  attestationProblem?: string;
  /**
   * SGT mint the document claims, read from the document, never a saved copy. Shown as held only
   * after `verifyGenesisToken`.
   */
  genesisMint?: string;
}

/** Defined here, not in `core/attestation.ts`, to keep this module runtime-free. */
export interface AttestationSummary {
  securityLevel: "tee" | "strongbox";
  manufacturer: string;
  model: string;
  brand: string;
  verifiedBoot: "verified" | "self-signed" | "unverified" | "failed";
  deviceLocked: boolean;
  /** Every package attested for the calling UID, and every signer digest. */
  packageNames: string[];
  signerDigests: string[];
  /** Leaf first. Serial is lowercase hex without leading zeros; validity in epoch ms. */
  certificates: { serial: string; notBefore: number; notAfter: number }[];
}

/** A stand-alone storage payment, persisted before opening a wallet. */
export interface StorageTopUp {
  lastValidBlockHeight: string;
  /** Absent: the wallet did not return it, so send status is unknown. */
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

/** Persisted under `es.candy.v1:${cluster}:${baseName}`. */
export interface CoreDraft {
  version: 2;
  protocol: typeof CORE_PROTOCOL;
  edition: CoreMetadata;
  /** Canonical (JCS) metadata document. */
  metadata: string;
  /** Every copy's `uri` is `https://arweave.net/${metadataId}`. */
  metadataId: string;
  imagePath: string;
  sourceHash: string;
  genesisUnchecked?: true;
  /** Lamports per copy, decimal string; absent or "0" is free. */
  price?: string;
  /** Per-copy SPL token price (SKR, or a devnet stand-in), amount in base units. */
  tokenPrice?: { mint: string; amount: string };
  /** Basis points, 0–`MAX_ROYALTY_BPS`. */
  royaltyBps: number;
  /** One claim per Genesis Token, through the co-signer. */
  seekerOnly: boolean;
  cosigner?: string;
  /** Ed25519 seeds (hex). Powerless once published. */
  seeds: { collection: string; candyMachine: string; copy: string };
  /** Both fully signed publish transactions (base64), re-sendable until `lastValidBlockHeight`. */
  signed?: { first: string; second: string; lastValidBlockHeight: string };
  confirmedAt?: number;
  storage?: "local" | "pending" | "available";
  storageError?: PublicationStorageProblem;
  storageFunding?: "credit" | "free";
  storageSettling?: { tx: string; since: number };
  storageTopUp?: StorageTopUp;
}
/**
 * `container` is the Core `CollectionV1`, `creatorAsset` is print #1, `supply` is edition size
 * (not issued count), `creator` is the publisher (not the owner).
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
