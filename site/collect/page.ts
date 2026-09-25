/**
 * The collector page itself: the screen, not the protocol.
 *
 * `browser.ts` accepts a link and hands the adapter for it to `run()`. This file owns wallet
 * discovery on Android (MWA) and elsewhere (Wallet Standard), quoting, the durable
 * pending-attempt safety, confirmation, availability wording, the device row, the open-in-app
 * control, the share card, the terms agreement, Report and Block, the moderation veil
 * (`src/moderation/core.ts`) and the error panel; it knows nothing about Metaplex Core plugins,
 * PDAs or instruction layouts. The adapter (`core.ts`) supplies the addresses, the reader, the
 * claim and the words that name its own costs, so a page change cannot quietly alter what a
 * collector is told they are paying for.
 *
 * Rules the page keeps whatever it is showing:
 *   - an RPC endpoint and a program address are NEVER taken from the link, only from the build's
 *     reviewed deployment table;
 *   - success is proven ONLY by the permanent claim receipt, never by a wallet's signature;
 *   - nothing is ever assigned through `innerHTML`; every string from the chain or a gateway lands
 *     as `textContent`, and the CSP's `require-trusted-types-for 'script'` enforces that.
 */
import { getWallets } from "@wallet-standard/app";
import type { Wallet } from "@wallet-standard/base";
import type { StandardConnectFeature } from "@wallet-standard/features";
import type { SolanaSignAndSendTransactionFeature } from "@solana/wallet-standard-features";
import { transact } from "@solana-mobile/mobile-wallet-adapter-protocol-kit";
import {
  SolanaMobileWalletAdapterProtocolError,
  SolanaMobileWalletAdapterProtocolErrorCode,
} from "@solana-mobile/mobile-wallet-adapter-protocol";
import {
  address,
  getAddressDecoder,
  getBase64Encoder,
  getBase58Decoder,
  getTransactionEncoder,
  type Instruction,
  type Transaction,
} from "@solana/kit";
import { prepareTransaction, confirmTransaction, request } from "../../publications/rpc";
import { assertAttempt, checkAttempt } from "../../publications/lifecycle";
import type { Cluster } from "../../publications/types";
import { genesisDisplay, type GenesisCheck, type GenesisStanding } from "../../publications/core/genesisToken";
import {
  MODERATION_URL,
  TERMS_VERSION,
  fetchModerationList,
  readBlockList,
  reportMailto,
  termsAgreed,
  veilOf,
  withBlocked,
  type ModerationList,
  type Veil,
} from "../../src/moderation/core";
import type { DeviceVerdict } from "../../publications/core/attestation";

import { qrMatrix } from "./qr";
import { DEVICE_LINE, deviceProblem, deviceVerdictRow, GENESIS_LINE, MODERATION_WORDS, NO_DEVICE, sol } from "./summary";

export type { Cluster } from "../../publications/types";

export const el = <T extends HTMLElement = HTMLElement>(id: string) => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing ${id}`);
  return node as T;
};

export const params = new URLSearchParams(location.search);
export const cluster: Cluster =
  params.get("cluster") === "devnet" ? "devnet" : "mainnet-beta";
const chain = cluster === "devnet" ? "solana:devnet" : "solana:mainnet";
// Same-origin production RPC proxy, optionally configured by the site operator. Never
// accept RPC endpoints in a shared QR URL, which would let a link author fake chain state.
export const mainnetEndpoint = new URL("/api/solana", location.origin).href;
export const endpoint =
  cluster === "devnet" ? "https://api.devnet.solana.com" : mainnetEndpoint;
/**
 * Google's attestation revocation list, through the same-origin Function
 * (`functions/api/attestation-status.ts`): Google's endpoint sends no CORS header.
 */
export const attestationStatusUrl = new URL("/api/attestation-status", location.origin).href;
const android = /Android/i.test(navigator.userAgent);

/** The app's Android package, the target of the App Link and of the `intent://` control. */
const APP_PACKAGE = "app.seekershot";

/**
 * This browser's agreement to the terms and its block list. They live in `localStorage` and are
 * never sent anywhere; storage that throws (a private window, blocked site data) reads as empty,
 * and what is set then holds for this page only.
 */
const TERMS_KEY = "seedshot.terms-agreed";
const BLOCKED_KEY = "seedshot.blocked-creators.v1";
function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function store(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* held in memory for this page */
  }
}
/** Signshot's moderation list, read from this page's own origin so `connect-src 'self'` covers it. */
const moderationUrl = new URL(new URL(MODERATION_URL).pathname, location.origin).href;

