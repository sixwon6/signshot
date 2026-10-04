/**
 * Core Candy Guard's guard-set serialization (`mpl-core-candy-machine`,
 * `programs/candy-guard/program/src/state/candy_guard.rs` and the `GuardSet` derive in
 * `programs/candy-guard/macro/src/lib.rs`). Not Borsh: a guard set is a u64 feature bitmask
 * (bit = the guard's `GuardType` index) followed by each enabled guard's fixed-size Borsh body,
 * in `GuardSet` field order (which is also `GuardType` order). Guard data is the default set, a
 * u32 group count, then per group a 6-byte label (right-padded with NUL) and its set. The same
 * bytes travel as the `data: Vec<u8>` argument of `initialize`/`update` and sit in the account
 * after its 73-byte header. `load` refuses any length that does not match exactly.
 *
 * Only the guards this app sets are encodable; every guard is sized, so a decoder that meets a
 * guard it does not decode still walks the bytes correctly and names it in `other`. Groups are
 * decoded (so foreign data reads) but this app never uses them: `edition.ts` accepts only an
 * account whose bytes re-encode exactly from one of its own guard sets.
 */

import { getAddressDecoder, getAddressEncoder, type Address } from "@solana/kit";

/** `GuardType` order, with each guard's fixed `size()` in bytes. */
const GUARDS = [
  ["botTax", 9], ["solPayment", 40], ["tokenPayment", 72], ["startDate", 8],
  ["thirdPartySigner", 32], ["tokenGate", 40], ["gatekeeper", 33], ["endDate", 8],
  ["allowList", 32], ["mintLimit", 3], ["nftPayment", 64], ["redeemedAmount", 8],
  ["addressGate", 32], ["nftGate", 32], ["nftBurn", 32], ["tokenBurn", 40],
  ["freezeSolPayment", 40], ["freezeTokenPayment", 72], ["programGate", 164], ["allocation", 5],
  ["token2022Payment", 72], ["solFixedFee", 40], ["nftMintLimit", 35], ["edition", 4],
  ["assetPayment", 64], ["assetBurn", 32], ["assetMintLimit", 35], ["assetBurnMulti", 33],
  ["assetPaymentMulti", 65], ["assetGate", 32], ["vanityMint", 104],
] as const;

export type GuardName = (typeof GUARDS)[number][0];
export const MAX_LABEL = 6;

/** The guards this app uses, with their Borsh fields. */
export interface GuardSet {
  solPayment?: { lamports: bigint; destination: Address };
  tokenPayment?: { amount: bigint; mint: Address; destinationAta: Address };
  thirdPartySigner?: { signerKey: Address };
  mintLimit?: { id: number; limit: number };
  addressGate?: { address: Address };
  edition?: { editionStartOffset: number };
  /** Enabled guards this client does not decode, by name (decoder output only). */
  other?: GuardName[];
}
export interface Group { label: string; guards: GuardSet }
export interface GuardData { default: GuardSet; groups: Group[] }

const keyEncoder = getAddressEncoder();
const keyDecoder = getAddressDecoder();

class Writer {
  private readonly parts: number[] = [];
  private byte(n: number) { this.parts.push(n & 255); }
  u8(n: number) { if (!Number.isInteger(n) || n < 0 || n > 0xff) throw new Error("u8 out of range"); this.byte(n); }
  u16(n: number) { if (!Number.isInteger(n) || n < 0 || n > 0xffff) throw new Error("u16 out of range"); this.byte(n); this.byte(n >>> 8); }
  u32(n: number) { if (!Number.isInteger(n) || n < 0 || n > 0xffff_ffff) throw new Error("u32 out of range"); for (let i = 0; i < 4; i += 1) this.byte(n >>> (8 * i)); }
  u64(n: bigint) {
    if (typeof n !== "bigint" || n < 0n || n > 0xffff_ffff_ffff_ffffn) throw new Error("u64 out of range");
    for (let i = 0n; i < 8n; i += 1n) this.byte(Number((n >> (8n * i)) & 255n));
  }
  key(a: Address) { for (const b of keyEncoder.encode(a)) this.byte(b); }
  bytes(b: Uint8Array) { for (const x of b) this.byte(x); }
  done() { return new Uint8Array(this.parts); }
  get length() { return this.parts.length; }
}

