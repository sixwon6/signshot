-- The co-signed transaction's id (its first signature, base58), so a released row can be checked
-- against the transaction itself and not only the copy's address. NULL on rows written before this.
ALTER TABLE claims ADD COLUMN signature TEXT;
