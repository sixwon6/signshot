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
  /** Mainnet: buys the upload's storage again, after the provider refused it or found it short. */
  payStorage: (amount: string): string => `Pay storage ${amount} SOL`,
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
   * opens the wallet — only the tap that spends carries the verb. The Wallet screen's entry is
   * one word per chip, since they sit in a row.
   */
  collect: "Collect",
  /**
   * Buying: the same two taps, for an edition with a price. `confirmBuy` opens the wallet, chosen
   * by the reviewed quote's own `kind` rather than by anything a screen read earlier.
   */
  confirmBuy: "Buy",
  /** The creator's own price control, on the photograph and on the Wallet screen. */
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

/** What a button does, as an accessibility hint. No amounts: the wallet shows the final cost. */
export const onChain = {
  publish: "Creates the edition and your copy 1, then uploads the public photo.",
  /** Free editions only: a priced one is `buy`, and the two must never be described alike. */
  collect: "Creates a numbered copy in your wallet.",
  buy: "Buys a numbered copy. The price goes to the publisher.",
  setPrice: "Sets what the next buyer pays. Zero makes it free.",
  send: "Transfers your copy to another wallet.",
  shareLink: "Shares the link to this edition.",
} as const;

/** The itemised estimate. */
export const estimate = {
  /** The one cost line. The parts below it are a tap away, not a wall of numbers. */
  label: "Estimated cost",
  show: "Show cost details",
  hide: "Hide cost details",
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
  publishChecking: "Wallet didn’t answer in time. Close it while the publication is checked.",
  publishFound: "This moment is published. Continue to its upload.",
  publishPending: "Not on Solana yet. Close the wallet and tap Continue again in a moment.",
  /** The approved transaction's blockhash has expired, so it cannot land. */
  publishRetry: "That transaction expired. Approve the new estimate to publish.",
  sendChecking: "Wallet didn’t answer in time. Close it while the transfer is checked.",
  sendFound: "The transfer is confirmed.",
  sendPending: "Transfer not confirmed yet. Close the wallet and check its status in a moment.",
  /** Reviews open a wallet only to choose an account: nothing can have been sent. */
  costCheck: "Wallet didn’t answer in time. Close it, then tap Continue again.",
  transferReview: "Wallet didn’t answer in time. Close it, then review the transfer again.",
  /** Settings' CONNECT: the wallet may have authorized before it stopped answering. */
  connect: "Wallet didn’t answer in time. Close it, then tap Connect wallet again.",
  /** The same three moments for collecting: checking, found, still pending. */
  collectChecking: "Wallet didn’t answer in time. Close it while your copy is checked.",
  collectFound: "Your copy was collected.",
  collectPending: "Not on Solana yet. Close the wallet and check the status in a moment.",
  /** A cost check opens the wallet only to choose an account; nothing can have been collected. */
  collectCostCheck: "Wallet didn’t answer in time. Close it, then tap Continue again.",
  /** The price: a cost check opens the wallet only to choose an account, so nothing changed. */
  offerCostCheck: "Wallet didn’t answer in time. Close it, then tap Continue again.",
  offerChecking: "Wallet didn’t answer in time. Close it while the price is checked.",
  offerFound: "The price is set.",
  offerPending: "Price not on Solana yet. Close the wallet and check again in a moment.",
} as const;

/**
 * The recipe picker and sheet. Recipe, stage and parameter names are data from `src/recipes/`,
 * so they are not here.
 */
