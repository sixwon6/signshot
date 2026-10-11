/**
 * Reading Signshot editions off the chain: the three accounts `readEdition` judges, the edition's
 * document and picture, its copies, and the scans behind the Wallet screen. Nothing here signs.
 * An edition `readEdition` does not accept is never shown as one.
 */

import { address, getAddressDecoder, getBase64Decoder, getBase64Encoder, getAddressEncoder, type Address } from "@solana/kit";
import {
  copyAnomalies,
  readCopy,
  readEdition,
  type AccountView,
  type CopyAnomaly,
  type CopyView,
  type Edition,
  type EditionVerdict,
  type Price,
} from "./candy/edition";
import {
  CANDY_GUARD_PROGRAM,
  CANDY_MACHINE_HIDDEN_BYTES,
  CANDY_MACHINE_PROGRAM,
  MPL_CORE,
  candyGuardAddress,
  decodeCandyMachine,
} from "./candy/programs";
import { arweaveBytes, request } from "./rpc";
import { readPhotoMetadata } from "./core/metadataDocument";
import { jpegDimensions, MAX_PRINT_EDGE } from "./core/document";
import { object } from "./core/attestation";
import type { Cluster, CoreMetadata } from "./types";

const b64 = getBase64Encoder();
const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

type RawAccount = { owner: string; lamports: number; data: [string, string]; executable: boolean } | null;

function view(key: string, raw: RawAccount): AccountView | null {
  if (!raw) return null;
  if (typeof raw.owner !== "string" || !Array.isArray(raw.data) || raw.data[1] !== "base64")
    throw new Error("Invalid account data");
  return { address: address(key), owner: address(raw.owner), lamports: BigInt(raw.lamports ?? 0), bytes: new Uint8Array(b64.encode(raw.data[0])) };
}

/** Up to 100 accounts in one read, in order; `null` for an absent one. */
export async function fetchAccounts(endpoint: string, keys: readonly string[]): Promise<(AccountView | null)[]> {
  if (!keys.length) return [];
  const { value } = await request<{ value: RawAccount[] }>(endpoint, "getMultipleAccounts",
    [keys, { encoding: "base64", commitment: "confirmed" }]);
  if (!Array.isArray(value) || value.length !== keys.length) throw new Error("Invalid Solana response");
  return value.map((raw, i) => view(keys[i], raw));
}

export const fetchAccount = async (endpoint: string, key: string) => (await fetchAccounts(endpoint, [key]))[0];

/** The candy machine's collection, or null when the account is not a hidden-settings candy machine. */
export function machineCollection(account: AccountView | null): Address | null {
  if (!account || account.owner !== CANDY_MACHINE_PROGRAM) return null;
  try {
    return decodeCandyMachine(account.bytes).collection;
  } catch {
    return null;
  }
}

/** `readEdition`'s verdict on the edition whose candy machine is `candyMachine`. */
export async function loadEdition(endpoint: string, candyMachine: string): Promise<EditionVerdict> {
  const machine = await fetchAccount(endpoint, address(candyMachine));
  if (!machine) return { ok: false, reason: "No such edition" };
  const collection = machineCollection(machine);
  if (!collection) return { ok: false, reason: "Not a Signshot edition" };
  const [candyGuard, collectionAccount] = await fetchAccounts(endpoint, [await candyGuardAddress(machine.address), collection]);
  return readEdition({ candyMachine: machine, candyGuard, collection: collectionAccount });
}

/** What every screen shows of an edition `readEdition` accepted, with its verified picture. */
export interface EditionDisplay {
  /** The app's view of the edition: `edition` is the candy machine, `creator` the publisher. */
  edition: CoreMetadata;
  chain: Edition;
  metadataId: string;
  minted: number;
  remaining: number;
  imageBytes: Uint8Array;
  /** The price of a copy (SOL or a token), or null when free. */
  offer: Price | null;
  seekerOnly: boolean;
  royaltyBps: number;
}

