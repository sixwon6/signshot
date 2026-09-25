/**
 * Publishing a photograph as a Metaplex Core edition. Nothing reaches Arweave until a wallet has
 * approved and the chain has confirmed; the attempt is persisted before the wallet opens; and the
 * nonce is deterministic, so a repeated tap cannot open a second edition of one photograph.
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import { address as addressOf, getBase58Decoder } from "@solana/kit";
import {
  SeekerCamera,
  type CaptureRecord,
  type PhotoEdit,
} from "../../modules/seeker-camera";
import {
  getUploadKey,
  buildDataItem,
  uploadDataItem,
} from "../arweave";
import { canonicalize, type JcsValue } from "../jcs";
import { RPC_ENDPOINT, CLUSTER_NAME as cluster, assertEndpointCluster } from "../solana/cluster";
import type { WalletSession } from "../solana/walletSession";
import {
  prepareTransaction,
  confirmTransaction,
  arweaveBytes,
  OPERATION_FLOOR_LAMPORTS,
  type PublicationOperation,
} from "../../publications/rpc";
import { refreshedQuote } from "./quoteRefresh";
import {
  checkReviewedReceipt,
  reviewedQuoteId,
  type ReviewedAttempt,
  type ReviewedReceipt,
} from "./reviewedReceipt";
import { assertAttempt, checkAttempt, exclusive, operationInProgress } from "../../publications/lifecycle";
import { checkStorageCapacity, storageProblem } from "../../publications/storage";
import {
  MAX_PRINT_EDGE,
  account,
  addresses,
  coreView,
  hash,
  instruction,
  metadata,
  readPublication,
  setOfferInstruction,
  terms,
  utf8,
  type GenesisAccounts,
} from "../../publications/core/protocol";
import { findGenesisTokenAccount } from "../../publications/core/genesisToken";
import { normalizeDescription, readDescription } from "../../publications/core/details";
import { readSavedPhotoMetadata } from "../../publications/core/metadataDocument";
import {
  configuredProgram,
  isTrustedDeployment,
  programFeatures,
  publishingAvailability,
} from "../../publications/deployments";
import { MAX_PRICE_LAMPORTS } from "./price";
import { CORE_PROTOCOL, type CoreDraft, type CoreMetadata, type PublicationView } from "../../publications/types";
// `coordinator.ts` imports `readDraft` from here in return. Only function references cross the
// cycle and none runs at module scope.
import {
  assertFreshIntentAllowed,
  publicationInProgress,
  publicationLockKey,
} from "./coordinator";
import { assertAlbumLabel, confirmedAlbum } from "./albums";
import { safeErrorText } from "../ui/errorText";
import { attestPublication } from "../seeker/publicationAttestation";
import { publisherGenesisMint } from "../seeker/publisherGenesis";

/** ANS-104 tags are public and unhashed, so each upload carries only its media type. */
const DOCUMENT_TAGS = [{ name: "Content-Type", value: "application/json" }];
const PRINT_TAGS = [{ name: "Content-Type", value: "image/jpeg" }];

/** One photograph's saved publication intent. */
export type PublicationDraft = CoreDraft;
export type { CoreDraft } from "../../publications/types";

/** Never throws: publishing availability is a screen state, not an error path. */
export function getPrintsAvailability(): { enabled: boolean; reason?: string } {
  return publishingAvailability(cluster);
}

/** The durable draft key. */
function draftKey(r: CaptureRecord) {
  return `es.core.v1:${cluster}:${r.baseName}`;
}
const key = draftKey;
/** The one photo+network lock, shared with the transfer flow. */
const lock = (r: CaptureRecord) => publicationLockKey(cluster, r.baseName);
export const isPublicationWorking = (r: CaptureRecord) => publicationInProgress(r);

const UNTRUSTED =
  "This saved edition names a publication program this build has not reviewed. It cannot be published or checked here.";

/**
 * The reader's size limit, enforced before paying: a published edition cannot be updated or
 * re-addressed, so an oversized or unmeasurable print could never be repaired.
 */
const publishableEdge = (value: number) =>
  Number.isInteger(value) && value > 0 && value <= MAX_PRINT_EDGE;