export const recipes = {
  /** The chip at the end of the row: every stage at neutral, opened for editing. */
  custom: "+",
  customLabel: "Custom",
  /** The strength dial's name, on its cell and spoken. */
  strength: "Strength",
  /** The key beside the strength dial that opens the look's stages. */
  edit: "Edit",
  strengthHint: (name: string) => `${name}. Strength.`,
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
  /** The camera's button into the wallet; the spoken hint names the screen it opens. */
  collection: "Wallet",
  collectionHint: "Open your wallet",
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
  /** The mode dial's positions, as a camera's dial prints them. */
  modes: { auto: "Auto", program: "P", manual: "M" },
  /** The key that cycles what is drawn over the picture, named as it is on a camera's back. */
  disp: "Disp",
  applyError: "Camera controls did not apply. Restart the camera and try again.",
  /** Full control names, spoken. */
  iso: "ISO",
  shutter: "Shutter",
  ev: "Brightness",
  whiteBalance: "White balance",
  kelvin: "Kelvin",
  focus: "Focus",
  /** Cell tags, in the readout under the thumb. */
  tag: {
    iso: "ISO",
    shutter: "Shutter",
    ev: "Bright",
    whiteBalance: "Colour",
    focus: "Focus",
    look: "Look",
  },
  look: "Look",
  awbLock: "AWB lock",
  /** The brightness ruler's reset. */
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
  /** The same lights, short enough for a cell. */
  lightTags: { fluorescent: "Fluo", warmFluorescent: "Warm fl", twilight: "Dusk" },
  /** The key that turns the colour row to its Kelvin ruler. */
  kelvinKey: "K",
  auto: "Auto",
  /** Spoken names. Short, and never shown. */
  modeDial: "Mode",
  modeNames: { auto: "Auto", program: "Program", manual: "Manual" },
  modeHeld: (name: string) => `${name}, holding your settings`,
  display: "Display",
  displays: { plain: "Plain", grid: "Grid", histogram: "Histogram" },
  histogramOf: (black: string, white: string) => `Histogram. Black clipped ${black}, white clipped ${white}`,
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
  deleteBody: "Removes it from this phone only.",
  deleteKeep: "Keep photo",
  deleteConfirm: "Delete photo",
  deleteBlocked: "Finish or check publication before deleting.",
  exportBundleDone: "Backup exported.",
  missingFullSize: "The full-size version is missing.",
} as const;

/** "Edition of 5 · Copy 1": the publisher's own copy is always number 1. */
export function editionLine(supply: number): string {
  return supply === 1 ? "Edition of 1" : `Edition of ${supply} · Copy 1`;
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
  /** The creator's cut of a resale, in whole percents, and who may collect. */
  royaltyLabel: "Royalty",
  royaltyValue: (bps: number): string => `${bps / 100}%`,
  lessRoyalty: "−",
  moreRoyalty: "+",
  seekerOnlyLabel: "Seeker holders only",
  /** The receipt rows, once a draft exists. Labels only; the values are the draft's. */
  rowCopies: "Copies",
  rowRoyalty: "Royalty",
  rowCollectors: "Collectors",
  rowMoment: "Moment",
  rowImage: "Image",
  rowDevice: "Device",
  rowGenesis: "Genesis Token",
  /** When mainnet could not be asked as the draft was made; the document names none. */
  rowGenesisUnchecked: "Couldn’t check.",
  rowWallet: "Wallet",
  needTitle: "Add a title to publish.",
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
} as const;

export const proof = {
  /** The cluster badge, shown only when the record itself names a network. */
  network: "SOLANA MAINNET",
  networkTest: "SOLANA DEVNET",
  heading: "Record",
  titleLabel: "Published title",
  momentLabel: "Moment",
  publicPhotoLabel: "Public photo",
  standard: "Metaplex Core edition",
  attestationLabel: "Device attestation",
  attestationNone: "Not recorded.",
  /**
   * Said when the document carries evidence this app set aside, or `deviceVerdict` refused it.
   * `reason` is the reader's own text or a `DEVICE_REFUSAL`.
   */
  attestationProblem: (reason: string): string => `Not accepted: ${reason}.`,
  /** While Google's revocation list and the publication time are fetched. */
  attestationChecking: "Checking…",
  /** Either could not be fetched: nothing is claimed. */
  attestationUnchecked: "Couldn’t check.",
  /**
   * Said beside an accepted attestation. The claim is the key and the device the keystore
   * attested, never the camera or the scene. Shown only after the manifest binding, the chain to
   * Google's roots, the release app, the boot state, revocation and the certificates' dates at
   * publication all checked out.
   */
  attestationBody: "Shows which device signed this, not what was photographed.",
  /**
   * The document's Seeker Genesis Token claim, as `useGenesisStanding` found it on mainnet, keyed
   * by `genesisDisplay`. The mint address is shown under the row whatever the answer.
   */
  genesisLabel: "Seeker Genesis Token",
  genesisNone: "Not recorded.",
  genesisStanding: {
    checking: "Checking…",
    held: "Held by the publishing wallet.",
    "not-held": "Not held by the publishing wallet.",
    "not-genesis": "Not a Seeker Genesis Token.",
    unavailable: "Couldn’t check.",
  },
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
  recipientLabel: "Recipient wallet address",
  recipientPlaceholder: "Solana address",
  costLabel: "Estimated network cost",
  consequence: "A transfer can’t be undone.",
  confirmedRecipient: "Confirmed recipient",
  earlierRecipient: "Earlier intended recipient",
  unresolvedBody: "The earlier attempt expired. Its outcome is unknown.",
  stillHeld: "The sender still holds this copy.",
  moved: "This copy is held by another wallet.",
  burned: "This copy has been burned.",
  frozen: "This copy is frozen.",
  recheck: "Checking current ownership…",
  /** "Copy 3 of 5": the numbered copy being sent. */
  copyLine: (number: number, supply: number): string => `Copy ${number} of ${supply}`,
} as const;

