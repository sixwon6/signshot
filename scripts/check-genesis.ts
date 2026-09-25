/**
 * Self-test for `seedshot-genesis/1` (`publications/core/genesisToken.ts`). Runs in `npm test`,
 * needs no network.
 *
 *   - the hand-written Token-2022 mint decoder, held to the OFFICIAL `@solana-program/token-2022`
 *     encoder: a mint with Solana Mobile's three properties is an SGT, and a mint missing any one
 *     of them is not;
 *   - the document: what `metadata()` writes reads back through `readPhotoMetadata`, alone and
 *     beside an attestation, and every malformed claim is refused;
 *   - `verifyGenesisToken` against a stubbed mainnet: held, moved, not an SGT, and an RPC failure
 *     that must throw rather than read as "not held".
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { AccountRole, address, getAddressEncoder, none, some, type Address } from "@solana/kit";
import { extension, getMintEncoder, getTokenEncoder, AccountState, type ExtensionArgs } from "@solana-program/token-2022";
import { canonicalize, type JcsValue } from "../src/jcs";
import {
  GENESIS_SCHEMA,
  SGT_GROUP_ADDRESS,
  SGT_METADATA_ADDRESS,
  SGT_MINT_AUTHORITY,
  genesisAttributes,
  isSeekerGenesisMint,
  readGenesisClaim,
  verifyGenesisToken,
} from "../publications/core/genesisToken";
import type { AttestationBundle } from "../publications/core/attestation";
import { readPhotoMetadata, readSavedPhotoMetadata } from "../publications/core/metadataDocument";
import {
  GENESIS_ATTRIBUTE,
  addresses,
  instruction,
  metadata,
  sealedGenesisMint,
  verifyEditionCollection,
} from "../publications/core/protocol";
import type { CoreMetadata } from "../publications/types";

const here = dirname(fileURLToPath(import.meta.url));

let failures = 0;
function ok(name: string, condition: boolean) {
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}`);
  if (!condition) failures += 1;
}
const throws = (fn: () => unknown) => { try { fn(); return false; } catch { return true; } };

// --- The mint decoder, against the official encoder ----------------------------------------------
const AUTHORITY = address(SGT_MINT_AUTHORITY);
const GROUP = address(SGT_GROUP_ADDRESS);
const MINT = address("So11111111111111111111111111111111111111112");
const OTHER = address("CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d");

const pointer = (authority: Address, metadataAddress: Address) =>
  extension("MetadataPointer", { authority: some(authority), metadataAddress: some(metadataAddress) });
const member = (group: Address) => extension("TokenGroupMember", { mint: MINT, group, memberNumber: 7n });
const closeAuthority = extension("MintCloseAuthority", { closeAuthority: OTHER });
const mintBytes = (mintAuthority: Address | null, extensions: ExtensionArgs[] | null) =>
  new Uint8Array(getMintEncoder().encode({
    mintAuthority: mintAuthority ? some(mintAuthority) : none(),
    supply: 1n,
    decimals: 0,
    isInitialized: true,
    freezeAuthority: some(AUTHORITY),
    extensions: extensions ? some(extensions) : none(),
  }));

const genuine = mintBytes(AUTHORITY, [pointer(AUTHORITY, address(SGT_METADATA_ADDRESS)), member(GROUP)]);
ok("a mint with all three properties is a Seeker Genesis Token", isSeekerGenesisMint(genuine));
ok("other extensions before, between and after are skipped", isSeekerGenesisMint(
  mintBytes(AUTHORITY, [closeAuthority, pointer(AUTHORITY, address(SGT_METADATA_ADDRESS)), closeAuthority, member(GROUP), closeAuthority])));
ok("a different mint authority is refused", !isSeekerGenesisMint(
  mintBytes(OTHER, [pointer(AUTHORITY, address(SGT_METADATA_ADDRESS)), member(GROUP)])));
ok("no mint authority is refused", !isSeekerGenesisMint(
  mintBytes(null, [pointer(AUTHORITY, address(SGT_METADATA_ADDRESS)), member(GROUP)])));
ok("a different metadata-pointer authority is refused", !isSeekerGenesisMint(
  mintBytes(AUTHORITY, [pointer(OTHER, address(SGT_METADATA_ADDRESS)), member(GROUP)])));
ok("a different metadata address is refused", !isSeekerGenesisMint(
  mintBytes(AUTHORITY, [pointer(AUTHORITY, OTHER), member(GROUP)])));
ok("a different group is refused", !isSeekerGenesisMint(
  mintBytes(AUTHORITY, [pointer(AUTHORITY, address(SGT_METADATA_ADDRESS)), member(OTHER)])));
ok("a missing group membership is refused", !isSeekerGenesisMint(
  mintBytes(AUTHORITY, [pointer(AUTHORITY, address(SGT_METADATA_ADDRESS))])));
ok("a missing metadata pointer is refused", !isSeekerGenesisMint(mintBytes(AUTHORITY, [member(GROUP)])));
ok("a mint with no extensions is refused", !isSeekerGenesisMint(mintBytes(AUTHORITY, null)));
ok("a truncated extension is refused, not thrown", !isSeekerGenesisMint(genuine.slice(0, genuine.length - 9)));
ok("empty data is refused, not thrown", !isSeekerGenesisMint(new Uint8Array(0)));
ok("a token ACCOUNT is refused", !isSeekerGenesisMint(new Uint8Array(getTokenEncoder().encode({
  mint: MINT, owner: AUTHORITY, amount: 1n, delegate: none(), state: AccountState.Frozen, isNative: none(),
  delegatedAmount: 0n, closeAuthority: none(), extensions: some([extension("ImmutableOwner", {})]),
}))));

// --- The document ----------------------------------------------------------------------------------
const fixture = JSON.parse(readFileSync(resolve(here, "fixtures", "attestation-sample.json"), "utf8")) as AttestationBundle & { note: string; syntheticRootKey: string };
const { note: _note, syntheticRootKey: _root, ...bundle } = fixture;
const commitment = bundle.manifest;
const e: CoreMetadata = {
  cluster: commitment.cluster, program: commitment.program, edition: commitment.edition,
  collection: commitment.collection, creator: commitment.creator, nonce: commitment.nonce,
  title: "Sample", supply: 3, image: "https://arweave.net/" + "A".repeat(43), imageHash: commitment.imageHash,
  width: 2448, height: 3264, description: "", genesisMint: MINT,
};
const written = metadata(e);
const serialized = canonicalize(written as unknown as JcsValue);
ok("metadata() writes the claim and its one attribute",
  serialized === canonicalize({
    name: "Sample", description: "", image: e.image,
    attributes: [{ trait_type: "Seeker Genesis Token", value: MINT }],
    properties: { genesisToken: { schema: GENESIS_SCHEMA, mint: MINT } },
  }));
const read = readPhotoMetadata(JSON.parse(serialized), e, serialized);
ok("a Genesis Token document reads back with the claimed mint and no device claim",
  read.genesisMint === MINT && read.attestation === undefined && read.attestationProblem === undefined && read.image === e.image);
ok("a plain document still reads with no claim", (() => {
  const { genesisMint: _mint, ...plain } = e;
  return readPhotoMetadata(JSON.parse(canonicalize(metadata(plain) as unknown as JcsValue)), plain).genesisMint === undefined;
})());
ok("a saved draft's own claim is replaced by what the document supports",
  readSavedPhotoMetadata(serialized, { ...e, genesisMint: OTHER }).genesisMint === MINT);
ok("a saved draft that claims a mint its document does not is stripped of it", (() => {
  const { genesisMint: _mint, ...plain } = e;
  const bytes = canonicalize(metadata(plain) as unknown as JcsValue);
  return readSavedPhotoMetadata(bytes, { ...plain, genesisMint: MINT }).genesisMint === undefined;
})());

// Beside an attestation, composed by hand as `metadata()` composes it (the writer refuses the
// synthetic chain, as `check-attestation.ts` shows): the device evidence is set aside for its
// forged root and the Genesis Token claim survives it.
const both = {
  name: e.title, description: e.description, image: e.image,
  attributes: [
    { trait_type: "Device", value: "Solana Seeker" },
    { trait_type: "Attestation", value: "StrongBox hardware key" },
    ...genesisAttributes(MINT),
  ],
  properties: { seedshot: bundle, genesisToken: { schema: GENESIS_SCHEMA, mint: MINT } },
};
const bothRead = readPhotoMetadata(JSON.parse(canonicalize(both as unknown as JcsValue)), e);
ok("the claim is independent of an attestation that was set aside",
  bothRead.genesisMint === MINT && bothRead.attestation === undefined && !!bothRead.attestationProblem);

const doc = (change: (d: Record<string, any>) => void) => {
  const d = JSON.parse(serialized) as Record<string, any>;
  change(d);
  return d;
};
ok("refuses: a claim with no attribute", throws(() => readPhotoMetadata(doc((d) => { d.attributes = []; }), e)));
ok("refuses: an attribute naming another mint", throws(() => readPhotoMetadata(doc((d) => { d.attributes[0].value = OTHER; }), e)));
ok("refuses: an extra attribute with no attestation to support it",
  throws(() => readPhotoMetadata(doc((d) => { d.attributes.unshift({ trait_type: "Device", value: "Solana Seeker" }); }), e)));
ok("refuses: an attribute after the Genesis Token's",
  throws(() => readPhotoMetadata(doc((d) => { d.attributes.push({ trait_type: "Verified", value: "yes" }); }), e)));
ok("refuses: a mint that is not an address", throws(() => readPhotoMetadata(doc((d) => { d.properties.genesisToken.mint = "not-a-mint"; d.attributes[0].value = "not-a-mint"; }), e)));
ok("refuses: an unknown claim schema", throws(() => readPhotoMetadata(doc((d) => { d.properties.genesisToken.schema = "seedshot-genesis/2"; }), e)));
ok("refuses: an extra claim key", throws(() => readPhotoMetadata(doc((d) => { d.properties.genesisToken.holder = commitment.creator; }), e)));
ok("refuses: an unknown evidence block", throws(() => readPhotoMetadata(doc((d) => { d.properties.other = {}; }), e)));
ok("refuses: empty properties", throws(() => readPhotoMetadata(doc((d) => { d.properties = {}; d.attributes = []; }), e)));
ok("refuses: a non-canonical document on the network path", throws(() => readPhotoMetadata(JSON.parse(serialized), e, serialized + " ")));
ok("readGenesisClaim refuses anything but the claim",
  throws(() => readGenesisClaim(null)) && throws(() => readGenesisClaim([])) && throws(() => readGenesisClaim({ schema: GENESIS_SCHEMA })));

// --- The program's two accounts ------------------------------------------------------------------------
// `publish` on a deployment with Genesis Token accounts takes them last, or the program id in each
// place; a deployment without them takes neither, and is refused the accounts rather than sent them.
const GENESIS_PROGRAM = "Ds4LT9zQ3a9V9ZxqKgwYQxskh1DgeYPhoCYz5iHjAizE"; // any non-legacy address
const LEGACY_PROGRAM = "7ZL3pF3e9RVLjMjZ9QJuNi8Epw9bmPaKBAfVWHX4uGhU";
const URI = "https://arweave.net/" + "B".repeat(43);
const TOKEN_ACCOUNT = "GH2ELkRUzqFRFZV6yJfjgE2XvzFz2mohS27Jrk6gji77";
async function publishAccounts(program: string, genesis?: { mint: string; token: string }, album?: string, genesisMint: string | null = MINT) {
  const keys = await addresses(program, e.creator, e.nonce);
  const item: CoreMetadata = { ...e, program, edition: keys.edition, collection: keys.collection, ...(genesisMint ? { genesisMint } : {}) };
  if (!genesisMint) delete item.genesisMint;
  const ix = await instruction(item, e.creator, 1, URI, "a".repeat(64), album, genesis);
  return ix.accounts!.map((a) => `${a.address}:${a.role === AccountRole.READONLY ? "r" : a.role === AccountRole.WRITABLE ? "w" : "s"}`);
}
async function publishThrows(program: string, genesis?: { mint: string; token: string }, genesisMint: string | null = MINT) {
  try { await publishAccounts(program, genesis, undefined, genesisMint); return false; } catch { return true; }
}
async function accountTests() {
  const plain = await publishAccounts(GENESIS_PROGRAM);
  ok("a plain publish carries the seven accounts plus two program-id placeholders, read only",
    plain.length === 9 && plain[7] === `${GENESIS_PROGRAM}:r` && plain[8] === `${GENESIS_PROGRAM}:r`);
  const sealed = await publishAccounts(GENESIS_PROGRAM, { mint: MINT, token: TOKEN_ACCOUNT });
  ok("a sealed publish carries the mint and the token account last, read only, and nothing else changes",
    sealed.length === 9 && sealed[7] === `${MINT}:r` && sealed[8] === `${TOKEN_ACCOUNT}:r` && sealed.slice(0, 7).join() === plain.slice(0, 7).join());
  const inAlbum = await publishAccounts(GENESIS_PROGRAM, { mint: MINT, token: TOKEN_ACCOUNT }, OTHER);
  ok("publish_in_album keeps the album before Core and the two accounts last",
    inAlbum.length === 10 && inAlbum[5] === `${OTHER}:w` && inAlbum[8] === `${MINT}:r` && inAlbum[9] === `${TOKEN_ACCOUNT}:r`);
  const legacy = await publishAccounts(LEGACY_PROGRAM);
  ok("a deployment without the accounts is sent exactly its seven", legacy.length === 7 && legacy.every((a) => !a.startsWith(LEGACY_PROGRAM)));
  ok("refuses: the accounts for a deployment that cannot seal them", await publishThrows(LEGACY_PROGRAM, { mint: MINT, token: TOKEN_ACCOUNT }));
  ok("refuses: sealing a mint the document does not name", await publishThrows(GENESIS_PROGRAM, { mint: OTHER, token: TOKEN_ACCOUNT }));
  ok("refuses: sealing when the document names none", await publishThrows(GENESIS_PROGRAM, { mint: MINT, token: TOKEN_ACCOUNT }, null));
}

// --- The sealed attribute, through the collection reader ---------------------------------------------
// A Core `CollectionV1` encoded by hand in the layout `decodeCollection` reads: the base, the plugin
// header, the three plugin blobs the program writes, then the registry. Only the attributes vary.
const u32le = (n: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; };
const u64le = (n: number) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n), true); return b; };
const text = (s: string) => { const bytes = new TextEncoder().encode(s); return concatBytes(u32le(bytes.length), bytes); };
const concatBytes = (...parts: Uint8Array[]) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let at = 0; for (const p of parts) { out.set(p, at); at += p.length; } return out; };
const state = { creator: address(e.creator), nonce: e.nonce, collection: OTHER, metadataHash: "c".repeat(64), imageHash: "d".repeat(64), supply: 3, minted: 1, title: "Sample", uri: URI };
const EDITION = e.edition;
function encodeCollection(attributes: { key: string; value: string }[]): Uint8Array {
  const base = concatBytes(new Uint8Array([5]), getAddressEncoder().encode(address(EDITION)) as Uint8Array, text(state.title), text(state.uri), u32le(1), u32le(1));
  const master = concatBytes(new Uint8Array([10, 1]), u32le(state.supply), new Uint8Array([0, 0])); // MasterEdition: Some(max_supply), None, None
  const immutable = new Uint8Array([12]);
  const attrs = concatBytes(new Uint8Array([6]), u32le(attributes.length), ...attributes.map((a) => concatBytes(text(a.key), text(a.value))));
  const headerLength = 1 + 8;
  const offsets = { master: base.length + headerLength, immutable: base.length + headerLength + master.length, attrs: base.length + headerLength + master.length + immutable.length };
  const registryOffset = offsets.attrs + attrs.length;
  const header = concatBytes(new Uint8Array([3]), u64le(registryOffset));
  const record = (type: number, offset: number) => concatBytes(new Uint8Array([type, 0]), u64le(offset)); // authority None
  const registry = concatBytes(new Uint8Array([4]), u32le(3), record(10, offsets.master), record(12, offsets.immutable), record(6, offsets.attrs), u32le(0));
  return concatBytes(base, header, master, immutable, attrs, registry);
}
const FIVE = [
  { key: "image_sha256", value: state.imageHash }, { key: "metadata_sha256", value: state.metadataHash },
  { key: "edition_size", value: "3" }, { key: "publisher", value: state.creator }, { key: "protocol", value: "erashot-core/1" },
];
const verifies = (attributes: { key: string; value: string }[]) => { try { return verifyEditionCollection(encodeCollection(attributes), state, EDITION); } catch { return null; } };
const five = verifies(FIVE);
ok("the five sealed attributes verify and seal no Genesis Token", !!five && sealedGenesisMint(five) === null);
const six = verifies([...FIVE, { key: GENESIS_ATTRIBUTE, value: MINT }]);
ok("the five plus seeker_genesis_token verify and seal that mint", !!six && sealedGenesisMint(six) === MINT);
ok("refuses: a sixth attribute under another key", verifies([...FIVE, { key: "genesis", value: MINT }]) === null);
ok("refuses: a sixth attribute that is not an address", verifies([...FIVE, { key: GENESIS_ATTRIBUTE, value: "not-a-mint" }]) === null);
ok("refuses: anything after the sixth", verifies([...FIVE, { key: GENESIS_ATTRIBUTE, value: MINT }, { key: "verified", value: "yes" }]) === null);
ok("refuses: the sixth in place of one of the five", verifies([...FIVE.slice(0, 4), { key: GENESIS_ATTRIBUTE, value: MINT }]) === null);
ok("refuses: fewer than five", verifies(FIVE.slice(0, 4)) === null);

// --- verifyGenesisToken, against a stubbed mainnet ---------------------------------------------------
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const HOLDER = commitment.creator;
const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const tokenAccount = (amount: string, overrides: Record<string, unknown> = {}) => ({
  pubkey: OTHER,
  account: { data: { program: "spl-token-2022", parsed: { type: "account", info: { mint: MINT, owner: HOLDER, tokenAmount: { amount, decimals: 0 }, ...overrides } } } },
});
type Stub = { mint: { owner: string; data: Uint8Array } | null; accounts?: unknown; fail?: boolean };
const calls: string[] = [];
function stub({ mint, accounts, fail }: Stub) {
  calls.length = 0;
  globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
    const { method, params } = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
    calls.push(method);
    if (fail) return new Response("upstream down", { status: 502 });
    const result = method === "getAccountInfo"
      ? { context: { slot: 1 }, value: mint && params[0] === MINT ? { owner: mint.owner, executable: false, lamports: 1, data: [base64(mint.data), "base64"] } : null }
      : { context: { slot: 1 }, value: accounts };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}
const rejects = async (p: Promise<unknown>) => { try { await p; return false; } catch { return true; } };

// tsx runs this file as CommonJS, which has no top-level await.
async function verifier() {
await accountTests();
stub({ mint: { owner: TOKEN_2022, data: genuine }, accounts: [tokenAccount("0"), tokenAccount("1")] });
ok("held: a genuine mint and a non-zero token account of the holder's",
  (await verifyGenesisToken("https://mainnet.invalid", MINT, HOLDER)) === "held" && calls.join() === "getAccountInfo,getTokenAccountsByOwner");
stub({ mint: { owner: TOKEN_2022, data: genuine }, accounts: [tokenAccount("0")] });
ok("moved: only the zero-balance account an SGT leaves behind", (await verifyGenesisToken("https://mainnet.invalid", MINT, HOLDER)) === "moved");
stub({ mint: { owner: TOKEN_2022, data: genuine }, accounts: [] });
ok("moved: no token account at all", (await verifyGenesisToken("https://mainnet.invalid", MINT, HOLDER)) === "moved");
stub({ mint: { owner: OTHER, data: genuine }, accounts: [tokenAccount("1")] });
ok("not-genesis: genuine-looking data under another program, and the holder is never asked",
  (await verifyGenesisToken("https://mainnet.invalid", MINT, HOLDER)) === "not-genesis" && calls.join() === "getAccountInfo");
stub({ mint: { owner: TOKEN_2022, data: mintBytes(OTHER, [pointer(AUTHORITY, address(SGT_METADATA_ADDRESS)), member(GROUP)]) }, accounts: [tokenAccount("1")] });
ok("not-genesis: a Token-2022 mint somebody else made", (await verifyGenesisToken("https://mainnet.invalid", MINT, HOLDER)) === "not-genesis");
stub({ mint: null });
ok("not-genesis: no such account", (await verifyGenesisToken("https://mainnet.invalid", MINT, HOLDER)) === "not-genesis");
stub({ mint: { owner: TOKEN_2022, data: genuine }, fail: true });
ok("an RPC failure throws and never reads as not held", await rejects(verifyGenesisToken("https://mainnet.invalid", MINT, HOLDER)));
stub({ mint: { owner: TOKEN_2022, data: genuine }, accounts: [tokenAccount("1", { owner: OTHER })] });
ok("a token account of another owner's is an invalid answer, not a holding", await rejects(verifyGenesisToken("https://mainnet.invalid", MINT, HOLDER)));
stub({ mint: { owner: TOKEN_2022, data: genuine }, accounts: { not: "a list" } });
ok("a malformed account list throws", await rejects(verifyGenesisToken("https://mainnet.invalid", MINT, HOLDER)));
ok("a mint or holder that is not an address throws before any request", await (async () => {
  stub({ mint: null });
  return (await rejects(verifyGenesisToken("https://mainnet.invalid", "nope", HOLDER))) && calls.length === 0;
})());
}

void verifier().then(
  () => {
    console.log(failures ? `\n${failures} check(s) failed.` : "\ngenesis token self-test passed.");
    process.exit(failures ? 1 : 0);
  },
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
