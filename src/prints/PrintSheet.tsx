import { CostEstimate, costSol as sol } from "./CostEstimate";
import { sheetStyles } from "./sheetStyles";
import { useEffect, useRef, useState } from "react";
import {
  KeyboardAvoidingView,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { CaptureRecord, PhotoEdit } from "../../modules/seeker-camera";
import type { WalletSession } from "../solana/walletSession";
import {
  createDraft,
  prepareSetup,
  sendSetup,
  discardDraft,
  getPrintsAvailability,
  getPublicationState,
  savedDraftPresent,
  type PublicationDraft,
  type PublicationState,
} from "./creator";
import { terms } from "../../publications/core/protocol";
import { deviceName, securityLevelName } from "../../publications/core/attestation";
import { deviceValue, useDeviceVerdict } from "../seeker/useDeviceVerdict";
import {
  DESCRIPTION_LIMIT,
  normalizeDescription,
} from "../../publications/core/details";
import {
  ALBUM_NAME_MAX_BYTES,
  createAlbum,
  loadAlbums,
  prepareAlbum,
  selectableAlbums,
  type AlbumRecord,
  type AlbumSetup,
} from "./albums";
import { readPhotoEdit } from "./photoStorage";
import { formatSol, parseSolPrice } from "./price";
import { shortAddress } from "./photoPresentation";
import {
  configuredProgram,
  programFeatures,
} from "../../publications/deployments";

import { colors, radius, space } from "../ui/theme";
import { typeScale as type } from "../ui/type";
import {
  Chip,
  NetworkLabel,
  PhotoFrame,
  Pill,
} from "../ui/primitives";
import {
  actions,
  changedEstimate,
  estimate,
  expiredEstimate,
  onChain,
  price as priceCopy,
  publish as copy,
  walletTimeout,
} from "../ui/copy";
import { safeErrorText } from "../ui/errorText";
import { assertReviewedProgram } from "../../publications/programImage";
import { useTermsAgreement } from "../moderation/store";
import { TermsAgreement } from "../moderation/TermsAgreement";
import { programFallback } from "./programVerdict";
import { CLUSTER_NAME as cluster, IS_MAINNET, RPC_ENDPOINT } from "../solana/cluster";
import {
  isChangedQuote,
  isExpiredQuote,
  isUserCancellation,
  isWalletResponseTimeout,
} from "../solana/walletErrors";

/** The chain this build publishes on, and therefore the deployment a fresh publication uses. */

/**
 * Before a wallet signs anything `era_editions` runs: the draft's program, or the one a fresh
 * publication uses, must still be the reviewed bytes under the recorded upgrade authority
 * (`publications/programImage.ts`). Refuses with one line otherwise.
 */
async function checkProgram(program?: string) {
  await assertReviewedProgram(RPC_ENDPOINT, program ?? configuredProgram(cluster), cluster);
}

export function PrintSheet({
  record,
  session,
  walletAddress,
  walletName,
  onClose,
  onChanged,
}: {
  record: CaptureRecord;
  session: WalletSession;
  walletAddress?: string;
  walletName?: string;
  onClose(): void;
  onChanged?(): void;
}) {
  const insets = useSafeAreaInsets(),
    running = useRef(false);
  // The terms are agreed to once, before anything is published; an upload owed by an edition
  // already on Solana is never held behind them.
  const agreement = useTermsAgreement();
  const [draft, setDraft] = useState<PublicationDraft | null>(null);
  const [edit, setEdit] = useState<PhotoEdit>();
  const [title, setTitle] = useState("");
  // The optional caption. Like the title, it is hashed into the document when the draft is
  // created and cannot change without discarding the draft.
  const [caption, setCaption] = useState("");
  // The album decides which instruction the wallet approves, so it also freezes with the draft.
  const [albums, setAlbums] = useState<AlbumRecord[]>([]);
  const [albumsReason, setAlbumsReason] = useState("");
  const [albumMode, setAlbumMode] = useState<"none" | "existing" | "new">("none");
  const [selectedAlbum, setSelectedAlbum] = useState("");
  const [newAlbum, setNewAlbum] = useState("");
  const [albumQuote, setAlbumQuote] = useState<AlbumSetup | null>(null);
  // A saved draft this build cannot read. `draft` is null in that case, so this flag is what
  // offers the discard action.
  const [unreadable, setUnreadable] = useState(false);
  const [showWallet, setShowWallet] = useState(false);
  // The itemised estimate, one tap away from the single cost line.
  const [showCost, setShowCost] = useState(false);
  const [count, setCount] = useState("10"),
    [solo, setSolo] = useState(true);
  /**
   * The price of a copy, as typed, in SOL. Empty is free, which is what every edition was before
   * this field existed. Only an edition of more than one copy has anything to sell — copy 1 is the
   * publisher's — and only a deployment with `set_offer` can hold a price at all, so the field is
   * absent, rather than disabled, whenever either is untrue.
   */
  const [priceText, setPriceText] = useState("");
  const [offers, setOffers] = useState(false);
  const [quote, setQuote] = useState<Awaited<
    ReturnType<typeof prepareSetup>
  > | null>(null);
  const [busy, setBusy] = useState(false),
    [initializing, setInitializing] = useState(true);
  const [status, setStatus] = useState(""),
    [error, setError] = useState("");
  const [published, setPublished] = useState(false);
  // The action the program's own verdict says would work instead of the failure on screen.
  const [fallback, setFallback] = useState<"publish-without-album" | "new-album" | null>(null);
  const [access, setAccess] = useState<"fresh" | "saved" | "blocked">(
    "blocked",
  );
  const [availability, setAvailability] = useState<{
    enabled: boolean;
    reason?: string;
  }>({ enabled: false });
  // The review's Device row: a draft not yet sent is judged now, a published one at its block time.
  const device = useDeviceVerdict(draft?.edition, published);

  async function applyPublicationState(state: PublicationState) {
    setDraft(state.draft);
    // A saved intent follows its validated deployment, independently of the fresh default.
    setAccess(
      state.draft && state.view
        ? "saved"
        : state.status === "local" && !state.draft
          ? "fresh"
          : "blocked",
    );
    setPublished(
      !!state.view &&
        (state.status === "published" ||
          state.draft?.confirmedAt !== undefined),
    );
    // "Unavailable" with no draft is either an unreachable network or an unreadable saved draft;
    // only the raw key tells them apart, and only the latter is discardable.
    setUnreadable(
      !state.draft && state.status === "unavailable"
        ? await savedDraftPresent(record).catch(() => false)
        : false,
    );
  }

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const [state, selected, available] = await Promise.all([
          getPublicationState(record),
          readPhotoEdit(record),
          getPrintsAvailability(),
        ]);
        if (!live) return;
        setEdit(selected);
        setAvailability(available);
        // Which deployment a fresh publication would use decides whether a price can be set on it
        // at all. `configuredProgram` throws when publishing is unavailable, which is already its
        // own screen state, so there is simply no price field then either.
        setOffers(
          available.enabled &&
            (() => {
              try {
                return programFeatures(configuredProgram(cluster)).offers;
              } catch {
                return false;
              }
            })(),
        );
        await applyPublicationState(state);
        if (!live) return;
        // Albums are a separate durable list; an unreadable one disables the control with a
        // reason rather than taking the whole publishing sheet down with it.
        try {
          const saved = await loadAlbums();
          if (live) setAlbums(saved);
        } catch (e) {
          if (live) setAlbumsReason(safeErrorText(e));
        }
        if (!live) return;
        if (state.draft) {
          setTitle(state.draft.edition.title);
          setCaption(state.draft.edition.description);
          setSelectedAlbum(state.draft.album ?? "");
          setAlbumMode(state.draft.album ? "existing" : "none");
          setSolo(state.draft.edition.supply === 1);
          setCount(String(state.draft.edition.supply));
        }
        if (state.reason) setStatus(state.reason);
        // Warms the program check while the details are typed; publishing asks again and refuses.
        void checkProgram(state.draft?.edition.program).catch(() => {});
      } catch (e) {
        if (live) setError(safeErrorText(e));
      } finally {
        if (live) setInitializing(false);
      }
    })();
    return () => {
      live = false;
    };
  }, [record.baseName]);

  /**
   * "Check publication status": ask the chain what happened and return the step. Safe to run
   * automatically, since `prepareSetup` opens no wallet and refuses while an attempt may land.
   */
  async function readPublicationStatus(current: PublicationDraft) {
    const next = await prepareSetup(record, current, stage => setStatus({
      network: "Connecting to Solana…",
      publication: "Checking this edition…",
      previous: "Checking the previous wallet request…",
      storage: "Checking image storage…",
      estimate: "Calculating a fresh transaction cost…",
    }[stage]));
    // Only a quote to sign reaches the program; an edition already on chain needs no check.
    if (next.step === "sign") await checkProgram(current.edition.program);
    setQuote(next);
    if (next.step === "ready") {
      setPublished(true);
      setStatus("The edition is confirmed. Continue to check its public image.");
    } else setStatus("");
    return next.step;
  }
  /**
   * The same check after a wallet timeout: "ready" (edition exists), "sign" (the earlier attempt
   * cannot land; a fresh estimate is shown), or null (an attempt may still land).
   */
  async function statusAfterTimeout(current: PublicationDraft | null) {
    if (!current) return null;
    try {
      return await readPublicationStatus(current);
    } catch {
      setQuote(null);
      return null;
    }
  }

  async function prepare() {
    if (running.current || initializing || !canPublish) return;
    running.current = true;
    setBusy(true);
    setError("");
    setFallback(null);
    // The estimate on screen belongs to the check that produced it. Clearing it first means a
    // refreshed approval can never show the amount from the previous, expired one.
    setQuote(null);
    setStatus("");
    try {
      let current = draft;
      if (!current) {
        terms(title.trim(), solo ? 1 : Number(count));
        // The same gates `createDraft` applies, run before the wallet opens.
        const moment = normalizeDescription(caption);
        // Zero is free, and a free edition is published exactly the way it always was.
        const lamports = priced ? priceLamports : undefined;
        const owner = await session.connectAnd((wallet) =>
          session.authorizeSession(wallet),
        );
        current = await createDraft(
          record,
          title.trim(),
          solo ? 1 : Number(count),
          owner.address,
          edit,
          moment,
          selectedAlbum || undefined,
          lamports,
        );
        setDraft(current);
        onChanged?.();
      }
      await readPublicationStatus(current);
    } catch (e) {
      // A cost check opens the wallet only to learn which account is publishing, so a wallet
      // that never answers has still published nothing.
      const timedOut = isWalletResponseTimeout(e);
      // The program's verdict may name a recovery, e.g. publishing without a full album.
      setFallback(programFallback(e) ?? null);
      setError(isUserCancellation(e) || timedOut ? "" : safeErrorText(e));
      setStatus(
        timedOut
          ? walletTimeout.costCheck
          : isUserCancellation(e)
            ? "Wallet closed. Nothing was sent."
            : "",
      );
    } finally {
      running.current = false;
      setBusy(false);
    }
  }

  async function publish() {
    if (!draft || !quote || running.current || !canPublish) return;
    running.current = true;
    setBusy(true);
    setError("");
    try {
      if (quote.step === "sign") await checkProgram(draft.edition.program);
      const receipt = await sendSetup(record, draft, session, quote, (phase) =>
        setStatus(
          {
            wallet: "Review and approve in your wallet…",
            confirming: "Waiting for Solana confirmation…",
            uploading:
              "Edition confirmed. Uploading the public photo and details…",
          }[phase],
        ),
      );
      setPublished(true);
      setQuote(null);
      // Published either way; a receipt mismatch (the landed transaction was not the reviewed
      // one) is said instead of the usual status.
      if (receipt === "mismatched") {
        setError(copy.reviewMismatch);
        setStatus("");
      } else setStatus("");
      onChanged?.();
    } catch (e) {
      setQuote(null);
      // A timeout is not a failure: Seed Vault broadcasts first and replies only when its success
      // screen is closed, so the edition is usually already published.
      const timedOut = isWalletResponseTimeout(e);
      const expired = isExpiredQuote(e);
      const changed = isChangedQuote(e);
      setFallback(programFallback(e) ?? null);
      setError(
        isUserCancellation(e) || timedOut || expired || changed
          ? ""
          : safeErrorText(e),
      );
      if (timedOut) setStatus(walletTimeout.publishChecking);
      const current = await getPublicationState(record).catch(() => null);
      if (current) await applyPublicationState(current);
      else {
        setAccess("blocked");
        setPublished(false);
      }
      if (timedOut) {
        // The status and the button have to agree: a fresh signable estimate means the earlier
        // transaction cannot land, and saying it might would contradict the button.
        const step = await statusAfterTimeout(current?.draft ?? draft);
        setStatus(
          step === "ready"
            ? walletTimeout.publishFound
            : step === "sign"
              ? walletTimeout.publishRetry
              : walletTimeout.publishPending,
        );
      } else
        setStatus(
          changed
            ? changedEstimate.publish
            : expired
              ? expiredEstimate.publish
              : `${isUserCancellation(e) ? "Wallet closed. " : ""}Your progress is saved. Check publication status before trying again.`,
        );
      onChanged?.();
    } finally {
      running.current = false;
      setBusy(false);
    }
  }

  /** The publishing wallet for album work: the draft's, or the connected one. */
  function albumWallet() {
    return draft?.edition.creator ?? walletAddress;
  }
  function adoptAlbum(record: AlbumRecord) {
    setAlbums((previous) => [
      ...previous.filter((a) => a.nonce !== record.nonce),
      record,
    ]);
    setSelectedAlbum(record.address);
    setAlbumMode("existing");
    setAlbumQuote(null);
    setNewAlbum("");
    // The group account was read and is held by this wallet; the transient flag says only that
    // the transaction which created it was not the reviewed message.
    if (record.reviewMismatch) {
      setError(copy.albumReviewMismatch);
      setStatus("");
    } else setStatus(`Album “${record.name}” is ready. It will hold this photograph.`);
  }
  /** Cost only. Nothing is created, and no wallet is asked to sign by this check. */
  async function quoteAlbum() {
    if (running.current || busy || !!draft) return;
    running.current = true;
    setBusy(true);
    setError("");
    // Same rule as the publication estimate: the old amount leaves the screen with its check.
    setAlbumQuote(null);
    setStatus("Checking the album cost…");
    try {
      const wallet =
        albumWallet() ??
        (await session.connectAnd((w) => session.authorizeSession(w))).address;
      const next = await prepareAlbum(newAlbum, wallet);
      if (next.step === "ready") adoptAlbum(next.record);
      else {
        await checkProgram(next.record.program);
        setAlbumQuote(next);
        setStatus("Review the album cost below. Nothing has been created by this check.");
      }
    } catch (e) {
      setAlbumQuote(null);
      const timedOut = isWalletResponseTimeout(e);
      setFallback(programFallback(e) ?? null);
      setError(isUserCancellation(e) || timedOut ? "" : safeErrorText(e));
      setStatus(
        timedOut
          ? walletTimeout.albumCostCheck
          : isUserCancellation(e)
            ? "Wallet closed. No album was created."
            : "",
      );
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  async function makeAlbum() {
    if (running.current || busy || albumQuote?.step !== "sign") return;
    running.current = true;
    setBusy(true);
    setError("");
    try {
      const wallet = albumQuote.record.creator;
      await checkProgram(albumQuote.record.program);
      const record = await createAlbum(wallet, session, albumQuote, (stage) =>
        setStatus(
          {
            wallet: "Review and approve the album in your wallet…",
            confirming: "Waiting for Solana confirmation…",
          }[stage],
        ),
      );
      adoptAlbum(record);
    } catch (e) {
      setAlbumQuote(null);
      const timedOut = isWalletResponseTimeout(e);
      const expired = isExpiredQuote(e);
      const changed = isChangedQuote(e);
      setFallback(programFallback(e) ?? null);
      setError(
        isUserCancellation(e) || timedOut || expired || changed
          ? ""
          : safeErrorText(e),
      );
      let adopted = false;
      if (timedOut) {
        setStatus(walletTimeout.albumChecking);
        // `prepareAlbum` adopts a group already on chain and refuses to re-quote while the
        // approved transaction may still land. It opens no wallet.
        try {
          const next = await prepareAlbum(
            albumQuote.record.name,
            albumQuote.record.creator,
          );
          if (next.step === "ready") {
            adoptAlbum(next.record);
            adopted = true;
          } else {
            // A signable quote means the earlier album transaction cannot land, so the
            // sheet offers it rather than telling the user to wait for something that is over.
            setAlbumQuote(next);
            setStatus(walletTimeout.albumRetry);
          }
        } catch {
          setStatus(walletTimeout.albumPending);
        }
      } else
        setStatus(
          changed
            ? changedEstimate.album
            : expired
              ? expiredEstimate.album
              : `${isUserCancellation(e) ? "Wallet closed. " : ""}Any album progress is saved. Check it before trying again.`,
        );
      // An adopted album is already in the list, and a re-read here could only put back a
      // staler answer than the reconcile just gave.
      if (!adopted)
        try {
          setAlbums(await loadAlbums());
        } catch {
          // A failed refresh leaves the list as it was; the reason above already says so.
        }
    } finally {
      running.current = false;
      setBusy(false);
    }
  }

  async function change() {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    try {
      await discardDraft(record);
      setDraft(null);
      setAccess("fresh");
      setPublished(false);
      setQuote(null);
      // Discarding frees the album selection; the album itself is untouched.
      setSelectedAlbum("");
      setAlbumMode("none");
      setAlbumQuote(null);
      setUnreadable(false);
      setError("");
      setFallback(null);
      setStatus("");
      onChanged?.();
    } catch (e) {
      setError(safeErrorText(e));
    } finally {
      running.current = false;
      setBusy(false);
    }
  }

  // A saved draft is previewed from the validated draft, not the text field, so the screen shows
  // exactly the hashed text. An unpublishable caption is an error here, never a silent trim.
  let detailsError = "";
  try {
    normalizeDescription(draft ? draft.edition.description : caption);
  } catch (e) {
    detailsError = safeErrorText(e);
  }
  const previewTitle = draft?.edition.title ?? title.trim();

  /**
   * The price field exists only where there is something to sell on a deployment that can hold a
   * price: an edition of 1 keeps its single copy, and a program without `set_offer` has no offer
   * account to write. Where it does not exist, nothing on the sheet mentions a price at all.
   */
  const priceable = !draft && !solo && offers;
  let priceError = "";
  let priceLamports = 0n;
  if (priceable)
    try {
      // The one place a typed amount becomes lamports. An amount that cannot be represented
      // exactly is refused here, before a wallet, rather than rounded into a transaction.
      priceLamports = parseSolPrice(priceText);
    } catch (e) {
      priceError = safeErrorText(e);
    }
  const priced = priceable && !priceError && priceLamports > 0n;
  /** The price the draft itself committed to, read back like every other receipt row. */
  const draftPrice = draftPriceLamports(draft);

  // Only confirmed albums held by the publishing wallet; any other album fails
  // `publish_in_album`. With no wallet known there is nothing to list.
  const albumOwner = draft?.edition.creator ?? walletAddress;
  const albumChoices = (albumOwner ? selectableAlbums(albums) : []).filter(
    (a) => a.creator === albumOwner,
  );
  // Two albums can share a label (renames, or a regenerated upload key), so a duplicate name is
  // shown with its group address.
  const duplicateAlbumNames = new Set(
    albumChoices
      .map((a) => a.name)
      .filter((name, index, all) => all.indexOf(name) !== index),
  );
  const albumChoiceLabel = (album: AlbumRecord) =>
    duplicateAlbumNames.has(album.name)
      ? `${album.name} · ${shortAddress(album.address)}`
      : album.name;
  const previewAlbum =
    draft?.albumName ??
    albumChoices.find((a) => a.address === selectedAlbum)?.name ??
    "";
  // A typed but uncreated album name blocks publishing, so the photograph cannot quietly land
  // outside the album being made.
  const albumPending = !draft && albumMode === "new" && newAlbum.trim().length > 0;

  const valid =
    title.trim().length > 0 &&
    !detailsError &&
    !priceError &&
    !albumPending &&
    (solo ||
      (/^\d+$/.test(count) && Number(count) >= 2 && Number(count) <= 1000));
  const canPublish =
    access === "saved" || (access === "fresh" && availability.enabled);
  const owner = draft?.edition.creator ?? walletAddress;
  // The `.skr` name is shown beside the address, never instead of it: the address is what other
  // surfaces can be checked against. With no wallet, the dock's Publish action connects one.
  const ownerLabel = owner ? shortAddress(owner) : "No wallet connected";
  const ownerName =
    owner && owner === walletAddress && walletName ? walletName : null;
  const complete = published && draft?.storage === "available";
  const storageCanRetry =
    !draft?.storageError ||
    draft.storageError.retryable ||
    draft.storageError.kind === "quota";
  // The sheet's title is the photograph's own name once it has one.
  const heading = published
    ? complete
      ? copy.headingPublished
      : copy.headingUpload
    : previewTitle || copy.heading;
  const printUri = draft
    ? `file://${draft.imagePath}`
    : (edit?.uri ?? record.styledUri);
  return (
    <Modal
      animationType="slide"
      onRequestClose={() => {
        if (!busy) onClose();
      }}
    >
      <KeyboardAvoidingView behavior="height" style={sheetStyles.root}>
        {/* The photograph above the sheet, starting below the header row so the back pill
            does not cover it. */}
        <View
          style={[sheetStyles.print, { top: insets.top + space.md + HEADER_ROW + space.sm }]}
          pointerEvents="none"
        >
          <PhotoFrame source={{ uri: printUri }} imageHeight={220} />
        </View>
        <View style={sheetStyles.scrim} pointerEvents="none" />
        <View style={[sheetStyles.headerRow, { paddingTop: insets.top + space.md }]}>
          <Pill
            label={complete ? actions.done : actions.backToPhoto}
            variant="secondary"
            size="small"
            disabled={busy}
            onPress={onClose}
          />
        </View>
        <View style={s.sheet}>
          <View style={sheetStyles.grabber} />
          <ScrollView
            style={sheetStyles.scroll}
            contentContainerStyle={sheetStyles.content}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
            showsVerticalScrollIndicator={false}
          >
            {/* The badge names the chain only: a devnet upload is as permanent and public. */}
            <NetworkLabel
              label={IS_MAINNET ? copy.network : copy.networkTest}
            />
            <Text style={sheetStyles.title}>{heading}</Text>
            {/* Fields until a draft exists; then a receipt. "Edit details" discards the draft
                to return to the fields. */}
            {!draft && (
              <>
                <Field
                  label={copy.titleLabel}
                  value={title}
                  onChangeText={setTitle}
                  editable={!draft && !busy && !initializing}
                  maxLength={24}
                />
                <Field
                  label={copy.momentLabel}
                  value={caption}
                  onChangeText={setCaption}
                  editable={!draft && !busy && !initializing}
                  maxLength={DESCRIPTION_LIMIT}
                />
                {!!detailsError && <Text style={sheetStyles.error}>{detailsError}</Text>}
                <View style={s.group}>
                  <Text style={sheetStyles.label}>{copy.copiesLabel}</Text>
                  <View
                    style={s.row}
                    accessibilityRole="radiogroup"
                    accessibilityLabel={copy.copiesLabel}
                  >
                    <Chip
                      label={actions.oneCopy}
                      accessibilityRole="radio"
                      selected={solo}
                      disabled={!!draft || busy}
                      onPress={() => setSolo(true)}
                      style={s.flex}
                    />
                    <Chip
                      label={actions.multipleCopies}
                      accessibilityRole="radio"
                      selected={!solo}
                      disabled={!!draft || busy}
                      onPress={() => setSolo(false)}
                      style={s.flex}
                    />
                  </View>
                  {!solo && (
                    <>
                      <View style={s.countRow}>
                        <Text style={[sheetStyles.label, s.countLabel]}>
                          {copy.totalLabel}
                        </Text>
                        <TextInput
                          style={s.count}
                          accessibilityLabel={copy.totalLabel}
                          value={count}
                          onChangeText={setCount}
                          editable={!draft && !busy}
                          keyboardType="number-pad"
                          maxLength={4}
                        />
                      </View>
                    </>
                  )}
                </View>
                {/* The price of a copy. Absent, never disabled, when there is nothing to sell or
                    the deployment cannot hold an offer. */}
                {priceable && (
                  <View style={s.group}>
                    <Text style={sheetStyles.label}>{priceCopy.publishLabel}</Text>
                    <TextInput
                      style={sheetStyles.input}
                      accessibilityLabel={priceCopy.publishLabel}
                      value={priceText}
                      onChangeText={setPriceText}
                      editable={!busy && !initializing}
                      keyboardType="decimal-pad"
                      placeholder={priceCopy.publishPlaceholder}
                      placeholderTextColor={colors.muted}
                      maxLength={24}
                    />
                    {!!priceError && <Text style={sheetStyles.error}>{priceError}</Text>}
                  </View>
                )}
                <View style={s.group}>
                  <Text style={sheetStyles.label}>{copy.albumLabel}</Text>
                  <View
                    style={s.row}
                    accessibilityRole="radiogroup"
                    accessibilityLabel={copy.albumLabel}
                  >
                    <Chip
                      label={actions.noAlbum}
                      accessibilityRole="radio"
                      selected={albumMode === "none"}
                      disabled={!!draft || busy}
                      onPress={() => {
                        setAlbumMode("none");
                        setSelectedAlbum("");
                        setAlbumQuote(null);
                        setNewAlbum("");
                      }}
                      style={s.flex}
                    />
                    <Chip
                      label={actions.chooseAlbum}
                      accessibilityRole="radio"
                      selected={albumMode === "existing"}
                      disabled={!!draft || busy || albumChoices.length === 0}
                      onPress={() => {
                        setAlbumMode("existing");
                        setAlbumQuote(null);
                        setNewAlbum("");
                      }}
                      style={s.flex}
                    />
                    <Chip
                      label={actions.newAlbum}
                      accessibilityRole="radio"
                      selected={albumMode === "new"}
                      disabled={!!draft || busy}
                      onPress={() => {
                        setAlbumMode("new");
                        setSelectedAlbum("");
                      }}
                      style={s.flex}
                    />
                  </View>
                  {albumMode === "existing" &&
                    (albumChoices.length ? (
                      <View
                        accessibilityRole="radiogroup"
                        accessibilityLabel={actions.chooseAlbum}
                        style={s.albumChoices}
                      >
                        {albumChoices.map((album) => (
                          <Chip
                            key={album.address}
                            label={albumChoiceLabel(album)}
                            accessibilityRole="radio"
                            selected={selectedAlbum === album.address}
                            disabled={!!draft || busy}
                            onPress={() => setSelectedAlbum(album.address)}
                          />
                        ))}
                      </View>
                    ) : (
                      <Text style={sheetStyles.help}>
                        {albumOwner ? copy.albumEmpty : copy.albumNeedsWallet}
                      </Text>
                    ))}
                  {albumMode === "new" && (
                    <>
                      <TextInput
                        style={sheetStyles.input}
                        accessibilityLabel={copy.albumNameLabel}
                        value={newAlbum}
                        onChangeText={(value) => {
                          setNewAlbum(value);
                          setAlbumQuote(null);
                        }}
                        editable={!draft && !busy && !initializing}
                        maxLength={ALBUM_NAME_MAX_BYTES}
                      />
                      {albumQuote?.step === "sign" ? (
                        <>
                          <CostEstimate prepared={albumQuote.prepared} suffix={copy.albumCostSuffix}
                            expanded={showCost} onToggle={() => setShowCost((v) => !v)} />
                          <Pill
                            label={
                              busy ? actions.creatingAlbum : actions.createAlbum
                            }
                            disabled={busy}
                            onPress={() => void makeAlbum()}
                          />
                        </>
                      ) : (
                        <Pill
                          label={busy ? "Checking…" : actions.checkAlbumCost}
                          variant="secondary"
                          disabled={busy || !newAlbum.trim() || !!draft || agreement.agreed !== true}
                          onPress={() => void quoteAlbum()}
                        />
                      )}
                    </>
                  )}
                  {!!albumsReason && <Text style={sheetStyles.help}>{albumsReason}</Text>}
                  {albumMode !== "none" && (
                    <Text style={sheetStyles.help}>{copy.albumBody}</Text>
                  )}
                </View>
              </>
            )}
            {/* The receipt rows come from the validated draft, never the text fields, so they
                match the hashed document exactly. */}
            {draft ? (
              <View style={s.receipt}>
                {quote?.step === "sign" && (
                  <View style={s.total}>
                    <Text style={s.totalValue}>
                      {sol(quote.prepared.estimatedLamports)} SOL
                    </Text>
                    <Text style={sheetStyles.label}>{estimate.label}</Text>
                  </View>
                )}
                <Row label={copy.rowCopies} value={String(draft.edition.supply)} />
                {/* The price is a buyer's, not the publisher's: it is stated beside the copies and
                    never added into the estimate below. */}
                {draftPrice !== null && (
                  <Row
                    label={priceCopy.label}
                    value={
                      draftPrice > 0n
                        ? priceCopy.value(formatSol(draftPrice))
                        : priceCopy.free
                    }
                  />
                )}
                {!!draft.edition.description && (
                  <Row label={copy.rowMoment} value={draft.edition.description} />
                )}
                {!!previewAlbum && (
                  <Row label={copy.rowAlbum} value={previewAlbum} />
                )}
                <Row
                  label={copy.rowImage}
                  value={`${draft.edition.width} × ${draft.edition.height}`}
                />
                {/* Derived from the certificate sealed in the document, never typed; always
                    shown, so a phone that produced no evidence says so here. */}
                <Row
                  label={copy.rowDevice}
                  value={deviceValue(draft.edition, device, (a) => `${deviceName(a)} · ${securityLevelName(a)}`)}
                />
                {/* The mint the document names, found on mainnet when the draft was made. */}
                {draft.edition.genesisMint ? (
                  <Row label={copy.rowGenesis} value={shortAddress(draft.edition.genesisMint)} />
                ) : draft.genesisUnchecked ? (
                  <Row label={copy.rowGenesis} value={copy.rowGenesisUnchecked} />
                ) : null}
                <WalletRow
                  owner={owner}
                  ownerLabel={ownerLabel}
                  ownerName={ownerName}
                  expanded={showWallet}
                  onToggle={() => setShowWallet((value) => !value)}
                />
                {quote?.step === "sign" && (
                  <>
                    <View style={sheetStyles.rule} />
                    <Row
                      label={estimate.networkFee}
                      value={`${sol(quote.prepared.estimateBreakdown.networkFee)} SOL`}
                    />
                    {/* The simulated balance delta contains the storage transfer; it is stated
                        on its own row rather than twice. */}
                    <Row
                      label={estimate.accountCost}
                      value={`${sol(
                        quote.prepared.estimateBreakdown.accountCost > quote.storageLamports
                          ? quote.prepared.estimateBreakdown.accountCost - quote.storageLamports
                          : 0n,
                      )} SOL`}
                    />
                    {quote.storageLamports > 0n && (
                      <Row label={estimate.storage} value={`${sol(quote.storageLamports)} SOL`} />
                    )}
                    <Row
                      label={estimate.allowance}
                      value={`${sol(quote.prepared.estimateBreakdown.allowance)} SOL`}
                    />
                  </>
                )}
              </View>
            ) : (
              <View style={s.receipt}>
                <WalletRow
                  owner={owner}
                  ownerLabel={ownerLabel}
                  ownerName={ownerName}
                  expanded={showWallet}
                  onToggle={() => setShowWallet((value) => !value)}
                />
              </View>
            )}
            {!published && draft && !busy && (
              <Pill
                label={actions.changeDraft}
                variant="secondary"
                onPress={() => void change()}
              />
            )}
          </ScrollView>
          <View style={[sheetStyles.dock, { paddingBottom: insets.bottom + space.lg }]}>
            {!canPublish && !initializing ? (
              <>
                <Text style={s.noticeTitle}>
                  {access === "blocked"
                    ? copy.blockedTitle
                    : copy.unavailableTitle}
                </Text>
                <Text style={sheetStyles.help}>
                  {access === "blocked"
                    ? unreadable
                      ? error || copy.unreadableBody
                      : error || status || copy.blockedBody
                    : (availability.reason ?? copy.unavailableBody)}
                </Text>
                {unreadable && (
                  <Pill
                    label={actions.discardUnreadable}
                    disabled={busy}
                    onPress={() => void change()}
                  />
                )}
                <Pill
                  label={actions.backToPhotograph}
                  variant="secondary"
                  onPress={onClose}
                />
              </>
            ) : (
              <>
                {!!(error || draft?.storageError?.message || status) && (
                  <Text
                    style={error || draft?.storageError ? sheetStyles.error : sheetStyles.help}
                    accessibilityLiveRegion="polite"
                  >
                    {error || draft?.storageError?.message || status}
                  </Text>
                )}
                {/* A full album: discarding the draft frees the album selection, and the
                    photograph's details are kept. */}
                {fallback === "publish-without-album" && !published && (
                  <>
                    <Text style={sheetStyles.help}>{copy.fallbackWithoutAlbum}</Text>
                    <Pill
                      label={copy.publishWithoutAlbum}
                      variant="secondary"
                      disabled={busy}
                      onPress={() => void change()}
                    />
                  </>
                )}
                {fallback === "new-album" && (
                  <Text style={sheetStyles.help}>{copy.fallbackNewAlbum}</Text>
                )}
                {!valid && !published && !initializing && !error && (
                  <Text style={sheetStyles.help}>
                    {!title.trim()
                      ? copy.needTitle
                      : detailsError
                        ? detailsError
                        : priceError
                          ? priceError
                          : albumPending
                          ? copy.needAlbum
                          : copy.needCount}
                  </Text>
                )}
                {complete || (published && !storageCanRetry) ? (
                  <Pill label={actions.viewPhotograph} onPress={onClose} />
                ) : !published && agreement.agreed !== true ? (
                  <TermsAgreement agreed={agreement.agreed} onAgree={() => void agreement.agree()} />
                ) : quote ? (
                  <Pill
                    label={
                      busy
                        ? "Publishing…"
                        : quote.step === "ready"
                          ? draft?.storageError?.kind === "quota"
                            ? actions.checkUpload
                            : actions.completeUpload
                          : actions.confirmPublish
                    }
                    accessibilityHint={onChain.publish}
                    disabled={busy || !canPublish}
                    onPress={() => void publish()}
                  />
                ) : (
                  <Pill
                    label={
                      busy
                        ? "Preparing…"
                        : initializing
                          ? "Loading photograph…"
                          : actions.continueToPublish
                    }
                    disabled={busy || initializing || !valid || !canPublish}
                    onPress={() => void prepare()}
                  />
                )}
              </>
            )}
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

/** One receipt row: a mono label on the left, its value on the right. */
function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={sheetStyles.rowLine}>
      <Text style={s.rowLabel}>{label}</Text>
      <Text style={sheetStyles.rowValue} selectable>
        {value}
      </Text>
    </View>
  );
}

/**
 * The wallet row: the address, with the `.skr` name beside it when known. Tapping shows the full
 * address. Never uppercased: base58 is case-sensitive.
 */
function WalletRow({
  owner,
  ownerLabel,
  ownerName,
  expanded,
  onToggle,
}: {
  owner: string | undefined;
  ownerLabel: string;
  ownerName: string | null;
  expanded: boolean;
  onToggle(): void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={
        expanded ? "Hide full wallet address" : "Show full wallet address"
      }
      accessibilityState={{ expanded }}
      disabled={!owner}
      onPress={onToggle}
      style={s.walletToggle}
    >
      <View style={sheetStyles.rowLine}>
        <Text style={s.rowLabel}>{copy.rowWallet}</Text>
        <Text style={owner ? sheetStyles.rowValue : s.rowValueMuted}>{ownerLabel}</Text>
      </View>
      {!!ownerName && <Text style={s.rowNote}>{ownerName}</Text>}
      {owner && expanded && (
        <Text style={s.address} selectable>
          {owner}
        </Text>
      )}
    </Pressable>
  );
}

/** A labelled text field, in the field colour with a mono label. */
function Field({
  label,
  value,
  onChangeText,
  editable,
  maxLength,
}: {
  label: string;
  value: string;
  onChangeText(value: string): void;
  editable: boolean;
  maxLength: number;
}) {
  return (
    <View style={sheetStyles.field}>
      <Text style={sheetStyles.label}>{label}</Text>
      <TextInput
        style={sheetStyles.input}
        accessibilityLabel={label}
        value={value}
        onChangeText={onChangeText}
        editable={editable}
        maxLength={maxLength}
      />
    </View>
  );
}

/**
 * The price a saved draft committed to, in lamports, or null when it carries none. Stored as a
 * decimal string because a draft is JSON; an unreadable one is treated as no price rather than
 * taken down to a crash, since the amount is a receipt line and not what the wallet signs.
 */
function draftPriceLamports(draft: PublicationDraft | null): bigint | null {
  if (!draft?.price) return draft?.price === "0" ? 0n : null;
  try {
    return BigInt(draft.price);
  } catch {
    return null;
  }
}

/** A small `Pill`'s height: the row the back action gets to itself, above the photo strip. */
const HEADER_ROW = 46;
const s = StyleSheet.create({
  sheet: { ...sheetStyles.sheet, marginTop: "20%" },
  group: { gap: space.sm },
  row: { flexDirection: "row", gap: space.sm },
  flex: { flex: 1 },
  albumChoices: { gap: space.sm, alignItems: "flex-start" },
  countRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.md,
  },
  countLabel: { flex: 1 },
  count: {
    ...type.readout,
    color: colors.ink,
    backgroundColor: colors.field,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.small,
    width: 96,
    height: 48,
    textAlign: "center",
  },
  receipt: {
    padding: space.lg - 4,
    gap: space.sm,
    backgroundColor: colors.field,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.small,
  },
  total: { gap: space.xs, paddingBottom: space.sm },
  totalValue: { ...type.display, color: colors.ink },
  rowLabel: { ...type.label, color: colors.muted, paddingTop: 2 },
  rowValueMuted: {
    ...type.readout,
    textTransform: "none",
    letterSpacing: 0,
    fontSize: 14,
    lineHeight: 19,
    color: colors.muted,
    flexShrink: 1,
    textAlign: "right",
  },
  rowNote: { ...type.body, fontSize: 13, lineHeight: 19, color: colors.muted, textAlign: "right" },
  walletToggle: { gap: space.xs },
  address: { ...type.imprint, textTransform: "none", color: colors.muted, textAlign: "right" },
  noticeTitle: { ...type.body, color: colors.ink },
});