/**
 * Which operation a draft's transaction is. It picks the estimate floor and tells `checkAttempt`
 * how to read `ExistingAsset`, which means different things per operation.
 */
const operationOf = (d: CoreDraft): PublicationOperation =>
  d.album ? "publish-in-album" : "publish";

/** Said when a price is asked of a deployment whose program has no `Offer` account. */
const NO_PRICES = "Prices are not available on this network's program yet.";
const BAD_PRICE = "Saved edition price is invalid.";

/**
 * A draft's committed price, in lamports, or `null` when it was published free.
 *
 * `null` and `0n` both mean free; they are kept apart only so a screen can say "free" for a draft
 * that was never priced and for one explicitly priced at zero without inventing a difference. Fails
 * closed on anything else, because a misread price would be shown beside a photograph as fact.
 */
export function draftPriceLamports(d: CoreDraft | null | undefined): bigint | null {
  if (!d || d.price === undefined) return null;
  return readPrice(d.price);
}

/** Digits only — the exact decimal integer `CoreDraft.price` promises — bounded by Borsh's u64. */
function readPrice(price: string): bigint {
  if (typeof price !== "string" || !/^\d{1,20}$/.test(price)) throw new Error(BAD_PRICE);
  const lamports = BigInt(price);
  if (lamports > MAX_PRICE_LAMPORTS) throw new Error(BAD_PRICE);
  return lamports;
}

/**
 * The value to store for a requested price: `undefined` for free, the decimal lamports otherwise.
 * A priced edition on a deployment that predates `set_offer` is refused here, at the one moment a
 * creator could still choose otherwise, rather than after a photograph has been measured.
 */
function priceText(program: string, priceLamports?: bigint): string | undefined {
  if (priceLamports === undefined || priceLamports === 0n) return undefined;
  if (typeof priceLamports !== "bigint" || priceLamports < 0n || priceLamports > MAX_PRICE_LAMPORTS)
    throw new Error("That price cannot be published.");
  if (!programFeatures(program).offers) throw new Error(NO_PRICES);
  return priceLamports.toString();
}

/** A pending attempt means wait; a terminal one means discard. Only discarding may pass a terminal attempt. */
const ATTEMPT_PENDING =
  "The previous publishing attempt may still land. Wait a moment, then check again.";
const ATTEMPT_TERMINAL =
  "The previous publishing attempt failed in a way that sending it again cannot fix. Discard this draft to start this photograph again.";
async function attemptStanding(d: CoreDraft) {
  return d.attempt
    ? await checkAttempt(RPC_ENDPOINT, d.attempt, { operation: operationOf(d) })
    : "retryable";
}

export async function readDraft(r: CaptureRecord): Promise<CoreDraft | null> {
  const raw = await AsyncStorage.getItem(key(r));
  if (!raw) return null;
  const d = JSON.parse(raw) as CoreDraft;
  if (
    d.version !== 1 ||
    d.protocol !== CORE_PROTOCOL ||
    !d.edition ||
    d.edition.cluster !== cluster ||
    !/^[A-Za-z0-9_-]{43}$/.test(d.metadataId)
  )
    throw new Error("Saved edition draft does not match this photo.");
  // Checked against the trusted list, not the configured default, so a rotation cannot strand it.
  if (!isTrustedDeployment(cluster, d.edition.program)) throw new Error(UNTRUSTED);
  d.edition = readSavedPhotoMetadata(d.metadata, d.edition);
  if (d.attempt) assertAttempt(d.attempt);
  terms(d.edition.title, d.edition.supply);
  // A draft edited on disk must not smuggle unbounded or bidi-reversed text onto a screen.
  readDescription(d.edition.description);
  // The album address is the binding; the name is only a renameable label.
  if (d.album !== undefined) {
    addressOf(d.album);
    assertAlbumLabel(d.albumName ?? "");
  } else if (d.albumName !== undefined)
    throw new Error("Saved edition draft does not match this photo.");
  // The price is digits only and within u64, and a non-zero one is refused outright on a deployment
  // that cannot hold an offer: `prepareSetup` would otherwise build a `set_offer` that program does
  // not implement. Read on the way in, so a hand-edited draft cannot reach a wallet.
  if (d.price !== undefined) {
    const lamports = readPrice(d.price);
    if (lamports > 0n && !programFeatures(d.edition.program).offers) throw new Error(NO_PRICES);
  }
  return d;
}
async function save(r: CaptureRecord, d: CoreDraft) {
  await AsyncStorage.setItem(key(r), JSON.stringify(d));
}

