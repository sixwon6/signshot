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
import { AccountRole, address, createSolanaRpc, getAddressDecoder, getAddressEncoder, none, some, type Address, type Instruction } from "@solana/kit";
import { extension, getMintEncoder, getTokenEncoder, AccountState, type ExtensionArgs } from "@solana-program/token-2022";
import { canonicalize, type JcsValue } from "../src/jcs";
import {
  DEVNET_GENESIS_GROUP,
  GENESIS_SCHEMA,
  MAINNET_GENESIS_HASH,
  MAX_GENESIS_CANDIDATES,
  SGT_GROUP_ADDRESS,
  SGT_METADATA_ADDRESS,
  findHeldGenesisToken,
  genesisAddresses,
  genesisAttributes,
  genesisDisplay,
  isSeekerGenesisMint,
  publishedGenesisClaim,
  readGenesisClaim,
  seekerGenesisMember,
  verifyGenesisToken,
  type GenesisCheck,
  type GenesisLine,
} from "../publications/core/genesisToken";
import { DEVNET_GENESIS_GROUP as FIXTURE_GROUP } from "../publications/devnet/genesisFixture";
import { claimGenesis, claimedCopy } from "../publications/core/seekerClaim";
import { findSeekerGenesisToken } from "../src/seeker/genesisToken";
import { proof } from "../src/ui/copy";
import { GENESIS_LINE } from "../site/collect/summary";
import type { AttestationBundle } from "../publications/core/attestation";
import { readPhotoMetadata, readSavedPhotoMetadata } from "../publications/core/metadataDocument";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  GENESIS_ATTRIBUTE,
  NO_ROYALTIES,
  ROYALTY_RANGE,
  SYSTEM_PROGRAM,
  addresses,
  buyInstruction,
  claimReceiptAddress,
  collectInstruction,
  collectionRoyalty,
  instruction,
  metadata,
  sealedGenesisMint,
  verifyEditionCollection,
  type GenesisAccounts,
  type SealedTerms,
} from "../publications/core/protocol";
import { programFeatures } from "../publications/deployments";
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
{
  // A Token-2022 multisig is 355 bytes whose first three are m, n and "initialized" and whose
  // other 352 are eleven signer keys its creator chooses. Laid out as a mint naming the group, it
  // would pass every other rule; only its length gives it away, as it does to Token-2022.
  const laidOut = (length: number) => {
    const bytes = new Uint8Array(length);
    bytes.set(mintBytes(null, [pointer(address(SGT_METADATA_ADDRESS)), member(GROUP)]));
    bytes.set([1, 1, 1], 0);
    return bytes;
  };
  ok("refuses: a 355-byte multisig laid out as a Seeker Genesis Token mint",
    !isSeekerGenesisMint(laidOut(355), MINT) && isSeekerGenesisMint(laidOut(356), MINT));
}
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
const devnetGenesis = /#\[cfg\(feature\s*=\s*"devnet-genesis"\)\]\s*mod genesis\s*\{([\s\S]*?)\n\}/.exec(lib)?.[1] ?? "";
ok("the devnet stand-in the readers accept is the devnet program build's and the acceptance fixture's",
  DEVNET_GENESIS_GROUP === FIXTURE_GROUP
    && /METADATA_ADDRESS\s*:\s*Pubkey\s*=\s*pubkey!\("([1-9A-HJ-NP-Za-km-z]+)"\)/.exec(devnetGenesis)?.[1] === DEVNET_GENESIS_GROUP
    && genesisAddresses("devnet").groupAddress === DEVNET_GENESIS_GROUP && genesisAddresses("devnet").metadataAddress === DEVNET_GENESIS_GROUP
    && genesisAddresses("mainnet-beta").groupAddress === SGT_GROUP_ADDRESS && genesisAddresses("mainnet-beta").metadataAddress === SGT_METADATA_ADDRESS);
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
ok("metadata() writes the claim and its one attribute beside the link and the file list",
  serialized === canonicalize({
    name: "Sample", description: "", image: e.image,
    external_url: `https://erashot.app/collect/?core=${e.edition}&cluster=devnet`,
    attributes: [{ trait_type: "Seeker Genesis Token", value: MINT }],
    properties: {
      files: [{ uri: e.image, type: "image/jpeg" }], category: "image",
      genesisToken: { schema: GENESIS_SCHEMA, mint: MINT },
    },
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
// The same in the current document, where a Device trait may precede the claim.
const bothCurrent = {
  ...written,
  attributes: [{ trait_type: "Device", value: "Solana Seeker" }, ...genesisAttributes(MINT)],
  properties: { ...written.properties, seedshot: bundle },
};
const bothCurrentRead = readPhotoMetadata(JSON.parse(canonicalize(bothCurrent as unknown as JcsValue)), e);
ok("in the current document too, the claim survives an attestation that was set aside",
  bothCurrentRead.genesisMint === MINT && bothCurrentRead.attestation === undefined && !!bothCurrentRead.attestationProblem);

// On mainnet the program seals every claim the app publishes, so an unsealed one reads as none.
ok("an unsealed claim reads as no claim on mainnet, and as the claim on devnet",
  publishedGenesisClaim("mainnet-beta", MINT, null) === undefined && publishedGenesisClaim("mainnet-beta", MINT, MINT) === MINT
    && publishedGenesisClaim("devnet", MINT, null) === MINT && publishedGenesisClaim("mainnet-beta", undefined, null) === undefined);
ok("loadPublication reads the claim through that rule",
  /publishedGenesisClaim\(cluster, claimed, sealed\)/.test(readFileSync(resolve(here, "..", "publications", "core", "protocol.ts"), "utf8")));

// The devnet acceptance (`publications/devnet/test.ts`) writes its documents with this `metadata()`
// and reads them back through `loadTrustedEdition` on a deployment with royalties and Seeker-only
// editions, where the earlier formats are refused: the harness's own document, built the same way
// (no attestation, a claim or none), must read back there.
const harness = readFileSync(resolve(here, "..", "publications", "devnet", "test.ts"), "utf8");
ok("the devnet acceptance writes metadata() canonicalized, as the app does",
  harness.includes("const bytes = utf8(canonicalize(metadata(e) as unknown as JcsValue));"));
{
  const ROYALTIES_PROGRAM = address("41UayL5qxYF6V8R7BG9aTtVR5nAdhE2iooWoKWB9kQXC");
  const acceptance: CoreMetadata = {
    ...e, program: ROYALTIES_PROGRAM, cluster: "devnet",
    image: "https://arweave.net/" + "C".repeat(43), description: "Devnet acceptance publication: seeker.",
  };
  const readsBack = (item: CoreMetadata) => {
    const text = canonicalize(metadata(item) as unknown as JcsValue);
    const read = readPhotoMetadata(JSON.parse(text), item, text);
    return read.image === item.image && read.description === item.description && read.genesisMint === item.genesisMint
      && readSavedPhotoMetadata(text, item).genesisMint === item.genesisMint;
  };
  const { genesisMint: _claim, ...unclaimed } = acceptance;
  ok("the acceptance's documents, with a claim and without, read back on a royalties deployment",
    programFeatures(ROYALTIES_PROGRAM).royaltiesAndSeekerOnly && readsBack(acceptance) && readsBack(unclaimed));
  ok("where the earlier plain document they replaced is refused",
    throws(() => readPhotoMetadata({ name: acceptance.title, description: acceptance.description, image: acceptance.image }, acceptance)));
}

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
/** Open to any wallet at 5%: the terms a current program is sent unless a check says otherwise. */
const OPEN: SealedTerms = { royaltyBps: 500, seekerOnly: false };
const accountList = (ix: Instruction) =>
  ix.accounts!.map((a) => `${a.address}:${a.role === AccountRole.READONLY ? "r" : a.role === AccountRole.WRITABLE ? "w" : "s"}`);
/** `sealed` null sends none. */
async function publishIx(program: string, genesis?: GenesisAccounts, album?: string, genesisMint: string | null = MINT,
  sealed: SealedTerms | null = programFeatures(program).royaltiesAndSeekerOnly ? OPEN : null) {
  const keys = await addresses(program, e.creator, e.nonce);
  const item: CoreMetadata = { ...e, program, edition: keys.edition, collection: keys.collection, ...(genesisMint ? { genesisMint } : {}) };
  if (!genesisMint) delete item.genesisMint;
  return instruction(item, e.creator, 1, URI, "a".repeat(64), album, genesis, sealed ?? undefined);
}
async function publishAccounts(program: string, genesis?: GenesisAccounts, album?: string, genesisMint: string | null = MINT) {
  return accountList(await publishIx(program, genesis, album, genesisMint));
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

// --- The royalty and Seeker-only setting ---------------------------------------------------------------
// A current deployment takes `royalty_bps` (u16) and `seeker_only` (bool) after `supply`, and on
// `collect` and `buy` the collector's Genesis Token accounts last, keying a claim made with one on its
// mint. The deployment before it (A1fn, which has the publisher's Genesis Token accounts) takes neither.
const TIMED_PROGRAM = "A1fnWjJD7LcHeksyVPiZrUhLoj6T78bEC24iGgf1SLAz";
const GENESIS: GenesisAccounts = { mint: MINT, token: TOKEN_ACCOUNT };
const failure = async (p: Promise<unknown>) => {
  try { await p; return null; } catch (error) { return error instanceof Error ? error.message : String(error); }
};
async function sealedTests() {
  const data = async (program: string, sealed?: SealedTerms | null) => [...(await publishIx(program, undefined, undefined, MINT, sealed)).data!];
  // The v1 arguments: discriminator, nonce, title, uri, both hashes, supply (185 bytes at an 8-byte title).
  const v1 = 8 + 32 + 4 + e.title.length + 4 + URI.length + 32 + 32 + 2;
  const sealed = await data(GENESIS_PROGRAM, { royaltyBps: 1000, seekerOnly: true });
  const before = await data(TIMED_PROGRAM);
  ok("three bytes more on a current program, the u16 royalty and the bool last, nothing before them moved",
    sealed.length === v1 + 3 && sealed.slice(-3).join() === "232,3,1" && sealed.slice(0, v1).join() === before.join());
  ok("0% and open to any wallet: three zero bytes", (await data(GENESIS_PROGRAM, { royaltyBps: 0, seekerOnly: false })).slice(v1).join() === "0,0,0");
  ok("the v1 arguments alone on the program before them, sent no terms or 0% and open",
    before.length === v1 && (await data(TIMED_PROGRAM, { royaltyBps: 0, seekerOnly: false })).join() === before.join());
  ok("refuses: no terms for a program that takes them",
    (await failure(publishIx(GENESIS_PROGRAM, undefined, undefined, MINT, null))) === "Invalid edition creation");
  for (const [name, royaltyBps] of [["over 10%", 1001], ["a fraction", 500.5], ["negative", -1]] as const)
    ok(`refuses: a royalty ${name}`,
      (await failure(publishIx(GENESIS_PROGRAM, undefined, undefined, MINT, { royaltyBps, seekerOnly: false }))) === ROYALTY_RANGE);
  ok("refuses: a royalty or Seeker-only for the program before them",
    (await failure(publishIx(TIMED_PROGRAM, undefined, undefined, MINT, OPEN))) === NO_ROYALTIES &&
    (await failure(publishIx(TIMED_PROGRAM, undefined, undefined, MINT, { royaltyBps: 0, seekerOnly: true }))) === NO_ROYALTIES);

  const keys = await addresses(GENESIS_PROGRAM, e.creator, e.nonce);
  const tokenReceipt = await claimReceiptAddress(GENESIS_PROGRAM, keys.edition, MINT);
  const publisherReceipt = async (seekerOnly: boolean, genesis?: GenesisAccounts) =>
    (await publishIx(GENESIS_PROGRAM, genesis, undefined, MINT, { ...OPEN, seekerOnly })).accounts![4].address;
  ok("the publisher's receipt is keyed on the sealed mint only on a Seeker-only edition with a Genesis Token",
    (await publisherReceipt(true, GENESIS)) === tokenReceipt && (await publisherReceipt(true)) === keys.receipt &&
    (await publisherReceipt(false, GENESIS)) === keys.receipt &&
    (await claimReceiptAddress(GENESIS_PROGRAM, keys.edition, e.creator)) === keys.receipt);

  const item = async (program: string): Promise<CoreMetadata> => {
    const k = await addresses(program, e.creator, e.nonce);
    return { ...e, program, edition: k.edition, collection: k.collection };
  };
  const claims = async (program: string, collector: string, genesis?: GenesisAccounts) => {
    const it = await item(program);
    return [await collectInstruction(it, collector, 2, genesis), await buyInstruction(it, collector, 2, 1_000_000n, 1, genesis)].map(accountList);
  };
  const collector = key(99);
  const walletReceipt = (await addresses(GENESIS_PROGRAM, e.creator, e.nonce, 2, collector)).receipt;
  const open = await claims(GENESIS_PROGRAM, collector);
  const held = await claims(GENESIS_PROGRAM, collector, GENESIS);
  ok("collect and buy end with the program id twice, read only, and use the wallet's receipt without a Genesis Token",
    open.map((a) => a.length).join() === "10,11" &&
    open.every((a) => a.slice(-2).join() === `${GENESIS_PROGRAM}:r,${GENESIS_PROGRAM}:r` && a[4] === `${walletReceipt}:w`));
  ok("with one they end with its mint and token account, read only, and the receipt is keyed on the mint",
    held.every((a, i) => a.length === open[i].length && a.slice(-2).join() === `${MINT}:r,${TOKEN_ACCOUNT}:r` && a[4] === `${tokenReceipt}:w`));
  const older = await claims(TIMED_PROGRAM, collector);
  ok("the program before them is sent neither: collect and buy end at System",
    older.map((a) => a.length).join() === "8,9" && older.every((a) => a[a.length - 1] === `${SYSTEM_PROGRAM}:r`));
  const olderItem = await item(TIMED_PROGRAM);
  ok("refuses: a Genesis Token on a claim for the program before them",
    (await failure(collectInstruction(olderItem, collector, 2, GENESIS))) === NO_ROYALTIES &&
    (await failure(buyInstruction(olderItem, collector, 2, 1_000_000n, 1, GENESIS))) === NO_ROYALTIES);
  const current = await item(GENESIS_PROGRAM);
  ok("the publisher is refused a claim, with or without a Genesis Token, as the program refuses it",
    (await failure(collectInstruction(current, e.creator, 2))) !== null &&
    (await failure(collectInstruction(current, e.creator, 2, GENESIS))) !== null &&
    (await failure(buyInstruction(current, e.creator, 2, 1_000_000n, 1, GENESIS))) !== null);
}

// --- The sealed attribute, through the collection reader ---------------------------------------------
// A Core `CollectionV1` encoded by hand in the layout `decodeCollection` reads: the base, the plugin
// header, the three plugin blobs the program writes and any `extras`, then the registry.
const u32le = (n: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; };
const u64le = (n: number) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n), true); return b; };
const text = (s: string) => { const bytes = new TextEncoder().encode(s); return concatBytes(u32le(bytes.length), bytes); };
const concatBytes = (...parts: Uint8Array[]) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let at = 0; for (const p of parts) { out.set(p, at); at += p.length; } return out; };
const state = { creator: address(e.creator), nonce: e.nonce, collection: OTHER, metadataHash: "c".repeat(64), imageHash: "d".repeat(64), supply: 3, minted: 1, title: "Sample", uri: URI };
const EDITION = e.edition;
/** One more plugin: its blob, discriminator first, and its registry authority (`None` unless given). */
type Extra = { blob: Uint8Array; authority?: Uint8Array };
function encodeCollection(attributes: { key: string; value: string }[], extras: Extra[] = []): Uint8Array {
  const base = concatBytes(new Uint8Array([5]), getAddressEncoder().encode(address(EDITION)) as Uint8Array, text(state.title), text(state.uri), u32le(1), u32le(1));
  const master = concatBytes(new Uint8Array([10, 1]), u32le(state.supply), new Uint8Array([0, 0])); // MasterEdition: Some(max_supply), None, None
  const immutable = new Uint8Array([12]);
  const attrs = concatBytes(new Uint8Array([6]), u32le(attributes.length), ...attributes.map((a) => concatBytes(text(a.key), text(a.value))));
  const plugins: Extra[] = [{ blob: master }, { blob: immutable }, { blob: attrs }, ...extras];
  let at = base.length + 1 + 8;
  const records = plugins.map(({ blob, authority = new Uint8Array([0]) }) => {
    const record = concatBytes(new Uint8Array([blob[0]]), authority, u64le(at));
    at += blob.length;
    return record;
  });
  const header = concatBytes(new Uint8Array([3]), u64le(at));
  const registry = concatBytes(new Uint8Array([4]), u32le(records.length), ...records, u32le(0));
  return concatBytes(base, header, ...plugins.map((p) => p.blob), registry);
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

// The `Royalties` plugin as the program writes it: `[0, u16 bps, u32 1, creator, 100, RuleSet::None]`.
const royalties = ({ bps = 500, creators = [{ creator: state.creator as string, share: 100 }], rules = new Uint8Array([0]) } = {}) =>
  concatBytes(new Uint8Array([0, bps & 255, bps >> 8]), u32le(creators.length),
    ...creators.map((c) => concatBytes(getAddressEncoder().encode(address(c.creator)) as Uint8Array, new Uint8Array([c.share]))), rules);
const royaltyOf = (...extras: Extra[]) => {
  try { return collectionRoyalty(verifyEditionCollection(encodeCollection(FIVE, extras), state, EDITION)); } catch { return undefined; }
};
ok("the program's Royalties plugin verifies and reads back, at 5% and at 0%; none reads as null",
  JSON.stringify(royaltyOf({ blob: royalties() })) === JSON.stringify({ basisPoints: 500, creator: state.creator }) &&
  royaltyOf({ blob: royalties({ bps: 0 }) })?.basisPoints === 0 && royaltyOf() === null);
for (const [name, extras] of [
  ["a second one", [{ blob: royalties() }, { blob: royalties() }]],
  ["a plugin authority other than None", [{ blob: royalties(), authority: new Uint8Array([2]) }]],
  ["an allow list", [{ blob: royalties({ rules: concatBytes(new Uint8Array([1]), u32le(0)) }) }]],
  ["a deny list", [{ blob: royalties({ rules: concatBytes(new Uint8Array([2]), u32le(1), getAddressEncoder().encode(OTHER) as Uint8Array) }) }]],
  ["no creator", [{ blob: royalties({ creators: [] }) }]],
  ["two creators", [{ blob: royalties({ creators: [{ creator: state.creator, share: 50 }, { creator: OTHER, share: 50 }] }) }]],
  ["the creator at 99%", [{ blob: royalties({ creators: [{ creator: state.creator, share: 99 }] }) }]],
  ["over 10%", [{ blob: royalties({ bps: 1001 }) }]],
  ["a creator other than the publisher", [{ blob: royalties({ creators: [{ creator: OTHER, share: 100 }] }) }]],
] as const)
  ok(`refuses: a Royalties plugin with ${name}`, royaltyOf(...extras) === undefined);

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
await sealedTests();
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
await collectorChecks();
}

