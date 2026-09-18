/**
 * Every user-visible word about photographs, editions, wallets, prices and costs. A numbered NFT
 * is a "copy". A free edition is collected and is not a sale; a priced edition is bought, and that
 * is a sale — its "price" is the publisher's own amount and reaches the publisher. "Cost" is never
 * the price: costs are network fees, rent and the Core fee, paid by whoever signs.
 */

/** Button labels. A label says what happens, in the words the rest of the screen uses. */
export const actions = {
  openCamera: "Open camera",
  viewPhotos: "View your photos",
  takePhoto: "Take photo",

  publish: "Publish this moment",
  continuePublication: "Continue publication",
  checkPublication: "Check publication",
  /** The photo page's pills. "Share" on a published photograph shares the card with its collect QR. */
  save: "Save",
  share: "Share",
  send: "Send",
  details: "Details",
  completeUpload: "Complete public upload",
  checkUpload: "Check upload availability",
  /** The only way the bytes of a confirmed, un-uploaded publication can leave this phone. */
  exportBundle: "Export backup",
  exportingBundle: "Exporting…",

  backToPhoto: "Back to photo",
  backToPhotograph: "Back to photograph",
  done: "Done",
  /**
   * The publish sheet's two taps: "Continue" connects, saves the draft and shows the cost;
   * "Publish" opens the wallet. Only the tap that spends money carries the verb.
   */
  continueToPublish: "Continue",
  confirmPublish: "Publish",
  changeDraft: "Edit details",
  discardUnreadable: "Discard saved details and start again",
  viewPhotograph: "View your photograph",
  oneCopy: "One copy",
  multipleCopies: "Multiple copies",
  noAlbum: "No album",
  chooseAlbum: "Choose album",
  newAlbum: "New album",
  checkAlbumCost: "Check album cost",
  createAlbum: "Create album",
  creatingAlbum: "Creating album…",
  openPublicPage: "Open the public photo page",
  openAlbumPage: "Open public album page",
  viewEdition: "View edition on Solana",
  viewTransaction: "View Solana transaction",
  viewTransactionShort: "View transaction",
  copyRecord: "Copy record details",
  reviewTransfer: "Review transfer",
  reviewNewTransfer: "Review a new transfer",
  approveAndSend: "Approve & send copy",
  checkTransfer: "Check transfer status",

  /**
   * Collecting. Two taps, like publishing: "Continue" connects and shows the cost, "Collect"
   * opens the wallet — only the tap that spends carries the verb. The Collection tab's own entry
   * is one word per pill, since the pills sit in a row beside each other.
   */
  collect: "Collect",
  /**
   * Buying: the same two taps, for an edition with a price. "Collect" is the free word and "Buy"
   * the priced one, so the tap that spends says which of the two it is. `buy` is the vocabulary's
   * one-word counterpart of `collect` above; `confirmBuy` is the tap that opens the wallet, chosen
   * by the reviewed quote's own `kind` rather than by anything a screen read earlier.
   */
  confirmBuy: "Buy",
  /** The creator's own price control, on the photograph and in the Collection. */
  price: "Price",
  setPrice: "Set price",
  scan: "Scan",
  open: "Open",
  paste: "Paste",
  close: "Close",
  connectWallet: "Connect wallet",
  continueToCollect: "Continue",
  confirmCollect: "Collect",
  checkCollect: "Check status",
  viewEditionShort: "View edition",

  useCameraVersion: "Use camera version",
  delete: "Delete photograph",
  back: "Photos",
  camera: "Camera",
  backToCamera: "Back to camera",
} as const;

/**
 * What a button does on Solana, in one plain sentence. Used as an accessibility hint and as the
 * text a screen shows under a group of actions. Amounts are never stated here: the estimate
 * comes from a simulation and the wallet shows the final cost.
 */
export const onChain = {
  publish:
    "One wallet approval creates the edition, its Metaplex Core collection and your copy 1, then uploads the public photo.",
  /** Free editions only: a priced one is `buy`, and the two must never be described alike. */
  collect:
    "Collecting creates one more numbered copy in the collector's own wallet. A free edition has no price; the collector pays the costs.",
  buy: "Buying creates one more numbered copy in your wallet. The price goes to the publisher, and the network, account and Core costs do not.",
  setPrice:
    "Setting a price changes what the next buyer pays for a copy of this edition. Copies already collected are unaffected, and a price of zero makes it free again.",
  send: "Sending transfers your numbered copy to another wallet. It leaves yours.",
  /**
   * Updated when collecting moved in-app: the same link now opens this app on the Collect sheet
   * when it is installed (an Android App Link for erashot.app/collect), and the public photo page
   * otherwise. What it still does not do is collect anything on its own.
   */
  shareLink:
    "The link opens this edition — in this app if it is installed, otherwise its public photo page. Opening it collects nothing until a wallet approves.",
  signature:
    "A signature records which wallet published a file. It does not identify a person, or certify the camera, the scene or the time of capture.",
  permanence:
    "The public photo, its Moment and the record are permanent. This app cannot withdraw them.",
} as const;

