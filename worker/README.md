# Signshot Seeker co-signer

Served at https://cosign.erashot.app (a custom domain; the workers.dev address and preview URLs
are off). The app reads it from `EXPO_PUBLIC_SEEKER_COSIGNER_URL`.

A Cloudflare Worker that holds the Third Party Signer key of Seeker-only editions. It co-signs a claim only after Solana Mobile's server-side check ([detecting Seeker users](https://docs.solanamobile.com/recipes/general/detecting-seeker-users), [Seeker Genesis Token](https://docs.solanamobile.com/solana-mobile-stack/seeker-genesis-token)):

1. Sign-in-with-Solana proves that the caller controls the wallet.
2. Mainnet shows that the wallet holds a Seeker Genesis Token (SGT). The Worker reads mainnet whatever cluster the edition is on.
3. That SGT's mint has not already claimed this edition.

Each SGT gets one claim per edition. A wallet holding several SGTs uses them lowest member number first, trying up to 10: it is refused only when all of them have claimed.

## Endpoints

All requests and responses are JSON. Errors come back as `{ "error": code }`, plus `"reason"` for a refused transaction.

**`GET /health`** returns `{ version, signer, accepted }`. `signer` is the active co-signer key, the one new editions should name; `accepted` lists every key the Worker will co-sign with.

**`POST /challenge`** takes `{ wallet }` and returns the SIWS payload, whose message the app has the wallet sign with MWA's `sign_messages`:

```json
{ "domain": "erashot.app", "statement": "Sign in to claim a Seeker edition", "uri": "https://erashot.app",
  "address": "<wallet>", "nonce": "<72 hex>", "issuedAt": "…Z", "expirationTime": "…Z" }
```

The nonce lasts 10 minutes and can be spent once.

**`POST /claim`** takes:

```json
{ "wallet": "<base58>", "nonce": "<from /challenge>",
  "signInOutput": { "address": "<b64>", "signed_message": "<b64>", "signature": "<b64>" },
  "edition": "<candy machine address>", "cluster": "devnet" | "mainnet-beta",
  "transaction": "<base64 wire transaction, already signed by the wallet and the app's keypairs>" }
```

`signInOutput` has the shape of MWA's `sign_in_result`: base64 `address`, `signed_message` and `signature`.

The signing order is fixed. The wallet signs first, with MWA `signTransactions`; it may rewrite the compute-unit price and reorder the accounts. The app then adds its local keypairs' signatures, and this Worker signs last.

On success `/claim` returns `200 { signature, signer, sgtMint, transaction }`:
- `signature` is the base58 ed25519 signature of the message exactly as received.
- `transaction` is the received transaction with that signature in the co-signer's slot, ready for the app to broadcast.

The app reports nothing back after broadcasting.

Failures:

| Status | Error codes |
|---|---|
| 400 | `bad-request` |
| 401 | `nonce-invalid`, `nonce-expired`, `nonce-used`, `signature-invalid` |
| 403 | `no-genesis-token` |
| 404 | `not-found` (any other path or method) |
| 409 | `genesis-used`, `genesis-pending` |
| 413 | `too-large` |
| 422 | `transaction-refused` (with `reason`), `blockhash-invalid`, `too-many-tokens` |
| 429 | `rate-limited` |
| 500 | `misconfigured` (a `NONCE_HMAC_SECRET` under 32 characters), `internal` |
| 502 | `rpc-unavailable` |

## What gets signed

The key signs only a claim exactly as the app's client builds it (`claimDraft` in `publications/candy/edition.ts`, compiled by `prepareForWallet` in `transactions.ts`). The check is in `src/claimTransaction.ts`, with the layout table at the top of that file, and `src/edition.ts`. There is no other signing path.

Key: W is the wallet (fee payer and minter). P is a fresh one-shot payer, A the copy, T a temporary token account and S this key.

**The three accepted shapes**

| Price | Instructions, in order | Signers |
|---|---|---|
| Free | System Transfer W→P; `mint_v1` with remaining `[S]`; System Allocate P | W, P, A, S |
| SOL | The same, with remaining `[publisher, S]` | W, P, A, S |
| Token | System Transfer W→P; System CreateAccount T (165 bytes, Token program, funded by W); Token InitializeAccount3 T (mint, owner W); Token Transfer ATA(W, mint)→T; `mint_v1` with remaining `[T, publisher's ATA, Token program, S]`; System Allocate P; Token CloseAccount T→W | W, P, A, T, S |

**`mint_v1`**
- Discriminator `9162c076b8937668`, empty `mint_args`, no group label.
- Account 0 is the guard PDA `["candy_guard", edition]`, account 2 is `edition`, and account 3 is its authority PDA.
- `payer` is P, `minter` is W, and `owner` is absent or W.
- The fixed programs and sysvars are the expected ones.
- There is no mint-limit counter.