/**
 * Is anything saved under this photograph's key, readable or not? Lets a screen tell an
 * unreachable network from an unreadable draft, which only the latter can discard.
 */
export async function savedDraftPresent(r: CaptureRecord): Promise<boolean> {
  return (await AsyncStorage.getItem(key(r))) !== null;
}
/**
 * Remove this photograph's saved intent. An unreadable draft must still be discardable, so the
 * only guards are a confirmed publication and an attempt that may still land. A fresh draft
 * derives the same edition PDA, so discarding cannot open a second publication.
 */
export async function discardDraft(r: CaptureRecord) {
  return exclusive(lock(r), async () => {
    let d: CoreDraft | null = null;
    let readable = true;
    try {
      d = await readDraft(r);
    } catch {
      readable = false;
      const raw = await AsyncStorage.getItem(key(r));
      try {
        d = raw ? (JSON.parse(raw) as CoreDraft) : null;
      } catch {
        d = null; // Not even JSON. There is nothing to protect and nothing to check.
      }
    }
    if (d) {
      let signed = false;
      try {
        signed = await isSigned(d);
      } catch (error) {
        // An unreadable draft cannot be verified; `confirmedAt` and the attempt still guard it.
        if (readable) throw error;
      }
      if (d.confirmedAt || signed)
        throw new Error("This edition is already published and cannot be changed.");
      // A terminally failed attempt cannot land, so it does not block discarding.
      const standing = await attemptStanding(d);
      if (standing === "pending" || standing === "confirmed")
        throw new Error(
          "The previous publishing attempt may still land. Wait before changing this edition.",
        );
    }
    await AsyncStorage.removeItem(key(r));
    // Also remove the public derivative `createDraft` wrote at the estimate step. Best effort: a
    // file that cannot be deleted must not leave the draft undiscardable.
    const imageHash = d?.edition?.imageHash;
    if (typeof imageHash === "string" && /^[a-f0-9]{64}$/.test(imageHash))
      await SeekerCamera.deletePrintImage(r.baseName, imageHash).catch(() => undefined);
  });
}

/**
 * Forget this photograph's saved intent because the photograph is being deleted. Unlike
 * `discardDraft` it has no guards; the deletion path has already checked the state.
 */
export async function forgetPublicationDraft(r: CaptureRecord) {
  await AsyncStorage.removeItem(key(r));
}

/**
 * Does this wallet still owe a publication an upload? Asked before the upload seed is deleted: a
 * regenerated key can never reproduce data item ids already committed on chain. Fails closed:
 * unparseable drafts, read errors, and drafts on either cluster all count as unfinished.
 */
export async function walletOwesUpload(wallet: string): Promise<boolean> {
  let keys: readonly string[];
  try {
    keys = await AsyncStorage.getAllKeys();
  } catch {
    return true;
  }
  for (const draftKeyName of keys) {
    if (!draftKeyName.startsWith("es.core.v1:")) continue;
    try {
      const raw = await AsyncStorage.getItem(draftKeyName);
      if (!raw) continue;
      const d = JSON.parse(raw) as CoreDraft;
      if (d?.edition?.creator !== wallet) continue;
      if (d.confirmedAt !== undefined && d.storage === "available") continue;
      return true;
    } catch {
      return true;
    }
  }
  return false;
}

/**
 * Start, or resume, this photograph's edition. An existing draft is returned unchanged.
 *
 * The caption and album freeze here: the caption is hashed into the metadata document, and the
 * album decides which instruction the wallet approves. Changing either means `discardDraft`.
 */