/**
 * The one place publisher-controlled bytes become an image on this origin.
 *
 * The bytes arrive hash-checked against the fingerprint in the edition account, so they are
 * exactly what the publisher committed to and no gateway can substitute them. What was never
 * checked is whether they are a JPEG at all. They are wrapped in a `blob:` labelled `image/jpeg`
 * and handed to <img> — safe in itself, even for SVG — and the `blob:` URL is SAME-ORIGIN with
 * erashot.app. `X-Content-Type-Options: nosniff` does not reach a `blob:`, whose type comes from
 * this constructor, so the label has to be true: require the JPEG start-of-image marker. The app
 * publishes JPEG and nothing else (`publications/core/protocol.ts` declares `image/jpeg` in every
 * metadata document), so this refuses nothing legitimate.
 */
export function jpegBlob(bytes: Uint8Array): Blob {
  if (bytes.length < 3 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff)
    throw new Error("Photo file does not match the published edition");
  return new Blob([new Uint8Array(bytes)], { type: "image/jpeg" });
}

/** The creator's price for the remaining copies, pinned to the revision it belongs to. */
export interface Price {
  priceLamports: bigint;
  revision: number;
}

/**
 * The device row, derived from the certificate chain inside the document after the app's reader
 * verified it down to Google's pinned roots. `line` is what the row says once `check()` (the
 * release app, the boot state, the publication time and Google's revocation list) answers
 * "verified"; `problem` when the document carries evidence the reader set aside (the photograph
 * still loads); `null` for a plain document that carries none.
 */
export type Device = { line: string; check(): Promise<DeviceVerdict> } | { problem: string } | null;

/**
 * The Genesis Token row: the mint the document claims, and the check that says whether the
 * publishing wallet holds it. The Seeker Genesis Token exists on mainnet only, so `standing`
 * asks `mainnetEndpoint` whatever network the edition is on. `null` when the document names none.
 */
export type Genesis = {
  mint: string;
  /** The edition program verified the token and sealed the mint at publish. Counts on mainnet only. */
  sealed: boolean;
  standing(): Promise<GenesisStanding>;
} | null;

/** What the page renders, reduced to what a screen needs from a publication. */
export interface Loaded {
  title: string;
  creator: string;
  supply: number;
  minted: number;
  remaining: number;
  width: number;
  height: number;
  imageBytes: Uint8Array;
  /** The publisher's caption, or `""` when they wrote none. */
  description: string;
  /** The price of the remaining copies as loaded, or `null` when they are free. Display only. */
  price: Price | null;
  device: Device;
  genesis: Genesis;
}

/**
 * The publisher's own words about the moment, under the title. One line, and nothing else.
 *
 * The value goes in through `textContent`. A caption is up to 280 characters of somebody else's
 * text arriving from a public gateway. The reader has already refused control, zero-width and
 * bidi characters (`publications/core/details.ts`), so what lands here is one line of plain
 * text — and it is still assigned as text, never parsed as markup.
 */
function showMoment(description: string) {
  const line = el("moment-text");
  line.textContent = description;
  el("moment").hidden = !description;
}

/**
 * Protocol-specific screen wording, supplied by the adapter. The page never hard-codes a
 * standard's fees or nouns: the code that knows a claim creates a Core asset is the code that
 * owns the sentence telling the collector they pay Core's fee for it.
 */
export interface Copy {
  /** `#availability` when the edition holds a single copy. */
  solo: string;
  /** `#cost` before a wallet is connected and a real estimate exists. */
  cost: string;
  /** "About this photo NFT". */
  details(loaded: Loaded): string;
  /** The protocol fee inside that panel, as a labelled value. */
  fees(): string;
  /** The share card's edition line, in the card's upper-case voice. */
  card(supply: number): string;
  /** The status message after a confirmed, receipt-proven claim. */
  collected(number: number, supply: number): string;
}

/** The publication protocol, as this page needs it. */
export interface Adapter {
  /** The publication's identity: the edition account named by the link. */
  edition: string;
  /** `localStorage` key of the durable claim attempt. Versioned per protocol and cluster. */
  pendingKey: string;
  copy: Copy;
  /** Fully verify the publication under its actual account owner, checked against build trust. */
  load(): Promise<Loaded>;
  /** The permanent one-claim receipt for `wallet`: the only proof a claim succeeded. */
  hasCollected(wallet: string): Promise<boolean>;
  /**
   * The claim instruction plus the print address it creates, for the pending record, and the
   * price the instruction was pinned to (`null` for a free collect). The adapter re-reads the
   * live offer here, so what the wallet is asked to approve is what the chain says right now.
   */
  claim(
    wallet: string,
    number: number,
  ): Promise<{ instruction: Instruction; asset: string; price: Price | null }>;
  /** The public link this page is reachable at; encoded into the share card's QR. */
  collectUrl(): string;
  /** Explorer links, available once `load()` has succeeded. */
  links(): { source: string; container?: { href: string; label: string } };
}

