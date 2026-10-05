/**
 * Publishing a photograph as a numbered edition on Metaplex's Core Candy Machine
 * (`publications/candy`). The draft holds the document, its Arweave ids (so the URI is known before
 * publishing) and this phone's three keypairs (collection, candy machine, copy 1). Publishing is two
 * transactions signed by the wallet in one request, sent in order; both signed transactions are kept
 * on the draft so "Continue" re-sends them, or re-signs the second with the same keypairs once their
 * blockhash has expired. Nothing reaches Arweave until both have confirmed.
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import { address } from "@solana/kit";
import {
  SeekerCamera,
  type CaptureRecord,
  type PhotoEdit,
} from "../../modules/seeker-camera";
import { getUploadKey, buildDataItem, uploadDataItem } from "../arweave";
import { canonicalize, type JcsValue } from "../jcs";
import { RPC_ENDPOINT, CLUSTER_NAME as cluster, assertEndpointCluster } from "../solana/cluster";
import type { WalletSession } from "../solana/walletSession";
import { NEEDS_SOL, FEE_ALLOWANCE_LAMPORTS } from "../../publications/rpc";
import {
  checkStorageCapacity,
  paidStorage,
  quoteStoragePayment,
  settleStoragePayment,
  storagePaymentInstructions,
  storageProblem,
  storageTopUpOffered,
  storageTopUpPending,
  type StoragePayment,
} from "../../publications/storage";
import { collectUrl, explorerUrl, hash, metadata, MAX_PRINT_EDGE, terms, utf8 } from "../../publications/core/document";
import { normalizeDescription, readDescription } from "../../publications/core/details";
import { readSavedPhotoMetadata, sealedEvidence } from "../../publications/core/metadataDocument";
import { checkDevice, GOOGLE_STATUS_URL, readRevocationList } from "../../publications/core/attestationCheck";
import { checkPriceMinimum, MAX_PRICE_LAMPORTS, minimumPriceLamports } from "./price";
import {
  CORE_PROTOCOL,
  DEFAULT_ROYALTY_BPS,
  MAX_ROYALTY_BPS,
  type CoreDraft,
  type CoreMetadata,
  type PublicationView,
} from "../../publications/types";
import {
  CORE_CREATE_FEE,
  SIGNATURE_FEE,
  checkTerms,
  copyBytes,
  editionGuards,
  publishTransactions,
  type EditionTerms,
  type Price,
} from "../../publications/candy/edition";
import {
  CANDY_GUARD_HEADER,
  CANDY_MACHINE_HIDDEN_BYTES,
  CANDY_MACHINE_PROGRAM,
  TOKEN_ACCOUNT_BYTES,
  TOKEN_PROGRAM,
  associatedTokenAddress,
  decodeCandyMachine,
} from "../../publications/candy/programs";
import { loadPriceToken } from "./priceToken";
import { encodeGuardData } from "../../publications/candy/guards";
import type { Budget, Draft } from "../../publications/candy/transactions";
import { fetchAccount } from "../../publications/editions";
// `coordinator.ts` imports `readDraft` from here in return. Only function references cross the
// cycle and none runs at module scope.
import { assertFreshIntentAllowed, publicationInProgress, publicationLockKey } from "./coordinator";
import { exclusive, operationInProgress } from "./locks";
import { safeErrorText } from "../ui/errorText";
import { attestPublication } from "../seeker/publicationAttestation";
import {
  attestationExpiring,
  type AttestationBundle,
  type AttestationSummary,
  type DeviceVerdict,
} from "../../publications/core/attestation";
import { publisherGenesisMint } from "../seeker/publisherGenesis";
import { cosignerKey } from "../seeker/cosigner";
import {
  balance,
  fromWire,
  isSeed,
  latestLifetime,
  lifetimeLive,
  newSeed,
  prepareDraft,
  priorityLamports,
  rent,
  seedAddress,
  seedSigner,
  sendAndConfirm,
  signWithWallet,
  signatureOf,
  signatureStanding,
  toWire,
  withLifetime,
  TransactionFailure,
} from "./send";

/** ANS-104 tags are public and unhashed, so each upload carries only its media type. */
const DOCUMENT_TAGS = [{ name: "Content-Type", value: "application/json" }];
const PRINT_TAGS = [{ name: "Content-Type", value: "image/jpeg" }];

/** One photograph's saved publication intent. */
export type PublicationDraft = CoreDraft;
export type { CoreDraft } from "../../publications/types";

/** Publishing goes through Metaplex's deployed programs, so it is available on every cluster. */
export function getPrintsAvailability(): { enabled: boolean; reason?: string } {
  return { enabled: true };
}

