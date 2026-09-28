/**
 * Albums: creating a Metaplex Core `GroupV1` at `["album", creator, nonce]` and remembering it.
 * Nothing on chain indexes albums by creator, so this file keeps a local list of nonces; losing it
 * loses the list, never an album.
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import { address, getBase58Decoder, type Instruction } from "@solana/kit";
import { getUploadKey } from "../arweave";
import { RPC_ENDPOINT, CLUSTER_NAME as cluster, assertEndpointCluster } from "../solana/cluster";
import type { WalletSession } from "../solana/walletSession";
import { forgetIfRefused } from "../solana/walletErrors";
import {
  confirmTransaction,
  OPERATION_FLOOR_LAMPORTS,
  prepareTransaction,
} from "../../publications/rpc";
import { refreshedQuote } from "./quoteRefresh";
import {
  checkReviewedReceipt,
  reviewedQuoteId,
} from "./reviewedReceipt";
import { checkAttempt, exclusive } from "../../publications/lifecycle";
import { account, albumAddress, hash, utf8 } from "../../publications/core/protocol";
import {
  albumLabel,
  albumTerms,
  albumUrl,
  createAlbumInstruction,
  readAlbum,
} from "../../publications/core/album";
import {
  configuredProgram,
  publishingAvailability,
} from "../../publications/deployments";
import { readAlbumStore, ALBUM_STORE_UNREADABLE as UNREADABLE, type AlbumRecord, type AlbumStore } from "./albumStore";
export { assertAlbumLabel, type AlbumRecord } from "./albumStore";

/** One durable list per network. */
const albumStoreKey = () => `es.core-albums.v1:${cluster}`;

/** One operation per album. A second tap cannot race a durable pending write. */
const albumLockKey = (nonce: string) => `album:${cluster}:${nonce}`;

/** `ExistingAsset` at the derived address: the same transaction would fail again, so pick a new name. */
const ALBUM_TERMINAL =
  "That album could not be created, and creating it again cannot succeed. Choose a different album name.";

/**
 * Caps the text input only. `maxLength` counts UTF-16 units, so `albumName` (the program's rule
 * via `albumTerms`) is the real check.
 */
export const ALBUM_NAME_MAX_BYTES = 32;

/** The gate for a name this app may ask a wallet to create. Runs before everything else. */
export function albumName(name: string): void {
  albumTerms(name);
}

/**
 * A signature over (cluster, creator, name), hashed: only this wallet can derive it, and tapping
 * "Create album" twice for one name maps to one album.
 */
export async function albumNonce(creator: string, name: string): Promise<string> {
  const signer = await getUploadKey(creator);
  return hash(signer.sign(utf8(`erashot-album/1\n${cluster}\n${creator}\n${name}`)));
}

/** Empty: there is no album document to upload; the members carry their own metadata. */
const ALBUM_URI = "";

async function readStore(): Promise<AlbumRecord[]> {
  return readAlbumStore(await AsyncStorage.getItem(albumStoreKey()), cluster);
}

async function writeStore(albums: AlbumRecord[]) {
  const store: AlbumStore = { version: 1, albums };
  await AsyncStorage.setItem(albumStoreKey(), JSON.stringify(store));
}

async function saveAlbum(record: AlbumRecord) {
  const { reviewMismatch: _transient, ...stored } = record;
  return saveAlbumRecord(stored);
}
async function saveAlbumRecord(record: AlbumRecord) {
  const albums = await readStore();
  const index = albums.findIndex((a) => a.nonce === record.nonce && a.program === record.program);
  if (index < 0) albums.push(record);
  else albums[index] = record;
  await writeStore(albums);
}

/**
 * The conforming album at this record's derived address, or `null` when nothing is there yet.
 * An RPC failure throws: reading it as "absent" would ask a wallet to create a second group.
 */
async function albumOnChain(record: AlbumRecord) {
  const raw = await account(RPC_ENDPOINT, record.address);
  if (!raw) return null;
  const album = await readAlbum(RPC_ENDPOINT, record.address, cluster);
  if (album.authority !== record.creator)
    throw new Error("This album address is held by another wallet.");
  return album;
}

