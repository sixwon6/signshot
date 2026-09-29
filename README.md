# Signshot

Signshot is a photographer's toolkit for the Solana Seeker phone. It has its own Camera2/OpenGL
still camera with manual exposure, white balance and focus; recipes that shape the look at capture
time and again in Develop; and a photo library with sharing, export, print cards and albums. It
works with the Seeker's built-in wallet (Seed Vault, through Mobile Wallet Adapter): a finished
photograph can be published as a numbered Metaplex Core edition with its image and details on
Arweave, offered free or at a SOL price, collected or bought by other wallets in the app or on the
web, and sent on to another wallet.

Some identifiers keep earlier names because published editions and verified App Links depend on
them: the repository, the Android package `app.seekershot`, the `erashot.app` domain, the
`era_editions` program, and the metadata identifiers `seedshot-attestation/1`,
`seedshot-genesis/1`, `properties.seedshot`, `erashot-core/1` and `erashot-album/1`.

## The camera

One layout under a mode dial (AUTO, P and M) and one grammar in every mode: the bottom row
chooses, the row above it adjusts, the shutter shoots. Every control is in the sheet under the
thumb, and the picture carries nothing at rest.

- **AUTO** is point-and-shoot: tap the picture to focus and meter there, choose a look and its
  strength, and set brightness up to two stops either way by dragging up or down on the picture or
  on a slider. Nothing else can be left set.
- **P** shows the readout as a row of cells in one fixed order (ISO, shutter, brightness, colour,
  focus and the look), and the row above is the live cell's dial: rulers with detents for ISO in
  third stops, shutter in full stops, brightness in the device's own steps, Kelvin by the hundred
  and fine focus, each ending in a key that hands the control back to the camera. A cell shows what
  the camera is doing in auto and, in the accent colour, what you are holding.
- **M** holds the exposure. Camera2 holds ISO and shutter together, so M holds the pair the camera
  just metered; moving either ruler in P turns the dial to M, and P hands both back.

AUTO remembers what P and M were holding and returns it with the dial, which shows the position
keeping it; holding AUTO down lets everything go. The looks are cameras you could have owned: the
phone itself (SEEKER on a Seeker, with nothing added), Digicam, Disposable and Camcorder. Off AUTO
the look in force opens its strength and, from there, its stages for editing. DISP cycles a plain
picture, a grid of thirds and the histogram. Capture sizes are the device's supported 4:3 YUV
sizes.

## The edition lifecycle

- **Publish.** One wallet approval creates the edition, its Metaplex Core collection and copy 1
  for the publisher; the public image and the metadata document are then uploaded to Arweave. The
  price, the creator's royalty and an optional rule that only Seeker Genesis Token holders may
  collect go into the same approval, and on mainnet so does the storage payment.
- **Share.** A published photograph shares a print card carrying its collect link,
  `https://erashot.app/collect/?core=<edition>`, as a QR code. Tapping that link on a Seeker with
  Signshot installed opens the Collect sheet directly (Android App Links); the Collection tab also
  takes a pasted link or address, or scans a QR code with the phone's camera. Anywhere else the
  link opens the web collect page.
- **Collect or buy.** A free edition is collected: the collector pays the network fee, account
  rent and Metaplex Core's create fee, and nothing reaches the publisher. A priced edition is
  bought: the price is paid to the publisher in the same transaction that creates the copy, and the
  buyer signs the exact price and offer revision they reviewed, so a changed price fails safely.
  One copy per wallet per edition, ever (per Genesis Token on a Seeker-only edition).
- **Price.** The publisher can set, change or remove the price of an edition at any time from the
  photo page or the Collection tab. Prices are in SOL only.
- **Send.** A copy can be transferred to another wallet. A transfer is not a sale.

## What goes on chain

Publishing mints a Metaplex Core asset through the Anchor program in `programs/editions/` and
writes a permanent `Edition` record beside it, plus one `Receipt` per collecting wallet (per
Genesis Token on a Seeker-only edition) and an optional `Offer` holding the price. Current builds
also lock the creator's royalty into the collection as a Metaplex Core `Royalties` plugin. The
photograph's full-size frames never leave the phone; the public copy is a compressed derivative.
A copy is ownership of the NFT, not of the image, and not evidence about the scene in front of the
camera.

