/**
 * Core Candy Machine, Core Candy Guard and Metaplex Core instructions on `@solana/kit`,
 * hand-written from github.com/metaplex-foundation/mpl-core-candy-machine and mpl-core (the only
 * published client is Umi). Candy programs are Anchor 0.28: instruction = sha256("global:<name>")
 * [..8] + Borsh args; account = sha256("account:<Name>")[..8] + data. Core: one-byte Shank variant
 * + Borsh. Signing accounts take `TransactionSigner`s so the signer travels in the account meta.
 */

import {
  AccountRole,
  address,
  getAddressEncoder,
  getProgramDerivedAddress,
  type AccountMeta,
  type AccountSignerMeta,
  type Address,
  type Instruction,
  type TransactionSigner,
} from "@solana/kit";
import { sha256 } from "@noble/hashes/sha2.js";
import { Reader, decodeGuardData, encodeGuardData, type GuardData } from "./guards";

export const CANDY_MACHINE_PROGRAM = address("CMACYFENjoBMHzapRXyo1JZkVS6EtaDDzkjMrmQLvr4J");
export const CANDY_GUARD_PROGRAM = address("CMAGAKJ67e9hRZgfC5SFTbZH8MgEmtqazKXjmkaJjWTJ");
export const MPL_CORE = address("CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d");
export const SYSTEM_PROGRAM = address("11111111111111111111111111111111");
export const TOKEN_PROGRAM = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const SYSVAR_INSTRUCTIONS = address("Sysvar1nstructions1111111111111111111111111");
export const SYSVAR_SLOT_HASHES = address("SysvarS1otHashes111111111111111111111111111");

/** Token Metadata's limits, which the candy machine applies to hidden-settings names and URIs. */
export const MAX_NAME_LENGTH = 32;
export const MAX_URI_LENGTH = 200;
/** Hidden settings means no config lines: just `HIDDEN_SECTION` (`candy-machine-core/src/constants.rs`). */
export const CANDY_MACHINE_HIDDEN_BYTES = 8 + 32 + 32 + 32 + 8 + 8 + 8 + 1 + 1 + (4 + MAX_NAME_LENGTH) + 4 +
  (4 + MAX_URI_LENGTH) + 4 + 1 + 1 + (4 + MAX_NAME_LENGTH) + (4 + MAX_URI_LENGTH) + 32;
/** Candy guard header: discriminator, base, bump, authority. */
export const CANDY_GUARD_HEADER = 8 + 32 + 1 + 32;
/** A mint-limit counter is a bare u16. */
export const MINT_COUNTER_BYTES = 2;

// --- Bytes ---

const utf8 = (s: string) => new TextEncoder().encode(s);
const concat = (...parts: readonly Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};
const keyBytes = (a: Address) => new Uint8Array(getAddressEncoder().encode(a));
const range = (n: number, max: number, what: string) => {
  if (!Number.isInteger(n) || n < 0 || n > max) throw new Error(`${what} out of range`);
  return n;
};
const u8 = (n: number) => new Uint8Array([range(n, 0xff, "u8")]);
const u16 = (n: number) => { range(n, 0xffff, "u16"); return new Uint8Array([n & 255, n >>> 8]); };
const u32 = (n: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, range(n, 0xffff_ffff, "u32"), true); return b; };
const u64 = (n: bigint) => {
  if (typeof n !== "bigint" || n < 0n || n > 0xffff_ffff_ffff_ffffn) throw new Error("u64 out of range");
  const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, n, true); return b;
};
const str = (s: string) => { const b = utf8(s); return concat(u32(b.length), b); };
const vecBytes = (b: Uint8Array) => concat(u32(b.length), b);
const none = u8(0);
const some = (b: Uint8Array) => concat(u8(1), b);
const anchor = (s: string) => sha256(utf8(s)).slice(0, 8);

