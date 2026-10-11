# Signshot

Signshot is an Android camera app for the Solana Seeker. It has its own Camera2/OpenGL camera with
manual controls and looks named for cameras, and a photo library with sharing and print cards. With
the Seeker's wallet, a photograph becomes a numbered Metaplex Core edition that other wallets
collect free or buy for SOL or SKR, with no program of its own.

Android package `app.signshot` · domain `erashot.app` · co-signer `cosign.erashot.app`

## Try it

- **APK (Solana devnet):** https://github.com/sixwon6/signshot/releases/latest/download/Signshot.apk
- Android 14 or newer on arm64, with a Mobile Wallet Adapter wallet set to devnet. On the Seeker
  that is Seed Vault Wallet. Test SOL: https://faucet.solana.com.
- Shooting, Develop, saving and sharing need no wallet.
- Collecting a Seeker-only edition needs a Seeker Genesis Token in the collecting wallet.

## Features

### Camera

- **AUTO · P · M dial over one layout.** AUTO: tap to focus and meter, drag on the picture for
  brightness (up to two stops either way). P: ISO, shutter, brightness, white balance (Kelvin)
  and focus as cells with ruler detents, each one handed back to the camera with one key. M: holds
  the metered ISO and shutter pair.
- **Looks named for cameras:** the phone's own look, named for the device model (`Seeker` on a
  Seeker, from `src/recipes/deviceLook.ts`), plus Digicam, Disposable and Camcorder. Each look has
  a strength control, and off AUTO its stages can be edited. Grades are LUTs applied in the GL
  pipeline at capture.
- **Develop** applies another look or strength to a photograph already taken.
- **Library:** save to the gallery, share, export, and print cards with a QR collect link.
- DISP cycles a plain view, a rule-of-thirds grid and a histogram.

### Editions

- **Publish:** title, caption, one copy or 2–1000 copies, a price per copy in SOL or SKR, a 0–10%
  royalty, and optionally **Seeker holders only**. Both publishing transactions are signed in one
  wallet approval.
- **Collect or buy** from a collect link (`https://erashot.app/collect/?core=<edition>`), opened by
  Android App Links, a pasted address or a scanned QR code.
- **One copy each:** one per wallet on open editions (Candy Guard Mint Limit), one per Seeker
  Genesis Token on Seeker-only editions (counted by the co-signer).
