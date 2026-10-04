# Signshot

Signshot is a photographer's toolkit for the Solana Seeker phone: its own Camera2/OpenGL still
camera with manual exposure, white balance and focus; recipes that shape the look at capture time
and again in Develop; and a photo library with sharing, export, print cards and albums. With the
Seeker's built-in wallet (Seed Vault, over Mobile Wallet Adapter) a photograph becomes a numbered
Metaplex Core edition, its image and details on Arweave, that other wallets collect free or buy
for SOL.

The repository, the Android package `app.seekershot`, the `erashot.app` domain, the
`era_editions` program and the metadata identifiers `seedshot-attestation/1`,
`seedshot-genesis/1`, `properties.seedshot`, `erashot-core/1` and `erashot-album/1` keep their
names: published editions and verified App Links depend on them.

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
phone itself (SEEKER on a Seeker, nothing added), Digicam, Disposable and Camcorder. Off AUTO
the look in force opens its strength, then its stages for editing. DISP cycles a plain picture, a
grid of thirds and the histogram. Capture sizes are the device's 4:3 YUV sizes.

The shutter opens the new photograph with Publish this moment, Save and Share. Develop, which
puts another look or strength on a photograph already taken, is offered when it is opened from
Photos, not on the one the shutter just made.

## The edition lifecycle

- **Publish.** One wallet approval creates the edition, its Metaplex Core collection and copy 1
  for the publisher, with the price, the creator's royalty, an optional rule that only Seeker
  Genesis Token holders collect and, on mainnet, the storage payment; the public image and the
  metadata document then go to Arweave.
- **Share.** A print card carries the collect link, `https://erashot.app/collect/?core=<edition>`,
  as a QR code. On a Seeker with Signshot installed the link opens the Collect sheet (Android App
  Links); the Collection tab also takes a pasted link or address, or scans a QR code. In a browser
  the link shows only "Open in Signshot".
- **Collect or buy.** A free edition is collected: the collector pays the network fee, account
  rent and Metaplex Core's create fee, and nothing reaches the publisher. A priced edition is
  bought: the price goes to the publisher in the transaction that creates the copy, at the exact
  price and offer revision the buyer reviewed; a change in between fails with `OfferChanged`. One
  copy per wallet per edition, ever (per Genesis Token on a Seeker-only edition).
- **Price.** The publisher sets, changes or removes an edition's price in SOL at any time from the
  photo page or the Collection tab.
- **Send.** A copy can be transferred to another wallet; a transfer is not a sale.

## What goes on chain

Publishing mints a Metaplex Core asset through the Anchor program in `programs/editions/` and
writes a permanent `Edition` record, one `Receipt` per collecting wallet (per Genesis
Token on a Seeker-only edition) and an optional `Offer` holding the price. The creator's royalty
is locked into the collection as a Metaplex Core `Royalties` plugin. The full-size frames never
leave the phone; the public copy is a compressed derivative. A copy is ownership of the NFT, not
of the image, and not evidence about the scene.

The metadata document follows the Metaplex JSON standard (`name`, `description`, `image`,
`external_url` as the collect link, `attributes`, and `properties` with the one JPEG under `files`
and `category: "image"`), beside the evidence below. Its hash is on chain, and the readers refuse a
link, file list or trait the app would not have written.

## Storage

The image and the document are ANS-104 data items signed on the phone by a per-wallet upload key
(`src/arweave/`) and posted to ar.io Turbo's HTTP API once the publication confirms, then read back from a gateway
against their hashes, for up to 30 seconds while the gateway catches up. Their ids are in the
approved `uri`, so an upload can resume in any later session.