/**
 * Collecting: taking one numbered copy of somebody else's edition into your own wallet. A free
 * edition is collected and nothing reaches the publisher; a priced one is bought and its price
 * does (`price` owns those words). Either way the collector pays Solana's own costs (`estimate`).
 * One copy per wallet (per Genesis Token on a Seeker-only edition), while copies remain.
 */
export const collect = {
  network: "SOLANA MAINNET",
  networkTest: "SOLANA DEVNET",

  /** The sheet's heading. The edition's own title wins once it has been read. */
  heading: "Collect a copy",
  headingCollected: "Copy collected",
  headingUnavailable: "Edition unavailable",

  /** The entry stage on the wallet screen: a link to paste, or a code to scan. */
  entryHeading: "Collect",
  /** Spoken only. */
  linkLabel: "Collect link",
  linkPlaceholder: "Paste a collect link",
  scanFailed: "Couldn’t scan that code.",
  pasteFailed: "Couldn’t read the clipboard.",

  /** The readout above the title: the copy this collect would take, then the one it took. */
  nextCopy: (minted: number, supply: number): string =>
    `COPY ${Math.min(minted + 1, supply)} OF ${supply}`,
  yourCopy: (number: number, supply: number): string =>
    `COPY ${number} OF ${supply} · YOUR COPY`,
  publishedBy: "PUBLISHED BY",
  /** Imprinted on the paper, under the title, as the Wallet screen imprints it. */
  by: (address: string): string => `By ${address}`,
  momentLabel: "MOMENT",
  issuedLabel: "ISSUED SO FAR",
  issuedValue: (minted: number, supply: number): string => `${minted} / ${supply}`,

  /** Before a wallet: a copy is collected INTO a wallet, so there is nothing to show without one. */
  needWallet: "Connect a wallet to collect.",
  /** A seeker-only edition: the rule as a value, and the one line for a wallet without a token. */
  collectorsLabel: "COLLECTORS",
  seekerOnly: "Seeker holders only",
  anyone: "Anyone",
  needsGenesis: "Needs a Seeker Genesis Token.",
  /** The states `getCollectState` reports. One sentence each, and never a claim of failure. */
  already: "Already collected by this wallet.",
  soldOut: "Sold out.",
  unavailable: "Couldn’t read this edition. Try again.",
  /** The link named a chain this build does not publish or collect on. */
  wrongNetwork: "This link is for a different network.",
  /** Another collect for this edition is already running in this app. */
  working: "A collect is already running.",


  /** Progress, while the wallet is open and while Solana confirms. */
  progressWallet: "Approve in wallet…",
  progressCosigner: "Checking Seeker Genesis Token…",
  progressConfirming: "Confirming…",
  loading: "Reading this edition…",
  checking: "Checking this wallet…",
  cancelled: "Wallet closed.",
} as const;

/**
 * The price: the publisher's own amount for a copy, in SOL or SKR. Never a cost: the costs (network fee,
 * account rent, the Metaplex Core fee) are the signer's either way, so the two are separate lines
 * and only then added up ("1 numbered copy · 0.25 SOL + network and account costs"). A price of
 * nothing is a free edition: collected, not bought, and nothing reaches the publisher.
 */