/** The durable draft key. */
const key = (r: CaptureRecord) => `es.candy.v1:${cluster}:${r.baseName}`;
/** The one photo+network lock, shared with the transfer flow. */
const lock = (r: CaptureRecord) => publicationLockKey(cluster, r.baseName);
export const isPublicationWorking = (r: CaptureRecord) => publicationInProgress(r);

const publishableEdge = (value: number) => Number.isInteger(value) && value > 0 && value <= MAX_PRINT_EDGE;
const BAD_DRAFT = "Saved edition draft does not match this photo.";

/** Is "Seeker holders only" offered: a co-signer is configured and answers. */
export async function seekerOnlyAvailable(): Promise<boolean> {
  return (await cosignerKey()) !== null;
}

/** A draft's price as the client reads it. */
export function draftPrice(d: CoreDraft): Price {
  if (d.tokenPrice)
    return { kind: "token", mint: address(d.tokenPrice.mint), amount: BigInt(d.tokenPrice.amount), tokenProgram: TOKEN_PROGRAM };
  const lamports = d.price ? BigInt(d.price) : 0n;
  return lamports > 0n ? { kind: "sol", lamports } : { kind: "free" };
}

export async function readDraft(r: CaptureRecord): Promise<CoreDraft | null> {
  const raw = await AsyncStorage.getItem(key(r));
  if (!raw) return null;
  const d = JSON.parse(raw) as CoreDraft;
  if (
    d.version !== 2 || d.protocol !== CORE_PROTOCOL || !d.edition || d.edition.cluster !== cluster ||
    d.edition.program !== CANDY_MACHINE_PROGRAM || !/^[A-Za-z0-9_-]{43}$/.test(d.metadataId) ||
    !d.seeds || !isSeed(d.seeds.collection) || !isSeed(d.seeds.candyMachine) || !isSeed(d.seeds.copy) ||
    seedAddress(d.seeds.candyMachine) !== d.edition.edition || seedAddress(d.seeds.collection) !== d.edition.collection
  )
    throw new Error(BAD_DRAFT);
  d.edition = readSavedPhotoMetadata(d.metadata, d.edition);
  terms(d.edition.title, d.edition.supply);
  readDescription(d.edition.description);
  if (d.price !== undefined && (!/^\d{1,20}$/.test(d.price) || BigInt(d.price) > MAX_PRICE_LAMPORTS)) throw new Error(BAD_DRAFT);
  if (d.tokenPrice !== undefined) {
    address(d.tokenPrice.mint);
    if (!/^\d{1,20}$/.test(d.tokenPrice.amount)) throw new Error(BAD_DRAFT);
  }
  if (!Number.isInteger(d.royaltyBps) || d.royaltyBps < 0 || d.royaltyBps > MAX_ROYALTY_BPS || typeof d.seekerOnly !== "boolean")
    throw new Error(BAD_DRAFT);
  if (d.seekerOnly) address(d.cosigner ?? "");
  if (d.signed !== undefined && (typeof d.signed.first !== "string" || typeof d.signed.second !== "string" ||
    !/^\d+$/.test(d.signed.lastValidBlockHeight)))
    throw new Error(BAD_DRAFT);
  if (d.storageFunding !== undefined && d.storageFunding !== "credit" && d.storageFunding !== "free") throw new Error(BAD_DRAFT);
  if (d.storageTopUp !== undefined) {
    const t = d.storageTopUp;
    if (!/^\d+$/.test(t.lastValidBlockHeight) || (t.signature && !/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(t.signature)) ||
      !/^\d{1,20}$/.test(t.lamports))
      throw new Error(BAD_DRAFT);
  }
  return d;
}
async function save(r: CaptureRecord, d: CoreDraft) {
  await AsyncStorage.setItem(key(r), JSON.stringify(d));
}

export async function savedDraftPresent(r: CaptureRecord): Promise<boolean> {
  return (await AsyncStorage.getItem(key(r))) !== null;
}

// ---------------------------------------------------------------------------------------------
// Where the publication stands on chain
// ---------------------------------------------------------------------------------------------

type Stage = "none" | "half" | "published";

/**
 * "none": the candy machine does not exist (transaction 1 has not landed). "half": it exists with
 * no copy minted (transaction 2 has not landed). "published": copy 1 exists, which only
 * transaction 2 does, atomically with locking the edition. Closing the sale later keeps it published.
 */
async function chainStage(d: CoreDraft): Promise<Stage> {
  const machine = await fetchAccount(RPC_ENDPOINT, d.edition.edition);
  if (!machine) return "none";
  let decoded;
  try {
    if (machine.owner !== CANDY_MACHINE_PROGRAM) throw new Error();
    decoded = decodeCandyMachine(machine.bytes);
  } catch {
    throw new Error("The account at this edition's address is not its candy machine.");
  }
  if (decoded.collection !== d.edition.collection || decoded.data.hidden.uri !== `https://arweave.net/${d.metadataId}`)
    throw new Error("The onchain edition differs from this draft.");
  return decoded.itemsRedeemed >= 1n ? "published" : "half";
}