export async function createDraft(
  r: CaptureRecord,
  title: string,
  count: number,
  creator: string,
  edit?: PhotoEdit,
  /** The optional caption, as typed. The document's `description`. */
  description?: string,
  /** A confirmed album of this creator's, by group address. */
  album?: string,
  /**
   * What a buyer pays for a copy, in lamports. Absent or `0n` is a free edition, published exactly
   * as it always was. A non-zero price is frozen into the draft here, like the caption and the
   * album, because it decides what the wallet approves: the publication and its `set_offer` are one
   * transaction and one approval. Changing it afterwards is `discardDraft`, or — once published —
   * `src/prints/offer.ts`, which is the only way to re-price a live edition.
   */
  priceLamports?: bigint,
): Promise<CoreDraft> {
  const reusable = await assertFreshIntentAllowed(r);
  if (reusable) return reusable;
  return exclusive(lock(r), async () => {
    const existing = await readDraft(r);
    if (existing) return existing;
    const program = configuredProgram(cluster);
    terms(title, count);
    // Validated with the terms, before the wallet, the camera or the network is touched.
    const moment = normalizeDescription(description);
    // The same gate `readDraft` applies on the way back in, so a price this deployment cannot hold
    // is refused before a photograph is measured rather than at the estimate.
    const price = priceText(program, priceLamports);
    // The program requires the album account to exist, or the approved transaction fails.
    const chosen = album ? await confirmedAlbum(album, creator) : null;
    const deployed = await account(RPC_ENDPOINT, program);
    if (!deployed?.executable)
      throw new Error("The edition program is not deployed on this network.");
    // Started here so the mainnet lookup runs beside the hashing and the print below. It never
    // rejects; the answer is read where the document is composed.
    const genesis = publisherGenesisMint(creator);
    const frames = await SeekerCamera.hashCaptureFrames(r.baseName);
    if (
      frames.clean !== r.clean.sha256 ||
      frames.styled !== r.styled.sha256 ||
      (edit && edit.sourceHash !== r.clean.sha256)
    )
      throw new Error("Original photo fingerprint changed.");
    const signer = await getUploadKey(creator);
    // A public, deterministic nonce prevents repeated taps from creating duplicate runs.
    const nonce = hash(
      signer.sign(
        utf8(`erashot-core/1\n${cluster}\n${r.baseName}\n${r.clean.sha256}`),
      ),
    );
    const keys = await addresses(program, creator, nonce);
    const sourceHash = edit?.sha256 ?? r.styled.sha256;
    const image = await SeekerCamera.preparePrintImage(
      r.baseName,
      edit?.uri ?? r.styledUri,
      sourceHash,
    );
    // Before anything is hashed, uploaded or signed. See `publishableEdge`.
    if (!publishableEdge(image.width) || !publishableEdge(image.height))
      throw new Error(
        "The published copy of this photo could not be measured. Try publishing it again.",
      );
    const bytes = new Uint8Array(
      await (await fetch(`file://${image.path}`)).arrayBuffer(),
    );
    if (hash(bytes) !== image.sha256)
      throw new Error("Published image fingerprint mismatch.");
    const item = buildDataItem({ data: bytes, tags: PRINT_TAGS, signer });
    const e: CoreMetadata = {
      cluster,
      program,
      edition: keys.edition,
      collection: keys.collection,
      creator,
      nonce,
      title,
      supply: count,
      image: `https://arweave.net/${item.id}`,
      imageHash: image.sha256,
      width: image.width,
      height: image.height,
      description: moment,
    };
    // The publishing wallet's Seeker Genesis Token, by mint address (`seedshot-genesis/1`). Its
    // own evidence, independent of the attestation below: every reader checks it against mainnet.
    // `undefined`: mainnet could not be asked, so the document names none and the review says so.
    const genesisMint = await genesis;
    if (genesisMint) e.genesisMint = genesisMint;
    // The phone's keystore attests this exact publication (the manifest names the edition, the
    // creator, the nonce and the image fingerprint) before the document is sealed, so the
    // evidence is inside the bytes the wallet commits to. A phone that cannot attest publishes
    // the plain document; that is a state, not a failure.
    const attested = await attestPublication(e, r, {
      sourceHash,
      width: image.width,
      height: image.height,
    });
    if (attested.status === "attested") e.attestation = attested.attestation.summary;
    else console.warn(`publication attestation unavailable: ${attested.reason}`);
    // The attested document, or the plain one if building it fails for any reason (an oversized
    // data item, a reader that refuses the bundle): evidence must never make a photograph
    // unpublishable. Note the attested document is NOT byte-identical across retries (a fresh
    // key each time); the deterministic nonce and the photo lock are what prevent a second edition.
    let json: string, meta: ReturnType<typeof buildDataItem>;
    try {
      if (attested.status !== "attested") throw new Error("plain");
      json = canonicalize(metadata(e, attested.attestation.bundle) as unknown as JcsValue);
      meta = buildDataItem({ data: utf8(json), tags: DOCUMENT_TAGS, signer });
    } catch (error) {
      if (attested.status === "attested")
        console.warn(`publishing without attestation: ${error instanceof Error ? error.message : String(error)}`);
      delete e.attestation;
      json = canonicalize(metadata(e) as unknown as JcsValue);
      meta = buildDataItem({ data: utf8(json), tags: DOCUMENT_TAGS, signer });
    }
    const d: CoreDraft = {
      version: 1,
      protocol: CORE_PROTOCOL,
      edition: e,
      metadata: json,
      metadataId: meta.id,
      imagePath: image.path,
      sourceHash,
      ...(chosen ? { album: chosen.address, albumName: chosen.name } : {}),
      ...(genesisMint === undefined ? { genesisUnchecked: true as const } : {}),
      // Absent for a free edition, so a draft written before prices existed and one published free
      // afterwards are the same record.
      ...(price ? { price } : {}),
      storage: "local",
    };
    await save(r, d);
    return d;
  });
}
async function publicationItems(d: CoreDraft) {
  const signer = await getUploadKey(d.edition.creator),
    bytes = new Uint8Array(
      await (await fetch(`file://${d.imagePath}`)).arrayBuffer(),
    );
  if (hash(bytes) !== d.edition.imageHash)
    throw new Error("Saved published image changed.");
  const img = buildDataItem({ data: bytes, tags: PRINT_TAGS, signer }),
    meta = buildDataItem({
      data: utf8(d.metadata),
      tags: DOCUMENT_TAGS,
      signer,
    });
  if (img.id !== d.edition.image.split("/").pop() || meta.id !== d.metadataId)
    throw new Error("Saved publication identifiers changed.");
  return { signer, img, meta };
}
async function checkStorage(d: CoreDraft) {
  const { signer, img, meta } = await publicationItems(d);
  return checkStorageCapacity(signer.ownerBase58, [img, meta]);
}
async function publish(d: CoreDraft) {
  const { img, meta } = await publicationItems(d);
  await Promise.all([
    uploadDataItem(img.bytes, img.id),
    uploadDataItem(meta.bytes, meta.id),
  ]);
  await Promise.all([
    arweaveBytes(img.id, d.edition.imageHash),
    arweaveBytes(meta.id, hash(utf8(d.metadata))),
  ]);
}

