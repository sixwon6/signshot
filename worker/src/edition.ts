/**
 * The edition on its cluster, accepted by the app's own rule (`readEdition` in
 * publications/candy/edition.ts, reproduced here, not imported): the candy machine, its guard and
 * its collection must be exactly what the app's publishing leaves, and the guard must re-encode
 * byte for byte from the app's Seeker-only set with THIS key as its Third Party Signer. The
 * Worker never co-signs for an edition the app would not show as a normal edition, so its
 * signature cannot be borrowed for a guard that does not ask for it.
 *
 * Layouts (mpl-core-candy-machine, mpl-core):
 *   candy machine  discriminator, authority, mint_authority, collection, items_redeemed u64,
 *                  items_available u64, max_supply u64, is_mutable u8, config_line_settings
 *                  Option (None), hidden_settings Option (Some: name, uri, hash[32]), zeros to
 *                  exactly `CANDY_MACHINE_HIDDEN_BYTES`
 *   candy guard    discriminator, base, bump, authority (73 bytes), then the guard data: u64
 *                  feature mask (bit = `GuardType` index), each enabled guard's body in bit
 *                  order, u32 group count
 *   collection     Core `CollectionV1` (key 5, update authority, name, uri, num_minted u32,
 *                  current_size u32), `PluginHeaderV1` (key 3, registry offset u64), the plugins,
 *                  `PluginRegistryV1` (key 4, records, external records) ending the account
 */

import { getAddressDecoder, getAddressEncoder, getBase64Encoder, type Address } from "@solana/kit";
import {
  CANDY_GUARD_PROGRAM, CANDY_MACHINE_PROGRAM, MPL_CORE, Refused, associatedTokenOf, candyMachineAuthorityOf, type ClaimTransaction,
} from "./claimTransaction";
import { object, rpc, RpcError, type Fetch } from "./rpc";

/** sha256("account:CandyMachine")[..8] and sha256("account:CandyGuard")[..8]. */
export const CANDY_MACHINE_DISCRIMINATOR = [51, 173, 177, 113, 25, 241, 109, 189];
export const CANDY_GUARD_DISCRIMINATOR = [44, 207, 199, 184, 112, 103, 34, 181];
export const CANDY_GUARD_HEADER = 8 + 32 + 1 + 32;
/** `CANDY_MACHINE_HIDDEN_BYTES` in publications/candy/programs.ts: 652. */
export const CANDY_MACHINE_HIDDEN_BYTES = 8 + 32 + 32 + 32 + 8 + 8 + 8 + 1 + 1 + (4 + 32) + 4 + (4 + 200) + 4 + 1 + 1 +
  (4 + 32) + (4 + 200) + 32;
/**
 * The app's `NO_AUTHORITY`: the System Program's derived address for ["signshot", "no authority"],
 * which nobody can sign for. Both the candy machine's authority and the collection's update
 * authority are handed to it at publish.
 */
export const NO_AUTHORITY = "864BTg5dsR5DtBxPHm8uiU9GnRWL5V94AneqsnLRxgg8";
const NAME_SUFFIX = " #$ID+1$";
/** The app's limits (publications/candy/edition.ts, programs.ts). */
const MAX_SUPPLY = 1000;
const MAX_TITLE_BYTES = 24;
const MAX_URI_BYTES = 200;
/** Core account keys and plugin types. */
const COLLECTION_V1 = 5;
const PLUGIN_HEADER_V1 = 3;
const PLUGIN_REGISTRY_V1 = 4;
export const PLUGIN = { royalties: 0, updateDelegate: 4, masterEdition: 10 } as const;

const BIT = { solPayment: 1, tokenPayment: 2, thirdPartySigner: 4, edition: 23 } as const;

export type EditionPrice =
  | { kind: "free" }
  | { kind: "sol"; lamports: bigint; destination: string }
  | { kind: "token"; mint: string; amount: bigint; destinationAta: string };

export interface EditionTerms { collection: string; publisher: string; price: EditionPrice }

const not = (): never => { throw new Refused("not-signshot-edition"); };
const utf8Length = (s: string) => new TextEncoder().encode(s).length;
const keyDecoder = getAddressDecoder();
const keyBytes = (a: string) => new Uint8Array(getAddressEncoder().encode(a as Address));
const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};
const u32 = (n: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; };
const u64 = (n: bigint) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, n, true); return b; };

class Reader {
  private readonly view: DataView;
  constructor(readonly bytes: Uint8Array, public at: number) { this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); }
  need(n: number) { if (n < 0 || this.at + n > this.bytes.length) not(); const was = this.at; this.at += n; return was; }
  u8() { return this.bytes[this.need(1)]; }
  u32() { return this.view.getUint32(this.need(4), true); }
  u64() { return this.view.getBigUint64(this.need(8), true); }
  key() { const at = this.need(32); return keyDecoder.decode(this.bytes.subarray(at, at + 32)); }
  str() {
    const n = this.u32();
    const at = this.need(n);
    try {
      return new TextDecoder("utf-8", { fatal: true } as never).decode(this.bytes.subarray(at, at + n));
    } catch {
      return not();
    }
  }
}