The metadata document follows the Metaplex JSON standard: `name`, `description`, `image`,
`external_url` (the edition's collect link), `attributes`, and `properties` with the one JPEG
under `files` and `category: "image"`, beside the evidence below. Its hash is on chain, and the
readers refuse a link, file list or trait the app would not have written.

## Storage

The image and the document are ANS-104 data items signed on the phone by a per-wallet upload key
(`src/arweave/`) and posted to ar.io Turbo's HTTP API after the publication has confirmed. Their
ids are in the approved `uri`, so an upload can resume from any later session.

- **Mainnet pays.** Turbo's free tier is a lifetime budget per wallet and per /24 subnet, and
  running out of it is permanent, so the publication transaction carries the storage payment: a SOL
  transfer to Turbo's payment address (pinned in `publications/storage.ts` and confirmed against
  `GET /v1/info` on every quote), priced by `/v1/price/bytes` and `/v1/price/solana` with half
  again as headroom and a 0.01 SOL ceiling, plus an spl-memo
  `turboCreditDestinationAddress=<upload key>`, turbo-sdk's own recipe. The review shows it as
  its own row. After confirmation the transaction id is posted to `/v1/account/balance/solana`,
  which credits the upload key once however often it is re-posted, and the upload waits for that
  credit. A quote that fails, or an `/info` naming another address, stops publishing before the
  wallet opens. A confirmed payment the service refuses or credits elsewhere is re-posted three
  times with backoff, then the upload falls back to the free tier for items within its size limit.
- **Devnet stays free.** The free allowance is checked before the approval and again before
  upload.
- **Recovery never pays twice:** it only re-posts the confirmed transaction. A wallet that never
  returned its receipt is answered from the history of the creator's claim receipt, then of the
  edition, by the reviewed fingerprint. The path settled on (credit or free tier) is saved on the
  draft, and a resumed upload takes it again.

## Device attestation

Every publication made on a phone that supports it carries Android hardware key attestation
inside the metadata document (`seedshot-attestation/1`, `publications/core/attestation.ts`).
Before the document is sealed, the phone's keystore generates a fresh StrongBox (or TEE) key
whose attestation challenge is the SHA-256 of a canonical manifest naming this exact publication:
edition address, creator, nonce, the public image fingerprint and the private capture
fingerprints. The key signs the manifest, the certificate chain and signature go into the document
under `properties.seedshot`, and the key is deleted. Because the document's hash is committed on
chain, the evidence cannot be swapped or transplanted: a certificate from another key, phone or
publication carries a different challenge and is refused. A phone that cannot attest publishes the
document without it.

The document's `attributes` name the device (`Device: Solana Seeker`) for wallets and explorers
only when the full verdict below passed as the document was sealed; a draft whose verdict no
longer passes when it is sent is sealed again without it. The app re-derives the trait from the
certificate on every read and refuses one from another app or from a phone without verified boot
and a locked bootloader. Older documents that carried `Device` and `Attestation` unconditionally
stay readable on the deployments they were published on.

The Proof sheet, the publish review and the collect page say "Signed on a Solana Seeker ·
StrongBox hardware key · verified boot, bootloader locked" only when every one of these holds
(`readAttestationBundle`, then `deviceVerdict`, in `publications/core/attestation.ts`):

- the manifest names this publication, the challenge is its SHA-256, the signature verifies, the
  key is hardware-backed, and the chain is signed down to one of Google's roots pinned in
  `src/seeker/keyAttestation.ts` (the RSA root and Key Attestation CA1);
- the attested app is exactly `app.seekershot` signed by exactly the release key
  (`RELEASE_APP`, from `dapp-store/signing-certificate.json`); a debug or test build is another app;
- verified boot and a locked bootloader, and the hardware-attested manufacturer and model are
  Solana Mobile Inc. / Seeker (another device that passes everything is named as itself);