const DISC = {
  cmInitialize: anchor("global:initialize"),
  cmUpdate: anchor("global:update"),
  cmSetAuthority: anchor("global:set_authority"),
  cmWithdraw: anchor("global:withdraw"),
  guardInitialize: anchor("global:initialize"),
  guardUpdate: anchor("global:update"),
  guardWrap: anchor("global:wrap"),
  guardUnwrap: anchor("global:unwrap"),
  guardMint: anchor("global:mint_v1"),
  guardWithdraw: anchor("global:withdraw"),
  guardSetAuthority: anchor("global:set_authority"),
  candyMachine: anchor("account:CandyMachine"),
  candyGuard: anchor("account:CandyGuard"),
};

// Account metas.
const ro = (a: Address): AccountMeta => ({ address: a, role: AccountRole.READONLY });
const w = (a: Address): AccountMeta => ({ address: a, role: AccountRole.WRITABLE });
const rs = (s: TransactionSigner): AccountSignerMeta => ({ address: s.address, role: AccountRole.READONLY_SIGNER, signer: s });
const ws = (s: TransactionSigner): AccountSignerMeta => ({ address: s.address, role: AccountRole.WRITABLE_SIGNER, signer: s });

// --- Addresses ---

/** The candy machine's authority PDA, `["candy_machine", candy machine]`: the collection's update delegate. */
export const candyMachineAuthorityPda = async (candyMachine: Address) =>
  (await getProgramDerivedAddress({ programAddress: CANDY_MACHINE_PROGRAM, seeds: [utf8("candy_machine"), keyBytes(candyMachine)] }))[0];

/** The candy guard, `["candy_guard", base]`; the base here is the candy machine's key. */
export const candyGuardAddress = async (base: Address) =>
  (await getProgramDerivedAddress({ programAddress: CANDY_GUARD_PROGRAM, seeds: [utf8("candy_guard"), keyBytes(base)] }))[0];

/** A wallet's mint-limit counter, `["mint_limit", id, minter, candy guard, candy machine]`. */
export const mintCounterAddress = async (id: number, minter: Address, candyGuard: Address, candyMachine: Address) =>
  (await getProgramDerivedAddress({
    programAddress: CANDY_GUARD_PROGRAM,
    seeds: [utf8("mint_limit"), u8(id), keyBytes(minter), keyBytes(candyGuard), keyBytes(candyMachine)],
  }))[0];

/** The classic SPL Token associated account (the Token Payment guard accepts only classic SPL Token). */
export const associatedTokenAddress = async (owner: Address, mint: Address) =>
  (await getProgramDerivedAddress({
    programAddress: address("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"),
    seeds: [keyBytes(owner), keyBytes(TOKEN_PROGRAM), keyBytes(mint)],
  }))[0];

// --- Metaplex Core ---

/** Core's `Authority`: None 0, Owner 1, UpdateAuthority 2, Address 3. */
export type CoreAuthority = { kind: "None" } | { kind: "Owner" } | { kind: "UpdateAuthority" } | { kind: "Address"; address: Address };
const authority = (a: CoreAuthority) =>
  a.kind === "None" ? u8(0) : a.kind === "Owner" ? u8(1) : a.kind === "UpdateAuthority" ? u8(2) : concat(u8(3), keyBytes(a.address));

/** `Plugin::Royalties` (variant 0) with `RuleSet::None`. */
const royaltiesPlugin = (basisPoints: number, creators: readonly { address: Address; percentage: number }[]) =>
  concat(u8(0), u16(basisPoints), u32(creators.length), ...creators.map((c) => concat(keyBytes(c.address), u8(c.percentage))), u8(0));
/** `Plugin::MasterEdition` (variant 10): `max_supply: Option<u32>`, `name`/`uri: Option<String>` left None. */
const masterEditionPlugin = (maxSupply: number) => concat(u8(10), some(u32(maxSupply)), none, none);

export interface CollectionTerms {
  name: string;
  uri: string;
  maxSupply: number;
  royaltyBasisPoints: number;
  creators: readonly { address: Address; percentage: number }[];
  /** Authority over the MasterEdition and Royalties plugins; `None` makes them permanent. */
  pluginAuthority: CoreAuthority;
}