/** Every key and plugin record of a Core `CollectionV1`, read to its last byte. */
function readCollection(bytes: Uint8Array) {
  const r = new Reader(bytes, 0);
  if (r.u8() !== COLLECTION_V1) not();
  const updateAuthority = r.key();
  const name = r.str(), uri = r.str();
  const numMinted = r.u32();
  r.u32(); // current_size
  if (r.u8() !== PLUGIN_HEADER_V1) not();
  const registry = r.u64();
  if (registry > BigInt(bytes.length)) not();
  r.at = Number(registry);
  if (r.u8() !== PLUGIN_REGISTRY_V1) not();
  const count = r.u32();
  if (count > 16) not();
  const records: { type: number; authority: string; offset: number }[] = [];
  for (let i = 0; i < count; i += 1) {
    const type = r.u8();
    const tag = r.u8();
    const authority = tag === 0 ? "None" : tag === 1 ? "Owner" : tag === 2 ? "UpdateAuthority" : tag === 3 ? r.key() : not();
    const offset = r.u64();
    if (offset > BigInt(bytes.length)) not();
    records.push({ type, authority, offset: Number(offset) });
  }
  const external = r.u32();
  if (r.at !== bytes.length) not();
  return { updateAuthority, name, uri, numMinted, records, external };
}

/** `editionGuards(publisher, price, cosigner)` for a Seeker-only edition, as `encodeGuardData` writes it. */
export async function seekerOnlyGuardData(publisher: string, price: EditionPrice, cosigner: string): Promise<Uint8Array> {
  let features = (1n << BigInt(BIT.thirdPartySigner)) | (1n << BigInt(BIT.edition));
  const body: Uint8Array[] = [];
  if (price.kind === "sol") { features |= 1n << BigInt(BIT.solPayment); body.push(u64(price.lamports), keyBytes(publisher)); }
  if (price.kind === "token") {
    features |= 1n << BigInt(BIT.tokenPayment);
    body.push(u64(price.amount), keyBytes(price.mint), keyBytes(await associatedTokenOf(publisher, price.mint)));
  }
  body.push(keyBytes(cosigner), u32(0)); // Third Party Signer; Edition (edition_start_offset 0)
  return concat(u64(features), ...body, u32(0)); // no groups
}

type View = { owner: string; data: Uint8Array } | null;

/**
 * The edition's terms, or a `Refused`: `not-signshot-edition` for anything `readEdition` refuses,
 * `not-cosigned-edition` for an edition whose claims this key does not gate, `sold-out`.
 */
