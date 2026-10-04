-- One row per Seeker Genesis Token per edition. The primary key is the uniqueness rule: two
-- claims with the same SGT on the same edition cannot both hold a row.
CREATE TABLE claims (
  cluster    TEXT    NOT NULL CHECK (cluster IN ('devnet', 'mainnet-beta')),
  edition    TEXT    NOT NULL,
  sgt_mint   TEXT    NOT NULL,
  wallet     TEXT    NOT NULL,
  asset      TEXT    NOT NULL,   -- the copy's address in the co-signed transaction
  blockhash  TEXT    NOT NULL,   -- that transaction's recent blockhash
  last_valid_height INTEGER NOT NULL, -- upper bound on its last valid block height, plus one (store.ts)
  message    TEXT    NOT NULL,   -- hex sha256 of the message bytes as received (identical-retry key)
  claim_id   TEXT    NOT NULL,   -- random per co-signature; compare-and-swap token
  status     TEXT    NOT NULL CHECK (status IN ('pending', 'confirmed')),
  created_at INTEGER NOT NULL,   -- unix ms
  PRIMARY KEY (cluster, edition, sgt_mint)
) WITHOUT ROWID;

-- Spent SIWS nonces, kept until the nonce would have expired anyway.
CREATE TABLE used_nonces (
  nonce      TEXT    NOT NULL PRIMARY KEY,
  expires_at INTEGER NOT NULL    -- unix seconds
) WITHOUT ROWID;

CREATE INDEX used_nonces_expiry ON used_nonces (expires_at);