type Connection = {
  address: string;
  send(tx: Transaction, slot: bigint): Promise<string>;
};

/** An account check failed before the page dispatched a transaction to the wallet. */
class WalletConnectionChangedError extends Error {}

/** A saved attempt this browser cannot read. It blocks collecting, never the photograph. */
class BrokenAttemptError extends Error {}

/**
 * Did the wallet explicitly refuse to sign THIS request, so that nothing was sent? Only then may
 * the durable attempt be removed (`src/prints/collect.ts` does the same with `isSigningRefused`).
 * MWA says so with `ERROR_NOT_SIGNED`; a Wallet Standard wallet has no code, so its explicit
 * rejection is recognised by the sentence it throws. A closed association, a timeout or any
 * other failure proves nothing about whether the transaction left the wallet, so the attempt is
 * kept and the chain decides.
 */
function signingRefused(e: unknown, transport: "mwa" | "standard"): boolean {
  if (transport === "mwa")
    return (
      e instanceof SolanaMobileWalletAdapterProtocolError &&
      e.code === SolanaMobileWalletAdapterProtocolErrorCode.ERROR_NOT_SIGNED
    );
  const message = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  return /user (rejected|declined|denied|cancel)/i.test(message);
}

/** A wallet must return exactly one 64-byte Ed25519 signature; anything else is not a receipt. */
function oneSignature(signatures: readonly Uint8Array[]): string {
  if (signatures.length !== 1 || signatures[0].length !== 64)
    throw new Error("Wallet returned no receipt. Check collection before retrying.");
  return getBase58Decoder().decode(signatures[0]);
}

/** The wallet refused to sign; the caller removes the attempt that was written for it. */
class SigningRefusedError extends Error {
  constructor(readonly cause: unknown) {
    super("The wallet did not sign.");
  }
}

/** The link itself is unusable: there is nothing to read and nothing to retry. */
export function fail(message: string) {
  el("loading").hidden = true;
  el("edition").hidden = true;
  el("retry-load").hidden = true;
  el("error-panel").hidden = false;
  el("load-error").textContent = message;
}

/**
 * The QR of the public link, drawn as SVG through the DOM (no markup string, no `innerHTML`).
 * `fill` is a presentation attribute, not a `style=`, so `style-src 'self'` is untouched.
 */