/**
 * Permanent publication evidence, checked against this draft without requiring the uploads or a
 * live print. `false` means no edition account yet; an account that disagrees throws, since
 * "not published" would offer to publish a second time.
 */
export async function isSigned(d: CoreDraft) {
  const e = d.edition;
  if (e.cluster !== cluster || !isTrustedDeployment(cluster, e.program))
    throw new Error(UNTRUSTED);
  const publication = await readPublication(RPC_ENDPOINT, e.program, e.edition);
  if (!publication) return false;
  const s = publication.state;
  const keys = publication.keys;
  if (
    keys.edition !== e.edition || keys.collection !== e.collection ||
    s.metadataHash !== hash(utf8(d.metadata)) ||
    s.imageHash !== e.imageHash ||
    s.creator !== e.creator ||
    s.supply !== e.supply || s.collection !== e.collection ||
    s.nonce !== e.nonce || s.title !== e.title ||
    s.uri !== `https://arweave.net/${d.metadataId}` ||
    // The album is not in the hashed document; this is its only check against chain evidence.
    (publication.album?.group ?? undefined) !== d.album ||
    // The program seals only what the document names. A seal is optional; a different one is not.
    (publication.sealedGenesis !== null && publication.sealedGenesis !== e.genesisMint)
  )
    throw new Error("The onchain edition differs from this draft.");
  // A chain fact, re-read here every time and never taken from the saved draft.
  if (publication.sealedGenesis) e.genesisSealed = true;
  else delete e.genesisSealed;
  return true;
}