**The order of checks.** Cheap, local checks run first; chain reads follow one at a time; the nonce is spent and the paid lookup runs only at the end:
1. SIWS.
2. The wallet's signature and the transaction's shape.
3. On the edition's cluster: the blockhash is live, then the edition is valid and names an accepted key.
4. The nonce is spent.
5. The Genesis Token lookup on mainnet (Helius).

A stranger with a fresh keypair, a made-up edition and a random blockhash costs one RPC read and no D1 write.

**Before anything else: the wallet's signature.** The fee payer's signature (slot 0) must verify over the message bytes as received. This proves the wallet approved exactly this message, on top of SIWS.

**Accounts are resolved, never positioned.** Every instruction's accounts are resolved through its indexes and compared by address. The signer and writable flags each one needs are checked on the resolved account. No position in the message's account list, and no canonical order, is assumed, because Seed Vault reorders.

**ComputeBudget**
- At most one SetComputeUnitLimit and one SetComputeUnitPrice, with any values, at any position.
- The limit is at most 1,400,000.
- price × limit (or × 200,000 per instruction, if no limit is set) must come to at most `MAX_PRIORITY_FEE_LAMPORTS` = 100,000 lamports (0.0001 SOL). The app reviews at most 50,000 lamports of priority fee and lets the wallet add at most 50,000 more.
- This product is the only way the transaction can cost the wallet more than it reviewed.

**Wallet-added programs**
- `WALLET_ADDED_PROGRAMS_ALLOWED` in `src/claimTransaction.ts` is empty. Lighthouse (`L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95`) is therefore refused.
- Whether Seed Vault adds Lighthouse assertions is measured on the phone, and that result goes into the constant.
- An allowed program's instructions are set aside, but they may not name S or P.

**Everything else**
- v0 only (the app sends nothing else), with no lookup tables and no duplicate keys.
- Any other instruction is refused, including `AdvanceNonceAccount`.
- SOL moves only from W to P. Tokens move only from W's own associated account to T.
- P appears only in its three places.
- S is a read-only signer, never the fee payer, and appears exactly once.

**On chain, on the edition's cluster, by the app's own `readEdition` rule**
- The candy machine is exactly the app's hidden-settings layout:
  - 652 bytes, with zeros after the data;
  - 1 to 1000 copies available;
  - a title of 1–24 bytes without `$ID`, and a URI of 1–200 bytes.
- The collection is read to its last byte:
  - its name and URI equal the candy machine's;
  - `num_minted` equals the copies redeemed;
  - it carries exactly three plugins, with the app's bytes and authorities: MasterEdition (max = supply, authority None), Royalties (creators exactly [guard authority 100%], RuleSet None, authority None), and UpdateDelegate (delegates exactly [the candy machine's authority PDA], authority UpdateAuthority);
  - it has no external plugins and no bytes after the plugin registry;
  - the claim names this collection and no other.
- The candy machine's authority and the collection's update authority are both `NO_AUTHORITY`.
- Its mint authority is the guard, and the guard's base is the candy machine.
- The guard's data re-encodes byte for byte from the app's Seeker-only set: Third Party Signer = an accepted key, plus Edition, plus SOL or token payment to the guard authority. That means no groups, no Mint Limit and no other guard.
- The claim's price kind, destination, token mint and token amount match the guard.
- The edition is not sold out.
- The blockhash is valid on the stated cluster, which ties the claim to that cluster.

## Record, then sign

A claim's row `(cluster, edition, sgt_mint)` is written as `pending` before the signature exists. If the Worker crashes in between, the row remains and no signature exists. The SGT is held back for a while, but it can never claim twice.

Each row stores a bound on the block height through which its transaction can land:
- When signing, the Worker checks the blockhash with `isBlockhashValid` at "processed".
- It then reads `getBlockHeight` with `minContextSlot` set to the slot that answered, so a lagging node can't answer.
- The bound is that height + 151.

A later claim that finds a pending row releases it only if the old transaction can no longer land. The Worker checks two things, in this order:

1. The confirmed block height (`getEpochInfo` at "confirmed") is past the stored bound. A lagging node can only make the row wait longer.
2. The copy's address is read at "confirmed", with `minContextSlot` = the slot that answered step 1. It counts as landed if it holds a Core-owned account, or a 1-byte account (the tombstone Core's burn leaves, which Core's fee sweep can leave System-owned). A burned copy still counts as the SGT's claim.

If the copy is there, the row is marked `confirmed`. If it isn't, the later claim takes the row over through a compare-and-swap.