/**
 * The itemised estimate. It is advisory: anyone may send lamports to the deterministic addresses
 * and `clear_pda` refunds them to the payer, so the real cost can be lower.
 */
export const estimate = {
  /** The one cost line. The parts below it are a tap away, not a wall of numbers. */
  label: "Estimated cost",
  show: "Show what makes up this cost",
  hide: "Hide what makes up this cost",
  networkFee: "Network fee",
  accountCost: "Accounts and Core fee",
  allowance: "Wallet allowance",
} as const;

/**
 * Wallet timeouts. Seed Vault sends the transaction at once but answers only when the person taps
 * Close, after the adapter's 90 s timeout, so the work has often already landed.
 */
export const walletTimeout = {
  /** Shown the instant the timeout is seen, while the status check runs. */
  publishChecking:
    "Your wallet didn’t answer in time. It may have published this moment already. Close the wallet’s success screen — we’re checking the publication status now.",
  publishFound:
    "Your wallet didn’t answer in time, but this moment is published. Continue to its public upload.",
  publishPending:
    "Your wallet didn’t answer in time, and this moment is not on Solana yet. Close the wallet’s success screen and tap Continue again in a moment: the approved transaction may still land.",
  /** The approved transaction's blockhash has expired, so it cannot land. */
  publishRetry:
    "Your wallet didn’t answer in time, and that transaction can no longer land. Nothing was published. The estimate below is a fresh one: approve it to publish this moment.",
  albumRetry:
    "Your wallet didn’t answer in time, and that album transaction can no longer land. No album was created. The cost below is a fresh estimate: approve it to create the album.",
  albumChecking:
    "Your wallet didn’t answer in time. The album may have been created already. Close the wallet’s success screen — we’re checking now.",
  albumPending:
    "Your wallet didn’t answer in time, and the album is not on Solana yet. Close the wallet’s success screen and check the album cost again in a moment: the approved transaction may still land.",
  sendChecking:
    "Your wallet didn’t answer in time. It may have sent this copy already. Close the wallet’s success screen — we’re checking the transfer status now.",
  sendFound:
    "Your wallet didn’t answer in time, but the transfer is confirmed.",
  sendPending:
    "Your wallet didn’t answer in time, and this transfer is not confirmed yet. Close the wallet’s success screen and check the transfer status again in a moment.",
  /** Reviews open a wallet only to choose an account: nothing can have been sent. */
  costCheck:
    "Your wallet didn’t answer in time. Nothing was published or sent. Close the wallet, then tap Continue again.",
  transferReview:
    "Your wallet didn’t answer in time. Nothing was sent by this review. Close the wallet, then review the transfer again.",
  albumCostCheck:
    "Your wallet didn’t answer in time. No album was created. Close the wallet, then check the album cost again.",
  /** Settings' CONNECT: the wallet may have authorized before it stopped answering. */
  connect:
    "Your wallet didn’t answer in time. It may have authorized already. Close the wallet, then tap Connect wallet again.",
  /** The same three moments for collecting: checking, found, still pending. */
  collectChecking:
    "Your wallet didn’t answer in time. It may have collected your copy already. Close the wallet’s success screen — we’re checking now.",
  collectFound:
    "Your wallet didn’t answer in time, but your copy was collected.",
  collectPending:
    "Your wallet didn’t answer in time, and this copy is not on Solana yet. Close the wallet’s success screen and check the status again in a moment: the approved transaction may still land.",
  /** A cost check opens the wallet only to choose an account; nothing can have been collected. */
  collectCostCheck:
    "Your wallet didn’t answer in time. Nothing was collected. Close the wallet, then tap Continue again.",
  /** The price: a cost check opens the wallet only to choose an account, so nothing changed. */
  offerCostCheck:
    "Your wallet didn’t answer in time. The price was not changed. Close the wallet, then tap Continue again.",
  offerChecking:
    "Your wallet didn’t answer in time. It may have set the price already. Close the wallet’s success screen — we’re checking now.",
  offerFound:
    "Your wallet didn’t answer in time, but this edition’s price is set.",
  offerPending:
    "Your wallet didn’t answer in time, and this price is not on Solana yet. Close the wallet’s success screen and check again in a moment: the approved transaction may still land.",
} as const;

/**
 * An estimate is simulated against a blockhash, and a blockhash expires. Nothing was signed,
 * nothing was spent, and the only thing lost is the estimate itself.
 */