function qrSvg(url: string, size: number): SVGSVGElement {
  const NS = "http://www.w3.org/2000/svg";
  const qr = qrMatrix(url);
  const quiet = 4;
  const side = qr.size + quiet * 2;
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${side} ${side}`);
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "QR code of this page’s link");
  svg.setAttribute("shape-rendering", "crispEdges");
  const bg = document.createElementNS(NS, "rect");
  bg.setAttribute("width", String(side));
  bg.setAttribute("height", String(side));
  bg.setAttribute("fill", "#ffffff");
  svg.append(bg);
  // One path for every dark module: a few hundred rects would be a slow DOM on a phone.
  let d = "";
  for (let y = 0; y < qr.size; y++)
    for (let x = 0; x < qr.size; x++)
      if (qr.modules[y * qr.size + x] === "1") d += `M${x + quiet} ${y + quiet}h1v1h-1z`;
  const path = document.createElementNS(NS, "path");
  path.setAttribute("d", d);
  path.setAttribute("fill", "#000000");
  svg.append(path);
  return svg;
}

/**
 * "Open in Signshot". The page URL itself is the app's verified App Link, so a tap on the link
 * from another app already opens Signshot; a viewer who is ALREADY in a browser on the phone
 * needs an explicit hand-off, which is what an Android `intent://` URL is for
 * (https://developer.chrome.com/docs/android/intents): Chrome opens the named package when it is
 * installed and otherwise follows `S.browser_fallback_url`, here the site's own home page rather
 * than a store listing that does not exist yet. Elsewhere the control is a QR of the public link
 * for the phone to scan; the app's own QR reader and the phone's camera both open it.
 */
function showOpenInApp(url: string) {
  const link = el<HTMLAnchorElement>("open-app");
  const holder = el("open-qr");
  holder.replaceChildren();
  if (android) {
    const target = new URL(url);
    const fallback = encodeURIComponent(`${target.origin}/`);
    link.href = `intent://${target.host}${target.pathname}${target.search}#Intent;scheme=https;package=${APP_PACKAGE};S.browser_fallback_url=${fallback};end`;
    link.hidden = false;
    holder.hidden = true;
  } else {
    link.hidden = true;
    holder.append(qrSvg(url, 168));
    holder.hidden = false;
  }
}

export function run(adapter: Adapter) {
  const machine = adapter.edition;
  let loaded: Loaded | null = null,
    connection: Connection | null = null;
  let quote: {
    prepared: Awaited<ReturnType<typeof prepareTransaction>>;
    asset: string;
    number: number;
    price: Price | null;
  } | null = null;
  let busy = false,
    imageUrl: string | null = null,
    alreadyCollected = false,
    needsReconnect = false;
  /** The last moderation list that parsed; `null` hides nothing (fail open). */
  let moderation: ModerationList | null = null,
    blocked: ReadonlySet<string> = new Set(readBlockList(stored(BLOCKED_KEY))),
    agreed = termsAgreed(stored(TERMS_KEY));
  /** What stands in for the loaded publication's picture, title and caption, if anything. */
  const veil = (): Veil => (loaded ? veilOf(machine, loaded.creator, moderation, blocked) : null);
  const pendingKey = adapter.pendingKey;
  type Pending = {
    wallet: string;
    asset: string;
    lastValidBlockHeight: string;
    signature?: string;
    /** Which instruction the attempt carried; decides how a program failure is classified. */
    kind?: "collect" | "buy";
  };
  /**
   * The durable attempt, or `null` when there is none or storage cannot be read (a private
   * window, blocked site data). A record that exists but cannot be trusted throws
   * `BrokenAttemptError`: it is never silently dropped (it may name a signature that landed),
   * and it is never allowed to stop the photograph from rendering.
   */
  function pending(): Pending | null {
    let raw: string | null;
    try {
      raw = localStorage.getItem(pendingKey);
    } catch {
      return null;
    }
    if (!raw) return null;
    try {
      const p = JSON.parse(raw) as Pending;
      address(p.wallet);
      address(p.asset);
      if (p.kind !== undefined && p.kind !== "collect" && p.kind !== "buy")
        throw new Error("Saved attempt names an unknown operation.");
      assertAttempt(p);
      return p;
    } catch (e) {
      throw new BrokenAttemptError(
        `Saved collection record unreadable (${e instanceof Error ? e.message : String(e)}). Clear this site's data to reset.`,
      );
    }
  }
  function writePending(p: Pending) {
    localStorage.setItem(pendingKey, JSON.stringify(p));
  }
  function removePending() {
    try {
      localStorage.removeItem(pendingKey);
    } catch {
      /* nothing to remove, or storage is unavailable: either way no attempt survives */
    }
  }
  function message(s: string) {
    el("status").textContent = s;
  }
  function error(e: unknown) {
    if (e instanceof WalletConnectionChangedError) {
      // Reset only the connection and its quote. The durable attempt still gates a fresh
      // approval after reconnecting, including when the user chooses a different account.
      connection = null;
      quote = null;
      alreadyCollected = false;
      needsReconnect = true;
      el("cost").textContent = adapter.copy.cost;
    }
    message(e instanceof Error ? e.message : String(e));
  }
  function setButton() {
    const b = el<HTMLButtonElement>("collect");
    b.hidden = loaded?.supply === 1;
    b.disabled = busy || !loaded || loaded.remaining === 0 || alreadyCollected || !!veil();
    const verb = loaded?.price ? "Buy a copy" : "Collect a copy";
    b.textContent = busy
      ? "Please wait…"
      : alreadyCollected
        ? "You hold a copy"
        : loaded?.remaining === 0
          ? "All copies collected"
          : !connection
            ? needsReconnect
              ? "Reconnect wallet to collect"
              : loaded?.price
                ? "Connect wallet to buy"
                : "Connect wallet to collect"
            : quote
              ? verb
              : "Review the cost";
  }
  /**
   * The picture, title and caption — or, when Signshot's list hides the publication or this
   * browser blocked its publisher, the word that stands in for all three. The record (publisher,
   * copies, device, links) stays either way, and a veiled edition is not collected from here.
   */
  function showContent() {
    if (!loaded) return;
    const v = veil();
    for (const img of [el<HTMLImageElement>("photo"), el<HTMLImageElement>("full-photo")]) {
      if (v || !imageUrl) img.removeAttribute("src");
      else img.src = imageUrl;
      img.alt = v ? "" : loaded.title;
    }
    el("view-photo").hidden = !!v;
    el("veil").hidden = !v;
    const title = v ? MODERATION_WORDS[v] : loaded.title;
    el("title").textContent = title;
    el("full-photo-title").textContent = v ? "" : loaded.title;
    document.title = `${title} · Signshot`;
    showMoment(v ? "" : loaded.description);
    el("share").hidden = !!v;
    if (v) {
      el("wallets").hidden = true;
      el("agreement").hidden = true;
    }
    el<HTMLAnchorElement>("report").href = reportMailto(machine, adapter.collectUrl());
    el("block").textContent = blocked.has(loaded.creator)
      ? MODERATION_WORDS.unblock
      : MODERATION_WORDS.block;
  }
  function receipt(sig: string) {
    const a = el<HTMLAnchorElement>("receipt");
    a.href = `https://explorer.solana.com/tx/${sig}${cluster === "devnet" ? "?cluster=devnet" : ""}`;
    a.hidden = false;
  }
  function showAvailability() {
    if (!loaded) return;
    el("availability").textContent =
      loaded.supply === 1
        ? adapter.copy.solo
        : loaded.remaining
          ? `${loaded.remaining} of ${loaded.supply} copies available`
          : `All ${loaded.supply} copies collected`;
    const progress = el<HTMLProgressElement>("supply-progress");
    progress.hidden = loaded.supply === 1;
    el("cost").hidden = loaded.supply === 1;
    progress.max = loaded.supply;
    progress.value = loaded.minted;
    // The price line: what the creator asks for a remaining copy, as loaded. A quote re-reads it.
    const price = el("price");
    price.hidden = loaded.supply === 1 || !loaded.remaining;
    price.textContent = loaded.price
      ? `${sol(loaded.price.priceLamports)} SOL per copy`
      : "Free to collect";
    el("fees").textContent = adapter.copy.fees();
    el("about").textContent = adapter.copy.details(loaded);
  }
  /**
   * The device row, in the app's own words (`ProofSheet.tsx`): the certificate names the device,
   * the key and the boot state; it does not say what was in front of the lens, and the fine print
   * under the row says so. The device is named only after `check()` says "verified"; until then
   * the row is checking, and a check that could not finish says so. A later refresh outruns an
   * earlier check by `deviceRun`.
   */
  let deviceRun = 0;
  function showDevice(device: Device) {
    const run = ++deviceRun;
    const row = el("device");
    const say = (text: string, state: "device-ok" | "device-problem" | "device-none") => {
      if (run !== deviceRun) return;
      el("device-text").textContent = text;
      row.classList.remove("device-ok", "device-problem", "device-none");
      row.classList.add(state);
    };
    row.hidden = false;
    if (!device) return say(NO_DEVICE, "device-none");
    if ("problem" in device) return say(deviceProblem(device.problem), "device-problem");
    say(DEVICE_LINE.checking, "device-none");
    void device.check().then(
      (verdict) => {
        const shown = deviceVerdictRow(device.line, verdict);
        say(shown.text, shown.state);
      },
      () => say(DEVICE_LINE.unavailable, "device-none"),
    );
  }
  /**
   * The Genesis Token row. The document only claims a mint, so the row says it is checking until
   * mainnet has answered, and the load never waits for it. A later refresh outruns an earlier
   * check by `genesisRun`. What it says, and whether the seal line shows, is `genesisDisplay`.
   */
  let genesisRun = 0;
  function showGenesis(genesis: Genesis) {
    const run = ++genesisRun;
    const row = el("genesis");
    row.hidden = !genesis;
    if (!genesis) return;
    const say = (check: GenesisCheck) => {
      if (run !== genesisRun) return;
      const { line, sealed } = genesisDisplay(check, { cluster, sealed: genesis.sealed });
      el("genesis-text").textContent = GENESIS_LINE[line];
      el("genesis-sealed").hidden = !sealed;
      row.classList.remove("device-ok", "device-problem", "device-none");
      row.classList.add(
        line === "held"
          ? "device-ok"
          : line === "checking" || line === "unavailable"
            ? "device-none"
            : "device-problem",
      );
    };
    el("genesis-mint").textContent = genesis.mint;
    say("checking");
    void genesis.standing().then(say, () => say("unavailable"));
  }
  async function refresh() {
    busy = true;
    quote = null;
    setButton();
    el("error-panel").hidden = true;
    el("loading").hidden = false;
    try {
      if (params.has("cluster") && !["devnet", "mainnet-beta"].includes(params.get("cluster")!))
        throw new Error("Unsupported network in this link.");
      address(machine);
      el("cost").textContent = adapter.copy.cost;
      // The list never throws: unreadable is `null`, and the last good list is kept.
      const [next, list] = await Promise.all([adapter.load(), fetchModerationList(moderationUrl)]);
      loaded = next;
      moderation = list ?? moderation;
      if (imageUrl) URL.revokeObjectURL(imageUrl);
      imageUrl = URL.createObjectURL(jpegBlob(loaded.imageBytes));
      showContent();
      el("creator").textContent = loaded.creator;
      showAvailability();
      showDevice(loaded.device);
      showGenesis(loaded.genesis);
      showOpenInApp(adapter.collectUrl());
      const links = adapter.links();
      el<HTMLAnchorElement>("source").href = links.source;
      const container = el<HTMLAnchorElement>("container");
      container.hidden = !links.container;
      if (links.container) {
        container.href = links.container.href;
        container.textContent = links.container.label;
      }
      el("network").hidden = cluster !== "devnet";
      el("edition").hidden = false;
      if (connection) alreadyCollected = await adapter.hasCollected(connection.address);
      // Outside the load's own failure path: a bad saved record is a note under the photograph,
      // not a reason to hide it.
      try {
        const p = pending();
        if (p?.signature) receipt(p.signature);
      } catch (e) {
        message(e instanceof Error ? e.message : String(e));
      }
    } catch (e) {
      loaded = null;
      el("edition").hidden = true;
      el("error-panel").hidden = false;
      el("load-error").textContent = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
      el("loading").hidden = true;
      setButton();
    }
  }
  async function connectMobile(): Promise<Connection> {
    const identity = { name: "Signshot", uri: location.origin, icon: "/icon.png" };
    const auth = await transact((wallet) => wallet.authorize({ chain, identity }));
    const selected = auth.accounts[0];
    if (!selected) throw new Error("No wallet account was selected.");
    const walletAddress = getAddressDecoder().decode(getBase64Encoder().encode(selected.address));
    return {
      address: walletAddress,
      send: async (tx, slot) =>
        transact(async (wallet) => {
          const next = await wallet.authorize({ chain, identity, auth_token: auth.auth_token });
          if (
            !next.accounts[0] ||
            getAddressDecoder().decode(getBase64Encoder().encode(next.accounts[0].address)) !==
              walletAddress
          )
            throw new WalletConnectionChangedError("Wallet account changed. Reconnect before collecting.");
          const sigs = await wallet
            .signAndSendTransactions({
              transactions: [tx],
              minContextSlot: Number(slot),
              skipPreflight: false,
            })
            .catch((e: unknown) => {
              if (signingRefused(e, "mwa")) throw new SigningRefusedError(e);
              throw e;
            });
          // MWA can return null or short signatures; saving one would make the attempt unreadable.
          return oneSignature(sigs);
        }),
    };
  }
  type SupportedWallet = Wallet & {
    features: StandardConnectFeature & SolanaSignAndSendTransactionFeature;
  };
  function supported(w: Wallet): w is SupportedWallet {
    return (
      !!w.features["standard:connect"] &&
      !!w.features["solana:signAndSendTransaction"] &&
      w.chains.includes(chain)
    );
  }
  async function connectStandard(w: SupportedWallet): Promise<Connection> {
    if (!w.features["solana:signAndSendTransaction"].supportedTransactionVersions.includes(0))
      throw new Error("This wallet does not support these Solana transactions.");
    const result = await w.features["standard:connect"].connect();
    const account = result.accounts.find(
      (a) => a.chains.includes(chain) && a.features.includes("solana:signAndSendTransaction"),
    );
    if (!account) throw new Error("Choose a Solana account on this network.");
    return {
      address: account.address,
      send: async (tx, slot) => {
        const live = w.accounts.find((a) => a.address === account.address);
        if (
          !live ||
          !live.chains.includes(chain) ||
          !live.features.includes("solana:signAndSendTransaction")
        )
          throw new WalletConnectionChangedError(
            "Wallet disconnected or changed networks. Reconnect to continue.",
          );
        const results = await w.features["solana:signAndSendTransaction"]
          .signAndSendTransaction({
            account: live,
            transaction: new Uint8Array(getTransactionEncoder().encode(tx)),
            chain,
            options: { minContextSlot: Number(slot), skipPreflight: false, commitment: "confirmed" },
          })
          .catch((e: unknown) => {
            if (signingRefused(e, "standard")) throw new SigningRefusedError(e);
            throw e;
          });
        return oneSignature(results.map((r) => r.signature));
      },
    };
  }
  function wallets() {
    const panel = el("wallets");
    panel.replaceChildren();
    panel.hidden = false;
    const add = (label: string, connect: () => Promise<Connection>) => {
      const b = document.createElement("button");
      b.textContent = label;
      b.onclick = () => void connectAndQuote(connect);
      panel.append(b);
    };
    if (android) add("Seed Vault / Android wallet", connectMobile);
    for (const w of getWallets().get().filter(supported)) add(w.name, () => connectStandard(w));
    if (!panel.childElementCount)
      message("Open this page in a Solana wallet browser, or use Chrome on your Seeker.");
  }
  async function connectAndQuote(connect: () => Promise<Connection>) {
    if (busy) return;
    busy = true;
    setButton();
    try {
      connection = await connect();
      needsReconnect = false;
      el("wallets").hidden = true;
      await estimate();
    } catch (e) {
      error(e);
    } finally {
      busy = false;
      setButton();
    }
  }
  async function estimate() {
    quote = null;
    if (!connection || !loaded) return;
    message("Checking availability and costs…");
    // Reload immutable bindings and rules immediately before preparing a transaction.
    loaded = await adapter.load();
    showAvailability();
    alreadyCollected = await adapter.hasCollected(connection.address);
    if (alreadyCollected) {
      message(
        "Already collected by this wallet.",
      );
      return;
    }
    if (!loaded.remaining) {
      message("Sold out.");
      return;
    }
    const p = pending(); // throws BrokenAttemptError: collecting stays paused, the photo stays up
    if (p) {
      // Numbered mints can belong to a competing collector. Only our permanent claim
      // receipt proves success; an occupied print address must not block retries forever.
      //
      // The operation matters: `publications/rpc.ts` reads `StaleNumber`, `ExistingAsset`,
      // `OfferChanged`, `PaymentRequired` and `NotForSale` as RETRYABLE only while claiming (the
      // next attempt is a different transaction on a refreshed number or offer) and as terminal
      // otherwise. Without it an on-chain race would lock this wallet out for good. Records
      // written before `kind` existed carried a free collect.
      //
      // `checkAttempt`'s contract is that anything which is NOT "retryable" means "do not offer
      // this again", which is how every caller in the app reads it. A "pending" attempt by
      // another wallet in this browser still blocks, because it can still take the number. A
      // retryable one is superseded by the record the next send writes.
      const previous = await checkAttempt(endpoint, p, { operation: p.kind ?? "collect" });
      if (p.wallet === connection.address) {
        if (previous === "pending")
          throw new Error("A previous collection may still land. Wait a moment and check again.");
        if (previous === "confirmed")
          throw new Error(
            "Earlier transaction confirmed, but its receipt is not visible yet. Check again before paying.",
          );
        if (previous === "terminal")
          throw new Error("An earlier attempt failed and cannot be repeated.");
      } else if (previous === "pending")
        throw new Error("A previous collection may still land. Wait a moment and check again.");
    }
    const number = loaded.minted + 1;
    const claim = await adapter.claim(connection.address, number);
    const prepared = await prepareTransaction(endpoint, connection.address, [claim.instruction]);
    quote = { prepared, asset: claim.asset, number, price: claim.price };
    const total = sol(prepared.estimatedLamports);
    el("cost").textContent = claim.price
      ? `Copy ${number} · Price ${sol(claim.price.priceLamports)} SOL · Estimated total ${total} SOL`
      : `Copy ${number} · Estimated total ${total} SOL`;
    message("Ready.");
  }
  async function collect() {
    if (busy || !loaded || veil()) return;
    // Once per browser, before its first collect or buy: the terms, and Agree, which carries on.
    if (!agreed) {
      el("agreement").hidden = false;
      return;
    }
    if (!connection) {
      wallets();
      return;
    }
    busy = true;
    setButton();
    try {
      if (!quote) {
        await estimate();
        return;
      }
      const current = quote;
      quote = null;
      const height = await request<number>(endpoint, "getBlockHeight", [{ commitment: "confirmed" }]);
      if (BigInt(height) + 10n >= current.prepared.lastValidBlockHeight) {
        await estimate();
        message("Estimate refreshed. Tap again to approve.");
        return;
      }
      const p: Pending = {
        wallet: connection.address,
        asset: current.asset,
        lastValidBlockHeight: String(current.prepared.lastValidBlockHeight),
        kind: current.price ? "buy" : "collect",
      };
      writePending(p); // If storage fails, do not send an unrecoverable wallet request.
      message(current.price ? "Approve the purchase in your wallet…" : "Approve collection in your wallet…");
      try {
        p.signature = await connection.send(current.prepared.transaction, current.prepared.minContextSlot);
      } catch (e) {
        // An explicit refusal proves nothing was sent, so the record written for it goes; any
        // other outcome (closed wallet, timeout) keeps it until the chain resolves it.
        if (e instanceof SigningRefusedError) removePending();
        throw e;
      }
      writePending(p);
      receipt(p.signature);
      message("Waiting for Solana confirmation…");
      await confirmTransaction(endpoint, p.signature, current.prepared.lastValidBlockHeight);
      alreadyCollected = await adapter.hasCollected(connection.address);
      if (!alreadyCollected)
        throw new Error("Receipt returned, but collection is not yet visible. Check again.");
      loaded = await adapter.load();
      showAvailability();
      message(adapter.copy.collected(current.number, loaded.supply));
    } catch (e) {
      error(e);
    } finally {
      busy = false;
      setButton();
    }
  }
  async function share() {
    if (!loaded || !imageUrl) return;
    const url = adapter.collectUrl();
    // A real photo+QR artifact is also available to creators reopening their public link.
    const canvas = document.createElement("canvas");
    canvas.width = 1080;
    canvas.height = 1920;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Sharing is unavailable in this browser.");
    ctx.fillStyle = "#F2EFE6";
    ctx.fillRect(0, 0, 1080, 1920);
    ctx.fillStyle = "#20271F";
    ctx.font = "32px monospace";
    ctx.fillText("SIGNSHOT / PHOTO & RECORD", 70, 105);
    const img = el<HTMLImageElement>("photo");
    await img.decode();
    const scale = Math.min(940 / img.naturalWidth, 1090 / img.naturalHeight),
      w = img.naturalWidth * scale,
      h = img.naturalHeight * scale;
    ctx.drawImage(img, (1080 - w) / 2, 170 + (1090 - h) / 2, w, h);
    ctx.font = "52px sans-serif";
    ctx.fillText(loaded.title, 70, 1350, 940);
    ctx.font = "30px monospace";
    ctx.fillText(adapter.copy.card(loaded.supply), 70, 1410);
    ctx.fillText(loaded.supply === 1 ? "SCAN TO VIEW" : "SCAN TO COLLECT", 70, 1570);
    ctx.fillText("erashot.app", 70, 1630);
    const qr = qrMatrix(url),
      unit = Math.floor(340 / (qr.size + 8));
    ctx.fillStyle = "#fff";
    ctx.fillRect(670, 1480, (qr.size + 8) * unit, (qr.size + 8) * unit);
    ctx.fillStyle = "#000";
    for (let y = 0; y < qr.size; y++)
      for (let x = 0; x < qr.size; x++)
        if (qr.modules[y * qr.size + x] === "1")
          ctx.fillRect(670 + (x + 4) * unit, 1480 + (y + 4) * unit, unit, unit);
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Unable to create share image."))), "image/png"),
    );
    const file = new File([blob], "signshot-print.png", { type: "image/png" });
    if (navigator.canShare?.({ files: [file] }))
      await navigator.share({ files: [file], title: loaded.title, text: url });
    else {
      const href = URL.createObjectURL(blob),
        a = document.createElement("a");
      a.href = href;
      a.download = file.name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(href), 30000);
      message("Invitation downloaded.");
    }
  }
  el("collect").onclick = () => void collect();
  el("agree").onclick = () => {
    agreed = true;
    store(TERMS_KEY, String(TERMS_VERSION));
    el("agreement").hidden = true;
    void collect();
  };
  el("block").onclick = () => {
    if (!loaded) return;
    const next = withBlocked(blocked, loaded.creator, !blocked.has(loaded.creator));
    blocked = new Set(next);
    store(BLOCKED_KEY, JSON.stringify(next));
    showContent();
    setButton();
  };
  el("retry-load").onclick = () => void refresh();
  el("share").onclick = () => void share().catch(error);
  const viewer = el<HTMLDialogElement>("photo-viewer");
  el("view-photo").onclick = () => viewer.showModal();
  el("close-photo").onclick = () => viewer.close();
  viewer.onclick = (event) => {
    if (event.target === viewer) viewer.close();
  };
  getWallets().on("register", () => {
    if (!el("wallets").hidden) wallets();
  });
  void refresh();
}