- **Mainnet pays.** Turbo's free tier is a lifetime budget per wallet and per /24 subnet, so the
  publication transaction carries the storage payment, its own row in the review: a SOL transfer
  to Turbo's payment address (pinned in `publications/storage.ts`, confirmed against
  `GET /v1/info` on every quote), priced by `/v1/price/bytes` and `/v1/price/solana` with half
  again as headroom and a 0.01 SOL ceiling, plus an spl-memo
  `turboCreditDestinationAddress=<upload key>` (turbo-sdk's recipe). The confirmed transaction id
  is posted to `/v1/account/balance/solana`, which credits the upload key once however often it is
  posted, and the upload waits for the credit. A failed quote or an `/info` naming another address
  stops publishing before the wallet opens. A payment refused or credited elsewhere is re-posted
  three times with backoff, then items within the free tier's size limit fall back to it.
- **Devnet stays free.** The free allowance is checked before the approval and again before
  upload.
- **Recovery never pays twice:** it only re-posts the confirmed transaction, found, when the
  wallet never returned it, in the history of the creator's claim receipt, then of the edition, by
  the reviewed fingerprint. The path settled on (credit or free tier) is saved on the draft and
  taken again on resume.

## Device attestation

On a phone that supports it, the metadata document carries Android hardware key attestation
(`seedshot-attestation/1`, `publications/core/attestation.ts`): a fresh StrongBox (or TEE) key,
whose challenge is the SHA-256 of a manifest naming this publication (edition, creator, nonce,
image and capture fingerprints), signs the manifest, the chain and signature go under
`properties.seedshot`, and the key is deleted. With the document's hash on chain, the evidence
cannot move to another publication.

The Record sheet and the publish review say "Signed on a Solana Seeker · StrongBox hardware key ·
verified boot, bootloader locked", and the document carries `Device: Solana Seeker`, only when
(`readAttestationBundle`, then `deviceVerdict`):

- the manifest, challenge and signature match a hardware-backed key whose chain ends at a Google
  root pinned in `src/seeker/keyAttestation.ts`;
- the attested app is `app.seekershot` signed by the release key (`RELEASE_APP`, from
  `dapp-store/signing-certificate.json`);
- boot is verified, the bootloader locked, and the attested maker and model are Solana Mobile Inc.
  / Seeker;
- every certificate is valid at `publicationTime`: the `published_at` the program wrote into the
  `Edition`, or on `LEGACY_WITHOUT_PUBLISHED_AT` deployments the block time of the transaction
  that created the publisher's claim receipt; a draft is judged now;
- no certificate serial is on Google's revocation list
  (`https://android.googleapis.com/attestation/status`).

Otherwise it reads "Not accepted:" with the reason, "Couldn't check." when the list or the time
cannot be fetched, or "Not recorded." when there is none. Sending attests again, in the same
approval, when a certificate has expired or expires within 24 hours.
`npm run release:check` refuses when Google's live roots
(`https://android.googleapis.com/attestation/root`) differ from the pinned ones.

It shows that a hardware key on a Seeker, with a verified, locked boot and this app, signed this
publication within its certificates' validity. It does not show that the sensor made the image, or
anything about the scene, and the app identity is only as good as the OS that verified boot
vouches for. Wallets and explorers show `attributes` unchecked. The same rules run off-device from
the published bytes and the on-chain hash, and exit non-zero on any failure:

```sh
npm run verify:attestation -- --edition <address> --cluster devnet
```

A native run on a Seeker is recorded in `dapp-store/attestation-device-check-2026-09-16.json`.

## Seeker Genesis Token

A publication from a wallet holding a Seeker Genesis Token (SGT) names its mint under
`properties.genesisToken` and as the attribute `Seeker Genesis Token: <mint>`
(`seedshot-genesis/1`, `publications/core/genesisToken.ts`). As Solana Mobile's
[recipe](https://docs.solanamobile.com/solana-mobile-stack/seeker-genesis-token) asks, the chain
shows the wallet holds an SGT and signed the transaction committing the document's hash, and the
mint identifies the Seeker across wallets.

A mint is an SGT when Token-2022 owns it and its `MetadataPointer` and `TokenGroupMember` name
Solana Mobile's group (`GT22s89nU4iWFkNXj1Bw6uYhJJWDRPpShHt4Bk8f99Te`) with the mint itself as
the member; only the group's update authority, Solana Mobile's key, can write that membership.
Readers fetch at most 4 KB and always read mainnet, where the SGT exists; an unreachable or
wrong-cluster endpoint is "Couldn't check", never "not held".

At publish the app names the SGT it found last time while still held, else the lowest member
number, or none when the wallet holds none or mainnet is unreachable. On mainnet `publish` and
`publish_in_album` also take the mint and the creator's token account, or the program id in each
place (`programs/editions/README.md`, "The Seeker Genesis Token accounts"); the program checks
both, refuses anything else with `InvalidGenesisToken`, and appends `seeker_genesis_token: <mint>`
to the collection's locked attributes. A devnet edition carries the document's claim only; the
devnet program's `--features devnet-genesis` (`programs/editions/DEVNET.md`) swaps Solana
Mobile's addresses for stand-ins the acceptance session mints. Deployments in
`LEGACY_WITHOUT_GENESIS` (`publications/deployments.ts`) take neither account.

The Record sheet reads "Held by the publishing wallet.", "Not held by the publishing wallet.",
"Not a Seeker Genesis Token." or "Couldn't check.", adding "now" for a sealed claim.
`sealedGenesisMint` refuses a collection whose seal disagrees with the document; on mainnet an
unsealed claim reads as none (`publishedGenesisClaim`), and "Verified and sealed by the edition
program at publish." shows while mainnet still finds an SGT (`genesisDisplay`).

**Seeker-only editions** allow one copy per Genesis Token: the app finds the collector's SGT
(`findHeldGenesisToken`), keys the claim receipt on its mint and passes the mint and its token
account to `collect` or `buy` (`publications/core/seekerClaim.ts`). Without one: "Needs a Seeker
Genesis Token."

The claim names the owner's token, not the phone that took the photograph.

## erashot.app

Collecting and buying happen in the app only. `site/` (see `site/README.md`) holds the static
files `erashot.app` serves to the app's links: the terms, the privacy policy, the moderation list,
the App Link association and the collect link page. `npm run build:site` produces `site/dist`,
deployed by Wrangler direct upload.

## Deployments

`publications/deployments.ts` is the reviewed allowlist: every trusted program is pinned to its
ELF digest and upgrade authority, and `EXPO_PUBLIC_EDITIONS_*` can select only an address listed
there, every reviewed devnet deployment among them; `programFeatures` tells their instruction
layouts apart by address (the `LEGACY_WITHOUT_*` lists), so editions on each stay readable. The
newest, `4Rk11vaKzxqJhX1kkScRuJ4PKuPnjik6LHwus4J67ipM`, carries the Seeker-only
publish rule; a Seeker run of publishing, pricing, buying, free collection and sending against it
is recorded in `dapp-store/money-path-check-2026-09-28.json`. The live acceptance run of
`7ZL3pF3e9RVLjMjZ9QJuNi8Epw9bmPaKBAfVWHX4uGhU` is recorded in
`programs/editions/devnet-acceptance-2026-09-16.json`, and
`BGEM8ZTk2pP2btuorG8EHzfHgQSaudjuZKVw6f74zAjq` has no prices. The mainnet program is listed the
same way once deployed (see "Deploy the program").

## Security properties

- **Reviewed programs only.** Publish, collect and buy refuse a program whose deployed bytes or
  upgrade authority differ from the pinned image (`publications/programImage.ts`); a signer's
  privileges reach every program it calls.
- **Release gate.** `npm run release:check` refuses a local env file a production bundle would
  load, a non-mainnet cluster without `--allow-cluster devnet`, a missing program (an unlisted one
  fails at load), a mainnet build without its own RPC URL or with a public solana.com one, an RPC
  URL carrying a query string or credentials, an RPC on another network, and any difference from
  Google's live attestation roots. `npm run release:apk` deletes an APK whose bundle does not match
  what the gate recorded or whose signer is not the upload key.
- **erashot.app.** Static files only, no Functions, and a `default-src 'none'` CSP on every page;
  the collect link page's one script, allowed by its hash, fetches nothing.

## Requirements

- Node.js 24.20.0 (see `.nvmrc`) and npm 10 or newer. The Solana program clients require Node 24
  or newer.
- JDK 17 and the Android SDK, with `ANDROID_HOME` set
- A Solana Seeker over USB with developer mode on

There is no iOS or web target, and Expo Go cannot load the native camera module. The camera and
the hardware attestation need the phone itself; an emulator runs neither.

Without a Seeker, two things still run: `npm test` needs only Node, and a published edition can
be checked from any machine:

```sh
npm ci
npm run verify:attestation -- --edition 7XCv1U3MxaJKzAC2oiVBvrRAcfoDimEVjhYGDW4hFF41 --cluster devnet
```

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

`npm test` runs the TypeScript typecheck and the `scripts/check-*` gates listed in `package.json`,
with no device or network; `npx tsx scripts/<gate>` runs one. The less obvious ones:

- `check-runtime-behavior.mjs` also reads this README: the RPC bullet under "Before release" must
  name exactly the Solana methods the app calls.
- `check-version.ts`: app.json and `build.gradle` agree on the version, and the versionCode is
  ahead of every release in `dapp-store/releases.json`.
- `check-prebuild.ts`: the committed `android/` project still matches app.json and the config
  plugins (permissions, sharing paths, ProGuard rules), not every generated file.
- `check-mainnet-deploy.ts`: every mainnet deploy step, end to end on a cluster held in memory.

Outside `npm test`:

- `npm run test:svm` runs built `era_editions` ELFs in LiteSVM against mainnet's Metaplex Core
  and a real Seeker Genesis Token; `npm run test:program` runs the program's Rust unit tests.
- `npm run devnet:check -- --require-offers`: read-only checks of the configured devnet program
  and the app's public wallet and App Links endpoints, saved to `.expo/devnet-check.json`.
- `npm run release:check` (`scripts/check-release-config.ts`) refuses while `.env`,
  `.env.production` or a `.env*.local` file is present, so it runs on release builds only.
- Builds: `npm run build:android-bundle`, `./gradlew :seeker-camera:compileDebugKotlin` from
  `android/`, `pwsh -File programs/editions/scripts/build-native-windows.ps1` and
  `npm run build:site`.

After native configuration changes run `npx expo prebuild -p android` and review the diff;
`npx expo install --check` and `npx expo-doctor` check the SDK and setup. The `react-dom` override
keeps one React; the scoped `xcode` override pins `uuid` 11.1.1.

Release signing uses the upload key (`CN=Era Shot`), whose SHA-256 identity
`dapp-store/signing-certificate.json` pins; the four local Gradle properties use the
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
- `site/`: erashot.app, the static pages the app links to
- `android/`: the generated Android project, the Gradle build and signing configuration
- `scripts/`: the checks `npm test` runs and the release tooling; `plugins/`: Expo config plugins
  for prebuild
- `dapp-store/`: the record of releases submitted to the Solana dApp Store, and device checks
- `assets/`: icons and fonts

## Before release

- **On the Seeker:** judge the looks in daylight with a face and something red in frame; check
  Camcorder's smear in both landscapes. Read the Device row of a draft left past its certificates
  (Continue renews it). Terms and Agree before the first publish and collect on a fresh install;
  an edition in `moderation.json` reads Hidden.

- **Mainnet:** `programs/editions/MAINNET.md` from step 6, with `prepare-mainnet-windows.ps1` and
  the real address, then `npm run test:svm` against that ELF before it is deployed; the address, digest,
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