The old blockhash's validity at "confirmed" is never the test: the confirmed bank lags, so a seconds-old blockhash would read as invalid and one SGT could get several co-signed copies.

This is sound only because a claim never carries a durable nonce: the only System instructions allowed are the layout's Transfer, CreateAccount and Allocate. The cost is that a failed or unsent claim holds its SGT for 150 blocks plus the confirmed lag, about 60–90 seconds. Retrying the identical claim (the same message bytes, by the same wallet) is signed again. A different message that reuses the asset is not a retry.

The app broadcasts the transaction itself and reports nothing back, so this chain check is the only source of truth about whether a claim landed.

## Storage: D1

A primary key on `(cluster, edition, sgt_mint)` makes the uniqueness rule atomic: of two simultaneous claims, exactly one `INSERT … ON CONFLICT DO NOTHING` succeeds. KV can't do this because it has no transactions. A Durable Object could, but D1 is simpler.

Spent nonces sit in `used_nonces` until their expiry, and an hourly cron prunes them. The nonce itself is stateless: random bytes, the issue time and an HMAC. `/challenge` therefore writes nothing, and spamming it costs no storage.

## Secrets and config

```sh
wrangler secret put COSIGNER_SECRET_KEY   # solana-keygen JSON (64-byte array) of the Third Party Signer key
wrangler secret put NONCE_HMAC_SECRET     # openssl rand -hex 32
wrangler secret put MAINNET_RPC_URL       # https://mainnet.helius-rpc.com/?api-key=…
```

- `MAINNET_RPC_URL` must be Helius, because the recipe's `getTokenAccountsByOwnerV2` is a Helius method. The Worker never logs or returns it.
- `NONCE_HMAC_SECRET` must be at least 32 characters. Shorter, and every request answers `500 misconfigured`.
- `DEVNET_RPC_URL` is the same Helius key's devnet URL, also a secret. The public devnet endpoint refuses requests from Workers.
- `wrangler.toml` sets the vars `SIWS_DOMAIN` and `SIWS_URI`. It also sets two rate limits:
  - 20 requests a minute per client network and route, on `/health`, `/challenge` and `/claim` (an IPv6 /64 counts as one client);
  - 600 requests a minute for the whole Worker.
- `wrangler.toml` serves the Worker only on the custom domain `cosign.erashot.app` (`workers_dev = false`, `preview_urls = false`).
- Worker code can't stop a flood from using up the account's daily request quota: every request counts, including refused ones. Only Cloudflare WAF rate limiting in front of the domain can.

**Key rotation.**
- `COSIGNER_SECRET_KEY` is the active key; `/health` names it.
- `COSIGNER_SECRET_KEYS` (optional) is a JSON array of further accepted keys.
- A claim is co-signed with whichever accepted key the edition's guard names. A transaction naming two accepted keys is refused.
- To rotate: make the new key active, move the old one into `COSIGNER_SECRET_KEYS`, and keep it there until no open edition names it. The app's `setPriceDraft` keeps an edition's current co-signer, so existing editions keep the key they were published with until they close.
- Generate the key with `solana-keygen new --no-bip39-passphrase -o cosigner.json`. Use the file's contents as the secret, then delete the file.

## Run the tests

```sh
cd worker
npm install
npm test
```

The tests run inside workerd with a local D1 and a fake RPC that returns Helius- and Solana-shaped responses. The fixtures build claims from the documented layout, not from the app's client. `test/client.test.ts` then imports the client from `publications/candy` and checks that the Worker accepts every Seeker-only claim it builds, and that the client accepts the fixtures' editions. `npm run typecheck` runs `tsc`.

## Deploy

The D1 database `signshot-claims` exists; its `database_id` is in `wrangler.toml`.

```sh
wrangler d1 migrations apply signshot-claims --remote
wrangler secret put …                     # the three secrets above
wrangler deploy
```

## Trust

- **What the key can do.** It can pass the Third Party Signer guard of editions that name it, one mint at a time, and only through transactions this Worker has checked.
- **What the key can't do.** It holds no funds and no authority over any account. It can't move tokens, change an edition or mint without the claimer's own signature. Keep it unfunded, and never make it an authority anywhere.
- **If the key leaks.** Someone could mint Seeker-only copies of the editions naming it without an SGT, until those editions close; new editions name the next active key. A leak can't touch funds.
- **If the Worker is down.** Seeker-only editions can't be claimed until it's back. Nothing else is affected: open editions, minted copies and payments don't involve it.
- **What a claim record means.** It means this Worker co-signed a claim, not that the claim landed. A pending row becomes confirmed only once the chain shows the copy.
