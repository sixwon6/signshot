# Signshot

Signshot is a photographer's toolkit for the Solana Seeker phone: its own Camera2/OpenGL still
camera with manual exposure, white balance and focus; looks that shape the picture at capture time
and again in Develop; and a photo library with sharing, export and print cards. With the Seeker's
built-in wallet (Seed Vault, over Mobile Wallet Adapter) a photograph becomes a numbered Metaplex
Core edition, sold through Metaplex's Core Candy Machine, its image and details on Arweave, that
other wallets collect free or buy for SOL or SKR.

The Android package is `app.signshot`; the web domain is `erashot.app` (collect links, App Links,
the co-signer at `cosign.erashot.app`, terms and privacy).

## The camera

One layout under a mode dial (AUTO, P and M), one grammar in every mode: the bottom row chooses,
the row above it adjusts, the shutter shoots. Every control is in the sheet under the thumb; the
picture carries nothing at rest.

- **AUTO** is point-and-shoot: tap the picture to focus and meter there, choose a look and its
  strength, and drag up or down on the picture for up to two stops of brightness. A new tap or
  reopening the app resets the brightness; nothing else stays set.
- **P** shows the readout as cells in one fixed order (ISO, shutter, brightness, colour, focus,
  the look); the row above is the live cell's ruler, with detents (ISO in third stops, shutter in
  full stops, brightness in the device's own steps, Kelvin by the hundred, fine focus) and a key
  that hands the control back to the camera. A cell shows the camera's own value in auto and, in
  the accent colour, what you hold.
- **M** holds the ISO and shutter pair the camera just metered (Camera2 holds them together);
  moving either ruler in P turns the dial to M, and P hands both back.

AUTO keeps what P and M are holding and returns it with the dial, which shows the position
keeping it; holding AUTO down lets everything go. The looks are cameras you could have owned: the
phone itself (named for its model, Seeker on a Seeker, nothing added), Digicam, Disposable and
Camcorder. Off AUTO the look in force opens its strength, then its stages for editing. DISP cycles
a plain picture, a grid of thirds and the histogram. Capture sizes are the device's 4:3 YUV sizes.

The shutter opens the new photograph with `Publish this moment`, `Save` and `Share`. Develop,
which puts another look or strength on a photograph already taken, is offered when it is opened
from Photos, not on the one the shutter just made.

## Editions

- **Publish.** `Publish this moment` opens the form: title (up to 24 bytes), caption, `One copy`
  or `Multiple copies` (2 to 1000 in all), a price per copy in SOL or SKR (multiple copies only;
  SKR on mainnet, on devnet the mint in `EXPO_PUBLIC_PRICE_TOKEN_MINT` when set),
  a royalty of 0–10% (5% to start) and, when the co-signer answers, `Seeker holders only`.
  `Continue` connects the wallet, saves the draft (document, Arweave ids and three fresh keypairs:
  collection, candy machine, copy 1) and shows the receipt and the estimated cost; `Publish` asks
  the wallet to sign both publishing transactions in one approval. The app sends them in order;
  the second mints copy 1 to the publisher and locks the edition. If only the first lands, the
  draft says "The first of two transactions landed. Continue to finish publishing." Once both
  confirm, the image and the document go to Arweave.
- **Share.** A print card carries the collect link, `https://erashot.app/collect/?core=<edition>`
  (`&cluster=devnet` on devnet), as a QR code; the edition address is the candy machine's. On a
  Seeker with Signshot installed the link opens the Collect sheet (Android App Links); the Wallet
  screen's `Collect` also takes a pasted link or address, or scans a QR code. In a browser the
  link shows only "Open in Signshot".
- **Collect or buy.** `Continue` reads the edition again and shows the cost; `Collect` (free) or
  `Buy` (priced) opens the wallet. The collector pays the network fee, the copy's rent, Metaplex
  Core's 0.0015 SOL create fee and, on an open edition, the rent of a one-copy counter. A price
  goes to the publisher inside the minting instruction: SOL to the publisher's wallet, SKR to the
  publisher's associated token account. The claim funds a one-shot payer (and, for SKR, a temporary
  token account) with exactly the reviewed amounts, so a price changed in between makes it fail
  rather than pay a different one.
- **One copy each.** An open edition allows one copy per wallet, counted on chain by Candy Guard's
  Mint Limit. A Seeker-only edition allows one copy per Seeker Genesis Token, counted by the
  co-signer Worker; without one the sheet reads "Needs a Seeker Genesis Token."
