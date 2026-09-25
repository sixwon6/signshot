# Signshot

Formerly Seedshot. The repository, the Android package `app.seekershot`, the `erashot.app` domain and
the on-chain and metadata identifiers (`seedshot-attestation/1`, `seedshot-genesis/1`, `properties.seedshot`, `erashot-core/1`)
keep their old names, because published editions and verified App Links depend on them.

Signshot is a photographer's toolkit for the Solana Seeker phone. It has its own Camera2/OpenGL
still camera with manual exposure, white balance and focus; recipes that shape the look at capture
time and again in Develop; and a photo library with sharing, export, print cards and albums. It
works with the Seeker's built-in wallet (Seed Vault, through Mobile Wallet Adapter): a finished
photograph can be published as a numbered Metaplex Core edition with its image and details on
Arweave, offered free or at a SOL price, collected or bought by other wallets from inside the app,
and sent on to another wallet.

The camera has one layout under a mode dial, AUTO, P and M, and one grammar in every mode: the
bottom row chooses, the row above it adjusts, the shutter shoots. All of it is in the sheet under
the thumb, and the picture carries nothing at rest. AUTO is the point-and-shoot: tap the picture
to focus and meter there, choose a look, set its strength, and set brightness two stops either
way, by dragging up or down on the picture or on a slider; nothing else can be left set. P puts
the readout up as a row of cells, ISO, shutter, brightness, colour, focus and the look, in one fixed order, and the row above is the live cell's dial: rulers
with detents for ISO in third stops, shutter in full stops, brightness in the device's own steps,
Kelvin by the hundred and fine focus, each ending in a key that hands the control back to the
camera. A cell shows what the camera is doing in auto and, in the accent colour, what you are
holding. M holds the exposure: Camera2 holds ISO and shutter together, so tapping M holds the pair
the camera just metered, moving either ruler in P turns the dial to M by itself, and P hands both
back. AUTO remembers what P and M were holding and returns it with the dial, the dial shows which
position is keeping it, and AUTO held down lets everything go. The looks are cameras you could
have owned: the phone itself (SEEKER on a Seeker, with nothing added), Digicam, Disposable and Camcorder. Off AUTO the look in force opens its
strength, and from there its stages for editing. DISP cycles a plain picture, a grid of thirds and
the histogram.
Camera resolutions are selected from the device's supported 4:3 YUV sizes.

## Before release

- **On the Seeker:** brightness by dragging on the picture and on AUTO's slider; send a copy; buy
  a priced copy from a second wallet; collect from the link in a browser wallet; cancel, time out
  and background the wallet mid-publish and mid-upload, and recover. Judge the looks in daylight with a
  face and something red in frame; check Camcorder's smear in both landscapes; save one photograph
  per look and compare it with the preview. Open the wallet screen's grid and a print with a wallet
  that holds copies, and connect a wallet from that screen. Publish from the wallet that holds the
  Genesis Token and read its row on the review, the Proof sheet and the collect page.
- **Site:** redeploy `site/`, page and `/api/solana` together: the live page refuses a document
  that names a Genesis Token, and the live proxy refuses the check's `getTokenAccountsByOwner`.
  The live home page still says "Simple controls", and the privacy page was corrected on
  2026-09-21.
- **Devnet program:** redeploy through `npm run devnet` (`programs/editions/DEVNET.md`): the
  listed devnet programs predate the Genesis Token accounts, so the sealed publish and its
  refusals have not run on a cluster yet; then list the new address and digest.
- **Mainnet:** `programs/editions/MAINNET.md`, then the program address and digest in
  `publications/deployments.ts`, production RPC and storage. The mainnet build is the plain
  one, never `-Features devnet-genesis`.
- **Final APK:** `npm run release:check`, `npm run release:apk` with the upload key, a fresh
  install, an offline capture, one small mainnet publication.
- **dApp Store:** the mainnet build above; the Publisher Policy's terms for user content (report,
  block, user terms) against the collect view; screenshots of 1080 px or more a side and a short
  description of 30 characters or fewer.
- **Submission:** `SUBMISSION_DRAFT.md`. CLOCK IN closes 2026-10-08 23:59 US Pacific.

## The edition lifecycle

- **Publish.** One wallet approval creates the edition, its Metaplex Core collection and copy 1
  for the publisher, then uploads the public image and a three-field document (`name`,
  `description`, `image`) to Arweave. An optional price goes into the same approval.
- **Share.** A published photograph shares a print card carrying its collect link,
  `https://erashot.app/collect/?core=<edition>`, as a QR code. Tapping that link on a Seeker with
  Signshot installed opens the Collect sheet directly (Android App Links); the Collection tab also
  takes a pasted link or address, or scans a QR code with the phone's camera.
