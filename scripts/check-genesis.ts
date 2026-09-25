/**
 * Self-test for `seedshot-genesis/1` (`publications/core/genesisToken.ts`). Runs in `npm test`,
 * needs no network.
 *
 *   - the hand-written Token-2022 mint decoder, held to the OFFICIAL `@solana-program/token-2022`
 *     encoder: Solana Mobile's current recipe (metadata pointer and group membership) and the
 *     member's own mint, whatever the mint authority; forgeries without the membership refused;
 *   - the document: what `metadata()` writes reads back through `readPhotoMetadata`, alone and
 *     beside an attestation, and every malformed claim is refused;
 *   - `verifyGenesisToken` against a stubbed mainnet: held, moved, gone, not an SGT (however big or
 *     foreign the account), a wrong cluster and an RPC failure, both of which must throw;
 *   - the app's lookup (`findSeekerGenesisToken`): which accounts it reads, and which SGT it picks;
 *   - what a screen says (`genesisDisplay`), and that the mainnet program names the same group.
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { AccountRole, address, createSolanaRpc, getAddressDecoder, getAddressEncoder, none, some, type Address } from "@solana/kit";
import { extension, getMintEncoder, getTokenEncoder, AccountState, type ExtensionArgs } from "@solana-program/token-2022";
import { canonicalize, type JcsValue } from "../src/jcs";
import {
  GENESIS_SCHEMA,
  MAINNET_GENESIS_HASH,
  SGT_GROUP_ADDRESS,
  SGT_METADATA_ADDRESS,
  genesisAttributes,
  genesisDisplay,
  isSeekerGenesisMint,
  readGenesisClaim,
  seekerGenesisMember,
  verifyGenesisToken,
  type GenesisCheck,
  type GenesisLine,
} from "../publications/core/genesisToken";
import { findSeekerGenesisToken } from "../src/seeker/genesisToken";
import { proof } from "../src/ui/copy";
import { GENESIS_LINE } from "../site/collect/summary";
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
// What a real SGT carries (mint 21Q8vbf36J9vJ6DDkUBjC29BKYMQdKZ5fs9LcJZQY4qH, read on mainnet
// 2026-09-24): metadata pointer, permanent delegate, close authority, group-member pointer and
// group member, in that order. Solana Mobile's authority below is only somebody's address here:
// the recipe no longer names it, so nothing may depend on it.
const SOLANA_MOBILE_KEY = address("GT2zuHVaZQYZSyQMgJPLzvkmyztfyXg2NJunqFp4p3A4");
const GROUP = address(SGT_GROUP_ADDRESS);
const MINT = address("So11111111111111111111111111111111111111112");
const OTHER = address("CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d");

const pointer = (metadataAddress: Address, authority: Address | null = SOLANA_MOBILE_KEY) =>
  extension("MetadataPointer", { authority: authority ? some(authority) : none(), metadataAddress: some(metadataAddress) });
const member = (group: Address, mint: Address = MINT, memberNumber = 7n) =>
  extension("TokenGroupMember", { mint, group, memberNumber });
const closeAuthority = extension("MintCloseAuthority", { closeAuthority: SOLANA_MOBILE_KEY });
const delegate = extension("PermanentDelegate", { delegate: SOLANA_MOBILE_KEY });
const memberPointer = (mint: Address) => extension("GroupMemberPointer", { authority: some(SOLANA_MOBILE_KEY), memberAddress: some(mint) });
const sgtExtensions = (mint: Address = MINT, memberNumber = 7n) =>
  [pointer(address(SGT_METADATA_ADDRESS)), delegate, closeAuthority, memberPointer(mint), member(GROUP, mint, memberNumber)];
const mintBytes = (mintAuthority: Address | null, extensions: ExtensionArgs[] | null) =>
  new Uint8Array(getMintEncoder().encode({
    mintAuthority: mintAuthority ? some(mintAuthority) : none(),
    supply: 1n,
    decimals: 0,
    isInitialized: true,
    freezeAuthority: some(SOLANA_MOBILE_KEY),
    extensions: extensions ? some(extensions) : none(),
  }));

const genuine = mintBytes(SOLANA_MOBILE_KEY, sgtExtensions());
ok("a mint shaped like a real SGT is a Seeker Genesis Token, member number and all",
  isSeekerGenesisMint(genuine, MINT) && seekerGenesisMember(genuine, MINT) === 7n);
ok("no mint authority: still an SGT (the recipe does not ask)", isSeekerGenesisMint(mintBytes(null, sgtExtensions()), MINT));
ok("another mint authority: still an SGT", isSeekerGenesisMint(mintBytes(OTHER, sgtExtensions()), MINT));
ok("another or no metadata-pointer authority: still an SGT",
  isSeekerGenesisMint(mintBytes(OTHER, [pointer(address(SGT_METADATA_ADDRESS), OTHER), member(GROUP)]), MINT) &&
  isSeekerGenesisMint(mintBytes(OTHER, [pointer(address(SGT_METADATA_ADDRESS), null), member(GROUP)]), MINT));
ok("only the two the recipe names are needed, other extensions skipped wherever they sit",
  isSeekerGenesisMint(mintBytes(null, [pointer(address(SGT_METADATA_ADDRESS)), member(GROUP)]), MINT) &&
  isSeekerGenesisMint(mintBytes(null, [closeAuthority, member(GROUP), delegate, pointer(address(SGT_METADATA_ADDRESS)), closeAuthority]), MINT));
ok("refuses: a pointer-only forgery, even with Solana Mobile's authority everywhere",
  !isSeekerGenesisMint(mintBytes(SOLANA_MOBILE_KEY, [pointer(address(SGT_METADATA_ADDRESS)), delegate, closeAuthority, memberPointer(MINT)]), MINT));
ok("refuses: a different group", !isSeekerGenesisMint(mintBytes(null, [pointer(address(SGT_METADATA_ADDRESS)), member(OTHER)]), MINT));
ok("refuses: a different metadata address", !isSeekerGenesisMint(mintBytes(null, [pointer(OTHER), member(GROUP)]), MINT));
ok("refuses: a missing metadata pointer", !isSeekerGenesisMint(mintBytes(null, [member(GROUP)]), MINT));
ok("refuses: a member that names another mint", !isSeekerGenesisMint(mintBytes(null, sgtExtensions(OTHER)), MINT));
ok("refuses: a real SGT's bytes offered for another address", !isSeekerGenesisMint(genuine, OTHER));
ok("refuses: an extension twice", !isSeekerGenesisMint(mintBytes(null, [...sgtExtensions(), member(GROUP)]), MINT));
ok("refuses: non-zero padding before the account type", (() => {
  const bent = genuine.slice(); bent[100] = 1; return !isSeekerGenesisMint(bent, MINT);
})());
ok("refuses: no extensions", !isSeekerGenesisMint(mintBytes(null, null), MINT));
ok("a truncated extension is refused, not thrown", !isSeekerGenesisMint(genuine.slice(0, genuine.length - 9), MINT));
ok("empty data is refused, not thrown", !isSeekerGenesisMint(new Uint8Array(0), MINT));
ok("a token ACCOUNT is refused", !isSeekerGenesisMint(new Uint8Array(getTokenEncoder().encode({
  mint: MINT, owner: SOLANA_MOBILE_KEY, amount: 1n, delegate: none(), state: AccountState.Frozen, isNative: none(),
  delegatedAmount: 0n, closeAuthority: none(), extensions: some([extension("ImmutableOwner", {})]),
})), MINT));

// The mainnet program must name the same group (`mod genesis` in the program, read as text).
const lib = readFileSync(resolve(here, "..", "programs", "editions", "src", "lib.rs"), "utf8");
const mainnetGenesis = /#\[cfg\(not\(feature\s*=\s*"devnet-genesis"\)\)\]\s*mod genesis\s*\{([\s\S]*?)\n\}/.exec(lib)?.[1] ?? "";
ok("the mainnet program's METADATA_ADDRESS is the readers'",
  /METADATA_ADDRESS\s*:\s*Pubkey\s*=\s*pubkey!\("([1-9A-HJ-NP-Za-km-z]+)"\)/.exec(mainnetGenesis)?.[1] === SGT_METADATA_ADDRESS);
ok("the app's own cluster check knows the same mainnet genesis hash",
  readFileSync(resolve(here, "..", "src", "solana", "cluster.ts"), "utf8").includes(`"mainnet-beta": "${MAINNET_GENESIS_HASH}"`));

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

// --- What a screen says --------------------------------------------------------------------------------
const shows = (check: GenesisCheck, cluster: "mainnet-beta" | "devnet", sealed: boolean, line: GenesisLine, sealLine: boolean) => {
  const shown = genesisDisplay(check, { cluster, sealed });
  return shown.line === line && shown.sealed === sealLine;
};
ok("unsealed: held, not held (no \"now\"), and a missing mint is not an SGT",
  shows("held", "mainnet-beta", false, "held", false) && shows("moved", "mainnet-beta", false, "not-held", false) &&
  shows("no-account", "mainnet-beta", false, "not-genesis", false) && shows("not-genesis", "mainnet-beta", false, "not-genesis", false));
ok("sealed on mainnet: the seal line beside held and not held now",
  shows("held", "mainnet-beta", true, "held", true) && shows("moved", "mainnet-beta", true, "not-held-now", true));
ok("sealed on mainnet, mint account gone: not held now, with no seal line",
  shows("no-account", "mainnet-beta", true, "not-held-now", false));
ok("sealed on mainnet: no seal line until mainnet finds a real SGT",
  shows("checking", "mainnet-beta", true, "checking", false) && shows("unavailable", "mainnet-beta", true, "unavailable", false) &&
  shows("not-genesis", "mainnet-beta", true, "not-genesis", false));
ok("a devnet seal counts for nothing",
  shows("held", "devnet", true, "held", false) && shows("moved", "devnet", true, "not-held", false) &&
  shows("no-account", "devnet", true, "not-genesis", false));
ok("the words: \"now\" only where a seal stands behind it",
  proof.genesisStanding["not-held"] === "Not held by the publishing wallet." &&
  proof.genesisStanding["not-held-now"] === "Not held by the publishing wallet now.");
ok("the collect page says exactly what the Proof sheet says",
  canonicalize(GENESIS_LINE as unknown as JcsValue) === canonicalize(proof.genesisStanding as unknown as JcsValue));

// --- verifyGenesisToken and the app's lookup, against a stubbed chain ---------------------------------
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const MAINNET = "https://mainnet.invalid";
const DEVNET_HASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const HOLDER = address(commitment.creator);
const SLOT_HASHES = "SysvarS1otHashes111111111111111111111111111";
const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const tokenAccount = (amount: string, overrides: Record<string, unknown> = {}) => ({
  pubkey: OTHER,
  account: { data: { program: "spl-token-2022", parsed: { type: "account", info: { mint: MINT, owner: HOLDER, tokenAmount: { amount, decimals: 0 }, ...overrides } } } },
});
type Held = { owner: string; data: Uint8Array };
type Chain = {
  /** Mainnet's unless said otherwise. */
  genesisHash?: string;
  accounts?: Record<string, Held>;
  /** `getTokenAccountsByOwner` for one mint (the readers' check). */
  holdings?: unknown;
  /** `getTokenAccountsByOwner` for the whole Token-2022 program (the app's lookup). */
  wallet?: unknown[];
  /** An endpoint that sends whole accounts whatever slice was asked for. */
  ignoreSlice?: boolean;
  fail?: boolean;
};
const calls: string[] = [];
const batches: string[][] = [];
/** The calls that ask about the chain itself, not which chain it is. */
const asked = () => calls.filter((method) => method !== "getGenesisHash").join();
function stub(chain: Chain) {
  calls.length = 0;
  batches.length = 0;
  globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
    const { id, method, params } = JSON.parse(String(init?.body)) as { id: unknown; method: string; params: any[] };
    calls.push(method);
    if (chain.fail) return new Response("upstream down", { status: 502 });
    const read = (key: string, config?: { dataSlice?: { offset: number; length: number } }) => {
      const account = chain.accounts?.[key];
      if (!account) return null;
      const slice = config?.dataSlice && !chain.ignoreSlice
        ? account.data.subarray(config.dataSlice.offset, config.dataSlice.offset + config.dataSlice.length)
        : account.data;
      return { owner: account.owner, executable: false, lamports: 1, rentEpoch: 0, space: account.data.length, data: [base64(slice), "base64"] };
    };
    const context = { slot: 1 };
    const result =
      method === "getGenesisHash" ? chain.genesisHash ?? MAINNET_GENESIS_HASH
      : method === "getAccountInfo" ? { context, value: read(params[0], params[1]) }
      : method === "getMultipleAccounts" ? (batches.push(params[0]), { context, value: params[0].map((key: string) => read(key, params[1])) })
      : method === "getTokenAccountsByOwner" ? { context, value: "mint" in params[1] ? chain.holdings : chain.wallet }
      : undefined;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}