export const price = {
  network: "SOLANA MAINNET",
  networkTest: "SOLANA DEVNET",

  /** The publish sheet's optional field. An edition of 1 has nothing to sell, so it has no field. */
  publishLabel: "Price per copy in SOL (optional)",
  publishLabelAny: "Price per copy (optional)",
  publishPlaceholder: "Free",

  /** The label of a price wherever it is read back: a receipt row, a readout, a cost line. */
  label: "Price",
  /** "0.25 SOL". The amount comes from `formatSol`, so it is exact. */
  value: (amount: string): string => `${amount} SOL`,
  /** An edition anyone may collect for nothing. */
  free: "Free",
  /** The buyer's box: the price, the estimate, then what the wallet will be asked for. */
  totalLabel: "Total",

  /** The creator's own sheet. Two taps, like everything else that spends. */
  heading: "Set a price",
  headingSet: "Price set",
  headingClosed: "Sale closed",
  closedValue: "Closed",
  currentLabel: "Current price",
  newLabel: "New price in SOL",
  /** States, one sentence each and never a claim of failure. */
  loading: "Reading this edition’s price…",
  unsupported: "This edition can’t have a price.",
  unavailable: "Couldn’t read the price. Try again.",
  working: "A price change is already running.",
  cancelled: "Wallet closed.",
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
  stampNeedsName: "Needs a .skr name.",
  aboutSection: "About",
  privacyLink: "Privacy & publication",
  termsLink: "Terms",
  supportLink: "Contact support",
  developerTools: "Developer tools",
} as const;

/** Terms, reports and blocks (`src/moderation/`). Labels only. */
export const moderation = {
  terms: "Terms",
  agree: "Agree",
  report: "Report",
  block: "Block",
  unblock: "Unblock",
  /** Said in place of a publication's picture, title and caption. */
  blocked: "Blocked",
  hidden: "Hidden",
} as const;

/** Copy numbers are printed to three figures, the way they are imprinted on the paper. */
const figures = (value: number): string => String(value).padStart(3, "0");

/**
 * The Wallet screen (route `Chain`): the address, what it holds, and what it published, in
 * Collected and Published views. Readouts are set in the mono step, so their words stay on one
 * line at the largest text size; sentences are kept for what retrying cannot fix.
 */
export const collection = {
  collected: "Collected",
  published: "Published",
  /** The wallet line: a tag over the address, and what the wallet holds. */
  wallet: "Wallet",
  sol: "SOL",
  /** A balance that has not been read. Never a zero: a balance is reported, never guessed. */
  noBalance: "—",
  noWallet: "No wallet",
  connect: "Connect",
  opening: "Opening wallet",
  notConnected: "Not connected",
  copyWalletAddress: "Copy wallet address",

  /** Where the prints would be, while there are none to show. */
  loading: "Loading",
  loadFailed: "Load failed",
  empty: (mode: "collected" | "published"): string =>
    mode === "collected" ? "No copies" : "Nothing published",
  noMatch: "No match",
  retry: "Retry",
  /** Partial reads, over a list that still has rows. */
  notRefreshed: "Not refreshed",
  unread: (count: number): string => `${count} unread`,
  notShown: (count: number): string => `+${count} not shown`,
  /** The collect entry's own two refusals; a link's other refusals carry their own reason. */
  notOurLink: "Not a Signshot link",
  noScanner: "No scanner",

  /** The chain these copies were read from, as the header says it. */
  networkFlag: (mainnet: boolean): string => (mainnet ? "MAINNET" : "DEVNET"),

  /** The right-hand imprint on a print: empty, so none is drawn. */
  imprint: "",
  openPhoto: (title: string, number?: number): string =>
    `Open ${title}${number ? `, copy ${number}` : ""}`,
  byYou: "By you",
  by: (address: string): string => `By ${address}`,

  /**
   * The one line under a print: this wallet's copy number under Collected, how many copies have
   * been issued under Published. The dial above says which of the two is being read.
   */
  tally: (count: number, supply: number): string =>
    `${figures(count)} / ${figures(supply)}`,

  /** The photograph's own screen. */
  edition: "Edition",
  backToWallet: "Back to wallet",
  exitFullScreen: "Exit full screen",
  openFullScreen: "View photograph full screen",
  previousPhoto: "Previous photograph",
  nextPhoto: "Next photograph",
  copyOf: (number: number, supply: number): string =>
    `COPY ${figures(number)} / ${figures(supply)}`,
  editionOf: (supply: number): string => `EDITION ${figures(supply)}`,
  byLabel: "By",
  you: "You",
  copyPublisher: "Copy publisher address",
  issuedLabel: "Issued",
  copyEdition: "Copy",
  copyEditionAddress: "Copy edition address",
  explorer: "Explorer",
  viewOnExplorer: "View on Solana Explorer",
  couldNotOpen: "Couldn’t open",
  shareMoment: "Share moment",
  shareFailed: "Share failed",
  copyLink: "Copy link",
  copyMomentLink: "Copy moment link",
  /** Said in place, on the key that was tapped, for a moment. */
  copied: "Copied",
  copyFailed: "Copy failed",
} as const;
