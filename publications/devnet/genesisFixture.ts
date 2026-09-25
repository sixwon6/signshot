/**
 * The Seeker Genesis Token stand-in for the devnet acceptance.
 *
 * No real SGT exists on devnet: only Solana Mobile's key can add a member to their group. The
 * devnet program build (`--features devnet-genesis`) therefore swaps Solana Mobile's addresses for
 * a test authority and a test group whose ed25519 seeds are public and reproducible — sha256 of
 * the two labels below — and this module builds what that authority would have minted, through
 * Token-2022's own instructions: a GROUP mint carrying `TokenGroup` under the test authority, and
 * a MEMBER mint with what a real SGT has (a `MetadataPointer` to the group mint, a
 * `TokenGroupMember` of it, which Token-2022 writes only with the group authority's signature),
 * minted once to its holder and frozen, as a held SGT is. The test authority also mints and
 * freezes; that is this fixture's convenience, not a property anything checks. `era_editions`
 * reads the results by hand; nothing here is special-cased for it.
 *
 * Devnet only, like everything in this directory. The keys are worthless by construction.
 */
import assert from "node:assert/strict";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  address,
  createKeyPairSignerFromPrivateKeyBytes,
  generateKeyPairSigner,
  some,
  type Address,
  type Instruction,
  type KeyPairSigner,
} from "@solana/kit";
import { getCreateAccountInstruction } from "@solana-program/system";
import {
  TOKEN_2022_PROGRAM_ADDRESS,
  extension,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  getFreezeAccountInstruction,
  getInitializeAccount3Instruction,
  getInitializeGroupMemberPointerInstruction,
  getInitializeGroupPointerInstruction,
  getInitializeMetadataPointerInstruction,
  getInitializeMint2Instruction,
  getInitializeTokenGroupInstruction,
  getInitializeTokenGroupMemberInstruction,
  getMintSize,
  getMintToInstruction,
  getThawAccountInstruction,
  getTokenSize,
  getTransferCheckedInstruction,
} from "@solana-program/token-2022";
import { request } from "../rpc";
import { isSeekerGenesisMint } from "../core/genesisToken";
import { guard, send, type Context } from "./work";

/** The labels `mod genesis` in `programs/editions/src/lib.rs` names beside each devnet key. */
const AUTHORITY_LABEL = "era_editions devnet genesis authority 2026-09-22";
const GROUP_LABEL = "era_editions devnet genesis group 2026-09-22";
/** The addresses the devnet program build carries. A mismatch here is a mismatch with the ELF. */
export const DEVNET_GENESIS_AUTHORITY = "AisKkoF5smX1dEmDayCnwuqG6h84W6wTZhuBbUKBdqM8";
export const DEVNET_GENESIS_GROUP = "CmJzRVDQjrj8NjAcN4qKuLNKwhWJVcPKsngfAWfu88WB";

const seed = (label: string) => sha256(new TextEncoder().encode(label));

export async function devnetGenesisKeys(): Promise<{ authority: KeyPairSigner; group: KeyPairSigner }> {
  const authority = await createKeyPairSignerFromPrivateKeyBytes(seed(AUTHORITY_LABEL));
  const group = await createKeyPairSignerFromPrivateKeyBytes(seed(GROUP_LABEL));
  assert.equal(authority.address, DEVNET_GENESIS_AUTHORITY, "The devnet genesis authority label changed");
  assert.equal(group.address, DEVNET_GENESIS_GROUP, "The devnet genesis group label changed");
  return { authority, group };
}

const rent = (c: Pick<Context, "endpoint">, space: number) =>
  request<number>(c.endpoint, "getMinimumBalanceForRentExemption", [space]);

/** The Token-2022 associated token account of `owner` for `mint`. */
export async function genesisTokenAccount(owner: Address, mint: Address): Promise<Address> {
  const [ata] = await findAssociatedTokenPda({ owner, mint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS });
  return ata;
}

/**
 * The group mint, once per cluster: `GroupPointer` to itself and a `TokenGroup` under the test
 * authority. Empty when it already exists, whichever session made it.
 */