/** Is this draft's edition published (copy 1 minted)? */
export async function isSigned(d: CoreDraft) {
  return (await chainStage(d)) === "published";
}

const signedLive = async (d: CoreDraft) =>
  !!d.signed && (await lifetimeLive(BigInt(d.signed.lastValidBlockHeight), 0n));

/**
 * Remove this photograph's saved intent. Refused once anything has landed, and while saved signed
 * transactions can still land.
 */
export async function discardDraft(r: CaptureRecord) {
  return exclusive(lock(r), async () => {
    let d: CoreDraft | null = null;
    let readable = true;
    try {
      d = await readDraft(r);
    } catch {
      readable = false;
      try {
        d = JSON.parse((await AsyncStorage.getItem(key(r))) ?? "null") as CoreDraft | null;
      } catch {
        d = null;
      }
    }
    if (d && readable) {
      if (d.confirmedAt || (await chainStage(d)) !== "none")
        throw new Error("This edition is already on Solana and cannot be changed.");
      if (await signedLive(d))
        throw new Error("The signed publication may still land. Wait a minute before changing this edition.");
    }
    await AsyncStorage.removeItem(key(r));
    const imageHash = d?.edition?.imageHash;
    if (typeof imageHash === "string" && /^[a-f0-9]{64}$/.test(imageHash))
      await SeekerCamera.deletePrintImage(r.baseName, imageHash).catch(() => undefined);
  });
}

/** Forget this photograph's saved intent (the photograph is being deleted). */
export async function forgetPublicationDraft(r: CaptureRecord) {
  await AsyncStorage.removeItem(key(r));
}

/**
 * Does this wallet still owe a publication an upload? Asked before the upload key is deleted.
 * Fails closed.
 */