export const expiredEstimate = {
  publish:
    "That estimate expired before your wallet approved it. Nothing was published. Tap Continue again.",
  album:
    "That album estimate expired before your wallet approved it. No album was created. Check the album cost again, then approve.",
  transfer:
    "That estimate expired before your wallet approved it. Nothing was sent. Review the transfer again, then approve.",
  collect:
    "That estimate expired before your wallet approved it. Nothing was collected. Tap Continue again.",
  offer:
    "That estimate expired before your wallet approved it. The price is unchanged. Tap Continue again.",
} as const;

/**
 * Not an expiry: the rebuilt transaction does not match the reviewed one (cost, rent or
 * simulation changed), so the new estimate has to be reviewed.
 */
export const changedEstimate = {
  publish:
    "The cost of publishing this moment changed while you were approving it, so nothing was published. Tap Continue again and check the new cost.",
  album:
    "The cost of creating this album changed while you were approving it, so no album was created. Check the album cost again and review the new estimate.",
  transfer:
    "The cost of this transfer changed while you were approving it, so nothing was sent. Review the transfer again and check the new estimate.",
  collect:
    "The cost of collecting this copy changed while you were approving it, so nothing was collected. Tap Continue again and check the new cost.",
  offer:
    "The cost of setting this price changed while you were approving it, so the price is unchanged. Tap Continue again and check the new cost.",
} as const;

/**
 * The recipe picker and sheet. Recipe, stage and parameter names are data from `src/recipes/`,
 * so they are not here.
 */
export const recipes = {
  /** The chip at the end of the row: every stage at neutral, opened for editing. */
  custom: "+",
  customLabel: "Custom",
  /** The strength dial's spoken name; the number beside it is the readout. */
  strength: "Strength",
  fineControls: "Fine controls",
  hideFineControls: "Hide fine controls",
  save: "Save",
  reset: "Reset",
  rename: "Rename",
  duplicate: "Copy",
  delete: "Delete",
  /** Deleting confirms with one word, in place of the Delete label. */
  sure: "Sure?",
  close: "Close",
  cancel: "Cancel",
  nameLabel: "Name",
  namePlaceholder: "Recipe name",
  newLabel: "New recipe",
  continueLabel: "Continue",
  /** Spoken names. Short, and never shown. */
  editHint: (name: string) => `${name}. Edit.`,
  valueOf: (param: string, value: string) => `${param}, ${value}`,
} as const;

export const camera = {
  loading: "Loading…",
  permissionTitle: "Take a photo\nworth keeping.",
  permissionBody: "The camera needs your permission before it can show a picture.",
  allow: "Allow camera access",
  waiting: "Waiting for camera access…",
  openPhoneSettings: "Open phone settings",
  restart: "Restart camera",
  /** Spoken for the invisible target over the picture. */
  tapToFocus: "Picture. Tap to focus and meter there.",
  /** The camera's button into the Collection; the spoken hint names the screen it opens. */
  collection: "On chain",
  collectionHint: "Open your collection",
  photos: "Photos",
  /** The header button's spoken name. */
  settings: "Settings",

  // --- Error states, one sentence and one action each. ----------------------
  cameraAccessError:
    "Camera access could not be requested. Open your phone settings to allow it.",
  recipeLoadError: "This recipe could not be loaded. Restart the camera to try again.",
  recipeSaveError: "That recipe could not be saved.",
  sessionError: "The camera is unavailable. Restart it to try again.",
  captureError: "The photo could not be saved. Restart the camera and try again.",
  settingsOpenError: "Open your phone settings, then allow camera access for this app.",
} as const;

/**
 * The camera controls' labels. Values come from the formatters in `src/capture/model.ts`. Focus
 * is a position, never a distance: the Seeker's lens is uncalibrated.
 */