/**
 * Core `CreateCollectionV1` (variant 1): `name`, `uri`, `plugins: Option<Vec<PluginAuthorityPair>>`.
 * Accounts: collection (writable signer), update authority, payer (writable signer), System.
 */
export function createCollectionInstruction(input: {
  collection: TransactionSigner; updateAuthority: Address; payer: TransactionSigner; terms: CollectionTerms;
}): Instruction {
  const t = input.terms;
  const pair = (plugin: Uint8Array) => concat(plugin, some(authority(t.pluginAuthority)));
  return {
    programAddress: MPL_CORE,
    accounts: [ws(input.collection), ro(input.updateAuthority), ws(input.payer), ro(SYSTEM_PROGRAM)],
    data: concat(u8(1), str(t.name), str(t.uri),
      some(concat(u32(2), pair(masterEditionPlugin(t.maxSupply)), pair(royaltiesPlugin(t.royaltyBasisPoints, t.creators))))),
  };
}

/**
 * Core `UpdateCollectionV1` (variant 16): `new_name`, `new_uri: Option<String>`; a new update
 * authority travels as account 3. Absent optional accounts are Core's own address.
 */
export function updateCollectionInstruction(input: {
  collection: Address; authority: TransactionSigner; payer: TransactionSigner;
  newName?: string; newUri?: string; newUpdateAuthority?: Address;
}): Instruction {
  return {
    programAddress: MPL_CORE,
    accounts: [w(input.collection), ws(input.payer), rs(input.authority),
      ro(input.newUpdateAuthority ?? MPL_CORE), ro(SYSTEM_PROGRAM), ro(MPL_CORE)],
    data: concat(u8(16), input.newName === undefined ? none : some(str(input.newName)),
      input.newUri === undefined ? none : some(str(input.newUri))),
  };
}

/**
 * Core `AddCollectionPluginV1` (variant 3) adding `Plugin::VerifiedCreators` (13) with one entry,
 * `{creator, verified: true}`, and the default authority (UpdateAuthority). Core accepts a
 * verified entry only when that creator is the signing authority.
 */
export const addVerifiedCreatorInstruction = (input: { collection: Address; creator: TransactionSigner; payer: TransactionSigner }): Instruction => ({
  programAddress: MPL_CORE,
  accounts: [w(input.collection), ws(input.payer), rs(input.creator), ro(SYSTEM_PROGRAM), ro(MPL_CORE)],
  data: concat(u8(3), u8(13), u32(1), keyBytes(input.creator.address), u8(1), none),
});

// --- Core Candy Machine ---

export interface HiddenSettings { name: string; uri: string; hash: Uint8Array }
export interface CandyMachineData { itemsAvailable: bigint; maxSupply: bigint; isMutable: boolean; hidden: HiddenSettings }

/** `CandyMachineData` with `config_line_settings: None` and hidden settings. */
function candyMachineData(d: CandyMachineData) {
  if (d.hidden.hash.length !== 32) throw new Error("Hidden settings hash is 32 bytes");
  return concat(u64(d.itemsAvailable), u64(d.maxSupply), u8(d.isMutable ? 1 : 0), none,
    some(concat(str(d.hidden.name), str(d.hidden.uri), d.hidden.hash)));
}

/**
 * `initialize`. The account must already exist, program-owned and zeroed, at least
 * `CANDY_MACHINE_HIDDEN_BYTES`. Adds the authority PDA as the collection's UpdateDelegate, so the
 * collection's update authority signs.
 */
