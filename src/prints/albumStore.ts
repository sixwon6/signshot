import { address } from "@solana/kit";
import { albumAddress, utf8 } from "../../publications/core/protocol";
import { hasUnsafeText } from "../../publications/core/details";
import { isTrustedDeployment } from "../../publications/deployments";
import { assertAttempt } from "../../publications/lifecycle";
import type { Cluster, PublicationAttempt } from "../../publications/types";

/** One album this wallet made, as this phone remembers it. */
export interface AlbumRecord {
  /** 32 bytes of hex. */
  nonce: string;
  /** Re-derived from program, creator and nonce when read. */
  address: string;
  /** Mutable label, never ownership evidence. */
  name: string;
  creator: string;
  program: string;
  createdAt: number;
  /** Older app versions saved the lifetime without a review fingerprint. */
  attempt?: PublicationAttempt & { quoteId?: string };
  /** Set only after the group account was read. */
  confirmedAt?: number;
  /** Returned only, never stored. */
  reviewMismatch?: true;
}

export interface AlbumStore {
  version: 1;
  albums: AlbumRecord[];
}

export const ALBUM_STORE_UNREADABLE = "Saved albums could not be read on this phone.";

/** A renamed group must not be subjected to the more restrictive creation-name rule. */
export function assertAlbumLabel(label: string): void {
  if (typeof label !== "string" || !label.trim() || utf8(label).length > 256 || hasUnsafeText(label))
    throw new Error("This album label cannot be shown.");
}

/** Validate without rewriting older records or inventing missing transaction evidence. */
export async function readAlbumStore(raw: string | null, cluster: Cluster): Promise<AlbumRecord[]> {
  if (!raw) return [];
  const parsed = JSON.parse(raw) as AlbumStore;
  if (parsed?.version !== 1 || !Array.isArray(parsed.albums)) throw new Error(ALBUM_STORE_UNREADABLE);
  for (const record of parsed.albums) {
    if (!record || !/^[a-f0-9]{64}$/.test(record.nonce) || typeof record.name !== "string" ||
        !Number.isSafeInteger(record.createdAt) ||
        (record.confirmedAt !== undefined && !Number.isSafeInteger(record.confirmedAt)))
      throw new Error(ALBUM_STORE_UNREADABLE);
    address(record.address);
    address(record.creator);
    address(record.program);
    try { assertAlbumLabel(record.name); }
    catch { throw new Error(ALBUM_STORE_UNREADABLE); }
    if (!isTrustedDeployment(cluster, record.program))
      throw new Error("A saved album names a publication program this build has not reviewed.");
    if (await albumAddress(record.program, record.creator, record.nonce) !== record.address)
      throw new Error(ALBUM_STORE_UNREADABLE);
    if (record.attempt) {
      assertAttempt(record.attempt);
      // Missing means the historical receipt is unchecked. A present, malformed fingerprint
      // is still refused; pending lifetimes/signatures remain available to prevent a duplicate.
      if (record.attempt.quoteId !== undefined &&
          (typeof record.attempt.quoteId !== "string" || !/^[a-f0-9]{64}$/.test(record.attempt.quoteId)))
        throw new Error(ALBUM_STORE_UNREADABLE);
    }
    delete record.reviewMismatch;
  }
  return parsed.albums;
}