export const captureControls = {
  simple: "Simple",
  pro: "Pro",
  simpleHint: "Brightness, colour and focus. Exposure stays automatic.",
  proHint: "Manual exposure, camera controls and recipe adjustments.",
  reset: "Reset to auto",
  applyError: "Camera controls did not apply. Restart the camera and try again.",
  autoExposure: "Auto exposure",
  manualHint: "ISO and shutter are held together. Auto exposure releases both.",
  evManualHint: "Brightness needs Auto exposure. Adjust ISO or shutter while exposure is manual.",
  help: {
    iso: "Lower for less noise. Higher for brighter photos in low light.",
    shutter: "Faster freezes movement. Slower adds blur and needs a steady phone.",
    ev: "Make the photo darker or brighter while the camera handles exposure.",
    whiteBalance: "Pick the light you are standing in. Auto guesses it.",
    focus: "Auto follows your subject. Near for close-ups, Far for landscapes.",
  },
  /** Tray names. */
  iso: "ISO",
  shutter: "Shutter",
  ev: "Brightness",
  whiteBalance: "White balance",
  kelvin: "Kelvin",
  focus: "Focus",
  /** Strip tags, in the five cells over the picture. */
  tag: {
    iso: "ISO",
    shutter: "Shutter",
    ev: "Light",
    whiteBalance: "Colour",
    focus: "Focus",
  },
  aeLock: "AE lock",
  awbLock: "AWB lock",
  histogram: "Histogram",
  /** Simple's three focus choices and the Pro ruler's reset. */
  near: "Near",
  far: "Far",
  zero: "0",
  /** The lights people stand in, for the white-balance modes Camera2 names. */
  lights: {
    daylight: "Sunny",
    cloudy: "Cloudy",
    shade: "Shade",
    indoor: "Indoor",
    fluorescent: "Fluorescent",
    warmFluorescent: "Warm fluorescent",
    twilight: "Twilight",
  },
  /** The two clipping fractions under the bars. */
  black: "Black",
  white: "White",
  auto: "Auto",
  on: "On",
  off: "Off",
  close: "Close",
  /** Spoken names. Short, and never shown. */
  readingOf: (name: string, value: string) => `${name}, ${value}`,
  openOf: (name: string, value: string) => `${name}, ${value}. Open.`,
} as const;

export const photos = {
  heading: "Photos",
  loading: "Opening your photos…",
  /** The grid readout: "12 PHOTOGRAPHS", beside the count of published ones. */
  photographs: (total: number) =>
    `${total} ${total === 1 ? "photograph" : "photographs"}`,
  publishedCount: (total: number) => `${total} published`,
  /** Imprinted at the right of a published print's caption band: "01 / 05". */
  copyMark: (number: number, supply: number) =>
    `${String(number).padStart(2, "0")} / ${String(supply).padStart(2, "0")}`,
  emptyHeading: "Take the first one.",
  /** The print's mark in the grid, under the paper (`photoMark`). Nothing for an unpublished one. */
  statusPublished: "Published",
  statusAttention: "Needs attention",
  savedToGallery: "Saved to gallery.",
  deleteTitle: "Delete this photo?",
  /** Photos is what is on this phone; the Collection is what is on chain. */
  deleteBody:
    "Removes it from Photos. If you published it, it stays in your Collection.",
  deleteKeep: "Keep photo",
  deleteConfirm: "Delete photo",
  deleteBlocked:
    "Finish or check publication before deleting the files needed to recover it.",
  /** For a confirmed publication whose upload is unfinished: this phone holds the only copy. */
  exportBundleDone:
    "Backup exported. Save it somewhere that is backed up.",
  missingFullSize:
    "The full-size selected version is missing. You can still share the published image.",
} as const;

/** "Edition of 5 · Copy 1 issued to the publishing wallet" and friends. */
export function editionLine(supply: number, issued: boolean): string {
  if (supply === 1) return "Edition of 1 · Copy 1 of 1";
  return `Edition of ${supply} · Copy 1 ${issued ? "issued to" : "for"} the publishing wallet`;
}

export const publish = {
  /** The cluster badge at the head of the sheet, rendered by `NetworkLabel`. */
  network: "SOLANA MAINNET",
  /** Not "test publication": a devnet publication is signed and recorded like a mainnet one. */
  networkTest: "SOLANA DEVNET",
  /** The sheet's title when the photograph has no name yet. Its name wins once it has one. */
  heading: "Publish this moment",
  headingPublished: "Your moment is published",
  headingUpload: "Photo upload pending",
  titleLabel: "Name this moment",
  momentLabel: "Moment (optional)",
  copiesLabel: "Copies",
  /** The form carries labels, not explanations; `needCount` names the range when it is wrong. */
  totalLabel: "Total copies, including yours",
  albumLabel: "Album (optional)",
  albumEmpty: "No albums yet.",
  albumNeedsWallet: "Connect a wallet to use albums.",
  albumNameLabel: "New album name",
  /** The one thing here a person cannot undo, so it keeps a line. */
  albumBody: "The album can’t be changed after publishing.",
  albumCostSuffix: "for the album. Separate approval.",
  /** The receipt rows, once a draft exists. Labels only; the values are the draft's. */
  rowCopies: "Copies",
  rowMoment: "Moment",
  rowAlbum: "Album",
  rowImage: "Image",
  rowDevice: "Device",
  rowWallet: "Wallet",
  needTitle: "Add a title to publish.",
  needAlbum:
    "Create the album before publishing a photograph into it, or choose No album.",
  needCount: "Choose an edition of 2 to 1000 copies to continue.",
  blockedTitle: "Saved publication needs attention",
  unavailableTitle: "Publishing is unavailable in this build",
  blockedBody:
    "This saved publication could not be validated. Close and reopen the photograph to check it again.",
  // A saved draft this build cannot read. Nothing is on Solana, so discarding it is safe and
  // keeps the photograph from being stuck.
  unreadableBody:
    "Saved publication details on this phone could not be read by this version of the app. Nothing was published and nothing on Solana is affected. Discard them to start this photograph again.",
  unavailableBody:
    "Wallet publication has not been enabled. Your photo is ready to save and share.",
  /**
   * Shown instead of "Published" when the confirmed transaction is not the reviewed message. The
   * edition was verified; only what else the transaction carried is unknown.
   */
  reviewMismatch:
    "The transaction your wallet sent is not the one shown in this review. The published edition matches this photograph, but check the transaction in your wallet or an explorer before taking another action.",
  /** The two fallbacks `describeProgramError` can name. */
  fallbackWithoutAlbum:
    "This album is full. Metaplex Core allows 256 collections in one group, and this one has them. You can publish this photograph without an album — the photograph, its title and its edition size are unchanged.",
  fallbackNewAlbum:
    "An album already exists at this address. Choose a different name and create a new album; the one that exists is untouched and still holds its photographs.",
  /** The button beside `fallbackWithoutAlbum`. */
  publishWithoutAlbum: "Publish without the album",
  /**
   * The deployed program's digest differs from the reviewed one. A warning, never a refusal, so an
   * unreachable endpoint cannot block publishing.
   */
  programReplaced:
    "The publication program at this address is not the build this app reviewed. You can still publish; check before approving.",
  /** The same fact for `create_album`, whose evidence is the group account rather than an edition. */
  albumReviewMismatch:
    "The transaction your wallet sent is not the one shown in this album review. The album exists and is held by this wallet, but check the transaction in your wallet or an explorer before taking another action.",
} as const;

