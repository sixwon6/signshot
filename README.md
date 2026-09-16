# Seedshot

Seedshot is a photographer's toolkit for the Solana Seeker phone. It has its own Camera2/OpenGL
still camera with manual exposure, white balance and focus; recipes that shape the look at capture
time and again in Develop; and a photo library with sharing, export, print cards and albums. It
works with the Seeker's built-in wallet (Seed Vault, through Mobile Wallet Adapter): a finished
photograph can be published as a numbered Metaplex Core edition with its image and details on
Arweave, offered free or at a SOL price, collected or bought by other wallets from inside the app,
and sent on to another wallet.

The camera starts with Simple controls: tap the picture to focus and meter there, and a readout
strip over the picture whose cells open a tray of plain choices with visible effect. Brightness
in whole stops, the light you are standing in (Sunny, Cloudy, Shade, Indoor, Fluorescent), and
Auto, Near or Far focus. Pro turns the same tray into camera dials: rulers with detents for ISO in
third stops, shutter in full stops, brightness in the device's own steps, Kelvin by the hundred
and fine focus, with AE and AWB locks and the histogram beside the control they belong to. The
readout shows what the camera is doing in auto and, in the accent colour, what you are holding.
Camera resolutions are selected from the device's supported 4:3 YUV sizes. See [APP_READINESS.md](APP_READINESS.md) for the current
device-tested status and the devnet-to-mainnet work remaining.

## The edition lifecycle

- **Publish.** One wallet approval creates the edition, its Metaplex Core collection and copy 1
  for the publisher, then uploads the public image and a three-field document (`name`,
  `description`, `image`) to Arweave. An optional price goes into the same approval.
- **Share.** A published photograph shares a print card carrying its collect link,
  `https://erashot.app/collect/?core=<edition>`, as a QR code. Tapping that link on a Seeker with
  Seedshot installed opens the Collect sheet directly (Android App Links); the Collection tab also
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

The public collect page at erashot.app is built separately, from the predecessor repository's
copy of the document reader. Its deployed bundle accepts only the three-field document, and the
page itself is currently behind a private-preview gate that answers HTTP 401. Until the reader is
rebuilt against this one, redeployed and the gate lifted, a collect link opens the edition in the
app (it is an Android App Link) but not on that web page.

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

There is no iOS or web target, and Expo Go cannot load the native camera module.

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
debounce/cancellation, bounded library loading, serialized storage) and `check-attestation.ts`
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