export interface PublicationState {
  status: "local" | "checking" | "draft" | "pending" | "published" | "unavailable";
  draft: CoreDraft | null;
  /** Present whenever a draft could be read AND its addresses round trip. */
  view?: PublicationView;
  reason?: string;
}

/** Local files and validated saved intent only. Never wait for RPC to open a photograph. */
export async function getSavedPublicationState(r: CaptureRecord): Promise<PublicationState> {
  let draft: CoreDraft | null = null;
  try {
    draft = await readDraft(r);
    if (!draft) return { status: "local", draft: null };
    return { status: "checking", draft, view: await coreView(draft) };
  } catch (error) {
    return { status: "unavailable", draft, reason: safeErrorText(error) };
  }
}

/** The photograph's publication state. */
export async function getPublicationState(r: CaptureRecord): Promise<PublicationState> {
  let d: CoreDraft | null = null;
  let view: PublicationView | undefined;
  try {
    d = await readDraft(r);
    if (!d) return { status: "local", draft: null };
    // These are validated local details, not proof of current chain state. Retain them
    // if the later network check fails, but never derive them from a rejected draft.
    view = await coreView(d);
    if (await isSigned(d)) {
      // A status refresh may overlap the upload finishing. Never write its older
      // snapshot over a pending attempt or newly verified storage availability.
      if (!d.confirmedAt && !operationInProgress(lock(r))) {
        const metadataId = d.metadataId;
        await exclusive(lock(r), async () => {
          const latest = await readDraft(r);
          if (latest?.metadataId === metadataId) {
            latest.confirmedAt ??= Date.now();
            await save(r, latest);
            // What `isSigned` just read off the chain, carried onto the re-read draft.
            if (d!.edition.genesisSealed) latest.edition.genesisSealed = true;
            d = latest;
          }
        });
      }
      return { status: "published", draft: d, view };
    }
    if (d.confirmedAt)
      return { status: "unavailable", draft: d, view, reason: "The previously confirmed record is not visible on this connection. Check again before taking another action." };
    const standing = await attemptStanding(d);
    if (standing === "pending" || standing === "confirmed")
      return { status: "pending", draft: d, view };
    // A terminal failure is a draft with a reason, so the discard path stays open.
    if (standing === "terminal")
      return { status: "draft", draft: d, view, reason: ATTEMPT_TERMINAL };
    return { status: "draft", draft: d, view };
  } catch (error) {
    return { status: "unavailable", draft: d, view, reason: safeErrorText(error) };
  }
}