export async function groupInstructions(
  c: Context,
  keys: { authority: KeyPairSigner; group: KeyPairSigner },
): Promise<Instruction[]> {
  const { value: existing } = await request<{ value: null | { owner: string } }>(
    c.endpoint, "getAccountInfo", [keys.group.address, { encoding: "base64", commitment: "confirmed" }],
  );
  if (existing) {
    assert.equal(existing.owner, TOKEN_2022_PROGRAM_ADDRESS, "The devnet genesis group address is not a Token-2022 mint");
    return [];
  }
  const group = keys.group.address;
  const authority = keys.authority.address;
  const pointer = extension("GroupPointer", { authority: some(authority), groupAddress: some(group) });
  // Token-2022 refuses InitializeMint2 unless the account is exactly as long as the extensions
  // initialized so far (`_process_initialize_mint`, InvalidAccountData), and InitializeTokenGroup
  // grows it for the `TokenGroup` itself. So the account starts at the fixed-size length, with rent
  // already paid for the final one.
  const space = getMintSize([pointer]);
  const full = getMintSize([
    pointer,
    extension("TokenGroup", { updateAuthority: some(authority), mint: group, size: 0n, maxSize: 1000n }),
  ]);
  return [
    getCreateAccountInstruction({
      payer: c.payer, newAccount: keys.group, lamports: await rent(c, full), space,
      programAddress: TOKEN_2022_PROGRAM_ADDRESS,
    }),
    getInitializeGroupPointerInstruction({ mint: group, authority: some(authority), groupAddress: some(group) }),
    getInitializeMint2Instruction({ mint: group, decimals: 0, mintAuthority: authority, freezeAuthority: some(authority) }),
    getInitializeTokenGroupInstruction({
      group, mint: group, mintAuthority: keys.authority, updateAuthority: some(authority), maxSize: 1000n,
    }),
  ];
}

/**
 * One member mint with the SGT's extensions, and `holder`'s frozen token account holding its one
 * unit, all paid by the session payer. The holder is the publisher unless named. Two transactions'
 * worth: this one creates and holds; `foilInstructions` builds the accounts the refusals need.
 */
export async function memberInstructions(
  c: Context,
  keys: { authority: KeyPairSigner; group: KeyPairSigner },
  member: KeyPairSigner,
  holder: Address = c.payer.address,
): Promise<Instruction[]> {
  const group = keys.group.address;
  const authority = keys.authority.address;
  const mint = member.address;
  const fixed = [
    extension("MetadataPointer", { authority: some(authority), metadataAddress: some(group) }),
    extension("GroupMemberPointer", { authority: some(authority), memberAddress: some(mint) }),
  ];
  // As in `groupInstructions`: InitializeTokenGroupMember grows the account for its own extension.
  const space = getMintSize(fixed);
  const full = getMintSize([...fixed, extension("TokenGroupMember", { mint, group, memberNumber: 0n })]);
  const held = await genesisTokenAccount(holder, mint);
  return [
    getCreateAccountInstruction({
      payer: c.payer, newAccount: member, lamports: await rent(c, full), space,
      programAddress: TOKEN_2022_PROGRAM_ADDRESS,
    }),
    getInitializeMetadataPointerInstruction({ mint, authority: some(authority), metadataAddress: some(group) }),
    getInitializeGroupMemberPointerInstruction({ mint, authority: some(authority), memberAddress: some(mint) }),
    getInitializeMint2Instruction({ mint, decimals: 0, mintAuthority: authority, freezeAuthority: some(authority) }),
    getInitializeTokenGroupMemberInstruction({
      member: mint, memberMint: mint, memberMintAuthority: keys.authority, group, groupUpdateAuthority: keys.authority,
    }),
    getCreateAssociatedTokenIdempotentInstruction({
      payer: c.payer, ata: held, owner: holder, mint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
    }),
    getMintToInstruction({ mint, token: held, mintAuthority: keys.authority, amount: 1n }),
    // A held Genesis Token is frozen. The program must accept a frozen account.
    getFreezeAccountInstruction({ account: held, mint, owner: keys.authority }),
  ];
}

/**
 * What the refusals need: another wallet's account holding one unit of the same mint, and an
 * EMPTY account of the publisher's own, at a fresh keypair rather than the ATA the held unit sits in.
 */