export async function acceptEdition(edition: string, candyGuard: string, collectionNamed: string,
  accounts: { machine: View; guard: View; collection: View },
  cosigner: string): Promise<EditionTerms> {
  const { machine, guard, collection } = accounts;
  if (!machine || !guard || !collection) not();
  if (machine!.owner !== CANDY_MACHINE_PROGRAM || guard!.owner !== CANDY_GUARD_PROGRAM || collection!.owner !== MPL_CORE) not();

  // The candy machine: 652 bytes, locked, hidden settings "<title> #$ID+1$", zeros after its data.
  const m = machine!.data;
  if (m.length !== CANDY_MACHINE_HIDDEN_BYTES || CANDY_MACHINE_DISCRIMINATOR.some((b, i) => m[i] !== b)) not();
  const r = new Reader(m, 8);
  const authority = r.key(), mintAuthority = r.key(), collectionAddress = r.key();
  // The collection the claim names must be the candy machine's own (the account read below).
  if (collectionAddress !== collectionNamed) throw new Refused("wrong-collection");
  const redeemed = r.u64(), available = r.u64(), maxSupply = r.u64(), mutable = r.u8();
  if (r.u8() !== 0 || r.u8() !== 1) not(); // no config lines; hidden settings
  const name = r.str(), uri = r.str();
  r.need(32); // the image hash
  if (m.subarray(r.at).some((b) => b !== 0)) not();
  if (authority !== NO_AUTHORITY || mintAuthority !== candyGuard || maxSupply !== 0n || mutable !== 1) not();
  if (available < 1n || available > BigInt(MAX_SUPPLY) || redeemed > available) not();
  if (!name.endsWith(NAME_SUFFIX)) not();
  const title = name.slice(0, -NAME_SUFFIX.length);
  if (utf8Length(title) < 1 || utf8Length(title) > MAX_TITLE_BYTES || title.includes("$ID")) not();
  if (utf8Length(uri) < 1 || utf8Length(uri) > MAX_URI_BYTES) not();

  // The guard: its PDA of the candy machine, based on it, its data exactly the app's Seeker-only set.
  const g = guard!.data;
  if (g.length < CANDY_GUARD_HEADER || CANDY_GUARD_DISCRIMINATOR.some((b, i) => g[i] !== b)) not();
  const gr = new Reader(g, 8);
  if (gr.key() !== edition) not();
  gr.u8();
  const publisher = gr.key();
  const features = gr.u64();
  const known = (1n << BigInt(BIT.solPayment)) | (1n << BigInt(BIT.tokenPayment)) | (1n << BigInt(BIT.thirdPartySigner)) | (1n << BigInt(BIT.edition));
  const both = (1n << BigInt(BIT.solPayment)) | (1n << BigInt(BIT.tokenPayment));
  if ((features & ~known) !== 0n || (features & both) === both) not();
  if (!((features >> BigInt(BIT.thirdPartySigner)) & 1n)) throw new Refused("not-cosigned-edition");
  let price: EditionPrice = { kind: "free" };
  if ((features >> BigInt(BIT.solPayment)) & 1n) price = { kind: "sol", lamports: gr.u64(), destination: gr.key() };
  else if ((features >> BigInt(BIT.tokenPayment)) & 1n) {
    const amount = gr.u64(), mint = gr.key(), destinationAta = gr.key();
    price = { kind: "token", mint, amount, destinationAta };
  }
  // The set the guard would hold for this price under this key; anything else (another key, a
  // foreign destination, a group) differs somewhere.
  if (!sameBytes(g.subarray(CANDY_GUARD_HEADER), await seekerOnlyGuardData(publisher, price, cosigner))) {
    const tpsAt = CANDY_GUARD_HEADER + 8 + (price.kind === "sol" ? 40 : price.kind === "token" ? 72 : 0);
    const tps = g.length >= tpsAt + 32 ? keyDecoder.decode(g.subarray(tpsAt, tpsAt + 32)) : null;
    throw new Refused(tps !== cosigner ? "not-cosigned-edition" : "not-signshot-edition");
  }

  // The collection: locked, named and pointed as the candy machine, no copy minted around it,
  // exactly the three plugins publishing leaves.
  const cd = collection!.data;
  const c = readCollection(cd);
  if (c.updateAuthority !== NO_AUTHORITY || c.name !== title || c.uri !== uri || BigInt(c.numMinted) !== redeemed || c.external !== 0) not();
  if (c.records.length !== 3 || new Set(c.records.map((x) => x.type)).size !== 3) not();
  const royalty = c.records.find((x) => x.type === PLUGIN.royalties);
  if (!royalty) not();
  const bps = cd[royalty!.offset + 1] | (cd[royalty!.offset + 2] << 8);
  if (bps > 10_000) not();
  const plugins: Record<number, { authority: string; bytes: Uint8Array }> = {
    [PLUGIN.masterEdition]: { authority: "None", bytes: concat(new Uint8Array([PLUGIN.masterEdition, 1]), u32(Number(available)), new Uint8Array([0, 0])) },
    [PLUGIN.royalties]: { authority: "None", bytes: concat(new Uint8Array([PLUGIN.royalties, bps & 255, bps >> 8]), u32(1), keyBytes(publisher), new Uint8Array([100, 0])) },
    [PLUGIN.updateDelegate]: { authority: "UpdateAuthority", bytes: concat(new Uint8Array([PLUGIN.updateDelegate]), u32(1), keyBytes(await candyMachineAuthorityOf(edition))) },
  };
  for (const record of c.records) {
    const want = plugins[record.type];
    if (!want || record.authority !== want.authority || !sameBytes(cd.subarray(record.offset, record.offset + want.bytes.length), want.bytes)) not();
  }

  if (redeemed >= available) throw new Refused("sold-out");
  return { collection: collectionAddress, publisher, price };
}

/** The three accounts from the edition's cluster in one read (one slot), then `acceptEdition`. */
export async function readEdition(fetchImpl: Fetch, url: string, edition: string, tx: ClaimTransaction, cosigner: string): Promise<EditionTerms> {
  const keys = [edition, tx.candyGuard, tx.collection];
  const result = object(await rpc<unknown>(fetchImpl, url, "getMultipleAccounts", [keys, { encoding: "base64", commitment: "confirmed" }]));
  const accounts = result?.value;
  if (!Array.isArray(accounts) || accounts.length !== 3) throw new RpcError("getMultipleAccounts");
  const [machine, guard, collection] = accounts.map((entry): View => {
    if (entry === null) return null;
    const info = object(entry);
    const data = info?.data;
    if (!info || typeof info.owner !== "string" || !Array.isArray(data) || data[1] !== "base64" || typeof data[0] !== "string")
      throw new RpcError("getMultipleAccounts");
    return { owner: info.owner, data: new Uint8Array(getBase64Encoder().encode(data[0])) };
  });
  return acceptEdition(edition, tx.candyGuard, tx.collection, { machine, guard, collection }, cosigner);
}

/** The claim against the edition's terms: its price kind and payment accounts. */
export function checkAgainstEdition(tx: ClaimTransaction, terms: EditionTerms): void {
  const p = tx.payment, price = terms.price;
  if (p.kind !== price.kind) throw new Refused("wrong-payment");
  if (p.kind === "sol" && price.kind === "sol" && p.destination !== price.destination) throw new Refused("wrong-payment");
  if (p.kind === "token" && price.kind === "token" &&
      (p.mint !== price.mint || p.amount !== price.amount || p.destinationAta !== price.destinationAta))
    throw new Refused("wrong-payment");
}
