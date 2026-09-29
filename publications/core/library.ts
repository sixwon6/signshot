/** Read-only discovery. RPC results are candidates, never evidence of Signshot issuance. */
import {
  address, getAddressDecoder, getAddressEncoder, getBase64Encoder, getBase64Decoder,
} from "@solana/kit";
import { TRUSTED, isTrustedDeployment } from "../deployments";
import { request } from "../rpc";
import type { Cluster } from "../types";
import {
  MPL_CORE, account, addresses, decodeAsset, decodeCollection, editionAccountBytes, readEdition,
  loadTrustedEdition, readPrintState,
} from "./protocol";

export type LibraryMode = "collected" | "published";
export type LibraryPhoto = {
  id: string;
  /**
   * The verified edition, including its `offer`: what a copy costs, or `null` for a free one.
   * `loadTrustedEdition` reads the `Offer` account itself, so nothing here has to add it — the
   * field is exactly the one `src/prints/collect.ts` quotes against.
   */
  photo: Awaited<ReturnType<typeof loadTrustedEdition>>;
  imageUri: string;
  number?: number;
  /** The wallet the scan found holding this copy. Collected copies only. */
  owner?: string;
};
export type LibraryResult = {
  items: LibraryPhoto[];
  unavailable: number;
  /** Candidates this scan did not resolve, because the cap was reached. 0 means "all of them". */
  hiddenCount: number;
};
type Row = { pubkey: string; account: { owner: string; executable: boolean; data: [string, string] } };

/**
 * Candidates resolved per scan. Anyone can mint Core assets to any owner, so address order alone
 * lets an attacker crowd out real prints; past the cap, a rescue scan runs per collection over
 * seeds ordered strongest first (see below).
 */
const MAX_CANDIDATES = 400;
/** How many collections the targeted rescue scan will ask about. One `getProgramAccounts` each. */
const MAX_TARGETED_COLLECTIONS = 32;

/** Core `Key::AssetV1`, base64 so the encoding is stated rather than inferred (see below). */
const ASSET_V1_FILTER = { memcmp: { offset: 0, bytes: "AQ==", encoding: "base64" } };
/**
 * `AssetV1`'s prefix: `key` (1 byte), `owner` (32), then `UpdateAuthority` — a Borsh enum whose
 * tag byte 2 is `Collection` followed by the collection's 32 bytes. 66 bytes is therefore
 * everything needed to decide whether a row is even a candidate, without the plugin area.
 */
const ASSET_PREFIX_BYTES = 66;
const UPDATE_AUTHORITY_OFFSET = 33;
const UPDATE_AUTHORITY_COLLECTION = 2;
/** `Edition`: Anchor's 8-byte discriminator then `creator`. The published scan memcmps on those. */
const EDITION_PREFIX_BYTES = 40;

const base64 = (bytes: Uint8Array) => getBase64Decoder().decode(bytes);
const addressBytes = (value: string) => new Uint8Array(getAddressEncoder().encode(address(value)));

function decode(row: Row, owner: string, maxChars: number) {
  address(row.pubkey);
  if (row.account.owner !== owner || row.account.executable !== false ||
      row.account.data?.[1] !== "base64" || typeof row.account.data[0] !== "string" ||
      row.account.data[0].length > maxChars)
    throw new Error("Invalid library account response.");
  return new Uint8Array(getBase64Encoder().encode(row.account.data[0]));
}

/** Raw code-unit order on the base58 address: deterministic on every engine, unlike locale order. */
const byAddress = (a: Row, b: Row) => (a.pubkey < b.pubkey ? -1 : a.pubkey > b.pubkey ? 1 : 0);

/**
 * @param knownCollections Collections the caller already verified a print in. They only choose a
 * `memcmp` filter for the rescue scan; every returned row is re-verified.
 */
