/**
 * Squads v4: the multisig account and its vault, read by hand.
 *
 * The multisig account is the configuration (members, threshold); the vault is a PDA of it that
 * signs executed transactions and holds nothing, so the vault, index 0, is the upgrade authority
 * (https://docs.squads.so/main/development/typescript/accounts/vault). Seeds are the official SDK's
 * `getMultisigPda` and `getVaultPda`, and the layout is the program's `Multisig`, both at commit
 * af94153ff77a28b6effe46b9c94baaa93742b48c of https://github.com/Squads-Protocol/v4:
 * `sdk/multisig/src/pda.ts` and `programs/squads_multisig_program/src/state/multisig.rs`.
 *
 *   multisig PDA  ["multisig", "multisig", create_key]
 *   vault PDA     ["multisig", multisig, "vault", u8 index]
 *   Multisig      8-byte discriminator sha256("account:Multisig"), create_key 32,
 *                 config_authority 32, threshold u16, time_lock u32, transaction_index u64,
 *                 stale_transaction_index u64, rent_collector Option<Pubkey>, bump u8,
 *                 members Vec<{ key 32, permissions.mask u8 }>
 *
 * Borsh writes a `None` rent collector as one byte, though `Multisig::size` reserves 33, and the
 * account is allocated with room for more members, so trailing bytes are ignored. Permission bits
 * are Initiate 1, Vote 2, Execute 4; members are kept sorted by key.
 */
import { createHash } from "node:crypto";
import {
  address,
  getAddressDecoder,
  getAddressEncoder,
  getProgramDerivedAddress,
  type Address,
} from "@solana/kit";

export const SQUADS_V4_PROGRAM = address("SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf");
const DISCRIMINATOR = createHash("sha256").update("account:Multisig").digest().subarray(0, 8);
const PERMISSION: Record<string, number> = { Initiate: 1, Vote: 2, Execute: 4 };
/** `Pubkey::default()`: no config authority, so every change is voted on (an autonomous multisig). */
const NO_KEY = "11111111111111111111111111111111";

export async function multisigAddress(createKey: string): Promise<Address> {
  const [found] = await getProgramDerivedAddress({
    programAddress: SQUADS_V4_PROGRAM,
    seeds: ["multisig", "multisig", getAddressEncoder().encode(address(createKey))],
  });
  return found;
}

export async function vaultAddress(multisig: string, index = 0): Promise<Address> {
  if (!Number.isInteger(index) || index < 0 || index > 255) throw new Error("Invalid vault index");
  const [found] = await getProgramDerivedAddress({
    programAddress: SQUADS_V4_PROGRAM,
    seeds: ["multisig", getAddressEncoder().encode(address(multisig)), "vault", new Uint8Array([index])],
  });
  return found;
}

export interface Multisig {
  createKey: string;
  configAuthority: string;
  threshold: number;
  timeLock: number;
  transactionIndex: bigint;
  staleTransactionIndex: bigint;
  rentCollector: string | null;
  bump: number;
  members: { key: string; mask: number }[];
}

export function decodeMultisig(bytes: Uint8Array): Multisig {
  const data = Buffer.from(bytes);
  if (data.length < 96 || !data.subarray(0, 8).equals(DISCRIMINATOR))
    throw new Error("Not a Squads v4 multisig account");
  const key = (at: number) => {
    if (at + 32 > data.length) throw new Error("Squads multisig account is truncated");
    return getAddressDecoder().decode(data.subarray(at, at + 32));
  };
  let at = 8;
  const createKey = key(at); at += 32;
  const configAuthority = key(at); at += 32;
  const threshold = data.readUInt16LE(at); at += 2;
  const timeLock = data.readUInt32LE(at); at += 4;
  const transactionIndex = data.readBigUInt64LE(at); at += 8;
  const staleTransactionIndex = data.readBigUInt64LE(at); at += 8;
  const tag = data[at++];
  if (tag > 1) throw new Error("Squads multisig rent collector is not an Option");
  const rentCollector = tag === 1 ? key(at) : null;
  if (tag === 1) at += 32;
  const bump = data[at++];
  if (at + 4 > data.length) throw new Error("Squads multisig account is truncated");
  const count = data.readUInt32LE(at); at += 4;
  if (at + count * 33 > data.length) throw new Error("Squads multisig account is truncated");
  const members = Array.from({ length: count }, (_, i) => ({
    key: key(at + i * 33),
    mask: data[at + i * 33 + 32],
  }));
  return {
    createKey, configAuthority, threshold, timeLock, transactionIndex, staleTransactionIndex,
    rentCollector, bump, members,
  };
}

/** `programs/editions/mainnet-multisig-plan.json`, the fields that bind the multisig. */
export interface MultisigPlan {
  threshold: number;
  timeLockSeconds: number;
  configAuthority: string | null;
  members: { name: string; address: string; permissions: string[] }[];
}

/**
 * Every way the account at `multisig`, owned by `owner` and holding `bytes`, differs from `plan`.
 * Empty when it is the reviewed multisig: Squads v4's own account at its canonical address, no
 * config authority unless the plan names one, the plan's threshold and time lock, and exactly the
 * plan's members, each with exactly the plan's permissions. The rent collector is not a signer
 * and is not checked.
 */
export async function planMismatches(
  multisig: string,
  owner: string,
  bytes: Uint8Array,
  plan: MultisigPlan,
): Promise<string[]> {
  if (owner !== SQUADS_V4_PROGRAM) return [`owned by ${owner}, not Squads v4 ${SQUADS_V4_PROGRAM}`];
  let account: Multisig;
  try { account = decodeMultisig(bytes); }
  catch (error) { return [error instanceof Error ? error.message : String(error)]; }
  const found: string[] = [];
  if ((await multisigAddress(account.createKey)) !== multisig)
    found.push("not at the multisig address of its own create key");
  const authority = plan.configAuthority ?? NO_KEY;
  if (account.configAuthority !== authority)
    found.push(`config authority ${account.configAuthority}, expected ${plan.configAuthority ?? "none"}`);
  if (account.threshold !== plan.threshold)
    found.push(`threshold ${account.threshold}, expected ${plan.threshold}`);
  if (account.timeLock !== plan.timeLockSeconds)
    found.push(`time lock ${account.timeLock} s, expected ${plan.timeLockSeconds} s`);
  const onChain = new Map(account.members.map((m) => [m.key, m.mask]));
  if (onChain.size !== account.members.length) found.push("a member is listed twice");
  for (const member of plan.members) {
    const mask = member.permissions.reduce((bits, name) => {
      if (!(name in PERMISSION)) throw new Error(`Unknown Squads permission ${name} in the plan`);
      return bits | PERMISSION[name];
    }, 0);
    if (!onChain.has(member.address)) found.push(`${member.name} ${member.address} is not a member`);
    else if (onChain.get(member.address) !== mask)
      found.push(`${member.name} has permission mask ${onChain.get(member.address)}, expected ${mask}`);
  }
  const planned = new Set(plan.members.map((m) => m.address));
  for (const member of account.members)
    if (!planned.has(member.key)) found.push(`${member.key} is a member but not in the plan`);
  return found;
}