// --- A collector's token, for a seeker-only claim (`findHeldGenesisToken`, `seekerClaim.ts`) -------
const STAND_IN = address(DEVNET_GENESIS_GROUP);
const standInAt = (mint: Address, memberNumber: bigint): Held =>
  ({ owner: TOKEN_2022, data: mintBytes(null, [pointer(STAND_IN), member(STAND_IN, mint, memberNumber)]) });
const heldIn = (mint: string, token: string, owner: string = HOLDER, amount = "1") => {
  const row = walletRow(mint, amount);
  return { ...row, pubkey: token, account: { ...row.account, data: { ...row.account.data, parsed: { ...row.account.data.parsed, info: { ...row.account.data.parsed.info, owner } } } } };
};
async function collectorChecks() {
  const [A, B, N, TA, TB] = [31, 32, 33, 34, 35].map(key);
  const both = (): Chain => ({
    wallet: [heldIn(A, TA), heldIn(B, TB), heldIn(N, key(36)), heldIn(key(37), key(38), HOLDER, "0")],
    accounts: { [A]: standInAt(A, 5n), [B]: sgtAt(B, 3n), [N]: plainAt() },
  });
  stub(both());
  const found = await findHeldGenesisToken("https://collector.invalid", HOLDER, "mainnet-beta");
  ok("collector: on mainnet, the real SGT and the account it sits in, once mainnet says it is mainnet",
    found?.mint === B && found.token === TB && calls[0] === "getGenesisHash"
      && asked() === "getTokenAccountsByOwner,getAccountInfo,getAccountInfo,getAccountInfo");
  stub(both());
  const standIn = await findHeldGenesisToken("https://devnet-collector.invalid", HOLDER, "devnet");
  ok("collector: on devnet, the acceptance's stand-in and never a real SGT, with no mainnet check",
    standIn?.mint === A && standIn.token === TA && !calls.includes("getGenesisHash"));
  stub({ wallet: [heldIn(A, TA)], accounts: { [A]: standInAt(A, 5n) } });
  ok("collector: a stand-in is no SGT on mainnet", (await findHeldGenesisToken("https://collector.invalid", HOLDER, "mainnet-beta")) === null);
  stub({ wallet: [heldIn(B, TB), heldIn(A, TA)], accounts: { [A]: sgtAt(A, 9n), [B]: sgtAt(B, 3n) } });
  ok("collector: the lowest member number, or the one known by the wallet while it is still held",
    (await findHeldGenesisToken("https://collector.invalid", HOLDER, "mainnet-beta"))?.mint === B
      && (await findHeldGenesisToken("https://collector.invalid", HOLDER, "mainnet-beta", A))?.mint === A);
  stub({ wallet: [heldIn(B, TB, OTHER)], accounts: { [B]: sgtAt(B, 3n) } });
  ok("collector: an account of another owner's is not a holding, and costs no mint read",
    (await findHeldGenesisToken("https://collector.invalid", HOLDER, "mainnet-beta")) === null && asked() === "getTokenAccountsByOwner");
  stub({ wallet: [heldIn(key(37), key(38), HOLDER, "0")], accounts: {} });
  ok("collector: nothing held, no mint reads", (await findHeldGenesisToken("https://collector.invalid", HOLDER, "mainnet-beta")) === null
    && asked() === "getTokenAccountsByOwner");
  const crowd = Array.from({ length: MAX_GENESIS_CANDIDATES + 1 }, (_, i) => key(60 + i));
  stub({ wallet: crowd.map((mint) => heldIn(mint, mint)), accounts: {} });
  ok(`collector: more than ${MAX_GENESIS_CANDIDATES} candidates throws, never reads as none`,
    await rejects(findHeldGenesisToken("https://collector.invalid", HOLDER, "mainnet-beta")) && asked() === "getTokenAccountsByOwner");
  stub({ ...both(), fail: true });
  ok("collector: an RPC failure throws", await rejects(findHeldGenesisToken("https://collector-down.invalid", HOLDER, "devnet")));
  stub({ genesisHash: DEVNET_HASH, ...both() });
  ok("collector: a mainnet lookup on another cluster throws", await rejects(findHeldGenesisToken("https://wrong.invalid", HOLDER, "mainnet-beta")));

  // The claim: keyed on the token for a seeker-only edition, on the wallet otherwise.
  const PROGRAM = key(40);
  const keys = await addresses(PROGRAM, e.creator, e.nonce);
  const open: CoreMetadata = { ...e, program: PROGRAM, edition: keys.edition, collection: keys.collection };
  // The rule is read off the Edition beside the metadata; the claim is the same record either way.
  const seekerOnly = open;
  stub(both());
  ok("an open edition's claim carries no token and asks nothing",
    (await claimGenesis("https://devnet-collector.invalid", "devnet", false, HOLDER)) === undefined && calls.length === 0);
  stub(both());
  const token = await claimGenesis("https://devnet-collector.invalid", "devnet", true, HOLDER);
  ok("a seeker-only claim carries the collector's token, the stand-in on devnet", token?.mint === A && token.token === TA);
  stub({ wallet: [], accounts: {} });
  ok("a seeker-only claim without a token is null", (await claimGenesis("https://devnet-collector.invalid", "devnet", true, HOLDER)) === null);
  const disc = sha256(new TextEncoder().encode("account:Receipt")).slice(0, 8);
  const u16 = (n: number) => new Uint8Array([n & 255, n >> 8]);
  const print2 = (await addresses(PROGRAM, e.creator, e.nonce, 2)).print;
  const receipt = (edition: string, collector: string, asset: string) => ({ owner: PROGRAM, data: concatBytes(disc,
    getAddressEncoder().encode(address(edition)) as Uint8Array, getAddressEncoder().encode(address(collector)) as Uint8Array,
    getAddressEncoder().encode(address(asset)) as Uint8Array, u16(2)) });
  const byToken = await claimReceiptAddress(PROGRAM, keys.edition, A);
  const byWallet = await claimReceiptAddress(PROGRAM, keys.edition, HOLDER);
  stub({ accounts: { [byToken]: receipt(keys.edition, OTHER, print2) } });
  ok("a seeker-only edition's claim is the token's receipt, whichever wallet made it",
    (await claimedCopy("https://devnet-collector.invalid", seekerOnly, HOLDER, token))?.number === 2);
  stub({ accounts: { [byWallet]: receipt(keys.edition, HOLDER, print2) } });
  ok("on a seeker-only edition the wallet's own receipt is not the token's claim, and no token is no claim",
    (await claimedCopy("https://devnet-collector.invalid", seekerOnly, HOLDER, token)) === null
      && (await claimedCopy("https://devnet-collector.invalid", seekerOnly, HOLDER, null)) === null);
  stub({ accounts: { [byToken]: receipt(OTHER, OTHER, print2) } });
  ok("a token's receipt naming another edition throws", await rejects(claimedCopy("https://devnet-collector.invalid", seekerOnly, HOLDER, token)));
  stub({ accounts: { [byToken]: receipt(keys.edition, OTHER, OTHER) } });
  ok("a token's receipt naming a print that is not the canonical one throws", await rejects(claimedCopy("https://devnet-collector.invalid", seekerOnly, HOLDER, token)));
  stub({ accounts: { [byToken]: { ...receipt(keys.edition, OTHER, print2), owner: OTHER } } });
  ok("a token's receipt owned by another program throws", await rejects(claimedCopy("https://devnet-collector.invalid", seekerOnly, HOLDER, token)));
  stub({ accounts: { [byWallet]: receipt(keys.edition, HOLDER, print2) } });
  ok("an open edition's claim is still the wallet's", (await claimedCopy("https://devnet-collector.invalid", open, HOLDER, undefined))?.number === 2);
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