export async function walletOwesUpload(wallet: string): Promise<boolean> {
  let keys: readonly string[];
  try {
    keys = await AsyncStorage.getAllKeys();
  } catch {
    return true;
  }
  for (const name of keys) {
    if (!name.startsWith("es.candy.v1:")) continue;
    try {
      const raw = await AsyncStorage.getItem(name);
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

// ---------------------------------------------------------------------------------------------
// Making a draft
// ---------------------------------------------------------------------------------------------

/**
 * Start, or resume, this photograph's edition. An existing draft is returned unchanged. The title,
 * caption, copies, price, royalty and Seeker-only setting freeze here; changing them is `discardDraft`.
 */
export async function createDraft(
  r: CaptureRecord,
  title: string,
  count: number,
  creator: string,
  edit?: PhotoEdit,
  description?: string,
  /** The price of a copy (SOL or this build's price token); absent or free is free. */
  priceOfCopy?: Price,
  sealed?: { royaltyBps: number; seekerOnly: boolean },
): Promise<CoreDraft> {
  const reusable = await assertFreshIntentAllowed(r);
  if (reusable) return reusable;
  return exclusive(lock(r), async () => {
    const existing = await readDraft(r);
    if (existing) return existing;
    terms(title, count);
    const moment = normalizeDescription(description);
    const royaltyBps = sealed?.royaltyBps ?? DEFAULT_ROYALTY_BPS;
    if (!Number.isInteger(royaltyBps) || royaltyBps < 0 || royaltyBps > MAX_ROYALTY_BPS)
      throw new Error("Use a royalty from 0% to 10%.");
    let price: string | undefined;
    let tokenPrice: CoreDraft["tokenPrice"];
    if (priceOfCopy?.kind === "sol") {
      if (priceOfCopy.lamports > MAX_PRICE_LAMPORTS) throw new Error("That price cannot be published.");
      checkPriceMinimum(priceOfCopy.lamports, await minimumPriceLamports(RPC_ENDPOINT));
      price = priceOfCopy.lamports.toString();
    } else if (priceOfCopy?.kind === "token") {
      const token = await loadPriceToken();
      if (!token || priceOfCopy.mint !== token.mint) throw new Error("SKR prices are not available on this network.");
      if (!(priceOfCopy.amount > 0n) || priceOfCopy.amount > MAX_PRICE_LAMPORTS) throw new Error("That price cannot be published.");
      tokenPrice = { mint: priceOfCopy.mint, amount: priceOfCopy.amount.toString() };
    }
    const cosigner = sealed?.seekerOnly && count > 1 ? await cosignerKey() : null;
    if (sealed?.seekerOnly && count > 1 && !cosigner)
      throw new Error("The Seeker co-signer cannot be reached. Try again, or turn off Seeker holders only.");
    // Started here so the mainnet lookup runs beside the hashing and the print below.
    const genesis = publisherGenesisMint(creator);
    const frames = await SeekerCamera.hashCaptureFrames(r.baseName);
    if (frames.clean !== r.clean.sha256 || frames.styled !== r.styled.sha256 || (edit && edit.sourceHash !== r.clean.sha256))
      throw new Error("Original photo fingerprint changed.");
    const signer = await getUploadKey(creator);
    const nonce = hash(signer.sign(utf8(`erashot-core/1\n${cluster}\n${r.baseName}\n${r.clean.sha256}`)));
    const seeds = { collection: newSeed(), candyMachine: newSeed(), copy: newSeed() };
    const sourceHash = edit?.sha256 ?? r.styled.sha256;
    const image = await SeekerCamera.preparePrintImage(r.baseName, edit?.uri ?? r.styledUri, sourceHash);
    if (!publishableEdge(image.width) || !publishableEdge(image.height))
      throw new Error("The published copy of this photo could not be measured. Try publishing it again.");
    const bytes = new Uint8Array(await (await fetch(`file://${image.path}`)).arrayBuffer());
    if (hash(bytes) !== image.sha256) throw new Error("Published image fingerprint mismatch.");
    const item = buildDataItem({ data: bytes, tags: PRINT_TAGS, signer });
    const e: CoreMetadata = {
      cluster,
      program: CANDY_MACHINE_PROGRAM,
      edition: seedAddress(seeds.candyMachine),
      collection: seedAddress(seeds.collection),
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
    const genesisMint = await genesis;
    if (genesisMint) e.genesisMint = genesisMint;
    const { json, meta } = await sealDocument(e, r, sourceHash, signer);
    const d: CoreDraft = {
      version: 2,
      protocol: CORE_PROTOCOL,
      edition: e,
      metadata: json,
      metadataId: meta.id,
      imagePath: image.path,
      sourceHash,
      ...(genesisMint === undefined ? { genesisUnchecked: true as const } : {}),
      ...(price ? { price } : {}),
      ...(tokenPrice ? { tokenPrice } : {}),
      royaltyBps,
      // Seeker-only needs the co-signer, which checks each collector's Genesis Token; the publisher need not hold one.
      seekerOnly: !!cosigner,
      ...(cosigner ? { cosigner } : {}),
      seeds,
      storage: "local",
    };
    // The client's own checks on the on-chain terms, before anything is saved.
    checkTerms(await editionTerms(d));
    await save(r, d);
    return d;
  });
}

/**
 * The metadata document for `e`, with `e.attestation` set to match it. A phone that cannot attest
 * gets the plain document.
 */
async function sealDocument(
  e: CoreMetadata,
  r: CaptureRecord,
  sourceHash: string,
  signer: Awaited<ReturnType<typeof getUploadKey>>,
) {
  const attested = await attestPublication(e, r, { sourceHash, width: e.width, height: e.height });
  if (attested.status === "attested") e.attestation = attested.attestation.summary;
  else {
    delete e.attestation;
    console.warn(`publication attestation unavailable: ${attested.reason}`);
  }
  let json: string, meta: ReturnType<typeof buildDataItem>;
  try {
    if (attested.status !== "attested") throw new Error("plain");
    json = canonicalize(metadata(e, attested.attestation.bundle, await sealVerdict(attested.attestation.summary)) as unknown as JcsValue);
    meta = buildDataItem({ data: utf8(json), tags: DOCUMENT_TAGS, signer });
  } catch (error) {
    if (attested.status === "attested")
      console.warn(`publishing without attestation: ${error instanceof Error ? error.message : String(error)}`);
    delete e.attestation;
    json = canonicalize(metadata(e) as unknown as JcsValue);
    meta = buildDataItem({ data: utf8(json), tags: DOCUMENT_TAGS, signer });
  }
  return { json, meta };
}

function sealVerdict(summary: AttestationSummary): Promise<DeviceVerdict> {
  return checkDevice(summary, {
    revocationList: () => readRevocationList(GOOGLE_STATUS_URL),
    publishedAt: async () => new Date(),
  }).catch((): DeviceVerdict => ({ status: "unchecked" }));
}

/**
 * Before the document goes on chain it must be what `metadata()` writes today, and may name the
 * device only while the verdict still passes. Only for a draft nothing has been signed for.
 */
async function resealDocument(r: CaptureRecord, d: CoreDraft) {
  const sealed = sealedEvidence(d.metadata);
  const summary = d.edition.attestation;
  const withdraw = sealed.namesDevice && (!summary || (await sealVerdict(summary)).status !== "verified");
  if (sealed.current && !withdraw) return;
  const bundle = summary ? (sealed.bundle as AttestationBundle | undefined) : undefined;
  const verdict = bundle && !withdraw ? await sealVerdict(summary!) : undefined;
  const json = canonicalize(metadata(d.edition, bundle, verdict) as unknown as JcsValue);
  if (json === d.metadata) return;
  const signer = await getUploadKey(d.edition.creator);
  d.edition = readSavedPhotoMetadata(json, d.edition);
  d.metadata = json;
  d.metadataId = buildDataItem({ data: utf8(json), tags: DOCUMENT_TAGS, signer }).id;
  await save(r, d);
}

const SEND_MARGIN_MS = 15 * 60 * 1000;
/** Re-attest a draft whose certificate chain has expired or soon will. Only before signing. */
async function renewStaleAttestation(r: CaptureRecord, d: CoreDraft) {
  const stale = d.edition.attestation;
  if (!stale || !attestationExpiring(stale)) return;
  const e: CoreMetadata = { ...d.edition };
  const { json, meta } = await sealDocument(e, r, d.sourceHash, await getUploadKey(e.creator));
  if (!e.attestation && !attestationExpiring(stale, Date.now(), SEND_MARGIN_MS)) return;
  d.edition = e;
  d.metadata = json;
  d.metadataId = meta.id;
  await save(r, d);
}

// ---------------------------------------------------------------------------------------------
// The uploads
// ---------------------------------------------------------------------------------------------

async function publicationItems(d: CoreDraft) {
  const signer = await getUploadKey(d.edition.creator),
    bytes = new Uint8Array(await (await fetch(`file://${d.imagePath}`)).arrayBuffer());
  if (hash(bytes) !== d.edition.imageHash) throw new Error("Saved published image changed.");
  const img = buildDataItem({ data: bytes, tags: PRINT_TAGS, signer }),
    meta = buildDataItem({ data: utf8(d.metadata), tags: DOCUMENT_TAGS, signer });
  if (img.id !== d.edition.image.split("/").pop() || meta.id !== d.metadataId)
    throw new Error("Saved publication identifiers changed.");
  return { signer, img, meta };
}
/** The signed data items the chain names, for the publication bundle. */
export async function publicationDataItems(d: CoreDraft) {
  const { img, meta } = await publicationItems(d);
  return { metadata: meta.bytes, image: img.bytes };
}

/**
 * Mainnet: a stand-alone storage payment, once made, is claimed as credit; without one the upload
 * tries Turbo's free tier, and a refusal there offers the payment (`storageTopUpOffered`).
 */
async function settleStorage(r: CaptureRecord, d: CoreDraft) {
  if (d.storageFunding) return;
  const { signer, img, meta } = await publicationItems(d);
  const paid = await topUpReceipt(r, d);
  if (!paid) {
    d.storageFunding = "free";
    await save(r, d);
    return;
  }
  const funding = await settleStoragePayment(async () => paid, signer.ownerBase58, [img, meta], undefined, async (tx) => {
    if (d.storageSettling?.tx !== tx) {
      d.storageSettling = { tx, since: Date.now() };
      await save(r, d);
    }
    return d.storageSettling.since;
  });
  if (!funding) return;
  d.storageFunding = funding;
  await save(r, d);
}

/** The stand-alone payment's signature once it has landed; null when there is none (or it failed). */
async function topUpReceipt(r: CaptureRecord, d: CoreDraft): Promise<string | null> {
  const topUp = d.storageTopUp;
  if (!topUp?.signature) return null;
  const standing = await signatureStanding(topUp.signature, BigInt(topUp.lastValidBlockHeight));
  if (standing === "confirmed") return topUp.signature;
  if (standing === "pending") throw storageTopUpPending();
  delete d.storageTopUp;
  await save(r, d);
  return null;
}
/** Can this draft buy its storage (`storageTopUpOffered`)? Mainnet only. */
export const canPayStorage = (d: CoreDraft) => paidStorage(cluster) && storageTopUpOffered(d);
export async function quoteStorageTopUp(d: CoreDraft): Promise<StoragePayment | null> {
  if (!canPayStorage(d)) return null;
  const { signer, img, meta } = await publicationItems(d);
  return quoteStoragePayment(signer.ownerBase58, [img, meta]);
}

type PublishProgress = "wallet" | "confirming" | "uploading";

/** Buy storage for a confirmed publication with one stand-alone payment, then upload. */
export async function payStorage(
  r: CaptureRecord,
  d: CoreDraft,
  session: WalletSession,
  payment: StoragePayment,
  onProgress?: (stage: PublishProgress) => void,
) {
  return exclusive(lock(r), async () => {
    await assertCurrent(r, d);
    if (!canPayStorage(d) || !(await isSigned(d))) throw new Error("Storage cannot be bought for this publication now.");
    const creator = address(d.edition.creator);
    const ready = await prepareDraft({ feePayer: creator, transactions: [{ instructions: storagePaymentInstructions(creator, payment), localSigners: [] }] });
    onProgress?.("wallet");
    const [tx] = (await signWithWallet(session, creator, ready.prepared)).transactions;
    d.storageTopUp = {
      lastValidBlockHeight: String(ready.lifetime.lastValidBlockHeight),
      signature: signatureOf(tx),
      quoteId: hash(new Uint8Array(tx.messageBytes)),
      blockhash: ready.lifetime.blockhash,
      slot: 0,
      lamports: payment.lamports.toString(),
    };
    delete d.storageFunding;
    delete d.storageSettling;
    await save(r, d);
    onProgress?.("confirming");
    await sendAndConfirm(tx, ready.lifetime.lastValidBlockHeight);
    onProgress?.("uploading");
    await uploadConfirmed(r, d);
  });
}

/**
 * The upload is done when Turbo holds both items. Each item's id is derived from its signed
 * content, so a gateway read-back proves nothing more, and a gateway that is a few seconds
 * behind used to end every publication on "Photo upload pending".
 */
async function publish(d: CoreDraft) {
  const { img, meta } = await publicationItems(d);
  await Promise.all([uploadDataItem(img.bytes, img.id), uploadDataItem(meta.bytes, meta.id)]);
}
async function uploadConfirmed(r: CaptureRecord, d: CoreDraft) {
  if (d.storage === "available") return;
  d.storage = "pending";
  delete d.storageError;
  await save(r, d);
  try {
    if (paidStorage(cluster)) await settleStorage(r, d);
    else await checkStorage(d);
    await publish(d);
  } catch (error) {
    d.storageError = storageProblem(error, paidStorage(cluster), d.storageFunding);
    if (d.storageFunding === "free" && d.storageError.kind === "quota") delete d.storageFunding;
    await save(r, d);
    throw new Error(d.storageError.message);
  }
  d.storage = "available";
  await save(r, d);
}

/** Devnet: the free allowance, advisory. */
async function checkStorage(d: CoreDraft) {
  const { signer, img, meta } = await publicationItems(d);
  await checkStorageCapacity(signer.ownerBase58, [img, meta]);
}

export async function retryPublicationStorage(r: CaptureRecord, d: CoreDraft) {
  return exclusive(lock(r), async () => {
    await assertCurrent(r, d);
    if (!(await isSigned(d))) throw new Error("Publish the edition before uploading its image.");
    d.confirmedAt ??= Date.now();
    await save(r, d);
    await uploadConfirmed(r, d);
  });
}

// ---------------------------------------------------------------------------------------------
// State for the screens
// ---------------------------------------------------------------------------------------------

export interface PublicationState {
  status: "local" | "checking" | "draft" | "pending" | "published" | "unavailable";
  draft: CoreDraft | null;
  view?: PublicationView;
  reason?: string;
}

/** What a screen renders, from the validated draft. */
export function coreView(draft: CoreDraft): PublicationView {
  const e = draft.edition;
  return {
    protocol: CORE_PROTOCOL,
    cluster: e.cluster,
    program: e.program,
    edition: e.edition,
    container: e.collection,
    creatorAsset: seedAddress(draft.seeds.copy),
    creator: e.creator,
    title: e.title,
    supply: e.supply,
    image: e.image,
    imageHash: e.imageHash,
    metadataId: draft.metadataId,
    metadataHash: hash(utf8(draft.metadata)),
    width: e.width,
    height: e.height,
    publicUrl: collectUrl(e.edition, e.cluster),
    explorerUrl: explorerUrl(e.edition, e.cluster),
  };
}

/** Local files and validated saved intent only. Never waits for RPC. */
export async function getSavedPublicationState(r: CaptureRecord): Promise<PublicationState> {
  try {
    const draft = await readDraft(r);
    if (!draft) return { status: "local", draft: null };
    return { status: "checking", draft, view: coreView(draft) };
  } catch {
    // An unreadable or foreign draft: the photograph reads as an ordinary one.
    return { status: "local", draft: null };
  }
}

/** The photograph's publication state. */
export async function getPublicationState(r: CaptureRecord): Promise<PublicationState> {
  let d: CoreDraft | null = null;
  let view: PublicationView | undefined;
  try {
    d = await readDraft(r);
  } catch {
    // A saved draft this build cannot read: not a fresh photograph. The sheet offers to discard it.
    return { status: "unavailable", draft: null };
  }
  if (!d) return { status: "local", draft: null };
  try {
    view = coreView(d);
    const stage = await chainStage(d);
    if (stage === "published") {
      if (!d.confirmedAt && !operationInProgress(lock(r))) {
        d.confirmedAt = Date.now();
        delete d.signed;
        await save(r, d);
      }
      return { status: "published", draft: d, view };
    }
    if (d.confirmedAt)
      return { status: "unavailable", draft: d, view, reason: "The confirmed edition is not visible on this connection. Check again." };
    if (stage === "half")
      return { status: "draft", draft: d, view, reason: "The first of two transactions landed. Continue to finish publishing." };
    return { status: "draft", draft: d, view };
  } catch (error) {
    return { status: "unavailable", draft: d, view, reason: safeErrorText(error) };
  }
}

async function assertCurrent(r: CaptureRecord, d: CoreDraft) {
  const current = await readDraft(r);
  if (!current || current.metadataId !== d.metadataId || current.metadata !== d.metadata ||
    current.price !== d.price || current.royaltyBps !== d.royaltyBps || current.seekerOnly !== d.seekerOnly ||
    current.seeds.candyMachine !== d.seeds.candyMachine)
    throw new Error("This photo's publication changed. Close and reopen it before continuing.");
  d.signed = current.signed;
  d.confirmedAt = current.confirmedAt;
  d.storage = current.storage;
  d.storageError = current.storageError;
  d.storageFunding = current.storageFunding;
  d.storageSettling = current.storageSettling;
  d.storageTopUp = current.storageTopUp;
}

// ---------------------------------------------------------------------------------------------
// Publishing
// ---------------------------------------------------------------------------------------------

const hexBytes = (text: string) => Uint8Array.from(text.match(/../g) ?? [], (h) => parseInt(h, 16));

async function editionTerms(d: CoreDraft): Promise<EditionTerms> {
  return {
    title: d.edition.title,
    uri: `https://arweave.net/${d.metadataId}`,
    imageSha256: hexBytes(d.edition.imageHash),
    supply: d.edition.supply,
    royaltyBasisPoints: d.royaltyBps,
    price: draftPrice(d),
    cosigner: d.seekerOnly && d.cosigner ? address(d.cosigner) : null,
  };
}

/** The two transactions, rebuilt from the draft's own keypairs (or only the second, after the first). */
async function publishDraft(d: CoreDraft, stage: "both" | "second"): Promise<{ draft: Draft; terms: EditionTerms }> {
  const terms = await editionTerms(d);
  const [collection, candyMachine, copy] = await Promise.all([
    seedSigner(d.seeds.collection), seedSigner(d.seeds.candyMachine), seedSigner(d.seeds.copy),
  ]);
  const built = await publishTransactions({
    publisher: address(d.edition.creator), collection, candyMachine, copy, terms,
    candyMachineRent: await rent(CANDY_MACHINE_HIDDEN_BYTES),
  });
  const draft = stage === "both" ? built.draft : { feePayer: built.draft.feePayer, transactions: [built.draft.transactions[1]] };
  return { draft, terms };
}

/** Transaction 2 cannot be simulated before transaction 1 lands, so it gets a fixed budget. */
const SECOND_UNITS = 800_000;

/** The cost of the transactions still to land, from the client's own numbers. */
async function publishCost(d: CoreDraft, terms: EditionTerms, stage: "both" | "second", budgets: Budget[]) {
  const guards = await editionGuards(address(d.edition.creator), terms.price, terms.cosigner);
  const nameUri = utf8(terms.title).length + utf8(terms.uri).length;
  // A Core collection with MasterEdition, Royalties (one creator) and UpdateDelegate (one key).
  const collectionBytes = 187 + nameUri;
  let accounts = (await rent(CANDY_GUARD_HEADER + encodeGuardData(guards).length)) +
    (await rent(copyBytes(`${terms.title} #1`, terms.uri))) + CORE_CREATE_FEE;
  if (stage === "both") accounts += (await rent(CANDY_MACHINE_HIDDEN_BYTES)) + (await rent(collectionBytes));
  // A token price: transaction 2 creates the publisher's token account to receive it, if missing.
  if (terms.price.kind === "token" &&
    !(await fetchAccount(RPC_ENDPOINT, await associatedTokenAddress(address(d.edition.creator), terms.price.mint))))
    accounts += await rent(TOKEN_ACCOUNT_BYTES);
  const signatures = BigInt(3 * budgets.length);
  const networkFee = signatures * SIGNATURE_FEE + priorityLamports(budgets);
  const allowance = FEE_ALLOWANCE_LAMPORTS * BigInt(budgets.length);
  return {
    estimatedLamports: accounts + networkFee + allowance,
    estimateBreakdown: { networkFee, accountCost: accounts + networkFee, allowance },
  };
}

export type PublishQuote =
  | { step: "ready" }
  | {
    step: "sign";
    metadataId: string;
    stage: "both" | "second";
    /** Saved signed transactions are re-sent instead of signing again. */
    resend: boolean;
    budgets: Budget[];
    prepared: Awaited<ReturnType<typeof publishCost>>;
  };

/** "Continue": where the edition stands, and what publishing (the rest of) it costs. Opens no wallet. */
export async function prepareSetup(r: CaptureRecord, d: CoreDraft,
  onProgress?: (stage: "network" | "publication" | "previous" | "storage" | "estimate") => void): Promise<PublishQuote> {
  onProgress?.("network");
  await assertEndpointCluster();
  await assertCurrent(r, d);
  onProgress?.("publication");
  const stage = await chainStage(d);
  if (stage === "published") return { step: "ready" };
  if (d.confirmedAt) throw new Error("The confirmed edition cannot be checked on this connection. Try again later.");
  onProgress?.("previous");
  const resend = await signedLive(d) && (stage === "half" || !!d.signed?.first);
  const which = stage === "none" ? "both" : "second";
  if (!resend && stage === "none") {
    // Nothing is on chain or can land: the document may still be brought up to date.
    await exclusive(`${lock(r)}:document`, async () => {
      await renewStaleAttestation(r, d);
      await resealDocument(r, d);
    });
  }
  onProgress?.("storage");
  if (!paidStorage(cluster)) await checkStorage(d);
  onProgress?.("estimate");
  const { draft, terms } = await publishDraft(d, which);
  checkTerms(terms);
  const ready = await prepareDraft(draft, which === "both" ? [null, SECOND_UNITS] : [null]);
  const prepared = await publishCost(d, terms, which, ready.budgets);
  if ((await balance(d.edition.creator)) < prepared.estimatedLamports) throw new Error(NEEDS_SOL);
  return { step: "sign", metadataId: d.metadataId, stage: which, resend, budgets: ready.budgets, prepared };
}

/**
 * Sign (both transactions in one wallet request), send 1, confirm, send 2, confirm, then upload.
 * Saved, still-valid signed transactions are re-sent without opening the wallet.
 */
export async function sendSetup(
  r: CaptureRecord,
  d: CoreDraft,
  session: WalletSession,
  quote: PublishQuote,
  onProgress?: (stage: PublishProgress) => void,
): Promise<"unchecked"> {
  return exclusive(lock(r), async () => {
    await assertCurrent(r, d);
    let stage = await chainStage(d);
    if (stage !== "published") {
      if (quote.step !== "sign" || quote.metadataId !== d.metadataId || quote.stage !== (stage === "none" ? "both" : "second"))
        throw new Error("The publication review changed. Continue again to refresh it.");
      const creator = address(d.edition.creator);
      let first: ReturnType<typeof fromWire> | null = null;
      let second: ReturnType<typeof fromWire>;
      let lastValid: bigint;
      if (d.signed && (await signedLive(d)) && (stage === "half" || d.signed.first)) {
        if (stage === "none") first = fromWire(d.signed.first);
        second = fromWire(d.signed.second);
        lastValid = BigInt(d.signed.lastValidBlockHeight);
      } else {
        const { draft } = await publishDraft(d, quote.stage);
        const ready = withLifetime(draft, quote.budgets, await latestLifetime());
        onProgress?.("wallet");
        const { transactions } = await signWithWallet(session, creator, ready.prepared);
        if (quote.stage === "both") first = transactions[0];
        second = transactions[transactions.length - 1];
        lastValid = ready.lifetime.lastValidBlockHeight;
        d.signed = { first: first ? toWire(first) : "", second: toWire(second), lastValidBlockHeight: String(lastValid) };
        await save(r, d);
      }
      onProgress?.("confirming");
      try {
        if (first) await sendAndConfirm(first, lastValid);
        await sendAndConfirm(second, lastValid);
      } catch (e) {
        // On chain with an error: the saved pair can never land, and keeping it would re-send it
        // on every Continue until its blockhash expired.
        if (e instanceof TransactionFailure && e.landed) {
          delete d.signed;
          await save(r, d);
        }
        throw e;
      }
      stage = await chainStage(d);
      if (stage !== "published") throw new Error("The edition is not visible yet. Check again in a moment.");
    }
    d.confirmedAt ??= Date.now();
    delete d.signed;
    await save(r, d);
    onProgress?.("uploading");
    await uploadConfirmed(r, d);
    return "unchecked" as const;
  });
}
