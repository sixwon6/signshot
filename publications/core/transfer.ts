/** Sending a copy (Core asset) with one `TransferV1`. Ownership is the asset's `owner` field; no account is created. */

import { address, AccountRole, isOffCurveAddress, type Address, type Instruction } from "@solana/kit";
import { MPL_CORE, SYSTEM_PROGRAM } from "../candy/programs";

/** `TransferV1`, Core instruction 14, with `compression_proof: None`. */
const TRANSFER_V1_DATA = new Uint8Array([14, 0]);

/** On-curve and not the owner: a copy sent to an off-curve address can never move again. */
export function validateRecipient(input: string, owner: string): Address {
  const recipient = input.trim();
  try {
    address(recipient);
  } catch {
    throw new Error("Enter a complete Solana wallet address.");
  }
  if (recipient === owner) throw new Error("Choose a different wallet to receive this copy.");
  if (isOffCurveAddress(address(recipient)) || recipient === SYSTEM_PROGRAM || recipient === MPL_CORE)
    throw new Error("Use a personal Solana wallet address, not a program or token account.");
  return address(recipient);
}

/** Core `TransferV1` in the SDK's account order; `payer` and `authority` are the owner. */
export function transferInstruction(details: { asset: string; collection: string; owner: string; recipient: string }): Instruction {
  const owner = address(details.owner);
  return {
    programAddress: MPL_CORE,
    accounts: [
      { address: address(details.asset), role: AccountRole.WRITABLE },
      { address: address(details.collection), role: AccountRole.READONLY },
      { address: owner, role: AccountRole.WRITABLE_SIGNER },
      { address: owner, role: AccountRole.READONLY_SIGNER },
      { address: address(details.recipient), role: AccountRole.READONLY },
      { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
      { address: MPL_CORE, role: AccountRole.READONLY },
    ],
    data: new Uint8Array(TRANSFER_V1_DATA),
  };
}