export async function foilInstructions(
  c: Context,
  keys: { authority: KeyPairSigner },
  mint: Address,
  other: Address,
  empty: KeyPairSigner,
): Promise<Instruction[]> {
  const theirs = await genesisTokenAccount(other, mint);
  const space = getTokenSize([]);
  return [
    getCreateAssociatedTokenIdempotentInstruction({
      payer: c.payer, ata: theirs, owner: other, mint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
    }),
    getMintToInstruction({ mint, token: theirs, mintAuthority: keys.authority, amount: 1n }),
    getCreateAccountInstruction({
      payer: c.payer, newAccount: empty, lamports: await rent(c, space), space,
      programAddress: TOKEN_2022_PROGRAM_ADDRESS,
    }),
    getInitializeAccount3Instruction({ account: empty.address, mint, owner: c.payer.address }),
  ];
}

/**
 * A held stand-in sent on to another wallet: the test authority thaws the holder's account,
 * the holder signs `TransferChecked` into `to`'s account, and the authority freezes that one.
 */
export async function moveInstructions(
  c: Context,
  keys: { authority: KeyPairSigner },
  mint: Address,
  from: KeyPairSigner,
  to: Address,
): Promise<Instruction[]> {
  const source = await genesisTokenAccount(from.address, mint);
  const destination = await genesisTokenAccount(to, mint);
  return [
    getCreateAssociatedTokenIdempotentInstruction({
      payer: c.payer, ata: destination, owner: to, mint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
    }),
    getThawAccountInstruction({ account: source, mint, owner: keys.authority }),
    getTransferCheckedInstruction({ source, mint, destination, authority: from, amount: 1n, decimals: 0 }),
    getFreezeAccountInstruction({ account: destination, mint, owner: keys.authority }),
  ];
}

/**
 * The member mint, read back through the app's own decoder with the devnet addresses in place of
 * Solana Mobile's: the same bytes the program accepts must be the bytes the client calls an SGT.
 */
export async function assertMemberDecodes(c: Pick<Context, "endpoint">, mint: Address) {
  const { value } = await request<{ value: null | { owner: string; data: [string, string] } }>(
    c.endpoint, "getAccountInfo", [mint, { encoding: "base64", commitment: "confirmed" }],
  );
  assert.ok(value && value.owner === TOKEN_2022_PROGRAM_ADDRESS, "The member mint is not a Token-2022 account");
  const bytes = new Uint8Array(Buffer.from(value.data[0], "base64"));
  assert.equal(
    isSeekerGenesisMint(bytes, mint, { metadataAddress: DEVNET_GENESIS_GROUP, groupAddress: DEVNET_GENESIS_GROUP }),
    true,
    "The client's decoder does not read the devnet member mint the program accepts",
  );
  assert.equal(isSeekerGenesisMint(bytes, mint), false, "The devnet stand-in must never read as a real SGT");
}

interface StandInContext extends Context {
  /** Each holder's stand-in until it confirms, so a retried `stand-in` resolves the same send. */
  standIns?: Record<string, KeyPairSigner>;
}

/**
 * `stand-in <wallet>` in `session.ts`: a fresh member mint held frozen by `wallet`, paid by the
 * session payer. Needs no deployment: the group is the fixture's, the same for every devnet build.
 */
export async function standIn(c: StandInContext, wallet: string) {
  const holder = address(wallet);
  await guard(c);
  const keys = await devnetGenesisKeys();
  const group = await groupInstructions(c, keys);
  if (group.length) await send(c, group, [c.payer, keys.group, keys.authority]);
  const pending = (c.standIns ??= {});
  const member = (pending[holder] ??= await generateKeyPairSigner());
  await send(c, await memberInstructions(c, keys, member, holder), [c.payer, member, keys.authority]);
  delete pending[holder];
  await assertMemberDecodes(c, member.address);
  const token = await genesisTokenAccount(holder, member.address);
  console.log("Stand-in Genesis Token for", holder);
  console.log("Mint:", member.address);
  console.log("Token account:", token);
  return { mint: member.address, token };
}