const ARWEAVE = /^https:\/\/arweave\.net\/([A-Za-z0-9_-]{43})$/;

/** The manifest nonce an attested document carries, which the attestation reader repeats. */
function manifestNonce(json: unknown): string {
  const nonce = object(object(object(object(json)?.properties)?.signshot)?.manifest)?.nonce;
  return typeof nonce === "string" ? nonce : "";
}

/** An accepted edition with its document and picture, both checked. */
export async function editionDisplay(cluster: Cluster, e: Edition): Promise<EditionDisplay> {
  const metadataId = ARWEAVE.exec(e.uri)?.[1];
  if (!metadataId) throw new Error("This edition's details are not on Arweave.");
  const text = new TextDecoder().decode(await arweaveBytes(metadataId));
  const json: unknown = JSON.parse(text);
  const imageHash = hex(e.imageSha256);
  const nonce = manifestNonce(json);
  const doc = readPhotoMetadata(json, {
    cluster, program: CANDY_MACHINE_PROGRAM, edition: e.candyMachine, collection: e.collection,
    creator: e.publisher, nonce, title: e.title, supply: e.supply, imageHash,
  }, text);
  const imageBytes = await arweaveBytes(doc.image.split("/").pop()!, imageHash);
  const { width, height } = jpegDimensions(imageBytes);
  if (width > MAX_PRINT_EDGE || height > MAX_PRINT_EDGE) throw new Error("Published photo is larger than Signshot accepts");
  if (doc.dimensions && (doc.dimensions.width !== width || doc.dimensions.height !== height))
    throw new Error("Photo dimensions do not match the published image");
  return {
    edition: {
      cluster, program: CANDY_MACHINE_PROGRAM, edition: e.candyMachine, collection: e.collection,
      creator: e.publisher, nonce, title: e.title, supply: e.supply, image: doc.image, imageHash,
      width, height, description: doc.description,
      ...(doc.attestation ? { attestation: doc.attestation } : {}),
      ...(doc.attestationProblem ? { attestationProblem: doc.attestationProblem } : {}),
      ...(doc.genesisMint ? { genesisMint: doc.genesisMint } : {}),
    },
    chain: e,
    metadataId,
    minted: e.minted,
    remaining: e.supply - e.minted,
    imageBytes,
    offer: e.price.kind === "free" ? null : e.price,
    seekerOnly: e.cosigner !== null,
    royaltyBps: e.royaltyBasisPoints,
  };
}

// ---------------------------------------------------------------------------------------------
// Copies
// ---------------------------------------------------------------------------------------------

type Row = { pubkey: string; account: { owner: string; data: [string, string] } };

const ASSET_V1 = { memcmp: { offset: 0, bytes: "AQ==", encoding: "base64" } };
const inCollection = (collection: string) => ({
  memcmp: {
    offset: 33,
    bytes: getBase64Decoder().decode(new Uint8Array([2, ...getAddressEncoder().encode(address(collection))])),
    encoding: "base64",
  },
});
const ownedBy = (wallet: string) => ({ memcmp: { offset: 1, bytes: wallet } });

async function scan(endpoint: string, program: string, filters: unknown[], dataSlice?: { offset: number; length: number }) {
  const rows = await request<Row[]>(endpoint, "getProgramAccounts",
    [program, { encoding: "base64", commitment: "confirmed", filters, ...(dataSlice ? { dataSlice } : {}) }]);
  if (!Array.isArray(rows)) throw new Error("Invalid Solana response");
  return rows;
}

export interface HeldCopy extends CopyView { owner: Address }

function copyOfRow(row: Row, collection: Address): HeldCopy | null {
  const account = view(row.pubkey, { ...row.account, lamports: 0, executable: false });
  if (!account) return null;
  const copy = readCopy(account, collection);
  return copy ? { ...copy, owner: getAddressDecoder().decode(account.bytes.subarray(1, 33)) } : null;
}