export const proof = {
  /** The cluster badge, shown only when the record itself names a network. */
  network: "SOLANA MAINNET",
  networkTest: "SOLANA DEVNET",
  heading: "What this record shows",
  limits:
    "The edition size is fixed, an album cannot be changed after publishing, and collecting does not transfer copyright.",
  titleLabel: "Published title",
  momentLabel: "Moment",
  albumLabel: "Album",
  albumUnnamed: "Named on the album page",
  publicPhotoLabel: "Public photo",
  standard: "Metaplex Core edition",
  attestationLabel: "Device attestation",
  attestationNone: "Not recorded. This publication was made without hardware key attestation.",
  /** Said when the document carries evidence this app set aside. `reason` is the reader's own text. */
  attestationProblem: (reason: string): string =>
    `Recorded, but not accepted by this app: ${reason}. The photograph is still a valid publication; it just carries no device claim here.`,
  /**
   * Said beside an accepted attestation. The claim is the key and the device the keystore
   * attested, never the camera or the scene. This app checked the manifest binding and that the
   * certificate chain is signed down from Google's attestation roots; dates and revocation are
   * checked off-device, at publication time.
   */
  attestationBody:
    "The phone's keystore generated a hardware-protected key for this publication alone, attested the device it lives in, and signed the publication's manifest. This app checked that the certificate chain is signed down from Google's attestation roots and that it names this exact publication. It does not show that the camera sensor produced the image.",
  attestationVerify:
    "Certificate dates and revocation are checked off-device, at publication time, with the verifier in the app's source (npm run verify:attestation).",
  /** "edition of 5 numbered copies" — the person's word, beside the record's own address. */
  editionSize: (supply: number): string =>
    supply === 1 ? "edition of 1" : `edition of ${supply} numbered copies`,
} as const;

export const send = {
  network: "SOLANA MAINNET",
  networkTest: "SOLANA DEVNET",
  heading: "Send this copy",
  headingConfirmed: "Transfer confirmed",
  headingUnknown: "Transfer outcome unknown",
  attribution:
    "The publication keeps its original wallet attribution after a transfer.",
  recipientLabel: "Recipient’s Solana wallet address",
  recipientPlaceholder: "Paste the full wallet address",
  recipientFine:
    "Use a personal Solana wallet address. Domain names are not accepted here yet.",
  costLabel: "Estimated network cost",
  costFine:
    "A Metaplex Core transfer creates no account for the recipient. Your wallet shows the final transaction.",
  consequence:
    "This moves your numbered copy to that address and it leaves your wallet; it is a transfer, not a sale: no payment is involved. A confirmed transfer cannot be cancelled, and it does not delete your local photo or transfer copyright.",
  confirmedRecipient: "Confirmed recipient",
  earlierRecipient: "Earlier intended recipient",
  confirmedBody:
    "This transfer was confirmed. Current ownership can change again after a transfer.",
  unresolvedBody:
    "The earlier attempt can no longer land, but we could not confirm whether it sent this copy. Its outcome remains unknown.",
  stillHeld:
    "The previous sender currently holds this copy. A new send needs a fresh recipient and wallet review.",
  moved:
    "This copy is held by another wallet. A new send is not available here.",
  burned:
    "This copy has been burned and cannot be sent. Your photograph and publication record stay here.",
  frozen: "This copy is frozen and cannot be sent right now.",
  recheck: "We’ll check current ownership before preparing another transfer.",
  /** "Copy 1 of 5" for the sender's own numbered copy. */
  copyLine: (supply: number): string =>
    supply === 1 ? "Copy 1 of 1 · edition of 1" : `Copy 1 of ${supply}`,
} as const;

