/**
 * The claims table (D1) and the order of "record" and "sign".
 *
 * RECORD FIRST, THEN SIGN. A row `(cluster, edition, sgt_mint)` is written as `pending` before
 * the co-signature exists. A crash after the write leaves a pending row and no signature: the
 * SGT is held back until that row is released, never claimed twice. Writing after signing would
 * let a crash between the two hand out a signature with no record.
 *
 * EVERY ROW CARRIES AN UPPER BOUND ON ITS TRANSACTION'S LAST VALID BLOCK HEIGHT. When the claim
 * is signed, its blockhash is valid at "processed" on a node whose context slot is S, so the
 * blockhash's own block height is at most that node's block height H (read with
 * `minContextSlot: S`, so no lagging node answers), and the transaction can land no later than
 * block height H + 150. The row stores H + 151.
 *
 * A PENDING ROW IS RELEASED ONLY WHEN ITS TRANSACTION CAN NO LONGER LAND:
 *   1. `getEpochInfo` at "confirmed" must report a block height PAST the stored bound (a
 *      confirmed height is real; a lagging node can only report a lower one, which holds the row
 *      longer, never shorter). Otherwise the transaction may still land: refuse.
 *   2. only then the transaction's own status is read (`getSignatureStatuses`, searching history)
 *      and the copy's address at "confirmed", both answered no earlier than the slot that answered
 *      step 1, so no node behind that point can answer "not there" for a claim that landed.
 *      Either one says it landed: the transaction found without an error, or a Core-owned or
 *      1-byte account at the copy's address (Core's burn leaves a 1-byte tombstone, which Core's
 *      permissionless fee sweep can leave System-owned). The status covers a copy since burned,
 *      swept and emptied by its keypair's holder; the account covers a node that has dropped the
 *      transaction from its history. The row is then marked `confirmed`: the SGT has had its copy.
 *   3. otherwise the row is taken over by a compare-and-swap on `claim_id`, and only the request
 *      that wins the swap signs.
 * Nothing can land between steps 1 and 2. It holds only because a claim never carries a durable
 * nonce (the transaction check allows only the claim layout's System Transfer, CreateAccount and
 * Allocate and names `AdvanceNonceAccount` as a refusal). The cluster cannot be lied about: the
 * blockhash must be valid on the stated cluster when the claim is signed.
 *
 * The app broadcasts the co-signed transaction itself and reports nothing back, so this chain
 * check is the only source of truth about whether a claim landed.
 *
 * Trade-off: a claim whose transaction failed or was never sent holds its SGT for up to about
 * 150 blocks plus the confirmed bank's lag (roughly 60–90 s), then the next attempt takes the row
 * over. Nothing burns an SGT's claim without a copy on chain.
 */

import type { Cluster } from "./rpc";

export interface ClaimRow {
  cluster: Cluster;
  edition: string;
  sgt_mint: string;
  wallet: string;
  asset: string;
  blockhash: string;
  /** Upper bound on the co-signed transaction's last valid block height, plus one. */
  last_valid_height: number;
  /** Hex sha256 of the message bytes as received. */
  message: string;
  /** The transaction's id: the wallet's signature, base58. Null on rows older than the column. */
  signature: string | null;
  claim_id: string;
  status: "pending" | "confirmed";
  created_at: number;
}

export type NewClaim = Omit<ClaimRow, "status">;

/** Spend a nonce once. `false` when it was already spent. */
export async function consumeNonce(db: D1Database, nonce: string, expiresAt: number): Promise<boolean> {
  const r = await db.prepare("INSERT INTO used_nonces (nonce, expires_at) VALUES (?1, ?2) ON CONFLICT DO NOTHING")
    .bind(nonce, expiresAt).run();
  return r.meta.changes === 1;
}

export const findClaim = (db: D1Database, cluster: Cluster, edition: string, sgtMint: string) =>
  db.prepare("SELECT * FROM claims WHERE cluster = ?1 AND edition = ?2 AND sgt_mint = ?3")
    .bind(cluster, edition, sgtMint).first<ClaimRow>();

/** Take the empty slot. `false` when another request holds it. */
export async function insertClaim(db: D1Database, c: NewClaim): Promise<boolean> {
  const r = await db.prepare(
    `INSERT INTO claims (cluster, edition, sgt_mint, wallet, asset, blockhash, last_valid_height, message, claim_id, status, created_at, signature)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'pending', ?10, ?11) ON CONFLICT DO NOTHING`,
  ).bind(c.cluster, c.edition, c.sgt_mint, c.wallet, c.asset, c.blockhash, c.last_valid_height, c.message, c.claim_id, c.created_at,
    c.signature).run();
  return r.meta.changes === 1;
}

/** Take over a released pending row, only if it is still the one that was checked. */
export async function replaceClaim(db: D1Database, previousClaimId: string, c: NewClaim): Promise<boolean> {
  const r = await db.prepare(
    `UPDATE claims SET wallet = ?4, asset = ?5, blockhash = ?6, last_valid_height = ?7, message = ?8, claim_id = ?9, created_at = ?10,
       signature = ?12
     WHERE cluster = ?1 AND edition = ?2 AND sgt_mint = ?3 AND status = 'pending' AND claim_id = ?11`,
  ).bind(c.cluster, c.edition, c.sgt_mint, c.wallet, c.asset, c.blockhash, c.last_valid_height, c.message, c.claim_id, c.created_at,
    previousClaimId, c.signature).run();
  return r.meta.changes === 1;
}

export async function confirmClaim(db: D1Database, row: ClaimRow): Promise<void> {
  await db.prepare(
    "UPDATE claims SET status = 'confirmed' WHERE cluster = ?1 AND edition = ?2 AND sgt_mint = ?3 AND claim_id = ?4",
  ).bind(row.cluster, row.edition, row.sgt_mint, row.claim_id).run();
}

/** Spent nonces past their expiry can go: an expired nonce is refused before it is looked up. */
export async function pruneNonces(db: D1Database, nowSeconds: number): Promise<void> {
  await db.prepare("DELETE FROM used_nonces WHERE expires_at < ?1").bind(nowSeconds).run();
}