async function assertCurrent(r: CaptureRecord, d: CoreDraft) {
  const current = await readDraft(r);
  if (!current || current.metadataId !== d.metadataId || current.metadata !== d.metadata ||
    // The album selects the instruction, so a stale copy would approve a different transaction.
    current.album !== d.album ||
    // So does the price: it decides whether `set_offer` is in the message at all, and for how much.
    current.price !== d.price)
    throw new Error("This photo's publication changed. Close and reopen it before continuing.");
  readSavedPhotoMetadata(d.metadata, d.edition);
  // The durable attempt always wins over a stale screen instance.
  d.attempt = current.attempt;
  d.confirmedAt = current.confirmedAt;
  d.storage = current.storage;
  d.storageError = current.storageError;
}
export async function prepareSetup(r: CaptureRecord, d: CoreDraft,
  onProgress?: (stage: "network" | "publication" | "previous" | "storage" | "estimate") => void) {
  // Estimates and confirmations must be read from the chain the wallet will broadcast to.
  onProgress?.("network");
  await assertEndpointCluster();
  await assertCurrent(r, d);
  onProgress?.("publication");
  if (await isSigned(d)) return { step: "ready" } as const;
  if (d.confirmedAt) throw new Error("The previously confirmed record cannot be checked on this connection. Try again later.");
  if (!isTrustedDeployment(cluster, d.edition.program)) throw new Error(UNTRUSTED);
  {
    onProgress?.("previous");
    const standing = await attemptStanding(d);
    if (standing === "terminal") throw new Error(ATTEMPT_TERMINAL);
    if (standing !== "retryable") throw new Error(ATTEMPT_PENDING);
  }
  // Checked before the estimate, so a doomed `publish_in_album` never reaches a wallet prompt.
  if (d.album) await confirmedAlbum(d.album, d.edition.creator);
  // Quote only. Public upload begins only after an approved, confirmed transaction.
  onProgress?.("storage");
  await checkStorage(d);
  const ix = await instruction(
    d.edition,
    d.edition.creator,
    1,
    `https://arweave.net/${d.metadataId}`,
    hash(utf8(d.metadata)),
    // Absent for a plain publication; present turns the same arguments into `publish_in_album`.
    d.album,
    await genesisAccounts(d.edition),
  );
  /**
   * PUBLISHING WITH A PRICE IS ONE APPROVAL, NOT TWO.
   *
   * `set_offer` is appended to the SAME transaction as the publication. Two transactions would mean
   * two wallet prompts and, worse, a window in which the edition exists and is free to collect
   * while the creator is still approving its price. In one transaction the offer either lands with
   * the publication or neither does. The order matters: `set_offer` reads the Edition account
   * (`has_one = creator`, and its seeds) and that account is created by the instruction before it.
   *
   * `isSigned` is deliberately unaffected — it asks whether the PUBLICATION happened, and the offer
   * is not publication evidence. An edition whose price failed to stick is a published edition
   * with no price, re-priceable from `src/prints/offer.ts`, never an unpublished one.
   */
  const price = draftPriceLamports(d);
  const ixs = price && price > 0n
    ? [ix, await setOfferInstruction(d.edition, price)]
    : [ix];
  // Both floors, because both accounts get created: the publication's, plus rent for the 85-byte
  // `Offer`. Advisory either way — pre-funded PDAs can legitimately make a publish cost less.
  const floor =
    OPERATION_FLOOR_LAMPORTS[operationOf(d)] +
    (ixs.length > 1 ? OPERATION_FLOOR_LAMPORTS["set-offer"] : 0n);
  onProgress?.("estimate");
  return {
    step: "sign",
    metadataId: d.metadataId,
    // Carried so the approval can rebuild the same transaction on a fresh blockhash.
    instructions: ixs,
    prepared: await prepareTransaction(RPC_ENDPOINT, d.edition.creator, ixs, [], floor),
  } as const;
}
/**
 * The Genesis Token accounts `publish` verifies and seals: the mint the document names and the
 * creator's token account for it, read from THIS cluster immediately before the quote. The token
 * exists on mainnet only, so a devnet edition publishes with the document's claim alone (every
 * reader checks that against mainnet) and the seal is exercised by the acceptance harness
 * against its stand-in. Refused, not dropped, when the wallet no longer holds the token: the
 * sealed document already names it, and the program would refuse the transaction anyway.
 */
async function genesisAccounts(e: CoreMetadata): Promise<GenesisAccounts | undefined> {
  if (!e.genesisMint || cluster !== "mainnet-beta" || !programFeatures(e.program).genesis)
    return undefined;
  const token = await findGenesisTokenAccount(RPC_ENDPOINT, e.genesisMint, e.creator);
  if (!token)
    throw new Error(
      "This wallet no longer holds the Genesis Token this edition names. Discard the draft and publish again.",
    );
  return { mint: e.genesisMint, token };
}