/** Re-derive and re-read an unconfirmed album. Confirmation is the group account, not a receipt. */
async function reconcile(record: AlbumRecord): Promise<AlbumRecord> {
  if (record.confirmedAt) return record;
  const derived = await albumAddress(record.program, record.creator, record.nonce);
  if (derived !== record.address) throw new Error(UNREADABLE);
  const album = await albumOnChain(record);
  if (!album) return record;
  const next: AlbumRecord = { ...record, name: albumLabel(album), confirmedAt: Date.now() };
  await saveAlbum(next);
  return next;
}

/**
 * This creator's albums, reconciling any that were never confirmed. `publish_in_album` needs the
 * group's update authority to sign, so another wallet's album is never offered.
 */
export async function loadAlbums(creator?: string): Promise<AlbumRecord[]> {
  const albums = await readStore();
  const mine = creator ? albums.filter((a) => a.creator === creator) : albums;
  const settled: AlbumRecord[] = [];
  for (const record of mine) settled.push(await reconcile(record));
  return settled;
}

/** The confirmed subset, in creation order. What the album picker lists. */
export function selectableAlbums(albums: readonly AlbumRecord[]): AlbumRecord[] {
  return albums
    .filter((a) => a.confirmedAt !== undefined)
    .slice()
    .sort((a, b) => a.createdAt - b.createdAt);
}

/** A confirmed album this creator may publish into, by address. */
export async function confirmedAlbum(
  albumAddressValue: string,
  creator: string,
): Promise<AlbumRecord> {
  const record = (await readStore()).find(
    (a) => a.address === albumAddressValue && a.creator === creator,
  );
  if (!record)
    throw new Error("This album was not created by the publishing wallet on this phone.");
  if (!record.confirmedAt)
    throw new Error("Create and confirm the album before publishing a photograph into it.");
  return record;
}

export type AlbumSetup =
  | { step: "ready"; record: AlbumRecord }
  | {
      step: "sign";
      record: AlbumRecord;
      /** The reviewed `create_album` instruction, kept so the approval can refresh its lifetime. */
      instructions: readonly Instruction[];
      prepared: Awaited<ReturnType<typeof prepareTransaction>>;
    };

/**
 * Validate the name, derive the album, reconcile whatever already exists, and quote the cost by
 * simulating the creator's own transaction. Nothing is signed.
 */
export async function prepareAlbum(name: string, creator: string): Promise<AlbumSetup> {
  const trimmed = name.trim();
  albumName(trimmed);
  // The estimate and confirmation must be read from the chain the wallet will broadcast to.
  await assertEndpointCluster();
  const availability = publishingAvailability(cluster);
  if (!availability.enabled)
    throw new Error(availability.reason ?? "Publishing is unavailable in this build.");
  address(creator);
  const program = configuredProgram(cluster);
  // Match a confirmed album by name before deriving a nonce: a regenerated upload key derives a
  // different nonce, which would otherwise offer to create a duplicate group.
  const named = (await readStore()).find(
    (a) =>
      a.creator === creator &&
      a.program === program &&
      a.confirmedAt !== undefined &&
      a.name === trimmed,
  );
  if (named) return { step: "ready", record: named } as const;
  const nonce = await albumNonce(creator, trimmed);
  const derived = await albumAddress(program, creator, nonce);
  return exclusive(albumLockKey(nonce), async () => {
    const saved = (await readStore()).find((a) => a.nonce === nonce && a.program === program);
    const record = await reconcile(
      saved ?? {
        nonce,
        address: derived,
        name: trimmed,
        creator,
        program,
        createdAt: Date.now(),
      },
    );
    if (record.confirmedAt) return { step: "ready", record } as const;
    // The operation is named because `ExistingAsset` on `create_album` is terminal, not retryable.
    const standing = record.attempt
      ? await checkAttempt(RPC_ENDPOINT, record.attempt, { operation: "create-album" })
      : "retryable";
    if (standing === "terminal") throw new Error(ALBUM_TERMINAL);
    if (standing !== "retryable")
      throw new Error(
        "The previous album transaction may still land. Wait a moment, then check again.",
      );
    const instruction = await createAlbumInstruction({
      program,
      creator,
      nonce,
      name: trimmed,
      uri: ALBUM_URI,
    });
    return {
      step: "sign",
      record,
      // Carried so the approval can rebuild the same transaction on a fresh blockhash.
      instructions: [instruction],
      prepared: await prepareTransaction(RPC_ENDPOINT, creator, [instruction], [],
        OPERATION_FLOOR_LAMPORTS["create-album"]),
    } as const;
  });
}

