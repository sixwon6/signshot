/**
 * All user-visible copy. Glossary: a numbered NFT is a "copy". Free editions are "collected",
 * priced ones "bought". "Price" goes to the publisher; "cost" (fees, rent, Core fee) is the signer's.
 */

export const actions = {
  openCamera: "Open camera",
  viewPhotos: "View your photos",
  takePhoto: "Take photo",

  publish: "Publish this moment",
  continuePublication: "Continue publication",
  checkPublication: "Check publication",
  save: "Save",
  share: "Share",
  send: "Send",
  details: "Details",
  completeUpload: "Complete public upload",
  checkUpload: "Check upload availability",
  /** Mainnet: re-buys storage after the provider refused it or found it short. */
  payStorage: (amount: string): string => `Pay storage ${amount} SOL`,
  /** The only way a confirmed but un-uploaded publication's bytes leave the phone. */
  exportBundle: "Export backup",
  exportingBundle: "Exporting…",

  backToPhoto: "Back to photo",
  backToPhotograph: "Back to photograph",
  done: "Done",
  /** Two taps: "Continue" connects and quotes; only the spending tap carries the verb. */
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

  collect: "Collect",
  /** Chosen by the reviewed quote's `kind`, not by earlier screen state. */
  confirmBuy: "Buy",
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

/** Accessibility hints. No amounts: the wallet shows the final cost. */
export const onChain = {
  publish: "Creates the edition and your copy 1, then uploads the public photo.",
  /** Free editions only; priced ones use `buy`. */
  collect: "Creates a numbered copy in your wallet.",
  buy: "Buys a numbered copy. The price goes to the publisher.",
  setPrice: "Sets what the next buyer pays. Zero makes it free.",
  send: "Transfers your copy to another wallet.",
  shareLink: "Shares the link to this edition.",
} as const;

export const estimate = {
  label: "Estimated cost",
  show: "Show cost details",
  hide: "Hide cost details",
  networkFee: "Network fee",
  accountCost: "Accounts and Core fee",
  allowance: "Wallet allowance",
} as const;

/** Seed Vault replies only when its sheet is closed, after the 90 s adapter timeout; the tx has often landed. */
export const walletTimeout = {
  publishChecking: "Wallet didn’t answer in time. Close it while the publication is checked.",
  publishFound: "This moment is published. Continue to its upload.",
  publishPending: "Not on Solana yet. Close the wallet and tap Continue again in a moment.",
  /** Blockhash expired. */
  publishRetry: "That transaction expired. Approve the new estimate to publish.",
  sendChecking: "Wallet didn’t answer in time. Close it while the transfer is checked.",
  sendFound: "The transfer is confirmed.",
  sendPending: "Transfer not confirmed yet. Close the wallet and check its status in a moment.",
  /** Reviews only pick an account; nothing was sent. */
  costCheck: "Wallet didn’t answer in time. Close it, then tap Continue again.",
  transferReview: "Wallet didn’t answer in time. Close it, then review the transfer again.",
  connect: "Wallet didn’t answer in time. Close it, then tap Connect wallet again.",
  collectChecking: "Wallet didn’t answer in time. Close it while your copy is checked.",
  collectFound: "Your copy was collected.",
  collectPending: "Not on Solana yet. Close the wallet and check the status in a moment.",
  collectCostCheck: "Wallet didn’t answer in time. Close it, then tap Continue again.",
  offerCostCheck: "Wallet didn’t answer in time. Close it, then tap Continue again.",
  offerChecking: "Wallet didn’t answer in time. Close it while the price is checked.",
  offerFound: "The price is set.",
  offerPending: "Price not on Solana yet. Close the wallet and check again in a moment.",
} as const;

/** Recipe, stage and parameter names live in `src/recipes/`. */
export const recipes = {
  /** All stages at neutral, opened for editing. */
  custom: "+",
  customLabel: "Custom",
  strength: "Strength",
  edit: "Edit",
  strengthHint: (name: string) => `${name}. Strength.`,
  fineControls: "Fine controls",
  hideFineControls: "Hide fine controls",
  save: "Save",
  reset: "Reset",
  rename: "Rename",
  duplicate: "Copy",
  delete: "Delete",
  /** Replaces the Delete label to confirm. */
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
  tapToFocus: "Picture. Tap to focus and meter there.",
  collection: "Wallet",
  collectionHint: "Open your wallet",
  photos: "Photos",
  settings: "Settings",

  // Errors
  cameraAccessError:
    "Camera access could not be requested. Open your phone settings to allow it.",
  recipeLoadError: "This recipe could not be loaded. Restart the camera to try again.",
  recipeSaveError: "That recipe could not be saved.",
  sessionError: "The camera is unavailable. Restart it to try again.",
  captureError: "The photo could not be saved. Restart the camera and try again.",
  settingsOpenError: "Open your phone settings, then allow camera access for this app.",
} as const;

/** Values come from the formatters in `src/capture/model.ts`. */
export const captureControls = {
  modes: { auto: "Auto", program: "P", manual: "M" },
  disp: "Disp",
  applyError: "Camera controls did not apply. Restart the camera and try again.",
  /** Spoken names. */
  iso: "ISO",
  shutter: "Shutter",
  ev: "Brightness",
  whiteBalance: "White balance",
  kelvin: "Kelvin",
  focus: "Focus",
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
  zero: "0",
  /** Camera2 white-balance modes. */
  lights: {
    daylight: "Sunny",
    cloudy: "Cloudy",
    shade: "Shade",
    indoor: "Indoor",
    fluorescent: "Fluorescent",
    warmFluorescent: "Warm fluorescent",
    twilight: "Twilight",
  },
  /** Short forms for cells. */
  lightTags: { fluorescent: "Fluo", warmFluorescent: "Warm fl", twilight: "Dusk" },
  kelvinKey: "K",
  auto: "Auto",
  /** Spoken only. */
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
  photographs: (total: number) =>
    `${total} ${total === 1 ? "photograph" : "photographs"}`,
  publishedCount: (total: number) => `${total} published`,
  /** "01 / 05". */
  copyMark: (number: number, supply: number) =>
    `${String(number).padStart(2, "0")} / ${String(supply).padStart(2, "0")}`,
  emptyHeading: "Take the first one.",
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

/** The publisher's copy is always number 1. */
export function editionLine(supply: number): string {
  return supply === 1 ? "Edition of 1" : `Edition of ${supply} · Copy 1`;
}

export const publish = {
  network: "SOLANA MAINNET",
  networkTest: "SOLANA DEVNET",
  /** Replaced by the photo's title once it has one. */
  heading: "Publish this moment",
  headingPublished: "Your moment is published",
  headingUpload: "Photo upload pending",
  titleLabel: "Name this moment",
  momentLabel: "Moment (optional)",
  copiesLabel: "Copies",
  totalLabel: "Total copies, including yours",
  royaltyLabel: "Royalty",
  royaltyValue: (bps: number): string => `${bps / 100}%`,
  lessRoyalty: "−",
  moreRoyalty: "+",
  seekerOnlyLabel: "Seeker holders only",
  rowCopies: "Copies",
  rowRoyalty: "Royalty",
  rowCollectors: "Collectors",
  rowMoment: "Moment",
  rowImage: "Image",
  rowDevice: "Device",
  rowGenesis: "Genesis Token",
  /** Mainnet unreachable when the draft was made; the document names no SGT. */
  rowGenesisUnchecked: "Couldn’t check.",
  rowWallet: "Wallet",
  needTitle: "Add a title to publish.",
  needCount: "Choose an edition of 2 to 1000 copies to continue.",
  blockedTitle: "Saved publication needs attention",
  unavailableTitle: "Publishing is unavailable in this build",
  blockedBody:
    "This saved publication could not be validated. Close and reopen the photograph to check it again.",
  // Unreadable saved draft. Nothing is on chain, so discarding is safe.
  unreadableBody:
    "Saved publication details on this phone could not be read by this version of the app. Nothing was published and nothing on Solana is affected. Discard them to start this photograph again.",
  unavailableBody:
    "Wallet publication has not been enabled. Your photo is ready to save and share.",
} as const;

export const proof = {
  /** Shown only when the record names a network. */
  network: "SOLANA MAINNET",
  networkTest: "SOLANA DEVNET",
  heading: "Record",
  titleLabel: "Published title",
  momentLabel: "Moment",
  publicPhotoLabel: "Public photo",
  standard: "Metaplex Core edition",
  attestationLabel: "Device attestation",
  attestationNone: "Not recorded.",
  /** `reason` is the reader's text or a `DEVICE_REFUSAL`. */
  attestationProblem: (reason: string): string => `Not accepted: ${reason}.`,
  attestationChecking: "Checking…",
  /** Revocation list or publication time unavailable: claim nothing. */
  attestationUnchecked: "Couldn’t check.",
  /** Attests the signing device only, never the scene. Shown only after every check passes. */
  attestationBody: "Shows which device signed this, not what was photographed.",
  /** Keyed by `genesisDisplay`; the mint address is always shown under the row. */
  genesisLabel: "Seeker Genesis Token",
  genesisNone: "Not recorded.",
  genesisStanding: {
    checking: "Checking…",
    held: "Held by the publishing wallet.",
    "not-held": "Not held by the publishing wallet.",
    "not-genesis": "Not a Seeker Genesis Token.",
    unavailable: "Couldn’t check.",
  },
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
  copyLine: (number: number, supply: number): string => `Copy ${number} of ${supply}`,
} as const;

/** One copy per wallet (per SGT on Seeker-only editions). Priced-edition wording lives in `price`. */
export const collect = {
  network: "SOLANA MAINNET",
  networkTest: "SOLANA DEVNET",

  /** Replaced by the edition's title once read. */
  heading: "Collect a copy",
  headingCollected: "Copy collected",
  headingUnavailable: "Edition unavailable",

  entryHeading: "Collect",
  /** Spoken only. */
  linkLabel: "Collect link",
  linkPlaceholder: "Paste a collect link",
  scanFailed: "Couldn’t scan that code.",
  pasteFailed: "Couldn’t read the clipboard.",

  nextCopy: (minted: number, supply: number): string =>
    `COPY ${Math.min(minted + 1, supply)} OF ${supply}`,
  yourCopy: (number: number, supply: number): string =>
    `COPY ${number} OF ${supply} · YOUR COPY`,
  publishedBy: "PUBLISHED BY",
  by: (address: string): string => `By ${address}`,
  momentLabel: "MOMENT",
  issuedLabel: "ISSUED SO FAR",
  issuedValue: (minted: number, supply: number): string => `${minted} / ${supply}`,

  needWallet: "Connect a wallet to collect.",
  collectorsLabel: "COLLECTORS",
  seekerOnly: "Seeker holders only",
  anyone: "Anyone",
  needsGenesis: "Needs a Seeker Genesis Token.",
  /** `getCollectState` results. Never phrased as failure. */
  already: "Already collected by this wallet.",
  soldOut: "Sold out.",
  unavailable: "Couldn’t read this edition. Try again.",
  wrongNetwork: "This link is for a different network.",
  working: "A collect is already running.",


  progressWallet: "Approve in wallet…",
  progressCosigner: "Checking Seeker Genesis Token…",
  progressConfirming: "Confirming…",
  loading: "Reading this edition…",
  checking: "Checking this wallet…",
  cancelled: "Wallet closed.",
} as const;

/** The publisher's amount per copy (SOL or SKR). Always shown apart from costs, then summed. */
export const price = {
  network: "SOLANA MAINNET",
  networkTest: "SOLANA DEVNET",

  /** Not shown for an edition of 1. */
  publishLabel: "Price per copy in SOL (optional)",
  publishLabelAny: "Price per copy (optional)",
  publishPlaceholder: "Free",

  label: "Price",
  /** `amount` from `formatSol`. */
  value: (amount: string): string => `${amount} SOL`,
  free: "Free",
  totalLabel: "Total",

  heading: "Set a price",
  headingSet: "Price set",
  headingClosed: "Sale closed",
  closedValue: "Closed",
  currentLabel: "Current price",
  newLabel: "New price in SOL",
  /** Never phrased as failure. */
  loading: "Reading this edition’s price…",
  unsupported: "This edition can’t have a price.",
  unavailable: "Couldn’t read the price. Try again.",
  working: "A price change is already running.",
  cancelled: "Wallet closed.",
  /** Other refusals come from `parseSolPrice`. */
  invalid: "Enter a price in SOL, like 0.25.",

  progressWallet: "Approve in wallet…",
  progressConfirming: "Confirming…",
} as const;


/** Seeker fact values are upper-case: they render in the mono readout style. */
export const settings = {
  heading: "Settings",
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
  /** Devnet builds only. */
  seekerSourceDevnet: "TOKEN AND SEEKER ID ARE READ FROM SOLANA MAINNET. PUBLISHING USES DEVNET.",
  /** No wallet connected. */
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

export const moderation = {
  terms: "Terms",
  agree: "Agree",
  report: "Report",
  block: "Block",
  unblock: "Unblock",
  /** Replace the picture, title and caption. */
  blocked: "Blocked",
  hidden: "Hidden",
} as const;

const figures = (value: number): string => String(value).padStart(3, "0");

/** Wallet screen (route `Chain`). Readouts are short so they fit one line at the largest text size. */
export const collection = {
  collected: "Collected",
  published: "Published",
  wallet: "Wallet",
  sol: "SOL",
  /** Unread balance; never show 0. */
  noBalance: "—",
  noWallet: "No wallet",
  connect: "Connect",
  opening: "Opening wallet",
  notConnected: "Not connected",
  copyWalletAddress: "Copy wallet address",

  loading: "Loading",
  loadFailed: "Load failed",
  empty: (mode: "collected" | "published"): string =>
    mode === "collected" ? "No copies" : "Nothing published",
  noMatch: "No match",
  retry: "Retry",
  /** Partial reads. */
  notRefreshed: "Not refreshed",
  unread: (count: number): string => `${count} unread`,
  notShown: (count: number): string => `+${count} not shown`,
  notOurLink: "Not a Signshot link",
  noScanner: "No scanner",

  networkFlag: (mainnet: boolean): string => (mainnet ? "MAINNET" : "DEVNET"),

  /** Empty: no right-hand imprint. */
  imprint: "",
  openPhoto: (title: string, number?: number): string =>
    `Open ${title}${number ? `, copy ${number}` : ""}`,
  byYou: "By you",
  by: (address: string): string => `By ${address}`,

  /** Collected: this wallet's copy number. Published: copies issued. */
  tally: (count: number, supply: number): string =>
    `${figures(count)} / ${figures(supply)}`,

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
  copied: "Copied",
  copyFailed: "Copy failed",
} as const;