/** Every copy of `collection` on chain. */
export async function editionCopies(endpoint: string, collection: Address): Promise<HeldCopy[]> {
  const rows = await scan(endpoint, MPL_CORE, [ASSET_V1, inCollection(collection)]);
  return rows.map((row) => copyOfRow(row, collection)).filter((c): c is HeldCopy => c !== null);
}

/** The copies of `collection` that `wallet` holds. */
export async function copiesHeld(endpoint: string, collection: Address, wallet: string): Promise<HeldCopy[]> {
  const rows = await scan(endpoint, MPL_CORE, [ASSET_V1, ownedBy(wallet), inCollection(collection)]);
  return rows.map((row) => copyOfRow(row, collection)).filter((c): c is HeldCopy => c !== null && c.owner === wallet);
}

/** One copy by address, or null when it is not a copy of `collection` (burned, absent, other). */
export async function readHeldCopy(endpoint: string, asset: string, collection: Address): Promise<HeldCopy | null> {
  const account = await fetchAccount(endpoint, asset);
  if (!account) return null;
  const copy = readCopy(account, collection);
  return copy ? { ...copy, owner: getAddressDecoder().decode(account.bytes.subarray(1, 33)) } : null;
}

/** `copyAnomalies` over the edition's copies; one line for a screen, or null when consistent. */
export async function copiesLine(endpoint: string, e: Edition): Promise<string | null> {
  const anomalies: CopyAnomaly[] = copyAnomalies({ title: e.title, minted: e.minted }, await editionCopies(endpoint, e.collection));
  if (!anomalies.length) return null;
  const duplicate = anomalies.some((a) => a.kind === "duplicate-number");
  return duplicate
    ? "Two copies of this edition carry the same number."
    : `The copies on chain do not match this edition's count (${anomalies.length} ${anomalies.length === 1 ? "issue" : "issues"}).`;
}

// ---------------------------------------------------------------------------------------------
// The Wallet screen's scans
// ---------------------------------------------------------------------------------------------

/** The candy machines whose guard `wallet` holds: the editions it published. */
export async function publishedBy(endpoint: string, wallet: string): Promise<Address[]> {
  // CandyGuard: discriminator 8, base 32, bump 1, authority 32.
  const rows = await scan(endpoint, CANDY_GUARD_PROGRAM, [{ memcmp: { offset: 41, bytes: address(wallet) } }], { offset: 8, length: 32 });
  return rows.map((row) => getAddressDecoder().decode(b64.encode(row.account.data[0]))).filter(Boolean);
}

/** The candy machine minting into `collection`, if exactly one hidden-settings machine does. */
export async function machineOf(endpoint: string, collection: Address): Promise<Address | null> {
  const rows = await scan(endpoint, CANDY_MACHINE_PROGRAM,
    [{ dataSize: CANDY_MACHINE_HIDDEN_BYTES }, { memcmp: { offset: 72, bytes: collection } }], { offset: 0, length: 0 });
  return rows.length === 1 ? address(rows[0].pubkey) : null;
}

/** Collections of the Core assets `wallet` holds, with those assets. */
export async function heldCollections(endpoint: string, wallet: string): Promise<Map<Address, Address[]>> {
  const rows = await scan(endpoint, MPL_CORE, [ASSET_V1, ownedBy(address(wallet))], { offset: 0, length: 66 });
  const out = new Map<Address, Address[]>();
  for (const row of rows) {
    try {
      const prefix = new Uint8Array(b64.encode(row.account.data[0]));
      if (prefix.length < 66 || prefix[0] !== 1 || prefix[33] !== 2) continue;
      const collection = getAddressDecoder().decode(prefix.subarray(34, 66));
      out.set(collection, [...(out.get(collection) ?? []), address(row.pubkey)]);
    } catch {
      // Not a Core asset in a collection.
    }
  }
  return out;
}