const rejects = async (p: Promise<unknown>) => { try { await p; return false; } catch { return true; } };
const mintAt = (data: Uint8Array) => ({ [MINT]: { owner: TOKEN_2022, data } });

/** A distinct, valid address per number, for the lookup's many mints. */
const key = (n: number) => getAddressDecoder().decode(new Uint8Array(32).fill(n));
const walletRow = (mint: string, amount: string, decimals = 0) => ({
  pubkey: key(250),
  account: {
    data: { program: "spl-token-2022", parsed: { type: "account", info: { isNative: false, mint, owner: HOLDER, state: "frozen", tokenAmount: { amount, decimals, uiAmount: Number(amount), uiAmountString: amount } } }, space: 170 },
    executable: false, lamports: 1, owner: TOKEN_2022, rentEpoch: 0, space: 170,
  },
});
const sgtAt = (mint: Address, memberNumber: bigint): Held => ({ owner: TOKEN_2022, data: mintBytes(null, sgtExtensions(mint, memberNumber)) });
const plainAt = (): Held => ({ owner: TOKEN_2022, data: mintBytes(OTHER, [pointer(OTHER)]) });

// tsx runs this file as CommonJS, which has no top-level await.
async function verifier() {
await accountTests();
stub({ accounts: mintAt(genuine), holdings: [tokenAccount("0"), tokenAccount("1")] });
ok("held: a genuine mint and a non-zero token account of the holder's, once mainnet says it is mainnet",
  (await verifyGenesisToken(MAINNET, MINT, HOLDER)) === "held" && calls.join() === "getGenesisHash,getAccountInfo,getTokenAccountsByOwner");
stub({ accounts: mintAt(genuine), holdings: [tokenAccount("1")] });
ok("the endpoint's cluster is asked once per session", (await verifyGenesisToken(MAINNET, MINT, HOLDER)) === "held" && !calls.includes("getGenesisHash"));
stub({ accounts: mintAt(mintBytes(null, sgtExtensions())), holdings: [tokenAccount("1")] });
ok("held: an SGT with no mint authority", (await verifyGenesisToken(MAINNET, MINT, HOLDER)) === "held");
stub({ accounts: mintAt(genuine), holdings: [tokenAccount("0")] });
ok("moved: only the zero-balance account an SGT leaves behind", (await verifyGenesisToken(MAINNET, MINT, HOLDER)) === "moved");
stub({ accounts: mintAt(genuine), holdings: [] });
ok("moved: no token account at all", (await verifyGenesisToken(MAINNET, MINT, HOLDER)) === "moved");
stub({ accounts: { [MINT]: { owner: OTHER, data: genuine } }, holdings: [tokenAccount("1")] });
ok("not-genesis: genuine-looking data under another program, and the holder is never asked",
  (await verifyGenesisToken(MAINNET, MINT, HOLDER)) === "not-genesis" && asked() === "getAccountInfo");
stub({ accounts: mintAt(mintBytes(SOLANA_MOBILE_KEY, [pointer(address(SGT_METADATA_ADDRESS)), delegate, closeAuthority])), holdings: [tokenAccount("1")] });
ok("not-genesis: a Token-2022 mint that points at the metadata but is no member", (await verifyGenesisToken(MAINNET, MINT, HOLDER)) === "not-genesis");
stub({ accounts: { [OTHER]: { owner: TOKEN_2022, data: genuine } }, holdings: [tokenAccount("1", { mint: OTHER })] });
ok("not-genesis: a real SGT's bytes served for another address", (await verifyGenesisToken(MAINNET, OTHER, HOLDER)) === "not-genesis");
stub({ accounts: { [SLOT_HASHES]: { owner: "Sysvar1111111111111111111111111111111111111", data: new Uint8Array(20_488).fill(7) } }, ignoreSlice: true });
ok("not-genesis, not a throw: a claim naming a huge sysvar",
  (await verifyGenesisToken(MAINNET, SLOT_HASHES, HOLDER)) === "not-genesis" && asked() === "getAccountInfo");
const huge = new Uint8Array(100_000).fill(3); huge.set(plainAt().data);
stub({ accounts: { [SLOT_HASHES]: { owner: TOKEN_2022, data: huge } } });
ok("not-genesis: a Token-2022 account far larger than an SGT, cut to the slice",
  (await verifyGenesisToken(MAINNET, SLOT_HASHES, HOLDER)) === "not-genesis");
stub({ accounts: { [SLOT_HASHES]: { owner: TOKEN_2022, data: huge } }, ignoreSlice: true });
ok("not-genesis: the same from an endpoint that ignores the slice", (await verifyGenesisToken(MAINNET, SLOT_HASHES, HOLDER)) === "not-genesis");
stub({ accounts: {} });
ok("no-account: nothing at the mint address", (await verifyGenesisToken(MAINNET, MINT, HOLDER)) === "no-account");
stub({ accounts: mintAt(genuine), fail: true });
ok("an RPC failure throws and never reads as not held", await rejects(verifyGenesisToken(MAINNET, MINT, HOLDER)));
stub({ accounts: mintAt(genuine), holdings: [tokenAccount("1", { owner: OTHER })] });
ok("a token account of another owner's is an invalid answer, not a holding", await rejects(verifyGenesisToken(MAINNET, MINT, HOLDER)));
stub({ accounts: mintAt(genuine), holdings: { not: "a list" } });
ok("a malformed account list throws", await rejects(verifyGenesisToken(MAINNET, MINT, HOLDER)));
ok("a mint or holder that is not an address throws before any request", await (async () => {
  stub({ accounts: {} });
  return (await rejects(verifyGenesisToken(MAINNET, "nope", HOLDER))) && calls.length === 0;
})());
stub({ genesisHash: DEVNET_HASH, accounts: {}, holdings: [] });
ok("an endpoint on another cluster throws, never \"no such mint\"", await rejects(verifyGenesisToken("https://devnet.invalid", MINT, HOLDER)));
stub({ accounts: mintAt(genuine), holdings: [tokenAccount("1")] });
ok("a refused cluster is asked again, not remembered",
  (await verifyGenesisToken("https://devnet.invalid", MINT, HOLDER)) === "held" && calls.includes("getGenesisHash"));

// The app's lookup, through a real kit client over the same stub.
const rpc = createSolanaRpc(MAINNET);
const [A, B, C, D, N, S] = [1, 2, 3, 4, 5, 6].map(key);
const lookupChain = (): Chain => ({
  wallet: [walletRow(A, "1"), walletRow(B, "1"), walletRow(C, "0"), walletRow(D, "2"), walletRow(N, "1"), walletRow(S, "1000000", 6)],
  accounts: { [A]: sgtAt(A, 9n), [B]: sgtAt(B, 3n), [C]: sgtAt(C, 1n), [D]: sgtAt(D, 0n), [N]: plainAt(), [S]: plainAt() },
});
stub(lookupChain());
const lowest = await findSeekerGenesisToken(rpc, HOLDER);
ok("lookup: only one unit of a 0-decimal mint is read, and the lowest member number wins",
  lowest === B && batches.length === 1 && [...batches[0]].sort().join() === [A, B, N].sort().join());
stub(lookupChain());
ok("lookup: the SGT found last time wins while it is still held", (await findSeekerGenesisToken(rpc, HOLDER, undefined, A)) === A);
stub(lookupChain());
ok("lookup: one found last time but no longer held is passed over", (await findSeekerGenesisToken(rpc, HOLDER, undefined, C)) === B);
stub({ wallet: [walletRow(C, "0"), walletRow(S, "5", 6)], accounts: {} });
ok("lookup: no candidates, no mint reads", (await findSeekerGenesisToken(rpc, HOLDER)) === null && batches.length === 0);
const many = Array.from({ length: 150 }, (_, i) => key(10 + i));
stub({
  wallet: many.map((mint) => walletRow(mint, "1")),
  accounts: Object.fromEntries(many.map((mint, i) => [mint, i === 120 ? sgtAt(mint, 42n) : plainAt()])),
});
ok("lookup: at most 100 mints per read, and an SGT in the second read is found",
  (await findSeekerGenesisToken(rpc, HOLDER)) === many[120] && batches.map((b) => b.length).join() === "100,50");
stub({ wallet: [walletRow(A, "1")], accounts: { [A]: { owner: OTHER, data: sgtAt(A, 1n).data } } });
ok("lookup: SGT-shaped data under another program is skipped", (await findSeekerGenesisToken(rpc, HOLDER)) === null);
stub({ genesisHash: DEVNET_HASH, ...lookupChain() });
ok("lookup: a client on another cluster throws", await rejects(findSeekerGenesisToken(createSolanaRpc("https://devnet.invalid"), HOLDER)));
stub({ ...lookupChain(), fail: true });
ok("lookup: an RPC failure throws", await rejects(findSeekerGenesisToken(createSolanaRpc("https://down.invalid"), HOLDER)));
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