export async function initializeCandyMachineInstruction(input: {
  candyMachine: Address; authority: Address; payer: TransactionSigner; collection: Address;
  collectionUpdateAuthority: TransactionSigner; data: CandyMachineData;
}): Promise<Instruction> {
  return {
    programAddress: CANDY_MACHINE_PROGRAM,
    accounts: [w(input.candyMachine), w(await candyMachineAuthorityPda(input.candyMachine)), ro(input.authority),
      ws(input.payer), w(input.collection), ws(input.collectionUpdateAuthority), ro(MPL_CORE), ro(SYSTEM_PROGRAM),
      ro(SYSVAR_INSTRUCTIONS)],
    data: concat(DISC.cmInitialize, candyMachineData(input.data)),
  };
}

/** `update`: replaces the whole `CandyMachineData` (with hidden settings, `items_available` may change). */
export const updateCandyMachineInstruction = (input: { candyMachine: Address; authority: TransactionSigner; data: CandyMachineData }): Instruction => ({
  programAddress: CANDY_MACHINE_PROGRAM,
  accounts: [w(input.candyMachine), rs(input.authority)],
  data: concat(DISC.cmUpdate, candyMachineData(input.data)),
});

export const setCandyMachineAuthorityInstruction = (input: { candyMachine: Address; authority: TransactionSigner; newAuthority: Address }): Instruction => ({
  programAddress: CANDY_MACHINE_PROGRAM,
  accounts: [w(input.candyMachine), rs(input.authority)],
  data: concat(DISC.cmSetAuthority, keyBytes(input.newAuthority)),
});

/** `withdraw`: closes the candy machine; its lamports go to the authority. */
export const withdrawCandyMachineInstruction = (input: { candyMachine: Address; authority: TransactionSigner }): Instruction => ({
  programAddress: CANDY_MACHINE_PROGRAM,
  accounts: [w(input.candyMachine), ws(input.authority)],
  data: DISC.cmWithdraw,
});

// --- Core Candy Guard ---

/** `initialize(data: Vec<u8>)`: creates the guard PDA of `base`, sized to the data. */
export async function initializeCandyGuardInstruction(input: {
  base: TransactionSigner; authority: Address; payer: TransactionSigner; guards: GuardData;
}): Promise<Instruction> {
  return {
    programAddress: CANDY_GUARD_PROGRAM,
    accounts: [w(await candyGuardAddress(input.base.address)), rs(input.base), ro(input.authority), ws(input.payer), ro(SYSTEM_PROGRAM)],
    data: concat(DISC.guardInitialize, vecBytes(encodeGuardData(input.guards))),
  };
}

/**
 * `update(data: Vec<u8>)`: replaces every guard and resizes the account; the payer covers or
 * receives the rent difference (so it is writable, though the IDL leaves it unmarked).
 */
export const updateCandyGuardInstruction = (input: {
  candyGuard: Address; authority: TransactionSigner; payer: TransactionSigner; guards: GuardData;
}): Instruction => ({
  programAddress: CANDY_GUARD_PROGRAM,
  accounts: [w(input.candyGuard), rs(input.authority), ws(input.payer), ro(SYSTEM_PROGRAM)],
  data: concat(DISC.guardUpdate, vecBytes(encodeGuardData(input.guards))),
});

/** `wrap`: makes the guard the candy machine's mint authority. */
export const wrapInstruction = (input: {
  candyGuard: Address; guardAuthority: TransactionSigner; candyMachine: Address; candyMachineAuthority: TransactionSigner;
}): Instruction => ({
  programAddress: CANDY_GUARD_PROGRAM,
  accounts: [ro(input.candyGuard), rs(input.guardAuthority), w(input.candyMachine), ro(CANDY_MACHINE_PROGRAM), rs(input.candyMachineAuthority)],
  data: DISC.guardWrap,
});

export const unwrapInstruction = (input: {
  candyGuard: Address; guardAuthority: TransactionSigner; candyMachine: Address; candyMachineAuthority: TransactionSigner;
}): Instruction => ({
  programAddress: CANDY_GUARD_PROGRAM,
  accounts: [ro(input.candyGuard), rs(input.guardAuthority), w(input.candyMachine), rs(input.candyMachineAuthority), ro(CANDY_MACHINE_PROGRAM)],
  data: DISC.guardUnwrap,
});

