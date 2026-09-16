import assert from "node:assert/strict";

interface PurchaseReceipt {
  transaction: { signatures: string[]; message: { accountKeys: string[] } };
  meta: {
    err: unknown;
    preBalances: number[];
    postBalances: number[];
    loadedAddresses?: { writable: string[]; readonly: string[] };
  } | null;
}

/** Transaction-local balances remain valid when a confirmed send is resumed after RPC failure. */
export function verifyCreatorProceeds(
  receipt: PurchaseReceipt | null,
  signature: string,
  creator: string,
  price: bigint,
): bigint {
  assert.ok(receipt?.meta, "Confirmed purchase receipt is not available");
  assert.equal(receipt.transaction.signatures[0], signature, "Wrong purchase receipt");
  assert.equal(receipt.meta.err, null, "Purchase failed on chain");
  const keys = [...receipt.transaction.message.accountKeys,
    ...(receipt.meta.loadedAddresses?.writable ?? []),
    ...(receipt.meta.loadedAddresses?.readonly ?? [])];
  const index = keys.indexOf(creator);
  assert.ok(index > 0, "Creator must be present and must not pay the buyer's fee");
  const before = receipt.meta.preBalances[index];
  const after = receipt.meta.postBalances[index];
  assert.ok(Number.isSafeInteger(before) && before >= 0 && Number.isSafeInteger(after) && after >= 0,
    "Invalid creator balances in purchase receipt");
  const proceeds = BigInt(after) - BigInt(before);
  assert.equal(proceeds, price, "The purchase did not pay the exact reviewed creator price");
  return proceeds;
}