/**
 * Collecting: taking one numbered copy of somebody else's edition into your own wallet. A free
 * edition is collected — no price, and nothing reaches the publisher; a priced one is bought, and
 * its price does reach the publisher (`price` below owns every word about that). Either way the
 * collector also pays Solana's own costs, the same three the publisher paid (`estimate`). One copy
 * per wallet, for as long as copies remain.
 */
export const collect = {
  network: "SOLANA MAINNET",
  networkTest: "SOLANA DEVNET",

  /** The sheet's heading. The edition's own title wins once it has been read. */
  heading: "Collect a copy",
  headingCollected: "Copy collected",
  headingUnavailable: "Edition unavailable",

  /** The entry stage on the Collection tab: a link to paste, or a code to scan. */
  entryHeading: "Collect a copy",
  linkLabel: "Collect link",
  linkPlaceholder: "Paste a collect link",
  /** The one hint on that stage; the two pills beside it are one word each. */
  entryHint: "Paste a collect link or scan its code.",
  linkInvalid: "That is not a Seedshot collect link.",
  scanUnavailable: "Scanning needs a newer version of this app.",
  scanFailed: "Couldn’t scan that code. Try again, or paste the link.",
  pasteFailed: "Couldn’t read the clipboard. Paste the link by hand.",

  /** The readout above the title: the copy this collect would take, then the one it took. */
  nextCopy: (minted: number, supply: number): string =>
    `COPY ${Math.min(minted + 1, supply)} OF ${supply}`,
  yourCopy: (number: number, supply: number): string =>
    `COPY ${number} OF ${supply} · YOUR COPY`,
  publishedBy: "PUBLISHED BY",
  /** Imprinted on the paper, under the title, the way the Collection imprints it. */
  by: (address: string): string => `By ${address}`,
  momentLabel: "MOMENT",
  issuedLabel: "ISSUED SO FAR",
  issuedValue: (minted: number, supply: number): string => `${minted} / ${supply}`,

  /** Before a wallet: a copy is collected INTO a wallet, so there is nothing to show without one. */
  needWallet: "A copy is collected into a wallet. Connect one to continue.",
  /** The states `getCollectState` reports. One sentence each, and never a claim of failure. */
  already:
    "This wallet already holds a copy of this edition. Each wallet can collect one, and that stays true after a transfer or a burn.",
  soldOut:
    "Every copy of this edition has been collected. The edition size is fixed and cannot grow.",
  wait: "An earlier collect request may still land. Check the status in a moment.",
  unavailable:
    "This edition could not be read on this connection. Nothing was collected; try again in a moment.",
  /** The link named a chain this build does not publish or collect on. */
  wrongNetwork:
    "That link is for a different Solana network from the one this app is set to, so it cannot be collected here.",
  /** Another collect for this edition is already running in this app. */
  working: "A collect for this edition is already running. Wait for it to finish.",

  /** The cost, in the same three parts the estimate is always shown in. */
  costFine:
    "No purchase price, and nothing reaches the publisher. Your wallet pays the network fee, account rent and the Metaplex Core fee, and shows the final transaction.",
  /** What a confirmed collect leaves you with. */
  collectedBody:
    "This numbered copy is in your wallet. It is yours to keep or send, and the publisher keeps the publication’s attribution and copyright.",

  /** Progress, while the wallet is open and while Solana confirms. */
  progressWallet: "Approve in wallet…",
  progressConfirming: "Confirming…",
  loading: "Reading this edition…",
  checking: "Checking this wallet…",
  cancelled: "Wallet closed. Nothing was collected.",
  cancelledPending: "Wallet closed. Check the collection status before trying again.",
} as const;

/**
 * The price: the publisher's own amount for a copy, in SOL. Never a cost — the costs are Solana's
 * network fee, account rent and the Metaplex Core fee, which the signer pays either way — so the
 * two are always shown as separate lines and only then added up
 * ("1 numbered copy · 0.25 SOL + network and account costs").
 *
 * A price of nothing is a free edition: it is collected, not bought, and nothing reaches the
 * publisher. That is the only difference the words are allowed to blur.
 */