export class Reader {
  at: number;
  private readonly view: DataView;
  constructor(readonly bytes: Uint8Array, start = 0) {
    this.at = start;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  private need(n: number) {
    if (this.at + n > this.bytes.length) throw new Error("Truncated candy account");
    const was = this.at;
    this.at += n;
    return was;
  }
  u8() { return this.bytes[this.need(1)]; }
  u16() { return this.view.getUint16(this.need(2), true); }
  u32() { return this.view.getUint32(this.need(4), true); }
  u64() { return this.view.getBigUint64(this.need(8), true); }
  key() { const was = this.need(32); return keyDecoder.decode(this.bytes.subarray(was, was + 32)); }
  raw(n: number) { const was = this.need(n); return this.bytes.subarray(was, was + n); }
  str() { return new TextDecoder().decode(this.raw(this.u32())); }
}

const bit = (name: GuardName) => GUARDS.findIndex(([n]) => n === name);

function encodeSet(w: Writer, set: GuardSet) {
  let features = 0n;
  const body = new Writer();
  // Field order is GuardType order; only these six are ever written.
  if (set.solPayment) { features |= 1n << BigInt(bit("solPayment")); body.u64(set.solPayment.lamports); body.key(set.solPayment.destination); }
  if (set.tokenPayment) {
    features |= 1n << BigInt(bit("tokenPayment"));
    body.u64(set.tokenPayment.amount); body.key(set.tokenPayment.mint); body.key(set.tokenPayment.destinationAta);
  }
  if (set.thirdPartySigner) { features |= 1n << BigInt(bit("thirdPartySigner")); body.key(set.thirdPartySigner.signerKey); }
  if (set.mintLimit) { features |= 1n << BigInt(bit("mintLimit")); body.u8(set.mintLimit.id); body.u16(set.mintLimit.limit); }
  if (set.addressGate) { features |= 1n << BigInt(bit("addressGate")); body.key(set.addressGate.address); }
  if (set.edition) { features |= 1n << BigInt(bit("edition")); body.u32(set.edition.editionStartOffset); }
  if (set.other?.length) throw new Error(`Not encodable here: ${set.other.join(", ")}`);
  w.u64(features);
  w.bytes(body.done());
}

/** The bytes `initialize`/`update` take as `data: Vec<u8>` (without the Vec length prefix). */
export function encodeGuardData(data: GuardData): Uint8Array {
  const w = new Writer();
  encodeSet(w, data.default);
  w.u32(data.groups.length);
  const labels = new Set<string>();
  for (const group of data.groups) {
    const label = new TextEncoder().encode(group.label);
    if (label.length === 0 || label.length > MAX_LABEL) throw new Error(`Group label must be 1-${MAX_LABEL} bytes`);
    if (labels.has(group.label)) throw new Error(`Duplicate group label ${group.label}`);
    labels.add(group.label);
    const padded = new Uint8Array(MAX_LABEL);
    padded.set(label);
    w.bytes(padded);
    encodeSet(w, group.guards);
  }
  return w.done();
}

function decodeSet(r: Reader): GuardSet {
  const features = r.u64();
  if (features >> BigInt(GUARDS.length) !== 0n) throw new Error(`Unknown guard bit in ${features.toString(2)}`);
  const set: GuardSet = {};
  GUARDS.forEach(([name, size], i) => {
    if (!((features >> BigInt(i)) & 1n)) return;
    const start = r.at;
    switch (name) {
      case "solPayment": set.solPayment = { lamports: r.u64(), destination: r.key() }; break;
      case "tokenPayment": set.tokenPayment = { amount: r.u64(), mint: r.key(), destinationAta: r.key() }; break;
      case "thirdPartySigner": set.thirdPartySigner = { signerKey: r.key() }; break;
      case "mintLimit": set.mintLimit = { id: r.u8(), limit: r.u16() }; break;
      case "addressGate": set.addressGate = { address: r.key() }; break;
      case "edition": set.edition = { editionStartOffset: r.u32() }; break;
      default: (set.other ??= []).push(name);
    }
    r.at = start + size;
  });
  return set;
}

/** Guard data from `bytes` (instruction data or the account after its header); exact length. */
export function decodeGuardData(bytes: Uint8Array, start = 0): GuardData {
  const r = new Reader(bytes, start);
  const data: GuardData = { default: decodeSet(r), groups: [] };
  const count = r.u32();
  for (let i = 0; i < count; i += 1) {
    const label = new TextDecoder().decode(r.raw(MAX_LABEL)).replace(/\0+$/, "");
    data.groups.push({ label, guards: decodeSet(r) });
  }
  if (r.at !== bytes.length) throw new Error(`Guard data is ${bytes.length - start} bytes; read ${r.at - start}`);
  return data;
}