/** `withdraw`: closes the guard; its lamports go to the authority. */
export const withdrawCandyGuardInstruction = (input: { candyGuard: Address; authority: TransactionSigner }): Instruction => ({
  programAddress: CANDY_GUARD_PROGRAM,
  accounts: [w(input.candyGuard), ws(input.authority)],
  data: DISC.guardWithdraw,
});

export const setCandyGuardAuthorityInstruction = (input: { candyGuard: Address; authority: TransactionSigner; newAuthority: Address }): Instruction => ({
  programAddress: CANDY_GUARD_PROGRAM,
  accounts: [w(input.candyGuard), rs(input.authority)],
  data: concat(DISC.guardSetAuthority, keyBytes(input.newAuthority)),
});

export interface MintInput {
  candyMachine: Address;
  candyGuard: Address;
  collection: Address;
  /** The guard data (no groups): it decides the remaining accounts. */
  guards: GuardData;
  /** Pays the SOL price, the counter's and the copy's lamports; signs. */
  payer: TransactionSigner;
  /** Validated by the guards (address gate, mint limit, token payment source); signs; receives the copy. */
  minter: TransactionSigner;
  /** A fresh keypair: the new Core asset's address. */
  asset: TransactionSigner;
  /** The Third Party Signer guard's key, when the active set has one. */
  cosigner?: TransactionSigner;
  /** The minter's classic SPL token account paying a Token Payment price. */
  paymentSource?: Address;
}

/**
 * `mint_v1(mint_args: Vec<u8>, label: None)`. Remaining accounts in `GuardSet` order: Sol Payment
 * (destination, w), Token Payment (source, destination ATA, Token program), Third Party Signer
 * (signer), Mint Limit (counter PDA, w); Edition takes none. `owner` absent, so the copy goes to the minter.
 */
export async function mintInstruction(input: MintInput): Promise<Instruction> {
  if (input.guards.groups.length) throw new Error("Guard groups are not used here");
  const set = input.guards.default;
  const remaining: AccountMeta[] = [];
  if (set.solPayment) remaining.push(w(set.solPayment.destination));
  if (set.tokenPayment) {
    if (!input.paymentSource) throw new Error("A token price needs the minter's token account");
    remaining.push(w(input.paymentSource), w(set.tokenPayment.destinationAta), ro(TOKEN_PROGRAM));
  }
  if (set.thirdPartySigner) {
    if (input.cosigner?.address !== set.thirdPartySigner.signerKey) throw new Error("This edition needs its co-signer");
    remaining.push(rs(input.cosigner));
  }
  if (set.mintLimit)
    remaining.push(w(await mintCounterAddress(set.mintLimit.id, input.minter.address, input.candyGuard, input.candyMachine)));
  return {
    programAddress: CANDY_GUARD_PROGRAM,
    accounts: [
      ro(input.candyGuard), ro(CANDY_MACHINE_PROGRAM), w(input.candyMachine),
      w(await candyMachineAuthorityPda(input.candyMachine)), ws(input.payer), ws(input.minter),
      ro(CANDY_GUARD_PROGRAM), ws(input.asset), w(input.collection), ro(MPL_CORE), ro(SYSTEM_PROGRAM),
      ro(SYSVAR_INSTRUCTIONS), ro(SYSVAR_SLOT_HASHES), ...remaining,
    ],
    data: concat(DISC.guardMint, vecBytes(new Uint8Array(0)), none),
  };
}

// --- System and classic SPL Token ---