- every certificate is valid at the edition's on-chain publication time (`publicationTime`): the
  `published_at` the program wrote into the `Edition` from the Clock sysvar at publish, which no
  later transaction can move. On the deployments in `LEGACY_WITHOUT_PUBLISHED_AT`, which predate
  the field, it is the block time of the transaction in which the System program created the
  publisher's claim receipt, so an earlier mention of the address cannot backdate it. A draft not
  yet sent is judged now. Google says RKP certificates must "continue to have their validity
  period checked", and the Seeker's StrongBox certificate lives 13 days. The rule applies to
  RSA-rooted chains too, which Google does not require for pre-2021 factory keys (no Seeker has
  one);
- no certificate serial, in hex or decimal, is on Google's revocation list
  (`https://android.googleapis.com/attestation/status`), whichever root the chain ends at. Leaked
  factory keyboxes chain to the RSA root, and Google's documentation asks for "the status of each
  certificate" with no exemption for Key Attestation CA1.

A definite failure reads "Not accepted:" with the reason (another app, bootloader unlocked, boot
not verified, revoked, suspended, expired at publication); a list or a publication time that
cannot be fetched reads "Couldn't check."; a document without evidence reads "Not recorded." (on
the collect page, "No device attestation."), and so does the review when the phone produced none.
The app fetches Google's list directly; the collect page reads it through
`site/functions/api/attestation-status.ts`, because Google sends no CORS header. A draft is
attested when it is built, so before its document's hash goes into the transaction the send path
attests again when any certificate has expired or will within 24 hours, in the same single wallet
approval. `npm run release:check` also compares Google's live root list
(`https://android.googleapis.com/attestation/root`) with the pinned roots and refuses on any
difference.

What it shows: a hardware-protected key on a Seeker, whose keystore attested a verified, locked
boot and this app, signed this publication's manifest while its certificates were valid and not
revoked. What it does not show: that the camera sensor produced the image, or anything about the
scene. The attested app identity is asserted by the keystore daemon, so it is as good as the OS
that verified boot vouches for. Wallets and explorers show the document's `attributes` as written,
without any of these checks. Evidence that fails the reader is set aside with a reason, and the
photograph still loads. The same rules, with Node's X.509 check as a second opinion, run
off-device from the published bytes; this also checks the on-chain metadata hash, prints what the
readers show, and exits non-zero on any failure:

```sh
npm run verify:attestation -- --edition <address> --cluster devnet
```

A native run on a Seeker is recorded in `dapp-store/attestation-device-check-2026-09-16.json`.

## Seeker Genesis Token