- **Price.** The publisher changes the price, or makes it free, with `Price` on the photo page or
  the price on the Wallet screen: `Continue`, then `Set price`. The edition keeps its kind (open or
  Seeker-only).
- **Close.** `Close sale`, reviewed and then confirmed, withdraws the guard and returns its rent;
  the sheet says "Closing ends the sale." The candy machine's rent cannot be recovered. The
  collection and the copies stay on chain, but the app then reads the edition as "This edition is
  closed" and no longer lists it or its copies on the Wallet screen. The app offers no way to
  reopen a sale; on chain, whoever holds the candy machine's key (its seed stays in the
  publisher's draft on the phone) can open a new guard at the same address.
- **Send.** `Send` transfers a copy (copy 1 from the photo page, any held copy from the Wallet
  screen) to another wallet with Core `TransferV1`. A transfer is not a sale and "A transfer can’t
  be undone."

## What goes on chain

Everything runs on programs Metaplex has deployed: Core Candy Machine
(`CMACYFENjoBMHzapRXyo1JZkVS6EtaDDzkjMrmQLvr4J`), Core Candy Guard
(`CMAGAKJ67e9hRZgfC5SFTbZH8MgEmtqazKXjmkaJjWTJ`) and Metaplex Core
(`CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d`). Signshot has no program of its own and nothing
to deploy on chain. `publications/candy/` builds their instructions by hand on `@solana/kit`.

- **The collection**, a Core collection named after the title with the document's URI, carries
  exactly three plugins: MasterEdition (max = the supply) and Royalties (the publisher as sole
  creator, no rule set), both with authority None, and UpdateDelegate naming the candy machine's
  authority PDA, which is what lets copies mint.
- **The candy machine** uses hidden settings: copy n is named `<title> #n` and every copy carries
  the one document URI; the settings hash holds the image's SHA-256.