export const TOKEN_ACCOUNT_BYTES = 165;
const ATA_PROGRAM = address("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

/** System `CreateAccount` (0): lamports, space, owner. */
export const createAccountInstruction = (payer: TransactionSigner, account: TransactionSigner, lamports: bigint, space: number, owner: Address): Instruction => ({
  programAddress: SYSTEM_PROGRAM,
  accounts: [ws(payer), ws(account)],
  data: concat(u32(0), u64(lamports), u64(BigInt(space)), keyBytes(owner)),
});

/** System `Transfer` (2). */
export const transferSolInstruction = (from: TransactionSigner, to: Address, lamports: bigint): Instruction => ({
  programAddress: SYSTEM_PROGRAM,
  accounts: [ws(from), w(to)],
  data: concat(u32(2), u64(lamports)),
});

/** System `Allocate` (8): gives a signer's empty, System-owned account `space` bytes of data. */
export const allocateInstruction = (account: TransactionSigner, space: number): Instruction => ({
  programAddress: SYSTEM_PROGRAM,
  accounts: [ws(account)],
  data: concat(u32(8), u64(BigInt(space))),
});
/** The System program's ceiling for one account's data. */
export const MAX_ACCOUNT_BYTES = 10 * 1024 * 1024;

/** Associated Token `CreateIdempotent` (1) for a classic SPL Token mint. */
export async function createTokenAccountInstruction(payer: TransactionSigner, owner: Address, mint: Address): Promise<Instruction> {
  return {
    programAddress: ATA_PROGRAM,
    accounts: [ws(payer), w(await associatedTokenAddress(owner, mint)), ro(owner), ro(mint), ro(SYSTEM_PROGRAM), ro(TOKEN_PROGRAM)],
    data: u8(1),
  };
}

/** SPL Token `InitializeAccount3` (18): the account, its mint; the owner in the data. */
export const initializeTokenAccountInstruction = (account: Address, mint: Address, owner: Address): Instruction => ({
  programAddress: TOKEN_PROGRAM,
  accounts: [w(account), ro(mint)],
  data: concat(u8(18), keyBytes(owner)),
});

/** SPL Token `Transfer` (3). */
export const transferTokensInstruction = (source: Address, destination: Address, owner: TransactionSigner, amount: bigint): Instruction => ({
  programAddress: TOKEN_PROGRAM,
  accounts: [w(source), w(destination), rs(owner)],
  data: concat(u8(3), u64(amount)),
});

/** SPL Token `CloseAccount` (9): refused unless the token balance is zero. */
export const closeTokenAccountInstruction = (account: Address, destination: Address, owner: TransactionSigner): Instruction => ({
  programAddress: TOKEN_PROGRAM,
  accounts: [w(account), w(destination), rs(owner)],
  data: u8(9),
});

// --- Accounts ---

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

export interface CandyMachineAccount {
  authority: Address;
  mintAuthority: Address;
  collection: Address;
  itemsRedeemed: bigint;
  data: CandyMachineData;
}

export function decodeCandyMachine(bytes: Uint8Array): CandyMachineAccount {
  if (!sameBytes(bytes.subarray(0, 8), DISC.candyMachine)) throw new Error("Not a candy machine");
  const r = new Reader(bytes, 8);
  const authority = r.key();
  const mintAuthority = r.key();
  const collection = r.key();
  const itemsRedeemed = r.u64();
  const itemsAvailable = r.u64();
  const maxSupply = r.u64();
  const isMutable = r.u8() === 1;
  if (r.u8() !== 0) throw new Error("This candy machine uses config lines, not hidden settings");
  if (r.u8() !== 1) throw new Error("This candy machine has no hidden settings");
  const hidden = { name: r.str(), uri: r.str(), hash: new Uint8Array(r.raw(32)) };
  return { authority, mintAuthority, collection, itemsRedeemed, data: { itemsAvailable, maxSupply, isMutable, hidden } };
}

export interface CandyGuardAccount { base: Address; bump: number; authority: Address; guards: GuardData }

export function decodeCandyGuard(bytes: Uint8Array): CandyGuardAccount {
  if (!sameBytes(bytes.subarray(0, 8), DISC.candyGuard)) throw new Error("Not a candy guard");
  const r = new Reader(bytes, 8);
  return { base: r.key(), bump: r.u8(), authority: r.key(), guards: decodeGuardData(bytes, CANDY_GUARD_HEADER) };
}

