/**
 * Claims table (D1).
 *
 * RECORD FIRST, THEN SIGN. The `(cluster, edition, sgt_mint)` row is written `pending` before the
 * co-signature exists, so a crash can hold an SGT back but never let it claim twice.
 *
 * LAST VALID HEIGHT BOUND. At signing, the blockhash is valid at "processed" on a node at context
 * slot S; that node's block height H (read with `minContextSlot: S`) bounds the blockhash's, so the
 * transaction lands by H + 150. The row stores H + 151.
 *
 * A PENDING ROW IS RELEASED ONLY WHEN ITS TRANSACTION CAN NO LONGER LAND:
 *   1. "confirmed" `getEpochInfo` block height must be PAST the bound (a lagging node only reports
 *      lower, holding the row longer). Otherwise refuse.
 *   2. Then read the signature status (searching history) and the copy's account at "confirmed",
 *      both no earlier than step 1's slot. Landed if the transaction is found without error, or the
 *      copy's address holds a Core-owned or 1-byte account (Core's burn tombstone, which a fee
 *      sweep can leave System-owned). Landed: mark `confirmed`.
 *   3. Otherwise take the row over by compare-and-swap on `claim_id`; only the winner signs.
 * Steps 1-2 are race-free only because claims never carry a durable nonce (refused by the
 * transaction check). The blockhash must be valid on the stated cluster at signing.
 *
 * The app broadcasts and reports nothing back; this chain check is the only truth about landing.
 * A failed or unsent claim holds its SGT ~150 blocks plus confirmed lag (~60-90 s).
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
  /** Wallet signature (transaction id), base58. Null on rows that predate the column. */
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

/** Safe: expired nonces are refused before lookup. */
export async function pruneNonces(db: D1Database, nowSeconds: number): Promise<void> {
  await db.prepare("DELETE FROM used_nonces WHERE expires_at < ?1").bind(nowSeconds).run();
}
