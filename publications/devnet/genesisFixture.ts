/**
 * The Seeker Genesis Token stand-in for the devnet acceptance.
 *
 * No real SGT exists on devnet: its mint authority is Solana Mobile's key. The devnet program
 * build (`--features devnet-genesis`) therefore swaps Solana Mobile's three addresses for a test
 * authority and a test group whose ed25519 seeds are public and reproducible — sha256 of the two
 * labels below — and this module builds what that authority would have minted, through
 * Token-2022's own instructions: a GROUP mint carrying `TokenGroup`, and a MEMBER mint with the
 * same three properties a real SGT has (that mint authority, a `MetadataPointer` to the group
 * mint, a `TokenGroupMember` of it), minted once to the publisher and frozen, as a held SGT is.
 * `era_editions` reads the results by hand; nothing here is special-cased for it.
 *
 * Devnet only, like everything in this directory. The keys are worthless by construction.
 */
import assert from "node:assert/strict";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  address,
  createKeyPairSignerFromPrivateKeyBytes,
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
  getTokenSize,
} from "@solana-program/token-2022";
import { request } from "../rpc";
import { isSeekerGenesisMint } from "../core/genesisToken";
import type { Context } from "./work";

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
  const space = getMintSize([
    extension("GroupPointer", { authority: some(authority), groupAddress: some(group) }),
    extension("TokenGroup", { updateAuthority: some(authority), mint: group, size: 0n, maxSize: 1000n }),
  ]);
  return [
    getCreateAccountInstruction({
      payer: c.payer, newAccount: keys.group, lamports: await rent(c, space), space,
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
 * One member mint with the three SGT properties, and the publisher's frozen token account
 * holding its one unit. Two transactions' worth: this one creates and holds; `foilInstructions`
 * builds the accounts the refusals need.
 */
export async function memberInstructions(
  c: Context,
  keys: { authority: KeyPairSigner; group: KeyPairSigner },
  member: KeyPairSigner,
): Promise<Instruction[]> {
  const group = keys.group.address;
  const authority = keys.authority.address;
  const mint = member.address;
  const space = getMintSize([
    extension("MetadataPointer", { authority: some(authority), metadataAddress: some(group) }),
    extension("GroupMemberPointer", { authority: some(authority), memberAddress: some(mint) }),
    extension("TokenGroupMember", { mint, group, memberNumber: 0n }),
  ]);
  const held = await genesisTokenAccount(c.payer.address, mint);
  return [
    getCreateAccountInstruction({
      payer: c.payer, newAccount: member, lamports: await rent(c, space), space,
      programAddress: TOKEN_2022_PROGRAM_ADDRESS,
    }),
    getInitializeMetadataPointerInstruction({ mint, authority: some(authority), metadataAddress: some(group) }),
    getInitializeGroupMemberPointerInstruction({ mint, authority: some(authority), memberAddress: some(mint) }),
    getInitializeMint2Instruction({ mint, decimals: 0, mintAuthority: authority, freezeAuthority: some(authority) }),
    getInitializeTokenGroupMemberInstruction({
      member: mint, memberMint: mint, memberMintAuthority: keys.authority, group, groupUpdateAuthority: keys.authority,
    }),
    getCreateAssociatedTokenIdempotentInstruction({
      payer: c.payer, ata: held, owner: c.payer.address, mint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
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
    isSeekerGenesisMint(bytes, { mintAuthority: address(DEVNET_GENESIS_AUTHORITY), metadataAddress: address(DEVNET_GENESIS_GROUP) }),
    true,
    "The client's decoder does not read the devnet member mint the program accepts",
  );
  assert.equal(isSeekerGenesisMint(bytes), false, "The devnet stand-in must never read as a real SGT");
}