export const price = {
  network: "SOLANA MAINNET",
  networkTest: "SOLANA DEVNET",

  /** The publish sheet's optional field. An edition of 1 has nothing to sell, so it has no field. */
  publishLabel: "Price per copy in SOL (optional)",
  publishPlaceholder: "Free",

  /** The label of a price wherever it is read back: a receipt row, a readout, a cost line. */
  label: "Price",
  /** "0.25 SOL". The amount comes from `formatSol`, so it is exact. */
  value: (amount: string): string => `${amount} SOL`,
  /** An edition anyone may collect for nothing. */
  free: "Free",
  /** The buyer's box: the price, the estimate, then what the wallet will be asked for. */
  totalLabel: "Total",
  buyFine:
    "The price reaches the publisher. The network fee, account rent and the Metaplex Core fee do not, and your wallet shows the final transaction.",

  /** The creator's own sheet. Two taps, like everything else that spends. */
  heading: "Set a price",
  headingSet: "Price set",
  currentLabel: "Current price",
  newLabel: "New price in SOL",
  /** What zero means, said before the wallet opens rather than after. */
  freeFine: "0, or nothing at all, makes this edition free to collect.",
  setBody:
    "This is what a buyer pays for one of the remaining copies. Copies already collected are unaffected.",
  /** Confirmed. The amount itself is the readout above this line. */
  setDone: "This edition’s price is set. You can change it again at any time.",
  /** States, one sentence each and never a claim of failure. */
  loading: "Reading this edition’s price…",
  unsupported:
    "This edition was published before prices, so it stays free to collect.",
  unavailable:
    "This edition’s price could not be read on this connection. Nothing was changed; try again in a moment.",
  working: "A price change for this edition is already running. Wait for it to finish.",
  cancelled: "Wallet closed. The price was not changed.",
  /** The one refusal this screen makes itself; `parseSolPrice` writes the rest. */
  invalid: "Enter a price in SOL, like 0.25.",

  /** Progress, while the wallet is open and while Solana confirms. */
  progressWallet: "Approve in wallet…",
  progressConfirming: "Confirming…",
} as const;


/**
 * Settings. The Seeker rows report facts about a wallet (a token it holds, a name it owns), in
 * capitals because they render in the mono readout step.
 */
export const settings = {
  heading: "Settings",
  /** The wallet card's label, above the name or the address. */
  walletLabel: "Publishing wallet",
  walletPlaceholder: "No wallet connected",
  connect: "Connect wallet",
  disconnect: "Disconnect wallet",
  opening: "Opening wallet…",
  seekerSection: "On your Seeker",
  genesisRow: "Seeker Genesis Token",
  genesisHeld: "HELD",
  genesisAbsent: "NOT HELD",
  skrRow: "Seeker ID",
  skrAbsent: "NO NAME",
  networkRow: "Network",
  networkDevnet: "SOLANA DEVNET",
  networkMainnet: "SOLANA MAINNET",
  /**
   * Devnet builds only. The token and the name exist on mainnet alone, so those two rows are read
   * there for the same wallet address while everything the app sends stays on devnet.
   */
  seekerSourceDevnet: "TOKEN AND SEEKER ID ARE READ FROM SOLANA MAINNET. PUBLISHING USES DEVNET.",
  /** No wallet, so there is no fact to report either way. */
  factUnknown: "—",
  factChecking: "CHECKING…",
  factUnavailable: "UNAVAILABLE",
  refresh: "Refresh Seeker details",
  checking: "Checking…",
  sharingSection: "Sharing",
  stampRow: "Add my .skr name",
  /** Shown only while the toggle cannot be used. */
  stampNeedsName: "Available once your wallet has a .skr name.",
  aboutSection: "About",
  privacyLink: "Privacy & publication",
  supportLink: "Contact support",
  developerTools: "Developer tools",
} as const;

/**
 * The Collection: the wallet library, in Collected and Published views. The route stays `Chain`
 * so saved navigation state and deep links keep working.
 */