- **The guard** is the candy machine's Candy Guard, with no groups. An open edition: Mint Limit
  (1 per wallet) and Edition, plus Sol Payment or Token Payment when priced. A Seeker-only
  edition: Third Party Signer (the Worker's key) and Edition, plus the payment; no Mint Limit.
- **The copies** are Core assets in the collection, each with its Edition number.

Publishing ends with the candy machine's authority and the collection's update authority both
handed to `864BTg5dsR5DtBxPHm8uiU9GnRWL5V94AneqsnLRxgg8`, the System Program's derived address for
`["signshot", "no authority"]`, for which no key exists. So nobody can change the title, the image
hash, the document URI, the supply, the royalty or the plugins, or mint a copy outside the candy
machine.

The publisher keeps the guard's authority, and with it:

- the price and closing, as the app offers them;
- any other guard set, sent by hand: a different payment or destination, no Mint Limit, copies for
  itself, Edition numbers shifted. The app then refuses the edition ("This edition's terms are not
  ones this app sets"), and the readers check the copies themselves for repeated or out-of-range
  numbers ("Two copies of this edition carry the same number.");
- handing the guard to another key, after which the edition no longer reads in the app.

What the chain does not show: an edition proves that one key is the sole royalty creator, the payee
and the guard's authority, not that this key signed the publish or holds the photograph's rights.
Anyone can send lamports to a wallet's Mint Limit counter address before it claims; the guard then
cannot create the counter, and that wallet can never claim that open edition ("This wallet cannot
claim this edition: its claim record's address is taken."). Seeker-only rests on the Worker's key:
whoever holds it can pass the guard without a Genesis Token, and nothing on chain counts
Seeker-only copies per wallet or per token.

A copy is ownership of the NFT, not of the image, and not evidence about the scene. The full-size
frames never leave the phone; the public copy is a compressed derivative.

The metadata document follows the Metaplex JSON standard (`name`, `description`, `image`,
`external_url` as the collect link, `attributes`, and `properties` with the one JPEG under `files`
and `category: "image"`), beside the evidence below. Readers refuse a document whose name, link,
file list or traits the app would not have written, and an image whose SHA-256 is not the candy
machine's.

## Storage

The image and the document are ANS-104 data items signed on the phone by a per-wallet upload key
(`src/arweave/`). Their ids are known before publishing, so the document's `https://arweave.net/<id>`
is in the candy machine and the collection from the start. They are posted to ar.io Turbo once
both publishing transactions confirm, and the upload is done when Turbo holds both: an item's id is
derived from its signed content. Readers fetch from `arweave.net/raw/` (Turbo's gateway as the
fallback) against the hashes. An interrupted upload resumes with
`Complete public upload`; `Export backup` saves the publication bundle while the bytes exist only
on the phone.

- **Devnet** uses Turbo's free tier; the allowance is checked at `Continue` and again before the
  upload.
- **Mainnet** uploads on the free tier first. When Turbo refuses (the free tier is a lifetime budget
  per wallet and per /24 subnet), the photo page and the publish sheet offer
  `Pay storage <amount> SOL`: one transaction holding a SOL transfer to Turbo's payment address
  (pinned in `publications/storage.ts`; a different address from `GET /v1/info` stops it) and an
  spl-memo `turboCreditDestinationAddress=<upload key>`, priced from `/v1/price/bytes` and
  `/v1/price/solana` with half again as headroom and refused above 0.01 SOL. The confirmed
  transaction id is posted to `/v1/account/balance/solana`, which credits the upload key once
  however often it is posted. A refused or misdirected credit is re-posted three times with
  backoff, and a credit still missing after ten minutes falls back to the free tier.

## Device attestation

On a phone that supports it, the metadata document carries Android hardware key attestation
(`signshot-attestation/1`, `publications/core/attestation.ts`): a fresh StrongBox (or TEE) key,
whose challenge is the SHA-256 of a manifest naming this publication (cluster, the Candy Machine
program, the candy machine, collection, publisher, nonce, image hash and capture fingerprints),
signs the manifest; the chain and signature go under `properties.signshot`, and the key is
deleted. The manifest names the candy machine and the image hash it holds, so the evidence cannot
move to another publication.

The receipt's `Device` row reads "Solana Seeker · StrongBox hardware key", the Record sheet "Signed
on a Solana Seeker · StrongBox hardware key · verified boot, bootloader locked", and the document
carries the attribute `Device: Solana Seeker`, only when (`readAttestationBundle`, then
`deviceVerdict`):

- the manifest, challenge and signature match a hardware-backed key whose chain ends at a Google
  root pinned in `src/seeker/keyAttestation.ts`;
- the attested app is exactly `app.signshot` signed by exactly the release key (`RELEASE_APP`,
  from `dapp-store/signing-certificate.json`);
- boot is verified, the bootloader locked, and the attested maker and model are Solana Mobile Inc.
  / Seeker;
- every certificate is valid at the publication time: the block time of the transaction in which
  the System Program created the candy machine account for the Candy Machine program
  (`publicationTime`, which walks at most three pages of the account's signatures); a draft is
  judged now;
- no certificate serial is on Google's revocation list
  (`https://android.googleapis.com/attestation/status`).

Otherwise it reads "Not accepted:" with the reason, "Couldn’t check." when the list or the time
cannot be fetched, or "Not recorded." when there is none. `Continue` attests again, before
anything is signed, when a certificate has expired or expires within 24 hours.
`npm run release:check` refuses when Google's live roots
(`https://android.googleapis.com/attestation/root`) differ from the pinned ones.

It shows that a hardware key on a Seeker, with a verified, locked boot and this app, signed this
publication within its certificates' validity. It does not show that the sensor made the image, or
anything about the scene, and the app identity is only as good as the OS that verified boot
vouches for. Wallets and explorers show `attributes` unchecked. The same rules run off-device from
the published edition, and exit non-zero on any failure:

```sh
npm run verify:attestation -- --edition <candy machine address> --cluster devnet
```

## Seeker Genesis Token

When the draft is made, the app looks up the publishing wallet's Seeker Genesis Token (SGT) on
mainnet, whatever cluster it publishes on: the one it found last time while still held, else the
lowest member number. A found mint is written under `properties.genesisToken`
(`signshot-genesis/1`, `publications/core/genesisToken.ts`) and as the attribute
`Seeker Genesis Token: <mint>`; when mainnet cannot be asked the document names none and the
receipt's `Genesis Token` row reads "Couldn’t check.".

The document only claims the mint. A mint is an SGT when Token-2022 owns it and its
`MetadataPointer` and `TokenGroupMember` name Solana Mobile's group
(`GT22s89nU4iWFkNXj1Bw6uYhJJWDRPpShHt4Bk8f99Te`) with the mint itself as the member; only the
group's update authority, Solana Mobile's key, can write that membership. Each time the Record
sheet opens it checks the claim against mainnet: "Held by the publishing wallet.", "Not held by
the publishing wallet.", "Not a Seeker Genesis Token." or "Couldn’t check.". Readers fetch at most
4 KB of the mint, and an endpoint that is unreachable or not mainnet is "Couldn’t check.", never
"not held". Nothing on chain records the token.

**Seeker-only editions**: the switch is offered for multiple copies when the co-signer answers,
whether or not the publisher holds an SGT. A claim signs in with Sign-in-with-Solana in the same
wallet session that signs the claim: the app authorizes, then has the wallet sign the Worker's
message with `sign_messages`. On Seed Vault Wallet that is a Verify sheet and the claim sheet,
each with its own confirmation. The Worker co-signs once per SGT per edition. The claim names the owner's token, not the phone that
took the photograph.

## Seeker ID

Settings, under `On your Seeker`, shows the connected wallet's `Seeker Genesis Token` (HELD or NOT
HELD) and its `Seeker ID`, the wallet's `.skr` name, both read from mainnet whatever cluster the
build publishes on. The name is resolved from the address as Solana Mobile's resolver does
(`src/seeker/skrName.ts`, https://docs.solanamobile.com/solana-mobile-stack/skr-domain), and stands
in place of the address on the Settings wallet card and on the publisher's own photo page. With
`Add my .skr name` on (Settings, `Sharing`), the QR card the publisher shares carries the name.

## The co-signer Worker

`worker/` (see `worker/README.md`) is a Cloudflare Worker served only at
`https://cosign.erashot.app` (`EXPO_PUBLIC_SEEKER_COSIGNER_URL`). It holds the Third Party Signer
key of Seeker-only editions and co-signs a claim after Solana Mobile's server-side check: the
Sign-in-with-Solana payload it issued, the wallet's signature over the exact claim it builds, an
edition `readEdition` would accept naming its key, and a Genesis Token the wallet holds on mainnet
(Helius) that has not claimed this edition (D1). It trusts its RPC endpoints (`MAINNET_RPC_URL`, a
Helius URL, and `DEVNET_RPC_URL`) and its own key; the key holds no funds and no authority over any
account. When it is down, Seeker-only editions
cannot be claimed; nothing else depends on it.

## erashot.app

Collecting and buying happen in the app only. `site/` (see `site/README.md`) holds the static
files `erashot.app` serves to the app's links: the terms, the privacy policy, the moderation list,
the App Link association and the collect link page. `npm run build:site` produces `site/dist`,
deployed by Wrangler direct upload.

## Security properties

- **Exact shape.** `readEdition` accepts an edition only when its candy machine, guard and
  collection are, field by field and byte for byte, what publishing leaves: owners, sizes,
  authorities, hidden settings, the three plugins and their bytes, and a guard that re-encodes from
  one of the app's own sets for its price and co-signer. Anything else reads "Not a Signshot
  edition (…)", and no claim is built from it.
- **What the wallet returns.** The wallet only signs (`signTransactions`); the app sends through its
  own RPC. Each returned transaction is refused ("The wallet returned a different transaction (…).
  Nothing was sent.") unless it has the same fee payer, lifetime, accounts and roles and the same
  instructions in order apart from compute budget, and the wallet's signature verifies; only then
  does the app add its keypairs' signatures, simulate the signed bytes and send.
- **Fee cap.** The reviewed priority fee is at most 50,000 lamports per transaction (the median of
  recent fees, at least 5,000 µlamports per unit). A wallet's compute-budget rewrite may add at most
  250,000 lamports above the reviewed fee, whatever limit it sets (at most 1,400,000 units; Seed
  Vault Wallet sets about 80,000 on a publish). The Worker refuses a claim whose priority fee
  exceeds 300,000 lamports.
- **Release gate.** `npm run release:check` refuses a local env file a production bundle would
  load, a non-mainnet cluster without `--allow-cluster devnet`, a mainnet build without its own RPC
  URL or with a public solana.com one, an RPC URL that is not HTTPS or carries a query string or
  credentials, an RPC on another network, a co-signer URL that is not HTTPS, and any difference
  from Google's live attestation roots. `npm run release:apk` deletes an APK whose bundle is not
  this build's (it must carry the fresh `EXPO_PUBLIC_BUILD_NONCE` the script sets, and the RPC URL)
  or whose signer is not the upload key.
- **erashot.app.** Static files only, no Functions, and a `default-src 'none'` CSP on every page;
  the collect link page's one script, allowed by its hash, fetches nothing.

## Requirements

- Node.js 24.20.0 (see `.nvmrc`) and npm 10 or newer.
- JDK 17 and the Android SDK, with `ANDROID_HOME` set
- A Solana Seeker over USB with developer mode on

There is no iOS or web target, and Expo Go cannot load the native camera module. The camera and
the hardware attestation need the phone itself; an emulator runs neither.

Without a Seeker, `npm test` needs only Node, and a published edition can be checked from any
machine with `npm ci` and `npm run verify:attestation`.

## Run it on a Seeker

Install dependencies with `npm ci`, then copy `.env.example` to `.env.local` and set:

```sh
EXPO_PUBLIC_SOLANA_CLUSTER=devnet
EXPO_PUBLIC_SEEKER_COSIGNER_URL=https://cosign.erashot.app
# optional: a classic SPL Token mint standing in for SKR on devnet
# EXPO_PUBLIC_PRICE_TOKEN_MINT=
# optional: an HTTPS RPC URL; devnet otherwise uses the public endpoint
# EXPO_PUBLIC_SOLANA_RPC_URL=
# optional: Turbo origins (plain https://host) in place of https://turbo.ardrive.io
# EXPO_PUBLIC_TURBO_HOST=
# EXPO_PUBLIC_TURBO_UPLOAD_HOST=
# EXPO_PUBLIC_TURBO_PAYMENT_HOST=
```

Build and install the development client with a device attached, then reload it from Metro for
later JavaScript changes:

```sh
npx expo run:android
adb reverse tcp:8081 tcp:8081
npx expo start --dev-client
```

## Checks

`npm test` runs the TypeScript typecheck (the app and `scripts/`) and the gates
`check-version.ts`, `check-prebuild.ts`, `check-signing.ts`, `check-runtime-behavior.mjs`,
`check-capture-hook.mjs`, `check-looks.mjs` and `check-smear.mjs`, with no device or network;
`npx tsx scripts/<gate>` runs one. The less obvious ones:

- `check-version.ts`: app.json and `build.gradle` agree on the version, and the versionCode is
  ahead of every release in `dapp-store/releases.json`.
- `check-prebuild.ts`: the committed `android/` project still matches app.json and the config
  plugins (permissions, sharing paths, ProGuard rules), not every generated file.

Outside `npm test`:

- `npx tsx scripts/check-candy-svm.ts` runs every edition flow, as the app sends it and with a
  simulated wallet rewriting it, in LiteSVM against mainnet's Core Candy Machine, Core Candy Guard
  and Metaplex Core, read once from `SVM_MAINNET_RPC` into `.cache/svm/`. It builds the LiteSVM host
  in `programs/svm/` (on Windows with the toolchain under `%LOCALAPPDATA%\ssbt`).
- `cd worker && npm test` runs the Worker's tests in workerd.
- `npm run release:check` (`scripts/check-release-config.ts`) refuses while `.env`,
  `.env.production` or a `.env*.local` file is present, so it runs on release builds only.
- Builds: `npm run build:android-bundle`, `./gradlew :seeker-camera:compileDebugKotlin` from
  `android/`, and `npm run build:site`.

After native configuration changes run `npx expo prebuild -p android` and review the diff;
`npx expo install --check` and `npx expo-doctor` check the SDK and setup. The `react-dom` override
keeps one React; the scoped `xcode` override pins `uuid` 11.1.1.

Release signing uses the upload key (`CN=Era Shot`), whose SHA-256 identity
`dapp-store/signing-certificate.json` pins; the four local Gradle properties use the
`SIGNSHOT_UPLOAD_*` prefix.

## Folders

- `src/`: the app: camera and photo screens, looks, publishing, collecting, prices, wallet and
  Arweave
- `modules/seeker-camera/`: the native Expo module: Camera2 capture, OpenGL rendering, file I/O,
  QR scanning, key attestation
- `publications/`: the edition client: `candy/` (Candy Machine, Candy Guard and Core instructions,
  `readEdition`, signing order), `core/` (the metadata document, attestation, Genesis Token),
  chain reads, RPC and storage
- `worker/`: the Seeker co-signer Worker
- `programs/svm/`: the LiteSVM host `check-candy-svm.ts` drives
- `site/`: erashot.app, the static pages the app links to
- `android/`: the generated Android project, the Gradle build and signing configuration
- `scripts/`: the checks and the release tooling; `plugins/`: Expo config plugins for prebuild
- `dapp-store/`: the release record, the signing certificate and the store icon
- `assets/`: icons and fonts

## Before release

- **On the Seeker, the rest of the new flows on the release build.** Run on devnet on 4 October:
  publish (open and Seeker-only), buy in SOL, `Set price`, a wallet with no Genesis Token refused.
  Still to run: a Seeker-only claim to the end, collect free, buy in SKR (devnet needs
  `EXPO_PUBLIC_PRICE_TOKEN_MINT`), `Close sale` and `Send`. Judge the looks in daylight with a face and something red in
  frame; check Camcorder's smear in both landscapes. Read the Device row of a draft left past its
  certificates (`Continue` renews it). Terms and `Agree` before the first publish and collect on a
  fresh install; an edition in `moderation.json` reads Hidden.
- **The Worker on the phone:** a Seeker-only claim has signed in and signed on the Seeker and
  reached the Worker, which then failed its devnet reads through the public endpoint. It now reads
  devnet through the `DEVNET_RPC_URL` secret; no claim has reached it since. Still unknown: whether
  Seed Vault adds Lighthouse instructions when it signs a claim (`WALLET_ADDED_PROGRAMS_ALLOWED` in
  `worker/src/claimTransaction.ts` is empty, so they are refused today).
- **The QR card on the phone:** it now reads `N COPIES` (`ONE COPY`) and, with `Add my .skr name`
  on, carries the publisher's `.skr` name under the count. Look at the card in the share sheet
  with the switch on and off.
- **Right after a publish** the Wallet screen's Published list showed the new edition as unread for
  about a minute, until a gateway served its files. Find which read was late.
- **A claim that pays and mints nothing.** The publisher keeps the guard, and a Bot Tax guard set
  while a claim is in flight makes the failed mint succeed as a transaction: the one-shot payer's
  funding goes to the candy machine and no copy is made. The claim needs an instruction after
  `mint_v1` that fails unless the copy exists (and the Worker's layout with it).
- **After a wallet failure the sheets still speak as if the wallet had broadcast.** The wallet only
  signs now: a failure before the app sends means nothing was sent, and a failure while sending is
  decided by a fresh chain read. `send.ts` should say which phase failed; the four sheets' catch
  blocks and the `walletTimeout` copy follow from that. Program errors on publish, `Set price`,
  `Close sale`, `Send` and `Pay storage` still reach the screen as raw JSON.
- **Storage after the fact.** The Arweave ids go on chain before the bytes exist anywhere but the
  phone, and the items can only be rebuilt with the upload key in the Keystore: a lost phone or
  cleared data before the upload leaves the edition pointing at nothing, and on mainnet a Turbo
  refusal is first seen after publishing. Upload after the wallet signs and before the app sends.
  The document itself is fetched unhashed (only the image is checked against the candy machine),
  and a refused storage payment is never offered again.
- **Mainnet build:** `EXPO_PUBLIC_SOLANA_RPC_URL` at a key-free HTTPS URL, a keyless proxy or a
  provider's key-free frontend URL, since the APK carries it in plain text (`release:check` refuses
  a public endpoint, a query string, credentials and another network). It must serve every method
  the app calls: `getAccountInfo`, `getBalance`, `getBlockHeight`, `getGenesisHash`,
  `getLatestBlockhash`, `getMinimumBalanceForRentExemption`, `getMultipleAccounts`,
  `getProgramAccounts`, `getRecentPrioritizationFees`, `getSignatureStatuses`,
  `getSignaturesForAddress`, `getTokenAccountsByOwner`, `getTransaction`, `sendTransaction` and
  `simulateTransaction`. Check the 5,000 µlamport/CU floor price against that provider's fee data.
- **Final APK:** `npm run release:check` (also Google's attestation roots), `npm run release:apk`
  with the upload key, a fresh install, an offline capture, one small mainnet publication and its
  upload (and `Pay storage` if Turbo refuses the free tier).
- **dApp Store listing:** the mainnet build above; a publisher wallet with about 0.2 SOL; terms URL
  https://erashot.app/terms/; the opaque 512×512 icon in `dapp-store/icon-512.png`, a 1200×600
  banner, 4–8 previews at 9:16 or 16:9 of 3 MB or less, a name of 25 characters or fewer and a
  short description of 30 or fewer; privacy URL https://erashot.app/privacy.
- **Submission:** push, connect GitHub on Align (or make the repository public), a public direct
  link to the APK, a captioned three-minute device demo and the pitch deck
  (`submission/presentation/Signshot-CLOCK-IN.pptx`, kept out of the repository).

## Licence

MIT. See [LICENSE](LICENSE).
