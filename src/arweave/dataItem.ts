import { sha256, sha384 } from "@noble/hashes/sha2.js";

import { base64UrlEncode, concatBytes, utf8 } from "./codec";

/**
 * ANS-104 data items, ed25519-signed, byte-identical to `@dha-team/arbundles`. Synchronous so the id
 * can be computed inside a wallet session.
 * Spec: https://github.com/ArweaveTeam/arweave-standards/blob/master/ans/ANS-104.md
 */

/** ANS-104 signature type 2. */
const SIGNATURE_TYPE_ED25519 = 2;
export const SIGNATURE_LENGTH = 64;
export const OWNER_LENGTH = 32;

/** sigType + signature + owner + target flag + anchor flag + tag count + tag byte length. */
const DATA_ITEM_OVERHEAD = 2 + SIGNATURE_LENGTH + OWNER_LENGTH + 1 + 1 + 8 + 8;

/** Below `TURBO_FREE_ITEM_BYTES`, so oversize fails before the wallet is involved, not as a 402. */
const MAX_DATA_ITEM_BYTES = 100 * 1024;

/** arbundles' `MAX_TAG_BYTES`; its writer overruns its buffer past this. */
const MAX_TAG_BYTES = 4096;

interface DataItemTag {
  name: string;
  value: string;
}

/** Keeps secret bytes out of this file. */
export interface DataItemSigner {
  /** 32-byte ed25519 public key; the item's `owner`. */
  publicKey: Uint8Array;
  /** Detached 64-byte ed25519 signature. */
  sign(message: Uint8Array): Uint8Array;
}

interface BuiltDataItem {
  /** `POST /tx` body. */
  bytes: Uint8Array;
  /** 43-char base64url, known before upload. */
  id: string;
  signature: Uint8Array;
  owner: Uint8Array;
}

type DeepHashChunk = Uint8Array | DeepHashChunk[];

/** Arweave deep hash (SHA-384), arbundles `deepHash.ts`. */
function deepHash(data: DeepHashChunk): Uint8Array {
  if (Array.isArray(data)) {
    let acc: Uint8Array = sha384(utf8(`list${data.length}`));
    for (const chunk of data) {
      acc = sha384(concatBytes(acc, deepHash(chunk)));
    }
    return acc;
  }
  return sha384(concatBytes(sha384(utf8(`blob${data.byteLength}`)), sha384(data)));
}

/** Avro zigzag varint (arbundles `tags.ts`), non-negative only. */
function writeLong(out: number[], n: number): void {
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new Error(`dataItem: a tag varint must be a non-negative integer, got ${String(n)}`);
  }
  let f = n * 2; // zigzag of a non-negative integer
  for (;;) {
    const byte = f % 128;
    f = Math.floor(f / 128);
    if (f === 0) {
      out.push(byte);
      return;
    }
    out.push(byte | 0x80);
  }
}

function writeString(out: number[], s: string): void {
  const bytes = utf8(s);
  writeLong(out, bytes.length);
  for (let i = 0; i < bytes.length; i += 1) out.push(bytes[i] as number);
}

/**
 * Avro tag block, as arbundles `serializeTags`. No tags must be zero bytes with no terminator; a
 * lone `0x00` would change the id.
 */
function encodeTags(tags: DataItemTag[]): Uint8Array {
  if (tags.length === 0) return new Uint8Array(0);

  const out: number[] = [];
  writeLong(out, tags.length);
  for (const tag of tags) {
    if (typeof tag.name !== "string" || typeof tag.value !== "string") {
      throw new Error("dataItem: every tag needs a string name and a string value");
    }
    if (tag.name.length === 0) throw new Error("dataItem: a tag name may not be empty");
    writeString(out, tag.name);
    writeString(out, tag.value);
  }
  writeLong(out, 0); // terminator block

  if (out.length > MAX_TAG_BYTES) {
    throw new Error(
      `dataItem: tags serialize to ${out.length} bytes, over the ANS-104 limit of ${MAX_TAG_BYTES}`,
    );
  }
  return Uint8Array.from(out);
}