type AlbumProgress = "wallet" | "confirming";

/**
 * Create the album: one wallet approval, then the chain is asked whether it happened. The
 * `GroupV1` at the derived address is the answer, not the returned signature.
 */
export async function createAlbum(
  creator: string,
  session: WalletSession,
  quote: AlbumSetup,
  onProgress?: (stage: AlbumProgress) => void,
): Promise<AlbumRecord> {
  if (quote.step === "ready") return quote.record;
  const record: AlbumRecord = { ...quote.record };
  return exclusive(albumLockKey(record.nonce), async () => {
    const saved = (await readStore()).find(
      (a) => a.nonce === record.nonce && a.program === record.program,
    );
    if (saved?.confirmedAt) return saved;
    const standing = saved?.attempt
      ? await checkAttempt(RPC_ENDPOINT, saved.attempt, { operation: "create-album" })
      : "retryable";
    if (standing === "terminal") throw new Error(ALBUM_TERMINAL);
    if (standing !== "retryable")
      throw new Error("An album transaction may still land. Check its status before retrying.");
    // It may already exist: a lost receipt, or another device.
    const existing = await albumOnChain(record);
    if (existing) {
      const done: AlbumRecord = { ...record, name: albumLabel(existing), confirmedAt: Date.now() };
      await saveAlbum(done);
      return done;
    }
    onProgress?.("wallet");
    await session.connectAnd(async (wallet) => {
      const owner = await session.authorizeSession(wallet);
      if (owner.address !== creator)
        throw new Error("Use the wallet chosen for this edition.");
      // The wallet's approval sheet can outlast a blockhash, so only the lifetime is refreshed;
      // any other change to the compiled message still refuses.
      const prepared = await refreshedQuote(
        RPC_ENDPOINT,
        creator,
        quote.instructions,
        quote.prepared,
        "Estimate expired. Refresh before creating the album.",
      );
      // Persisted before the wallet opens, so a lost receipt is reconciled rather than re-sent.
      record.attempt = {
        lastValidBlockHeight: String(prepared.lastValidBlockHeight),
        quoteId: reviewedQuoteId(prepared.transaction.messageBytes),
      };
      await saveAlbum(record);
      // Declined in the wallet: the record goes back to its previous attempt, under the album lock.
      const signatures = await forgetIfRefused(wallet.signAndSendTransactions({
        transactions: [prepared.transaction],
        minContextSlot: Number(prepared.minContextSlot),
        skipPreflight: false,
      }), async () => {
        record.attempt = saved?.attempt;
        await saveAlbum(record);
      });
      // A malformed signature would make the saved attempt unreadable on the next load.
      if (signatures.length !== 1 || signatures[0].length !== 64)
        throw new Error("No wallet receipt. Check before retrying.");
      record.attempt.signature = getBase58Decoder().decode(signatures[0]);
      await saveAlbum(record);
    });
    if (!record.attempt?.signature)
      throw new Error("No wallet receipt. Check before retrying.");
    onProgress?.("confirming");
    await confirmTransaction(
      RPC_ENDPOINT,
      record.attempt.signature,
      BigInt(record.attempt.lastValidBlockHeight),
    );
    // A receipt mismatch is reported, not thrown: the album exists and must stay usable.
    const receipt = await checkReviewedReceipt(
      RPC_ENDPOINT,
      record.attempt.signature,
      record.attempt.quoteId,
    );
    const created = await albumOnChain(record);
    if (!created)
      throw new Error("The album is not visible on this connection yet. Check again.");
    const done: AlbumRecord = { ...record, name: albumLabel(created), confirmedAt: Date.now() };
    await saveAlbum(done);
    return receipt === "mismatched" ? { ...done, reviewMismatch: true as const } : done;
  });
}

/** The album's public page. */
export function albumPublicUrl(group: string): string {
  return albumUrl(group, cluster);
}