- **Manage:** change the price, close the sale (returns the guard's rent), send a copy to another
  wallet (Core `TransferV1`).

### Built for Seeker

- **Seed Vault Wallet over Mobile Wallet Adapter.** The app is sign-only: it calls
  `signTransactions`, checks what the wallet returns and sends it itself.
- **Seeker Genesis Token.** The publisher's SGT is claimed in the metadata (`signshot-genesis/1`)
  and checked against mainnet each time the record is opened. A Third Party Signer guard, co-signed
  by the Worker, restricts Seeker-only editions to SGT holders.
- **.skr names.** The wallet's `.skr` name is resolved from mainnet and shown in place of the
  address. It can also be printed on the share card.
- **StrongBox key attestation.** Each publication is signed by a fresh hardware key, and its
  certificate chain is published with it (`signshot-attestation/1`). Anyone can verify it off the
  device.
- **SKR pricing.** Editions can be priced in SKR (`SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3`)
  through Candy Guard's `tokenPayment`.

## How it works

```
 Seeker ──MWA──▶ Seed Vault Wallet (signs only)
   │
   ├─ Camera2 + OpenGL (modules/seeker-camera) ── originals stay on the phone
   ├─ publish / collect ──RPC──▶ Core Candy Machine · Candy Guard · Metaplex Core
   ├─ image + metadata (ANS-104, signed on device) ──▶ Turbo ──▶ Arweave
   └─ Seeker-only claim ──SIWS──▶ cosign.erashot.app (Worker + D1) ──Helius──▶ SGT check
```

### On chain

Everything runs on programs Metaplex has deployed: Core Candy Machine
(`CMACYFENjoBMHzapRXyo1JZkVS6EtaDDzkjMrmQLvr4J`), Core Candy Guard
(`CMAGAKJ67e9hRZgfC5SFTbZH8MgEmtqazKXjmkaJjWTJ`) and Metaplex Core
(`CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d`). `publications/candy/` builds their instructions
by hand on `@solana/kit`.

| Account | What it holds |
|---|---|
| Core collection | Title, metadata URI, plugins: MasterEdition (max = supply), Royalties (publisher as sole creator), UpdateDelegate (the candy machine's authority PDA) |
| Candy machine | Hidden settings: copy n is `<title> #n`, one shared URI, the image's SHA-256 as the settings hash |
| Candy Guard | Open: `mintLimit` + `edition` (+ `solPayment` or `tokenPayment`). Seeker-only: `thirdPartySigner` + `edition` (+ payment) |
| Copy | A Core asset in the collection carrying its Edition number |

- **Who pays.** The publisher pays the rent for the collection, candy machine, guard and copy 1.
  Copy 1 is minted to the publisher in the second transaction. A collector pays the network fee,
  the copy's rent, Core's 0.0015 SOL create fee and, on open editions, the mint-limit counter. The
  price goes to the publisher inside `mint_v1`.
- **What is immutable.** Publishing hands the candy machine's authority and the collection's update
  authority to `864BTg5dsR5DtBxPHm8uiU9GnRWL5V94AneqsnLRxgg8`. That is the System Program PDA of
  `["signshot", "no authority"]`, which has no key. Title, image hash, URI, supply, royalty and
  plugins can never change, and no copy can be minted outside the guard. The publisher keeps only
  the guard's authority, which covers price and closing.

### Storage

- The image and metadata are ANS-104 data items, signed on the phone by a per-wallet upload key
  (`src/arweave/`). Their ids are known before publishing, so the URI is on chain from the first
  transaction.
- They are uploaded to Arweave via ar.io Turbo once both transactions confirm. Devnet uses Turbo's
  free tier. On mainnet, when the free tier refuses, the app offers a single SOL payment to Turbo
  for credit.
- The metadata follows the Metaplex JSON standard. The extra evidence lives under
  `properties.signshot` (attestation) and `properties.genesisToken`.
- Full-size originals never leave the phone. The public copy is a compressed derivative.

### Co-signer (`worker/`)

A Cloudflare Worker at `cosign.erashot.app` holds the Third Party Signer key for Seeker-only
editions. It co-signs a claim only after all of these pass: Sign-in-with-Solana, the wallet's
signature over the exact claim transaction, an edition the app's own reader accepts, and a mainnet
check that the wallet holds an SGT that has not already claimed this edition (one D1 row per
token per edition). It also serves `POST /rpc`, the mainnet build's key-free RPC endpoint, which
proxies an allowlist of methods to Helius. See [worker/README.md](worker/README.md).

### Device attestation

At publish time the native module makes a fresh StrongBox key (TEE where StrongBox is
unavailable). The key's attestation challenge is the SHA-256 of a manifest naming this publication:
cluster, program, candy machine, collection, publisher, nonce, image hash and capture
fingerprints. The key signs the manifest, then is deleted. The app shows `Device: Solana Seeker`
only when:

- the chain ends at a pinned Google attestation root (`src/seeker/keyAttestation.ts`) and no serial
  is on Google's revocation list;
- the attested app is `app.signshot` signed by the release key (`dapp-store/signing-certificate.json`);
- boot is verified, the bootloader is locked, and the maker and model are Solana Mobile Inc. /
  Seeker;
- every certificate is valid at the block time of the candy machine's creation.

The same rules run off the device and exit non-zero on any failure:

```sh
npm run verify:attestation -- --edition <candy machine address> --cluster devnet
```

This proves a Seeker's hardware key, with a locked and verified boot running this app, signed this
publication. It does not prove the sensor made the image.

### Security properties

- **Exact shape.** `readEdition` accepts an edition only when its candy machine, guard and
  collection match, byte for byte, what publishing leaves. No claim is built from anything else.
- **Wallet output is checked.** Each transaction the wallet returns must keep the same fee payer,
  lifetime, accounts, roles and instructions (compute budget aside), and the wallet's signature
  must verify. Only then does the app add its signatures, simulate and send.
- **Fee caps.** The app reviews at most 50,000 lamports of priority fee. The wallet may add at most
  250,000 more, and the Worker refuses above 300,000.
- **Exact funding.** A claim funds a one-shot payer with exactly the reviewed amount. A price
  changed mid-claim makes the transaction fail instead of charging a different amount.
- **Co-signer limits.** The co-signer key holds no funds and no authority, and signs only the claim
  layout in `worker/src/claimTransaction.ts`.
- **Release gate.** `npm run release:check` refuses stray `.env` files, an unflagged non-mainnet
  cluster, a mainnet build with no RPC URL or a public solana.com one, an RPC URL that carries
  credentials, and attestation roots that differ from Google's live list.

## Build and run

**Requirements:** Node.js 24.20.0 (`.nvmrc`) and npm 10+, JDK 17, the Android SDK with
`ANDROID_HOME` set, and a Seeker (or another Android 14+ arm64 phone) over USB. Expo Go and
emulators cannot run the native camera or attestation. There is no iOS or web target.

```sh
npm ci
cp .env.example .env.local     # then edit
npx expo run:android           # build and install the dev client
```

| Variable | Purpose |
|---|---|
| `EXPO_PUBLIC_SOLANA_CLUSTER` | `devnet` or `mainnet-beta` (unset means mainnet) |
| `EXPO_PUBLIC_SEEKER_COSIGNER_URL` | Co-signer URL. Empty hides "Seeker holders only" |
| `EXPO_PUBLIC_SOLANA_RPC_URL` | Optional HTTPS RPC. Required for mainnet releases (`https://cosign.erashot.app/rpc`) |
| `EXPO_PUBLIC_PRICE_TOKEN_MINT` | Devnet only: an SPL mint standing in for SKR |
| `EXPO_PUBLIC_TURBO_HOST` / `_UPLOAD_HOST` / `_PAYMENT_HOST` | Optional Turbo origins |

**Release APK.** Signed with the upload key from the four `SIGNSHOT_UPLOAD_*` Gradle properties.
`release:check` refuses `.env.local` and the other local env files, so the values go on the command
line:

```sh
# devnet
EXPO_PUBLIC_SOLANA_CLUSTER=devnet EXPO_PUBLIC_SEEKER_COSIGNER_URL=https://cosign.erashot.app \
  npm run release:apk -- --allow-cluster devnet
# mainnet: the same build with a cluster and an RPC URL, and no program to deploy
EXPO_PUBLIC_SOLANA_CLUSTER=mainnet-beta EXPO_PUBLIC_SOLANA_RPC_URL=https://cosign.erashot.app/rpc \
  EXPO_PUBLIC_SEEKER_COSIGNER_URL=https://cosign.erashot.app npm run release:apk
```

**Checks**

```sh
npm test                                   # typecheck + offline gates (version, prebuild, signing, runtime, looks)
cd worker && npm ci && npm test            # Worker tests in workerd
npx tsx scripts/check-candy-svm.ts         # every edition flow in LiteSVM against mainnet's programs (needs SVM_MAINNET_RPC)
npm run build:site                         # erashot.app static files into site/dist
```

## Repository layout

- `src/`: the React Native app (screens, looks, publishing, collecting, wallet, Arweave, Seeker integrations)
- `modules/seeker-camera/`: native Expo module (Kotlin) for Camera2 capture, OpenGL rendering, print cards, QR scanning and key attestation
- `publications/`: edition client: Candy Machine/Guard/Core instructions, `readEdition`, the metadata document, attestation, RPC, storage
- `worker/`: the Seeker co-signer and mainnet RPC proxy (Cloudflare Worker + D1)
- `site/`: static files for erashot.app (terms, privacy, moderation list, App Links, collect page)
- `scripts/`: checks, the attestation verifier and release tooling
- `programs/svm/`: the LiteSVM host that `check-candy-svm.ts` drives (a test harness, not an on-chain program)
- `plugins/`: Expo config plugins (signing, ProGuard, sharing paths)
- `android/`: the generated Android project
- `dapp-store/`: release record, signing certificate, store icon
- `assets/`: icons and fonts
- `submission/`: demo video script and voice-over

## Before release

- On-phone runs still to do on the release build: a Seeker-only claim to the end, collect free,
  buy in SKR, `Close sale`, `Send`.
- On-phone visual checks: the looks in daylight (a face, something red), Camcorder's smear in both
  landscape orientations, and the QR card with `Add my .skr name` on and off.
- On-phone state checks: the Device row of a draft whose certificates have expired, terms and
  `Agree` on a fresh install, and an edition in `moderation.json` showing as Hidden.
- Find out whether Seed Vault adds Lighthouse instructions to a claim.
  `WALLET_ADDED_PROGRAMS_ALLOWED` in `worker/src/claimTransaction.ts` is empty, so such claims are
  refused today.
- Right after a publish, the Wallet screen's Published list shows the new edition as not yet
  readable for about a minute, until a gateway serves its files.
- A Bot Tax guard set by the publisher while a claim is in flight can make the mint fail inside a
  successful transaction, so the payer's funding is spent and no copy is made. The claim needs an
  instruction after `mint_v1` that fails unless the copy exists.
- Wallet-failure copy (`walletTimeout`, the sheets' catch blocks) still assumes the wallet
  broadcasts. `send.ts` should report which phase failed. Program errors from publish, `Set price`,
  `Close sale`, `Send` and `Pay storage` reach the screen as raw JSON.
- Arweave ids go on chain before the bytes leave the phone. A lost phone before the upload leaves
  the edition pointing at nothing, and a mainnet Turbo refusal shows up only after publishing. The
  fix is to upload after signing and before sending. The metadata document is fetched without a
  hash check, and a refused storage payment is never offered again.
- Final mainnet APK: `release:check`, `release:apk`, a fresh install, an offline capture, and one
  small mainnet publication with its upload.
- dApp Store listing: the mainnet APK, a 1200×600 banner, 4–8 previews, terms
  (https://erashot.app/terms/) and privacy (https://erashot.app/privacy) URLs.

## Licence

MIT. See [LICENSE](LICENSE).