export const collection = {
  collected: "Collected",
  published: "Published",
  /** The album filter row's first chip. */
  allAlbums: "All",

  loading: "Finding your photographs…",
  /** Partial reads, shown above a list that still has rows. */
  noticeStale: "Refresh paused. Showing the last checked collection.",
  noticeHidden: (count: number): string =>
    `${count} more ${count === 1 ? "copy" : "copies"} not shown. This list may be incomplete.`,
  noticeUnavailable:
    "Some copies couldn’t be checked. This list may be incomplete.",
  tryAgain: "Try again",

  /** Disconnected: what the Collection shows once a wallet is connected, and one action. */
  disconnectedTitle: "No wallet connected.",
  disconnectedBody:
    "Collection shows the copies a connected wallet owns and the editions it published.",
  disconnectedAction: "Connect in Settings",

  /** Empty, per view: what would appear here, and the action that gets there. */
  emptyTitle: (mode: "collected" | "published"): string =>
    mode === "collected" ? "No copies yet." : "Nothing published yet.",
  emptyBody: (mode: "collected" | "published"): string =>
    mode === "collected"
      ? "Copies you collect or are sent appear here, and so does copy 1 of anything you publish."
      : "Photographs you publish appear here with their edition and numbered copies.",
  emptyAction: "Take a photograph",

  /** Nothing matched the search or the album filter. */
  noMatchTitle: "Nothing in this album.",
  noMatchBody: "Choose All to see every photograph.",
  clearFilters: "Show all",

  /** Partial: some rows could not be read, so say what is known and offer the refresh. */
  partialTitle: "Some copies couldn’t be checked.",
  partialBody: "Everything shown was verified; the rest could not be read.",
  partialAction: "Refresh collection",

  /**
   * Limited: the scan reached its cap before it resolved anything. Different from partial —
   * nothing failed, there was simply more than one pass could read — so it says the number.
   */
  limitedTitle: "More than this list could read.",
  limitedBody: (count: number): string =>
    `${count} ${count === 1 ? "copy was" : "copies were"} not read this time. Refresh to look again.`,
  limitedAction: "Refresh collection",

  /** Failed: the library could not be read at all. The reason is the error's own sentence. */
  failedTitle: "Collection unavailable",
  /** Said when the read failed for an ordinary reason a retry can fix. */
  refreshFailed: "Couldn’t refresh your collection. Try again in a moment.",
  /** Said when this build has no deployed program for the network, which a retry cannot fix. */
  notOnNetwork:
    "Collection is not available on this network in this build yet.",

  /** The `NetworkLabel` in the header. Says which chain these copies were read from. */
  networkFlag: (mainnet: boolean): string =>
    mainnet ? "SOLANA MAINNET" : "SOLANA DEVNET",

  /** The right-hand imprint on a Collection print: empty, so none is drawn. */
  imprint: "",
  /** The blank print of the no-wallet state. */
  noCopy: "No copy",
  openPhoto: (title: string, number?: number): string =>
    `Open ${title}${number ? `, copy ${number}` : ""}`,
  byYou: "By you",
  by: (address: string): string => `By ${address}`,

  /**
   * The numbering line, in teal below the paper. Collected rows show this wallet's copy number;
   * Published rows show how many copies have been issued.
   */
  copyLine: (number: number, supply: number): string =>
    `${String(number).padStart(3, "0")} / ${String(supply).padStart(3, "0")} · YOUR COPY`,
  issuedLine: (minted: number, supply: number): string =>
    `${String(minted).padStart(3, "0")} / ${String(supply).padStart(3, "0")} · ISSUED`,

  /** The photograph's own screen. */
  detailEyebrow: "EDITION",
  immersiveEyebrow: "THE PHOTOGRAPH",
  backToCollection: "Back to Collection",
  exitFullScreen: "Exit full screen",
  openFullScreen: "View photograph full screen",
  viewPhotograph: "VIEW FULL SCREEN",
  previousPhoto: "Previous photograph",
  nextPhoto: "Next photograph",
  copyOf: (number: number, supply: number): string =>
    `COPY ${number} OF ${supply}`,
  editionOf: (supply: number): string => `EDITION OF ${supply}`,
  publishedBy: "PUBLISHED BY",
  you: "You",
  copyPublisher: "Copy publisher address",
  publisherAddress: "Publisher address",
  inAlbum: (mode: "collected" | "published"): string =>
    mode === "collected" ? "IN YOUR COLLECTION" : "IN YOUR PUBLISHED WORK",
  browseAlbum: (label: string): string => `Browse album ${label}`,
  editionSizeLabel: "Edition size",
  editionSizeValue: (supply: number): string => `${supply} numbered copies`,
  issuedLabel: "Issued so far",
  networkLabel: "Network",
  networkValue: (mainnet: boolean): string =>
    mainnet ? "Solana" : "Solana devnet",
  proofToggle: "Publication details",
  /** Says what the match establishes, and what it does not. */
  proofBody:
    "The publication and image match the on-chain record. This verifies the published file, not the scene or capture device.",
  copyEdition: "Copy edition address",
  editionAddress: "Edition address",
  viewOnExplorer: "View on Solana Explorer",
  explorerFailed: "Couldn’t open the explorer.",
  ownershipChecked:
    "Ownership checked when this collection was last refreshed.",
  ownershipPublished:
    "This is your publishing history. Copies may belong to other wallets.",
  shareMoment: "Share moment",
  shareFailed: "Couldn’t open sharing. Please try again.",
  copyLink: "Copy moment link",
  momentLink: "Moment link",
  copied: (label: string): string => `${label} copied`,
  copyFailed: "Couldn’t copy. Please try again.",
} as const;