- **Collect or buy.** A free edition is collected: the collector pays the network fee, account
  rent and Metaplex Core's create fee, nothing reaches the publisher. A priced edition is bought:
  the price is paid to the publisher in the same transaction that creates the copy, and a buyer
  signs the exact price and offer revision they reviewed, so a changed price fails safely. One
  copy per wallet per edition, ever.
- **Price.** The publisher can set, change or remove the price of an edition at any time from the
  photo page or the Collection tab. Prices are in SOL only.
- **Send.** A copy can be transferred to another wallet. A transfer is not a sale.

## What goes on chain

Publishing mints a Metaplex Core asset through the Anchor program in `programs/editions/` and
writes a permanent `Edition` record beside it, plus one `Receipt` per collecting wallet and an
optional `Offer` holding the price. The photograph's full-size frames never leave the phone; the
public copy is a compressed derivative. A copy is ownership of the NFT — not of the image, and not
evidence about the scene in front of the camera.

## Device attestation

Every publication made on a phone that supports it carries Android hardware key attestation
inside the metadata document (`seedshot-attestation/1`, in `publications/core/attestation.ts`).
Before the document is sealed, the phone's keystore generates a fresh StrongBox (or TEE) key
whose attestation challenge is the SHA-256 of a canonical manifest naming this exact publication:
edition address, creator, nonce, the public image fingerprint and the private capture
fingerprints. The key signs the manifest, the certificate chain and signature go into the document
under `properties.seedshot`, and the key is deleted. Because the document's hash is committed on
chain, the evidence cannot be swapped or transplanted: a certificate from another key, phone or
publication carries a different challenge and is refused. The document also carries Metaplex
`attributes` (`Device: Solana Seeker`, `Attestation: StrongBox hardware key`) so wallets and
explorers show the device without parsing certificates; the app re-derives them from the
certificate on every read and refuses a document whose attributes overclaim.

What it shows: a hardware-protected key on a device whose keystore attested these properties
signed this publication's manifest. What it does not show: that the camera sensor produced the
image, or anything about the scene. The app checks, in pure JavaScript, the manifest binding, the
signature, the security level, and that the certificate chain is signed down from one of Google's
published attestation roots (pinned in `src/seeker/keyAttestation.ts`); evidence that fails is set
aside with a reason on the Proof sheet, and the photograph still loads. Certificate dates and
revocation need a reference time and the network, so they are checked off-device, from the
published bytes:

```sh
npm run verify:attestation -- --edition <address> --cluster devnet
```