A publication from a wallet that holds a Seeker Genesis Token (SGT) records the token's mint
address in the metadata document (`seedshot-genesis/1`, `publications/core/genesisToken.ts`):
under `properties.genesisToken`, and as a Metaplex attribute (`Seeker Genesis Token: <mint>`) that
wallets and explorers show as written. It follows Solana Mobile's
[recipe](https://docs.solanamobile.com/solana-mobile-stack/seeker-genesis-token) and answers its
three checks from the chain alone: the wallet owns an SGT (any reader can ask mainnet), the user
proved ownership of the wallet (it signed the transaction that commits the document's hash), and
the mint address is kept, because it stays the same when the token moves and so identifies the
Seeker across wallets.

**Reading a claim.** The document only claims the mint. The Proof sheet and the collect page check
it on mainnet when they open, once the endpoint's genesis hash says it is mainnet: the mint
account must be owned by Token-2022, its `MetadataPointer` and `TokenGroupMember` must name Solana
Mobile's group (`GT22s89nU4iWFkNXj1Bw6uYhJJWDRPpShHt4Bk8f99Te`), the member must be the claimed
mint itself, and the publishing wallet must hold it now with a non-zero balance. The membership is
what cannot be forged: Token-2022 writes it only with the signature of the group's update
authority, Solana Mobile's key. Mint authority and metadata pointer are anyone's to set on their
own mint, and the recipe names no mint authority, so nothing checks one. Readers fetch at most 4 KB
of the account; anything that does not decode as an SGT, however large or foreign, is not a
Genesis Token, and an unreachable or wrong-cluster endpoint is "Couldn't check", never "not held".
The SGT exists on mainnet only, so the check reads mainnet whatever network the edition is on. It
is independent of the device attestation: one names the owner's token, the other the phone that
signed.

The row says "Held by the publishing wallet.", "Not held by the publishing wallet.", "Not a
Seeker Genesis Token." or "Couldn't check."; "now" is added only for a sealed claim, which the
program saw held, including a sealed mint whose account has since closed, since an SGT can be
burned out of a wallet. A seal counts on mainnet only (a devnet seal comes from the acceptance
build's stand-ins), and "Verified and sealed by the edition program at publish." shows only while
mainnet still finds the mint to be an SGT (`genesisDisplay`). On mainnet, where the app has the
program seal every claim it publishes, a claim without the seal reads as none
(`publishedGenesisClaim`).

**Publishing a claim.** The app reads the wallet's Token-2022 accounts holding one unit of a
0-decimal mint, at most 100 mints per request. A wallet with several SGTs names the one found last
time while it still holds it, else the lowest member number; a wallet with none publishes without
the claim. When mainnet cannot be asked, the document names none and the review's Genesis Token
row says "Couldn't check."; a remembered mint is never written into a document.

**The program seals it.** `publish` and `publish_in_album` take two more accounts at the end: the
Genesis Token mint and the creator's token account for it, or the program id in each place for a
publication without one (`programs/editions/README.md`, "The Seeker Genesis Token accounts").
With both, the program reads the two accounts by hand (Token-2022 owner, the mint checks above,
and a non-zero balance owned by the creator), refuses anything else with `InvalidGenesisToken`,
and appends `seeker_genesis_token: <mint>` to the collection's locked attributes, so "held at
publish" is on chain with no document to trust and no RPC to ask. The app passes the accounts on
mainnet, where the token exists; a devnet edition carries the document's claim only. The reader
(`sealedGenesisMint`) accepts the five attributes or the five plus that one, and refuses a
collection whose seal disagrees with the document. The devnet program is built with `--features
devnet-genesis`, which swaps Solana Mobile's addresses for the acceptance's stand-ins so the seal
and its refusals run against a mock the session mints (`programs/editions/DEVNET.md`); a mainnet
build never carries the feature. Deployments in `LEGACY_WITHOUT_GENESIS`
(`publications/deployments.ts`) predate the two accounts and are sent neither.

**Seeker-only editions** are collected with a Genesis Token: one copy per token. The app and the
collect page find the collector's SGT with the same membership check (`findHeldGenesisToken`; on
devnet, the acceptance's stand-in that the devnet program build accepts), key the claim receipt on
its mint and hand the mint and its token account to `collect` or `buy`
(`publications/core/seekerClaim.ts`). A wallet without one reads "Needs a Seeker Genesis Token."

## The collect page

The public collect page at erashot.app is built from `site/` (see `site/README.md`) with the same
reader the app uses, so it accepts the same documents, shows the Device and Genesis Token rows,
and offers `collect` or `buy` by the live `Offer` account. A collect link opens the edition in the
app on a phone that has it (an Android App Link) and on the web page everywhere else.
`npm run build:site` produces `site/dist`, which is deployed by Wrangler direct upload.

## Deployments

`publications/deployments.ts` is the reviewed allowlist: every trusted program is pinned to its
ELF digest and upgrade authority, and `EXPO_PUBLIC_EDITIONS_*` can only select an address listed
there. It lists every reviewed devnet deployment; `programFeatures` tells their instruction
layouts apart by address, so editions on older deployments stay readable. The newest,
`4Rk11vaKzxqJhX1kkScRuJ4PKuPnjik6LHwus4J67ipM`, carries the Seeker-only publish rule; a Seeker run
of publishing, pricing, buying, free collection and sending against it is recorded in
`dapp-store/money-path-check-2026-09-28.json`. The live acceptance run of
`7ZL3pF3e9RVLjMjZ9QJuNi8Epw9bmPaKBAfVWHX4uGhU` is recorded in
`programs/editions/devnet-acceptance-2026-09-16.json`, and
`BGEM8ZTk2pP2btuorG8EHzfHgQSaudjuZKVw6f74zAjq` predates prices. The mainnet program is listed the
same way once deployed (see "Deploy the program").

## Security properties

- **Reviewed programs only.** Publish, collect and buy, in the app and on the collect page, refuse
  a program whose deployed bytes or upgrade authority differ from the pinned image
  (`publications/programImage.ts`); a signer's privileges reach every program it calls.
- **What the wallet signs is what was reviewed.** A buyer signs the exact price and offer
  revision, so a price changed in between fails (`OfferChanged`) instead of charging a different
  amount. Storage is paid only to Turbo's pinned address, within a 0.01 SOL ceiling, and recovery
  never pays twice.
- **Documents are bound to the chain.** The metadata document's hash is on chain; readers refuse
  a link, file list or trait the app would not have written, and re-derive the Device and Genesis
  Token rows instead of trusting the document's attributes.
- **Release gate.** `npm run release:check` refuses a local env file a production bundle would
  load, a non-mainnet cluster without `--allow-cluster devnet`, a missing program (an unlisted one
  fails at load), a mainnet build without its own RPC URL or with a public solana.com one, an RPC
  URL carrying a query string or credentials, an RPC on another network, and any difference from
  Google's live attestation roots. `npm run release:apk` deletes an APK whose bundle does not match
  what the gate recorded or whose signer is not the upload key.
- **Collect page.** A strict CSP with Trusted Types, no inline script, and inline style only by
  hash for the wallet adapter's dialogs; the RPC endpoint and trusted programs come from the
  build, never from the link. Its mainnet RPC proxy
  (`site/functions/api/solana.ts`) allows only the read-only methods the page calls, holds their
  params to the exact shapes it sends, bounds request and response sizes, refuses cross-origin and
  `Origin`-less callers, and sits behind a Cloudflare rate-limit rule.

## Requirements

- Node.js 24.20.0 (see `.nvmrc`) and npm 10 or newer. The Solana program clients require Node 24
  or newer.
- JDK 17 and the Android SDK, with `ANDROID_HOME` set
- A Solana Seeker over USB with developer mode on

There is no iOS or web target, and Expo Go cannot load the native camera module. The camera and
the hardware attestation need the phone itself; an emulator runs neither.

Without a Seeker, two things still run: `npm test` needs only Node, and a published edition can
be checked from any machine and opened in a browser:

```sh
npm ci
npm run verify:attestation -- --edition 7XCv1U3MxaJKzAC2oiVBvrRAcfoDimEVjhYGDW4hFF41 --cluster devnet
```

https://erashot.app/collect/?core=7XCv1U3MxaJKzAC2oiVBvrRAcfoDimEVjhYGDW4hFF41&cluster=devnet

## Run it on a Seeker

Install dependencies with `npm ci`, then copy `.env.example` to `.env.local` and set:

```sh
EXPO_PUBLIC_SOLANA_CLUSTER=devnet
EXPO_PUBLIC_EDITIONS_DEVNET_PROGRAM=4Rk11vaKzxqJhX1kkScRuJ4PKuPnjik6LHwus4J67ipM
```

Build and install the development client with a device attached, then reload it from Metro for
later JavaScript changes:

```sh
npx expo run:android
adb reverse tcp:8081 tcp:8081
npx expo start --dev-client
```

## Deploy the program

The pinned toolchain lives outside the repository; `build-native-windows.ps1 -Bootstrap` fetches
it (`programs/editions/README.md`, "Build").

- **Devnet** (`programs/editions/DEVNET.md`): `npm run devnet` opens a session whose `prepare`
  step builds the program with the pinned toolchain in an isolated tree and records the ELF
  digest; `deploy` writes it under a generated address and prints the lines to add to
  `publications/deployments.ts`.
- **Mainnet** (`programs/editions/MAINNET.md`): `npm run mainnet -- <step>` runs one resumable
  step at a time: `prepare` (keys and the ELF), `svm` (the LiteSVM suite on that ELF), `quote`,
  `deploy`, `verify`, `vault` and `authority` (hand the upgrade authority to a Squads multisig),
  `refund`, `record` (prints the `deployments.ts` lines) and `forget` (deletes the keys);
  `status` shows where it stands. `--cluster devnet` rehearses the same steps on devnet.

## Checks

`npm test` runs the TypeScript typecheck over the app and over `scripts/`, then these gates, all
with no device or network:

- `check-version.ts`: app.json and `build.gradle` agree on the version, and the versionCode is
  ahead of every release in `dapp-store/releases.json`
- `check-prebuild.ts`: the committed `android/` project still matches app.json and the config
  plugins (permissions, sharing paths, ProGuard rules)
- `check-signing.ts`: `build.gradle` carries the release-signing plugin's output, and the plugin
  still fits the Expo template
- `check-runtime-behavior.mjs`: publication metadata and its legacy formats, rent and upload
  budgets, capture modes and exposure, collect links, the release bundle's refusals, the
  deployed-program pin, sending copies, program error words, and the RPC method list in this
  README
- `check-capture-hook.mjs`: the capture controls' hook against a fake camera
- `check-looks.mjs`: each look's colour targets and the strength dial
- `check-smear.mjs`: Camcorder's chroma smear kernel as the shader emits it
- `check-attestation.ts`: the attestation parser, chain verifier, document reader and device
  verdict, against a synthetic certificate and Google's real root certificates
- `check-genesis.ts`: the hand-written Genesis Token decoder against the official
  `@solana-program/token-2022` encoder, the lookup, the display rules and the mainnet program's
  group address
- `check-site.ts`: the collect page's wording, its CSP copies, the App Link file, the RPC proxy
  and the build guards
- `check-storage.ts`: the storage quote, the payment instructions against the official System
  Program encoder, the credit and the recovery lookup
- `check-mainnet-deploy.ts`: every mainnet deploy step, end to end on a cluster held in memory

Outside `npm test`:

- `npm run test:svm` runs built `era_editions` ELFs end to end in LiteSVM against mainnet's
  Metaplex Core and a real Seeker Genesis Token, and `npm run test:program` runs the program's
  Rust unit tests on the pinned toolchain.
- `npm run devnet:check -- --require-offers` performs read-only checks against the configured
  devnet program and the app's public wallet and App Links endpoints, and saves a report to
  `.expo/devnet-check.json`. It signs nothing and does not replace the live acceptance run in
  `programs/editions/DEVNET.md`; it fails on a deployment without paid editions.
- `npm run release:check` (`scripts/check-release-config.ts`) is the release gate under "Security
  properties". It refuses while `.env`, `.env.production` or a `.env*.local` file is present and
  while no reviewed mainnet program is configured, so it belongs to a release build rather than to
  `npm test`.
- Builds: `npm run build:android-bundle` checks that the JavaScript bundle builds,
  `./gradlew :seeker-camera:compileDebugKotlin` from `android/` compiles the native module,
  `pwsh -File programs/editions/scripts/build-native-windows.ps1` builds the program, and
  `npm run build:site` builds the collect page.

`npx expo install --check` validates SDK compatibility, and `npx expo-doctor` checks the
dependency tree and project setup. The `react-dom` override keeps the wallet libraries' web peer on
Expo's React version, so npm installs a single React. The scoped `xcode` override pins `uuid`
11.1.1, and its CommonJS `v4()` consumer is tested. Expo Doctor warns about the committed
`android/` folder because EAS does not run Prebuild for it: after native configuration changes,
run `npx expo prebuild -p android`, review the generated diff, and run the checks. The prebuild
gate covers permissions, sharing paths and ProGuard rules, not every generated file.

Release signing uses the upload key, whose certificate subject is `CN=Era Shot`;
`dapp-store/signing-certificate.json` pins its SHA-256 identity, which is what Android and the
dApp Store match, not the display name. The four local Gradle properties use the
`SEEDSHOT_UPLOAD_*` prefix.

## Folders

- `src/`: the app: camera and photo screens, recipes, publishing, collecting, offers, wallet and
  Arweave
- `modules/seeker-camera/`: the native Expo module: Camera2 capture, OpenGL rendering, file I/O,
  QR scanning
- `publications/`: the Metaplex Core edition client: accounts, instructions, RPC, transfers,
  devnet and mainnet deploy tooling
- `programs/editions/`: the Anchor program behind publishing, collecting, pricing and buying an
  edition
- `site/`: the erashot.app collect page and its Cloudflare Pages Functions
- `android/`: the generated Android project, the Gradle build and signing configuration
- `scripts/`: the checks `npm test` runs and the release tooling; `plugins/`: Expo config plugins
  for prebuild
- `dapp-store/`: the record of releases submitted to the Solana dApp Store, and device checks
- `assets/`: icons and fonts

## Before release

- **On the Seeker:** brightness by dragging on the picture and on AUTO's slider; collect from the
  link in a browser wallet (Chrome's local network prompt, then Seed Vault signs and declines);
  time out and background the wallet mid-publish and mid-upload, and recover. Judge the looks in
  daylight with a face and something red in frame; check Camcorder's smear in both landscapes; save
  one photograph per look and compare it with the preview. Connect a wallet from the wallet
  screen and send a collected copy from it. Publish from the wallet that holds the Genesis Token and read its row on the review, the
  Proof sheet and the collect page. Read the Device row of a draft left past its certificates
  (Continue renews it). Terms and Agree before the first publish and collect; Report; Block and
  Unblock; an edition in `moderation.json` reads Hidden.
- **Site:** redeploy `site/` (page, `/api/solana`, `/api/attestation-status`, `/terms/`,
  `/moderation.json`) in one deploy, since the page now batches `getMultipleAccounts`, which the old
  Function refuses; the live page refuses a document that names a Genesis Token until then.
  Set `SOLANA_RPC_URL` to a provider (without it the proxy uses Solana's public endpoint), apply
  `site/cloudflare/rate-limit-rule.json` again (now 120 requests per 10 s), and route mail for
  support@erashot.app.
- **Mainnet:** the Squads multisig and its test proposal (`programs/editions/MAINNET.md` steps
  2–4), then the rest of `MAINNET.md` with `prepare-mainnet-windows.ps1` and the real
  address, then `npm run test:svm` against that ELF before it is deployed; the address, digest,
  length and upgrade authority in `publications/deployments.ts`; `EXPO_PUBLIC_SOLANA_RPC_URL` at a
  key-free HTTPS URL, a keyless proxy or a provider's key-free frontend URL, since the APK carries it
  in plain text (`release:check` refuses a public endpoint, a query string, credentials and another
  network). It must serve every method the app calls: `getAccountInfo`, `getBalance`,
  `getBlockHeight`, `getFeeForMessage`, `getGenesisHash`, `getLatestBlockhash`,
  `getMinimumBalanceForRentExemption`, `getMultipleAccounts`, `getProgramAccounts`,
  `getRecentPrioritizationFees`, `getSignatureStatuses`, `getSignaturesForAddress`,
  `getTokenAccountsByOwner`, `getTransaction` and `simulateTransaction`. Check the fixed 5,000
  µlamport/CU priority price against that provider's fee data.
- **Final APK:** `npm run release:check` (also Google's attestation roots), `npm run release:apk`
  with the upload key, a fresh install, an offline capture, one small mainnet publication — the
  first paid storage upload, so confirm Turbo credited the upload key from the publish transaction
  (otherwise it goes to the free tier after ten minutes, or Pay storage buys it on its own).
- **dApp Store:** the mainnet build above; publisher identity verification and a publisher wallet
  with about 0.2 SOL; terms URL https://erashot.app/terms/; the opaque 512×512 icon in
  `dapp-store/icon-512.png`, a 1200×600 banner, 4–8 previews at 9:16 or 16:9 of 3 MB or less, a
  name of 25 characters or fewer and a subtitle of 50 or fewer.
- **Submission:** `SUBMISSION_DRAFT.md`: push, connect GitHub on Align (or make the repository
  public), a public direct link to the APK, a captioned demo video (the judges read its
  transcript). CLOCK IN closes 2026-10-08 23:59 US Pacific.

## Licence

MIT. See [LICENSE](LICENSE).
