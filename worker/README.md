# Signshot co-signer Worker

A Cloudflare Worker served only at `https://cosign.erashot.app` (`workers_dev` and preview URLs
off). It does two jobs:

1. It holds the Third Party Signer key for Seeker-only editions and co-signs one claim per Seeker
   Genesis Token (SGT) per edition. This follows Solana Mobile's server-side check
   ([detecting Seeker users](https://docs.solanamobile.com/recipes/general/detecting-seeker-users)).
2. It serves `POST /rpc`, the mainnet app build's key-free RPC endpoint.

The app reads the URL from `EXPO_PUBLIC_SEEKER_COSIGNER_URL`.

## Endpoints

All bodies are JSON. Errors are `{ "error": code }`, plus `reason` for a refused transaction.

| Route | Request | Response |
|---|---|---|
| `GET /health` | | `{ version, signer, accepted }`: the active key and every accepted key |
| `POST /challenge` | `{ wallet }` | SIWS payload (domain `erashot.app`). The nonce is stateless (HMAC), single-use, and valid for 10 min |
| `POST /claim` | `{ wallet, nonce, signInOutput, edition, cluster, transaction }` | `{ signature, signer, sgtMint, transaction }`, with the co-signature in its slot, ready to broadcast |
| `POST /rpc` | one JSON-RPC 2.0 call | the upstream answer, forwarded to `MAINNET_RPC_URL` |

- `signInOutput` is MWA's `sign_in_result` (base64 `address`, `signed_message`, `signature`).
- `transaction` is the base64 wire transaction, already signed by the wallet (`signTransactions`)
  and the app's keypairs.
- `cluster` is `devnet` or `mainnet-beta`.
- `/rpc` takes no batches and bodies of at most 16 KB. It allows only the methods in `RPC_METHODS`
  (`src/rpcProxy.ts`) and answers with JSON-RPC errors (403 for a method not on the list, 429,
  502).

`/claim` errors: 400 `bad-request` · 401 `nonce-invalid` `nonce-expired` `nonce-used`
`signature-invalid` · 403 `no-genesis-token` · 409 `genesis-used` `genesis-pending` · 413
`too-large` · 422 `transaction-refused` `blockhash-invalid` `too-many-tokens` · 429
`rate-limited` · 500 `misconfigured` `internal` · 502 `rpc-unavailable`. Any other path returns
404 `not-found`.

## What a claim must pass

Cheap local checks run first. The nonce is spent and the paid lookup runs last.

1. **SIWS:** the wallet signed the payload this Worker issued, and it has not expired.
2. **Transaction:** the fee payer's signature verifies over the message as received, and the
   message is exactly one of the claim layouts in `src/claimTransaction.ts` (free, SOL or token
   price). Accounts are resolved by address, never by position, because Seed Vault reorders them.
   The co-signer key appears exactly once, as a read-only signer. Priority fee is capped at
   300,000 lamports. Wallet-added programs are refused (`WALLET_ADDED_PROGRAMS_ALLOWED` is empty).
3. **Edition** (`src/edition.ts`), on the claim's cluster: the blockhash is live, and the candy
   machine, collection and guard are byte for byte what the app publishes. The guard must name an
   accepted key, and the claim must pay exactly the guard's price.
4. **Nonce** is spent (D1 `used_nonces`).
5. **SGT** is held on mainnet (Helius `getTokenAccountsByOwnerV2`). Up to 10 held tokens are tried,
   lowest member number first.

**Record, then sign.** The `(cluster, edition, sgt_mint)` row is inserted as `pending` before the
signature exists, so one SGT can never be co-signed twice. A pending row is released to a later
claim only once the confirmed block height passes the stored bound (blockhash height + 151) and
neither the transaction nor the copy is on chain. Otherwise it becomes `confirmed`. A failed claim
holds its SGT for about 60–90 s.

## Config

Secrets (`wrangler secret put <NAME>`):

| Name | Value |
|---|---|
| `COSIGNER_SECRET_KEY` | solana-keygen JSON (64-byte array) of the active Third Party Signer key |
| `COSIGNER_SECRET_KEYS` | optional: JSON array of further accepted keys (rotation) |
| `NONCE_HMAC_SECRET` | at least 32 characters (`openssl rand -hex 32`). Shorter, and every request returns `500 misconfigured` |
| `MAINNET_RPC_URL` | Helius mainnet URL with its API key, used for the SGT lookup and `/rpc`. Never logged or returned |
| `DEVNET_RPC_URL` | Helius devnet URL. The public devnet endpoint refuses Workers |

`wrangler.toml` sets:

- vars `SIWS_DOMAIN`, `SIWS_URI`
- the D1 binding `DB` (`signshot-claims`)
- rate limits: `LIMITER` (20/min per client network and route), `GLOBAL_LIMITER` (600/min for the
  whole Worker) and `RPC_LIMITER` (300/min per client network, `/rpc` only). An IPv6 /64 counts as
  one client
- an hourly cron that prunes expired nonces

**Key rotation:** make the new key `COSIGNER_SECRET_KEY` and move the old one into
`COSIGNER_SECRET_KEYS` until no open edition names it. The Worker signs with whichever accepted key
the edition's guard names. Keep every key unfunded and never make it an authority.

## Test and deploy

```sh
npm ci
npm test            # vitest in workerd: local D1, fake RPC, plus the app's own claim client
npm run typecheck

npx wrangler d1 migrations apply signshot-claims --remote
npx wrangler deploy
```

## Trust

- The key can only pass the Third Party Signer guard of editions that name it, one checked claim
  at a time. It cannot move funds or change an edition.
- If the key leaks, anyone can mint Seeker-only copies of the editions that name it without an SGT,
  until those editions close.
- If the Worker is down, Seeker-only claims and the mainnet build's RPC stop working. Open editions
  and existing copies are unaffected.
- A `confirmed` row means the copy reached the chain. A `pending` row means only that the Worker
  co-signed.