export async function loadLibrary(
  endpoint: string, cluster: Cluster, wallet: string, mode: LibraryMode,
  signal?: AbortSignal, knownCollections?: readonly string[],
): Promise<LibraryResult> {
  address(wallet);
  const programs = TRUSTED[cluster];
  if (!programs.length) throw new Error("Chain is not available on this network in this build yet.");
  const check = () => { if (signal?.aborted) throw new Error("Library request cancelled."); };
  const scan = async (program: string, filters: unknown[], dataSlice: { offset: number; length: number }) => {
    check();
    // `dataSlice` limits the response to the prefix each mode reads; filters still match the
    // whole account.
    const rows = await request<Row[]>(endpoint, "getProgramAccounts", [program, {
      encoding: "base64", commitment: "confirmed", dataSlice, filters,
    }]);
    if (!Array.isArray(rows)) throw new Error("The wallet library response was incomplete. Please retry.");
    return rows;
  };
  // AssetV1's owner follows a 1-byte key; Edition's creator follows an 8-byte discriminator.
  // `AQ==` is byte 0x01 in base64; in base58 a one-character slip ("1" = 0x00) would match burned
  // print tombstones instead.
  const collectedScan = (extra: unknown[] = []) =>
    scan(MPL_CORE, [ASSET_V1_FILTER, { memcmp: { offset: 1, bytes: wallet } }, ...extra],
      { offset: 0, length: ASSET_PREFIX_BYTES });
  // `dataSize` is the pinned `Edition` length of that program's layout, which is also its only
  // layout version.
  const publishedScan = (program: string) =>
    scan(program, [{ dataSize: editionAccountBytes(program) }, { memcmp: { offset: 8, bytes: wallet } }],
      { offset: 0, length: EDITION_PREFIX_BYTES });

  const groups = mode === "collected"
    ? [await collectedScan()]
    : await Promise.all(programs.map(publishedScan));
  const discovered = new Map<string, Row>(groups.flat().map(row => [row.pubkey, row]));
  const rows = [...discovered.values()].sort(byAddress);

  const result: LibraryResult = { items: [], unavailable: 0, hiddenCount: 0 };
  const photos = new Map<string, Promise<LibraryPhoto["photo"]>>();
  const collections = new Map<string, Promise<string | null>>();
  /** Collections whose update authority IS a canonical Edition PDA. The rescue's last seed. */
  const verifiedCollections = new Set<string>();
  const resolveCollection = (key: string) => {
    if (!collections.has(key)) collections.set(key, (async () => {
      const raw = await account(endpoint, key);
      if (!raw || raw.owner !== MPL_CORE || raw.executable) throw new Error("Collection unavailable");
      const collection = decodeCollection(raw.bytes);
      const edition = await account(endpoint, collection.updateAuthority);
      if (!edition || edition.executable || !isTrustedDeployment(cluster, edition.owner)) return null;
      // Trusted ownership is not enough (Receipts qualify, and a collection's update authority is
      // minter-chosen): require the Edition length and discriminator, and that the address
      // re-derives from the creator and nonce the account carries.
      if (edition.bytes.length !== editionAccountBytes(edition.owner)) return null;
      const state = readEdition(edition.bytes, edition.owner);
      const derived = await addresses(edition.owner, state.creator, state.nonce);
      if (derived.edition !== collection.updateAuthority) return null;
      verifiedCollections.add(key);
      return collection.updateAuthority;
    })());
    return collections.get(key)!;
  };

  /** Resolve one candidate row into an item, or account for why it is not one. */
  const resolve = async (row: Row) => {
    try {
      let edition: string;
      let number: number | undefined;
      if (mode === "collected") {
        // The sliced prefix decides candidacy before any full account is fetched: a junk asset
        // whose update authority is not a Collection costs exactly one row of JSON and no RPC.
        const prefix = decode(row, MPL_CORE, 200);
        if (prefix.length < ASSET_PREFIX_BYTES || prefix[0] !== 1) return;
        if (getAddressDecoder().decode(prefix.slice(1, 33)) !== wallet) return;
        if (prefix[UPDATE_AUTHORITY_OFFSET] !== UPDATE_AUTHORITY_COLLECTION) return;
        const collectionKey = getAddressDecoder().decode(
          prefix.slice(UPDATE_AUTHORITY_OFFSET + 1, ASSET_PREFIX_BYTES));
        const candidate = await resolveCollection(collectionKey);
        if (!candidate) return;
        edition = candidate;
        check();
        const full = await account(endpoint, row.pubkey);
        if (!full || full.owner !== MPL_CORE || full.executable) throw new Error("Print unavailable");
        const asset = decodeAsset(full.bytes);
        // `resolveCollection` answered about the collection the PREFIX named; the whole account
        // has to still name it, and still be owned by this wallet.
        if (asset.owner !== wallet || asset.updateAuthority.kind !== "Collection" ||
            asset.updateAuthority.address !== collectionKey) return;
        number = asset.plugins.find(p => p.type === "Edition")?.number;
        if (number === undefined) throw new Error("Missing print number");
      } else {
        if (!isTrustedDeployment(cluster, row.account.owner)) throw new Error("Unreviewed publisher");
        check();
        const full = await account(endpoint, row.pubkey);
        if (!full || full.owner !== row.account.owner || full.executable)
          throw new Error("Edition unavailable");
        if (readEdition(full.bytes, full.owner).creator !== wallet) throw new Error("Wrong publisher");
        edition = row.pubkey;
      }
      check();
      if (!photos.has(edition)) photos.set(edition, loadTrustedEdition(endpoint, edition, cluster));
      const photo = await photos.get(edition)!;
      check();
      if (mode === "collected") {
        const state = await readPrintState(endpoint, photo.publication, number);
        if (state.status === "unavailable") throw new Error(state.reason);
        if (state.status !== "live" || state.asset.owner !== wallet) return;
        if (state.address !== row.pubkey) throw new Error("Noncanonical print");
      } else if (photo.edition.creator !== wallet) throw new Error("Wrong publisher");
      // Display exactly the bytes whose fingerprint passed verification, without refetching.
      result.items.push({ id: row.pubkey, photo, number, ...(mode === "collected" ? { owner: wallet } : {}),
        imageUri: `data:image/jpeg;base64,${getBase64Decoder().decode(photo.imageBytes)}` });
    } catch {
      check();
      result.unavailable++;
    }
  };

  const done = new Set<string>();
  /** Resolve a page of candidates with a bounded fan-out, newest cursor shared by three workers. */
  const page = async (queue: readonly Row[]) => {
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(3, queue.length) }, async () => {
      while (cursor < queue.length) {
        check();
        const row = queue[cursor++];
        if (done.has(row.pubkey)) continue;
        done.add(row.pubkey);
        await resolve(row);
      }
    }));
  };

  await page(rows.slice(0, MAX_CANDIDATES));
  const overflow = rows.slice(MAX_CANDIDATES);

  // --------------------------------------------------------------- the rescue scan
  // Only when the cap was actually reached, and only in "collected" mode: the published scan is
  // filtered by an Edition account's own `creator` field, which nobody but this wallet can write.
  if (overflow.length > 0 && mode === "collected") {
    // Seeds are added strongest first and capped as they go, so attacker-influenceable seeds
    // cannot displace the wallet's own collections.
    const targets: string[] = [];
    const seed = (collection: string) => {
      if (targets.length >= MAX_TARGETED_COLLECTIONS || targets.includes(collection)) return;
      targets.push(collection);
    };
    try {
      // 1. Every collection this wallet has published. An attacker cannot add to this set: the
      // filter is the Edition account's `creator`, and `era_editions` only ever writes the
      // signer there.
      for (const program of programs) {
        for (const row of await publishedScan(program)) {
          if (targets.length >= MAX_TARGETED_COLLECTIONS) break;
          const full = await account(endpoint, row.pubkey);
          if (!full || !isTrustedDeployment(cluster, full.owner) || full.executable) continue;
          const e = readEdition(full.bytes, full.owner);
          if (e.creator === wallet) seed(e.collection);
        }
      }
    } catch {
      // A failed rescue scan leaves the first page exactly as it was; it never fails the read.
    }
    // 2. Collections the caller already verified a print in; covers wallets that only collect.
    // An address here only chooses a filter; every returned row is re-verified.
    for (const collection of knownCollections ?? []) {
      if (targets.length >= MAX_TARGETED_COLLECTIONS) break;
      try {
        seed(address(collection));
      } catch {
        // A caller's stale or malformed record is skipped, never a failure of the read.
      }
    }
    // 3. Last, collections pass one resolved. Anyone can mint junk pointing at a real collection,
    // so these go after the two seeds an attacker cannot pad.
    for (const collection of verifiedCollections) seed(collection);
    const rescued: Row[] = [];
    for (const collection of targets.slice(0, MAX_TARGETED_COLLECTIONS)) {
      if (rescued.length >= MAX_CANDIDATES) break;
      try {
        const filter = {
          memcmp: {
            offset: UPDATE_AUTHORITY_OFFSET,
            bytes: base64(new Uint8Array([UPDATE_AUTHORITY_COLLECTION, ...addressBytes(collection)])),
            encoding: "base64",
          },
        };
        for (const row of await collectedScan([filter]))
          if (!done.has(row.pubkey)) rescued.push(row);
      } catch {
        // One unanswerable collection does not end the rescue.
      }
    }
    rescued.sort(byAddress);
    await page(rescued.slice(0, MAX_CANDIDATES));
  }
  // Exactly the candidates nothing looked at; rescued rows are not counted.
  result.hiddenCount = overflow.filter((row) => !done.has(row.pubkey)).length;

  check();
  result.items.sort((a, b) => a.photo.edition.title.localeCompare(b.photo.edition.title) ||
    a.photo.edition.edition.localeCompare(b.photo.edition.edition) || (a.number ?? 0) - (b.number ?? 0));
  return result;
}