It validates the chain against Google's published attestation roots
(`scripts/attestation-roots.pem`), the revocation list, the on-chain metadata hash and the
attested app's signing identity, and exits non-zero on any failure. Certificate validity is
judged at publication time (the edition's first transaction), because Google's device and
intermediate attestation certificates live for days to weeks. A phone that cannot attest
publishes the plain three-field document, exactly as before; the Proof sheet says so. The
native path was exercised on a Seeker on 2026-09-16
(`dapp-store/attestation-device-check-2026-09-16.json`).

## Seeker Genesis Token

A publication from a wallet that holds a Seeker Genesis Token records the token's mint address in
the metadata document (`seedshot-genesis/1`, in `publications/core/genesisToken.ts`): under
`properties.genesisToken`, and as a Metaplex attribute (`Seeker Genesis Token: <mint>`) that wallets
and explorers show as it is. It follows Solana Mobile's
[recipe](https://docs.solanamobile.com/solana-mobile-stack/seeker-genesis-token) and answers its
three checks from the chain alone: the wallet owns an SGT (any reader can ask mainnet), the user
proved ownership of the wallet (it signed the transaction that commits the document's hash), and
the mint address is kept, because it stays the same when the token moves and so identifies the
Seeker across wallets.

The document only claims the mint. The Proof sheet and the collect page check it on mainnet when
they open, once the endpoint's genesis hash says it is mainnet: the mint account must be owned by
Token-2022, its `MetadataPointer` and `TokenGroupMember` must name Solana Mobile's group
(`GT22s89nU4iWFkNXj1Bw6uYhJJWDRPpShHt4Bk8f99Te`), the member must be the claimed mint itself, and
the publishing wallet must hold it now with a non-zero balance. The membership is what cannot be
forged: Token-2022 writes it only with the signature of the group's update authority, Solana
Mobile's key. Mint authority and metadata pointer are anyone's to set on their own mint, and the
recipe names no mint authority, so nothing checks one. Readers fetch at
most 4 KB of the account; anything that does not decode as an SGT, however large or foreign, is
not a Genesis Token, and an unreachable or wrong-cluster endpoint is "Couldn't check", never not
held. The SGT exists on mainnet only, so the check reads mainnet whatever network the edition is
on. It is independent of the device attestation: one names the owner's token, the other the phone
that signed.

The row says "Held by the publishing wallet.", "Not held by the publishing wallet.", "Not a
Seeker Genesis Token." or "Couldn't check."; "now" is added only for a sealed claim, which the
program saw held — including a sealed mint whose account has since closed, since an SGT can be
burned out of a wallet. A seal counts on mainnet only (a devnet seal comes from the acceptance
build's stand-ins), and "Verified and sealed by the edition program at publish." shows only
while mainnet still finds the mint to be an SGT (`genesisDisplay`).

At publish the app reads the wallet's Token-2022 accounts holding one unit of a 0-decimal mint,
at most 100 mints per request. A wallet with several SGTs names the one found last time while it
still holds it, else the lowest member number; a wallet with none publishes without the claim.
When mainnet cannot be asked, the document names none and the review's Genesis Token row says
"Couldn't check." — a remembered mint is never written into a document. `npm test` holds the
hand-written mint decoder to the official `@solana-program/token-2022` encoder, and the lookup,
the display rules and the mainnet program's group address to the same constants
(`scripts/check-genesis.ts`). The check was run against a live mainnet SGT on 2026-09-24.

The program seals it too. `publish` and `publish_in_album` take two more accounts at the end,
the Genesis Token mint and the creator's token account for it, or the program id in each place
for a publication without one (`programs/editions/README.md`, "The Seeker Genesis Token
accounts"). With both, the program reads the two accounts by hand — Token-2022 owner, the mint
checks above, and a non-zero balance owned by the creator — refuses anything else with
`InvalidGenesisToken`, and appends `seeker_genesis_token: <mint>` to the collection's locked
attributes, so "held at publish" is on chain with no document to trust and no RPC to ask. The app
passes the accounts on mainnet, where the token exists; a devnet edition carries the document's
claim only. The reader (`sealedGenesisMint`) accepts the five attributes or the five plus that
one and refuses a collection whose seal disagrees with the document. The devnet program is built
with `--features devnet-genesis`, which swaps Solana Mobile's addresses for the acceptance's
stand-ins so the seal and its refusals run
against a mock the session mints (`programs/editions/DEVNET.md`); a mainnet build never carries
the feature. This needs the next deployment: the two devnet programs listed in
`publications/deployments.ts` predate the accounts (`LEGACY_WITHOUT_GENESIS`) and are sent
neither.

The public collect page at erashot.app now lives in this repository (`site/`, see
`site/README.md`) and is bundled from the same reader the app uses, so it accepts the attested
document, shows the Device row, and offers `collect` or `buy` by the live `Offer` account.
`npm run build:site` produces `site/dist`; `npm test` checks the page's wording, its CSP copies,
the App Link association and the build guards. It was deployed to erashot.app on 2026-09-18 by Wrangler direct upload from `site/`
(`site/README.md`, "Deploying"); the predecessor repository's Git builds are disabled and the
preview gate is gone. A collect link opens the edition in the app on a phone that has it (an
Android App Link) and on the web page everywhere else.

The current devnet deployment is `7ZL3pF3e9RVLjMjZ9QJuNi8Epw9bmPaKBAfVWHX4uGhU`. Its bytes
match the reviewed build, and publishing, free collection, transfers, albums, prices and paid
purchases passed the live acceptance run on 2026-09-16. Public evidence is recorded in
`programs/editions/devnet-acceptance-2026-09-16.json`. The legacy deployment
`BGEM8ZTk2pP2btuorG8EHzfHgQSaudjuZKVw6f74zAjq` predates prices and remains readable.
The client tells the two apart by address (`programFeatures` in `publications/deployments.ts`).

`erashot` in the publication tags (`erashot-core/1`, `erashot-album/1`), the `erashot.app` domain,
the signing key alias and the native toolchain cache directory name is the project's original
name. The domain stays for now: the App Links
statement and the wallet identity are published there.

Release signing uses the existing upload key, whose certificate subject is `CN=Era Shot`.
`dapp-store/signing-certificate.json` pins its actual SHA-256 identity; renaming the app does not
require replacing the key. The four local Gradle properties use the `SEEDSHOT_UPLOAD_*` prefix.

## Requirements

- Node.js 24.20.0 (see `.nvmrc`) and npm 10 or newer. The Solana program clients require Node 24 or newer.
- JDK 17 and the Android SDK, with `ANDROID_HOME` set
- A Solana Seeker over USB with developer mode on

There is no iOS or web target, and Expo Go cannot load the native camera module. The camera and
the hardware attestation need the phone itself; an emulator runs neither.

Without a Seeker, two things still run. `npm test` needs only Node. A published edition can be
checked from any machine, and opened in a browser:

```sh
npm ci
npm run verify:attestation -- --edition 7XCv1U3MxaJKzAC2oiVBvrRAcfoDimEVjhYGDW4hFF41 --cluster devnet
```

https://erashot.app/collect/?core=7XCv1U3MxaJKzAC2oiVBvrRAcfoDimEVjhYGDW4hFF41&cluster=devnet

## Run it on a Seeker

Install dependencies with `npm ci`, then copy `.env.example` to `.env.local` and set:

```sh
EXPO_PUBLIC_SOLANA_CLUSTER=devnet
EXPO_PUBLIC_EDITIONS_DEVNET_PROGRAM=7ZL3pF3e9RVLjMjZ9QJuNi8Epw9bmPaKBAfVWHX4uGhU
```

Build and install the development client with a device attached, then reload it from Metro for
later JavaScript changes:

```sh
npx expo run:android
adb reverse tcp:8081 tcp:8081
npx expo start --dev-client
```

## Deploy the program

Nothing here is on mainnet. To put the current program on devnet, follow
`programs/editions/DEVNET.md`: `npm run devnet` opens a session whose `prepare` step builds
the program with the pinned toolchain in an isolated tree and records the ELF digest; `deploy`
writes it under a generated address and prints the lines to add to `publications/deployments.ts`.
The pinned toolchain lives outside the repository; `programs/editions/README.md` says how to fetch
it.

## Checks

`npm run devnet:check -- --require-offers` performs read-only checks against the configured devnet
program and the app's public wallet/App Links endpoints. It fails on the legacy deployment because
that program has no paid editions. The report is saved to `.expo/devnet-check.json`; this check
does not sign transactions or replace the live acceptance run in `programs/editions/DEVNET.md`.

`npm test` runs the TypeScript typecheck over the app and over `scripts/`, then the gates that
hold on any machine: `scripts/check-version.ts` (the version, the dApp Store release record and
its digests), `check-prebuild.ts` (the generated Android project still matches `app.json` and the
config plugins), `check-signing.ts` (the release signing configuration),
`check-runtime-behavior.mjs` (legacy publication metadata, the devnet rent and upload budget,
capture modes and exposure, collect-link parsing, malformed URLs, photo-editor
debounce/cancellation, bounded library loading, serialized storage), `check-capture-hook.mjs` (the
capture controls' hook against a fake camera), `check-looks.mjs` (each look's colour targets and the
strength dial), `check-smear.mjs` (the chroma smear kernel), `check-site.ts` and `check-attestation.ts`
(the attestation parser, chain verifier and document reader against a synthetic certificate and
Google's real root certificates).

`npx expo install --check` validates SDK compatibility; `npx expo-doctor` checks the dependency
tree and project setup. The React DOM override keeps the wallet libraries' web peer on the same
React version as Expo, preventing npm from installing a second React copy. This app has no web target.
The scoped `xcode` UUID override uses patched 11.1.1; its CommonJS `v4()` consumer is tested.
Expo Doctor warns about the committed `android/` folder: EAS does not run Prebuild for it. Run
`npx expo prebuild -p android` after native configuration changes, review the generated diff,
and run the checks before building. The existing prebuild gate checks permissions, sharing paths
and ProGuard rules; it is not a full comparison of every generated file.

`npm run release:check` is the fourth gate, `scripts/check-release-config.ts`: it resolves the
cluster and program a store artifact would be built against. It refuses while a `.env*.local` file
is present and while no reviewed mainnet program is configured, so it belongs to a release build
rather than to `npm test`.

Three builds are separate commands: `npm run build:android-bundle` checks that the JavaScript
bundle builds, `./gradlew :seeker-camera:compileDebugKotlin` from `android/` compiles the native
module, and `pwsh -File programs/editions/scripts/build-native-windows.ps1` builds the program.

## Folders

- `src/` — the app: camera and photo screens, recipes, publishing, collecting, offers, wallet and Arweave
- `modules/seeker-camera/` — the native Expo module: Camera2 capture, OpenGL rendering, file I/O, QR scanning
- `publications/` — the Metaplex Core edition client: accounts, instructions, RPC, transfers, devnet tooling
- `programs/editions/` — the Anchor program behind publishing, collecting, pricing and buying an edition
- `android/` — the generated Android project, the Gradle build and signing configuration
- `scripts/` — the release gates `npm test` runs and the release-APK tooling; `plugins/` — Expo config plugins for prebuild
- `dapp-store/` — the record of releases submitted to the Solana dApp Store
- `assets/` — icons and fonts

## Licence

MIT. See [LICENSE](LICENSE).
