/**
 * Sending a Signshot print (a Metaplex Core asset) with one `TransferV1`. Ownership is the asset's
 * own `owner` field, so no account is created. Sending is not a sale.
 */

import { address, AccountRole, isOffCurveAddress, type Instruction } from "@solana/kit";
import { account, addresses, isBurnedPrintAccount, isFrozen, verifyPrintAsset, MPL_CORE, SYSTEM_PROGRAM } from "./protocol";
import type { CoreMetadata } from "../types";

const SYSTEM: string = SYSTEM_PROGRAM;

/**
 * `TransferV1`, Core instruction 14. Its only argument, `compression_proof`, is always
 * `None`, so the data is the discriminator and a `None` tag.
 */
const TRANSFER_V1_DISCRIMINATOR = 14;
const TRANSFER_V1_DATA = new Uint8Array([TRANSFER_V1_DISCRIMINATOR, 0]);

/**
 * A recipient must be a complete, different, on-curve wallet. A print sent to an off-curve PDA
 * can never move again; Core's own id is on curve, so it is checked separately.
 */
function validateRecipient(input: string, owner: string): string {
  const recipient = input.trim();
  try {
    address(recipient);
  } catch {
    throw new Error("Enter a complete Solana wallet address.");
  }
  if (recipient === owner) throw new Error("Choose a different wallet to receive this NFT.");
  if (isOffCurveAddress(address(recipient)) || recipient === SYSTEM || recipient === MPL_CORE)
    throw new Error("Use a personal Solana wallet address, not a program or token account.");
  return recipient;
}

/**
 * Everything checked before the wallet opens: the exact asset (copy `number`'s canonical print),
 * current ownership, the Signshot shape, the published `metadataId`, and a plain-wallet recipient.
 */
export async function inspectTransfer(
  endpoint: string,
  e: CoreMetadata,
  metadataId: string,
  input: string,
  owner: string,
  number = 1,
) {
  address(owner);
  const recipient = validateRecipient(input, owner);
  const keys = await addresses(e.program, e.creator, e.nonce, number);
  if (keys.edition !== e.edition || keys.collection !== e.collection)
    throw new Error("This photograph's saved edition addresses do not match its record.");
  const [assetAccount, recipientAccount] = await Promise.all([
    account(endpoint, keys.print),
    account(endpoint, recipient),
  ]);
  // First: a burn whose fees Core has swept leaves a System-owned tombstone, which the ownership
  // check below would misread as an unavailable asset.
  if (isBurnedPrintAccount(assetAccount))
    throw new Error("This digital print has been burned and cannot be sent.");
  if (!assetAccount || assetAccount.owner !== MPL_CORE || assetAccount.executable)
    throw new Error("The published NFT is not available on this network.");
  const asset = verifyPrintAsset(assetAccount.bytes, e, keys.print, number);
  if (asset.uri !== `https://arweave.net/${metadataId}`)
    throw new Error("The NFT metadata does not match this photograph.");
  if (asset.owner !== owner)
    throw new Error("This wallet does not currently own this photo's NFT.");
  // A freeze is the owner's own doing and does not make the print a forgery — it makes it
  // unsendable until it is lifted. Say that, rather than calling a valid print invalid. Only
  // `FreezeDelegate` blocks `TransferV1`; `FreezeExecute` does not (`isFrozen`).
  if (isFrozen(asset))
    throw new Error("This NFT is frozen and cannot be sent until the freeze is removed.");
  // A recipient account may not exist at all — that is the normal case for a fresh wallet — but
  // if it does exist it must be an empty, system-owned account, never a program or data account.
  if (
    recipientAccount &&
    (recipientAccount.owner !== SYSTEM ||
      recipientAccount.executable ||
      recipientAccount.bytes.length)
  )
    throw new Error("The recipient is not a personal wallet account. Check the address.");
  return { owner, recipient, asset: keys.print, collection: keys.collection };
}

export type TransferDetails = Awaited<ReturnType<typeof inspectTransfer>>;

/**
 * Core `TransferV1` in the SDK's account order. `payer` and `authority` are
 * the same wallet; `log_wrapper` is the mpl-core id (an omitted optional account); the real system
 * program is passed because Core may resize the asset.
 */
export function transferInstructions(details: TransferDetails): Instruction[] {
  const owner = address(details.owner);
  return [
    {
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
    },
  ];
}