type PublicationQuote = Awaited<ReturnType<typeof prepareSetup>>;
type PublishProgress = "wallet" | "confirming" | "uploading";
async function uploadConfirmed(r: CaptureRecord, d: CoreDraft) {
  if (d.storage === "available") return;
  d.storage = "pending";
  delete d.storageError;
  await save(r, d);
  try {
    await checkStorage(d);
    await publish(d);
  } catch (error) {
    d.storageError = storageProblem(error);
    await save(r, d);
    throw new Error(d.storageError.message);
  }
  d.storage = "available";
  await save(r, d);
}
export async function retryPublicationStorage(r: CaptureRecord, d: CoreDraft) {
  return exclusive(lock(r), async () => {
    await assertCurrent(r, d);
    if (!await isSigned(d)) throw new Error("Confirm the wallet record before publishing its image.");
    d.confirmedAt ??= Date.now();
    await save(r, d);
    await uploadConfirmed(r, d);
  });
}
/**
 * Approve, confirm, check the receipt, upload. Returns the receipt verdict: paths that open no
 * wallet (already signed, resumed upload) answer `unchecked`.
 */
export async function sendSetup(
  r: CaptureRecord,
  d: CoreDraft,
  session: WalletSession,
  quote: PublicationQuote,
  onProgress?: (stage: PublishProgress) => void,
): Promise<ReviewedReceipt> {
  return exclusive(lock(r), async () => {
    await assertCurrent(r, d);
    if (await isSigned(d)) {
      d.confirmedAt ??= Date.now();
      await save(r, d);
      onProgress?.("uploading");
      await uploadConfirmed(r, d);
      return "unchecked";
    }
    if (quote.step === "ready" || quote.metadataId !== d.metadataId)
      throw new Error("The publication review changed. Refresh before approving.");
    if (!isTrustedDeployment(cluster, d.edition.program)) throw new Error(UNTRUSTED);
    {
      const standing = await attemptStanding(d);
      if (standing === "terminal") throw new Error(ATTEMPT_TERMINAL);
      if (standing !== "retryable")
        throw new Error("A publishing attempt may still land. Check its status before retrying.");
    }
    if (d.confirmedAt) throw new Error("The previously confirmed record cannot be checked on this connection. Try again later.");
    await checkStorage(d);
    onProgress?.("wallet");
    await session.connectAnd(async (wallet) => {
      const owner = await session.authorizeSession(wallet);
      if (owner.address !== d.edition.creator)
        throw new Error("Use the wallet chosen for this edition.");
      // The wallet's approval sheet can outlast a blockhash, so only the lifetime is refreshed;
      // any other change to the compiled message still refuses.
      const prepared = await refreshedQuote(
        RPC_ENDPOINT,
        d.edition.creator,
        quote.instructions,
        quote.prepared,
        "Estimate expired. Refresh before publishing.",
      );
      // The refreshed lifetime and the message fingerprint are persisted before the wallet
      // opens, so a lost receipt is reconciled and the later check is against what was reviewed.
      const attempt: ReviewedAttempt = {
        lastValidBlockHeight: String(prepared.lastValidBlockHeight),
        quoteId: reviewedQuoteId(prepared.transaction.messageBytes),
      };
      d.attempt = attempt;
      await save(r, d);
      const sigs = await wallet.signAndSendTransactions({
        transactions: [prepared.transaction],
        minContextSlot: Number(prepared.minContextSlot),
        skipPreflight: false,
      });
      // MWA can return null or short signatures; saving one would make the attempt unreadable.
      if (sigs.length !== 1 || sigs[0].length !== 64)
        throw new Error("No wallet receipt. Check before retrying.");
      d.attempt.signature = getBase58Decoder().decode(sigs[0]);
      await save(r, d);
    });
    if (!d.attempt?.signature)
      throw new Error("No wallet receipt. Check before retrying.");
    onProgress?.("confirming");
    await confirmTransaction(
      RPC_ENDPOINT,
      d.attempt.signature,
      BigInt(d.attempt.lastValidBlockHeight),
    );
    // `isSigned` checks the resulting accounts, not the other instructions in the message, so the
    // transaction is compared with the reviewed fingerprint. A mismatch is reported, not thrown:
    // the publication is already paid for and its upload must still follow.
    const receipt = await checkReviewedReceipt(
      RPC_ENDPOINT,
      d.attempt.signature,
      (d.attempt as ReviewedAttempt).quoteId,
    );
    if (!(await isSigned(d)))
      throw new Error("Edition confirmation is still pending. Check again.");
    d.confirmedAt = Date.now();
    await save(r, d);
    onProgress?.("uploading");
    await uploadConfirmed(r, d);
    return receipt;
  });
}