/** Unsigned little-endian, as arbundles `longToNByteArray`. */
function toLeBytes(value: number, length: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`dataItem: ${String(value)} is not a non-negative integer`);
  }
  const out = new Uint8Array(length);
  let rest = value;
  for (let i = 0; i < length; i += 1) {
    const byte = rest % 256;
    out[i] = byte;
    rest = (rest - byte) / 256;
  }
  if (rest !== 0) throw new Error(`dataItem: ${String(value)} does not fit in ${length} bytes`);
  return out;
}

/** arbundles `getSignatureData`. Errors here are invisible locally; only the bundler rejects them. */
function dataItemSignatureData(
  owner: Uint8Array,
  tagsBytes: Uint8Array,
  data: Uint8Array,
): Uint8Array {
  return deepHash([
    utf8("dataitem"),
    utf8("1"),
    utf8(String(SIGNATURE_TYPE_ED25519)),
    owner,
    new Uint8Array(0), // no target: an empty chunk, not a zero byte
    new Uint8Array(0), // no anchor
    tagsBytes,
    data,
  ]);
}

/** `base64url(sha256(signature))`, unpadded. */
function dataItemId(signature: Uint8Array): string {
  if (signature.length !== SIGNATURE_LENGTH) {
    throw new Error(`dataItem: a signature is ${SIGNATURE_LENGTH} bytes, got ${signature.length}`);
  }
  return base64UrlEncode(sha256(signature));
}

export function serializedDataItemId(bytes: Uint8Array): string {
  if (bytes.length < DATA_ITEM_OVERHEAD || bytes[0] !== SIGNATURE_TYPE_ED25519 || bytes[1] !== 0) {
    throw new Error("dataItem: not a serialized ed25519 data item");
  }
  return dataItemId(bytes.subarray(2, 2 + SIGNATURE_LENGTH));
}

/**
 * No target or anchor, so the id depends only on data, tags and key: rebuilding after a crash
 * reproduces an id already referenced on chain.
 */
export function buildDataItem(args: {
  data: Uint8Array;
  tags: DataItemTag[];
  signer: DataItemSigner;
}): BuiltDataItem {
  const { data, tags, signer } = args;

  const owner = signer.publicKey;
  if (owner.length !== OWNER_LENGTH) {
    throw new Error(`dataItem: owner must be ${OWNER_LENGTH} bytes, got ${owner.length}`);
  }

  const tagsBytes = encodeTags(tags);
  const total = DATA_ITEM_OVERHEAD + tagsBytes.length + data.length;
  if (total >= MAX_DATA_ITEM_BYTES) {
    throw new Error(
      `dataItem: ${total} bytes is at or over the ${MAX_DATA_ITEM_BYTES}-byte free-tier limit ` +
        `(${data.length} of data, ${DATA_ITEM_OVERHEAD + tagsBytes.length} of header and tags).`,
    );
  }

  const signature = signer.sign(dataItemSignatureData(owner, tagsBytes, data));
  if (signature.length !== SIGNATURE_LENGTH) {
    throw new Error(
      `dataItem: the signer returned ${signature.length} bytes, expected ${SIGNATURE_LENGTH}`,
    );
  }

  const bytes = new Uint8Array(total);
  let at = 0;
  bytes.set(toLeBytes(SIGNATURE_TYPE_ED25519, 2), at);
  at += 2;
  bytes.set(signature, at);
  at += SIGNATURE_LENGTH;
  bytes.set(owner, at);
  at += OWNER_LENGTH;
  bytes[at] = 0; // no target
  at += 1;
  bytes[at] = 0; // no anchor
  at += 1;
  bytes.set(toLeBytes(tags.length, 8), at);
  at += 8;
  bytes.set(toLeBytes(tagsBytes.length, 8), at);
  at += 8;
  bytes.set(tagsBytes, at);
  at += tagsBytes.length;
  bytes.set(data, at);

  return { bytes, id: dataItemId(signature), signature, owner };
}
