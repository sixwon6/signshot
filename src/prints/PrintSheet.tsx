import { sheetStyles } from "./sheetStyles";
import { useEffect, useState } from "react";
import {
  KeyboardAvoidingView,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { CaptureRecord, PhotoEdit } from "../../modules/seeker-camera";
import type { WalletSession } from "../solana/walletSession";
import {
  seekerOnlyAvailable,
  createDraft,
  prepareSetup,
  sendSetup,
  discardDraft,
  draftPrice,
  getPrintsAvailability,
  getPublicationState,
  payStorage,
  savedDraftPresent,
  type PublicationDraft,
  type PublicationState,
} from "./creator";
import { useStorageTopUp } from "./useStorageTopUp";
import { terms } from "../../publications/core/document";
import { useDeviceVerdict } from "../seeker/useDeviceVerdict";
import { normalizeDescription } from "../../publications/core/details";
import { readPhotoEdit } from "./photoStorage";
import { formatSol, formatUnits, parseSolPrice, parseUnits } from "./price";
import { loadPriceToken, priceOf, type PriceToken } from "./priceToken";
import { shortAddress } from "./photoPresentation";
import {
  DEFAULT_ROYALTY_BPS,
  DEFAULT_SEEKER_ONLY,
} from "../../publications/types";

import { space } from "../ui/theme";
import {
  NetworkLabel,
  PhotoFrame,
  Pill,
} from "../ui/primitives";
import {
  actions,
  publish as copy,
  walletTimeout,
} from "../ui/copy";
import { safeErrorText } from "../ui/errorText";
import { useTermsAgreement } from "../moderation/store";
import { IS_MAINNET } from "../solana/cluster";
import {
  isUserCancellation,
  isWalletResponseTimeout,
} from "../solana/walletErrors";
import { useSheetOperation } from "./useSheetOperation";
import { PrintDetails } from "./PrintForm";
import { PrintReceipt } from "./PrintReceipt";
import { PrintDock } from "./PrintDock";

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
  const insets = useSafeAreaInsets();
  const {
    running,
    busy,
    status,
    setStatus,
    error,
    setError,
    quote,
    setQuote,
    run,
  } = useSheetOperation<Awaited<ReturnType<typeof prepareSetup>>>();
  // Agreed once before publishing; an upload owed by an edition already on chain is never gated on it.
  const agreement = useTermsAgreement();
  const [draft, setDraft] = useState<PublicationDraft | null>(null);
  const [edit, setEdit] = useState<PhotoEdit>();
  const [title, setTitle] = useState("");
  // Hashed into the document with the title; changing either means discarding the draft.
  const [caption, setCaption] = useState("");
  // A saved draft this build cannot read (`draft` stays null); offers the discard action.
  const [unreadable, setUnreadable] = useState(false);
  const [showWallet, setShowWallet] = useState(false);
  const [count, setCount] = useState("10"),
    [solo, setSolo] = useState(true);
  /** As typed, in `priceUnit`; empty is free. */
  const [priceText, setPriceText] = useState("");
  const [offers, setOffers] = useState(false);
  /** "token" only where this build has a price token. */
  const [priceUnit, setPriceUnit] = useState<"sol" | "token">("sol");
  const [token, setToken] = useState<PriceToken | null>(null);
  /** Royalty (basis points) and Seeker-only, frozen into the draft like the price. */
  const [royaltyBps, setRoyaltyBps] = useState(DEFAULT_ROYALTY_BPS);
  const [seekerOnly, setSeekerOnly] = useState(DEFAULT_SEEKER_ONLY);
  const [distribution, setDistribution] = useState(false);
  // Seeker-only needs the co-signer (`seekerOnlyAvailable`).
  const [sealable, setSealable] = useState(false);
  const [initializing, setInitializing] = useState(true);
  const [published, setPublished] = useState(false);
  const [access, setAccess] = useState<"fresh" | "saved" | "blocked">(
    "blocked",
  );
  const [availability, setAvailability] = useState<{
    enabled: boolean;
    reason?: string;
  }>({ enabled: false });
  // Device row: an unsent draft is judged now, a published one at its block time.
  const device = useDeviceVerdict(draft?.edition, published);
  // Offered when the provider refused the upload or the credit ran short.
  const topUp = useStorageTopUp(published ? draft : null);

  async function applyPublicationState(state: PublicationState) {
    setDraft(state.draft);
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
        // Wait for the co-signer too: `Continue` must not run before the form knows whether it
        // shows the Seeker-only switch.
        const [state, selected, available, canSeal] = await Promise.all([
          getPublicationState(record),
          readPhotoEdit(record),
          getPrintsAvailability(),
          seekerOnlyAvailable(),
        ]);
        if (!live) return;
        setEdit(selected);
        setAvailability(available);
        setOffers(true);
        setDistribution(true);
        setSealable(canSeal);
        void loadPriceToken().then((t) => { if (live) setToken(t); }, () => undefined);
        await applyPublicationState(state);
        if (!live) return;
        if (state.draft) {
          setTitle(state.draft.edition.title);
          setCaption(state.draft.edition.description);
          setSolo(state.draft.edition.supply === 1);
          setCount(String(state.draft.edition.supply));
          setRoyaltyBps(state.draft.royaltyBps);
          setSeekerOnly(state.draft.seekerOnly);
          // The price too, or `Edit details` on a priced draft would publish it free.
          const price = draftPrice(state.draft);
          const known = price.kind === "token" ? await loadPriceToken().catch(() => null) : null;
          if (!live) return;
          setPriceUnit(price.kind === "token" ? "token" : "sol");
          setPriceText(price.kind === "sol" ? formatSol(price.lamports)
            : price.kind === "token" && known ? formatUnits(price.amount, known.decimals) : "");
        }
        if (state.reason) setStatus(state.reason);
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
    return run(async () => {
      setError("");
      // Clear first so a refreshed approval never shows the previous, expired estimate.
      setQuote(null);
      setStatus("");
      try {
        let current = draft;
        if (!current) {
          terms(title.trim(), solo ? 1 : Number(count));
          // The same gates `createDraft` applies, run before the wallet opens.
          const moment = normalizeDescription(caption);
          // Zero or no price publishes free.
          const lamports = priced ? priceOf(priceUnit, priceLamports) : undefined;
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
            lamports,
            // An edition of 1 has no collectors and keeps the default; `createDraft` records
            // Seeker-only only for more than one copy with a co-signer configured.
            distribution ? { royaltyBps, seekerOnly: sealable && (solo || seekerOnly) } : undefined,
          );
          setDraft(current);
          onChanged?.();
        }
        await readPublicationStatus(current);
      } catch (e) {
        // The wallet opened only to learn the publishing account, so a timeout published nothing.
        const timedOut = isWalletResponseTimeout(e);
        setError(isUserCancellation(e) || timedOut ? "" : safeErrorText(e));
        setStatus(
          timedOut
            ? walletTimeout.costCheck
            : isUserCancellation(e)
              ? "Wallet closed. Nothing was sent."
              : "",
        );
      }
    });
  }

  async function publish() {
    if (!draft || !quote || running.current || !canPublish) return;
    return run(async () => {
      setError("");
      try {
        await sendSetup(record, draft, session, quote, (phase) =>
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
        setStatus("");
        onChanged?.();
      } catch (e) {
        setQuote(null);
        // A timeout is not a failure: Seed Vault broadcasts first and replies only when its success
        // screen is closed, so the edition is usually already published.
        const timedOut = isWalletResponseTimeout(e);
        setError(
          isUserCancellation(e) || timedOut
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
          // Match the button: a fresh signable estimate means the earlier transaction cannot land.
          const step = await statusAfterTimeout(current?.draft ?? draft);
          setStatus(
            step === "ready"
              ? walletTimeout.publishFound
              : step === "sign"
                ? walletTimeout.publishRetry
                : walletTimeout.publishPending,
          );
        } else if (current?.reason) {
          // The chain's view (e.g. the first of two landed) is what to act on.
          setError("");
          setStatus(current.reason);
        } else
          setStatus(
            `${isUserCancellation(e) ? "Wallet closed. " : ""}Your progress is saved. Continue to check it before trying again.`,
          );
        onChanged?.();
      }
    });
  }

  async function payForStorage() {
    if (!draft || !topUp || running.current) return;
    await run(async () => {
      setError("");
      try {
        await payStorage(record, draft, session, topUp, (phase) =>
          setStatus(
            {
              wallet: "Review and approve in your wallet…",
              confirming: "Waiting for Solana confirmation…",
              uploading: "Uploading the public photo and details…",
            }[phase],
          ),
        );
        setStatus("");
      } catch (e) {
        setError(isUserCancellation(e) ? "" : safeErrorText(e));
        setStatus("");
      } finally {
        const current = await getPublicationState(record).catch(() => null);
        if (current) await applyPublicationState(current);
      }
    });
    onChanged?.();
  }

  async function change() {
    return run(async () => {
      try {
        await discardDraft(record);
        setDraft(null);
        setAccess("fresh");
        setPublished(false);
        setQuote(null);
        setUnreadable(false);
        setError("");
        setStatus("");
        onChanged?.();
      } catch (e) {
        setError(safeErrorText(e));
      }
    });
  }

  // Preview the validated draft, not the field, so the screen shows exactly the hashed text.
  // An unpublishable caption is an error, never a silent trim.
  let detailsError = "";
  try {
    normalizeDescription(draft ? draft.edition.description : caption);
  } catch (e) {
    detailsError = safeErrorText(e);
  }
  const previewTitle = draft?.edition.title ?? title.trim();

  // Priced only when there are copies to sell; an edition of 1 shows no price.
  const priceable = !draft && !solo && offers;
  let priceError = "";
  let priceLamports = 0n;
  if (priceable)
    try {
      // Inexact amounts are refused here, never rounded into a transaction.
      priceLamports = priceUnit === "token" && token ? parseUnits(priceText, token.decimals) : parseSolPrice(priceText);
    } catch (e) {
      priceError = safeErrorText(e);
    }
  const priced = priceable && !priceError && priceLamports > 0n;

  const valid =
    title.trim().length > 0 &&
    !detailsError &&
    !priceError &&
    (solo ||
      (/^\d+$/.test(count) && Number(count) >= 2 && Number(count) <= 1000));
  const canPublish =
    access === "saved" || (access === "fresh" && availability.enabled);
  const owner = draft?.edition.creator ?? walletAddress;
  // The `.skr` name goes beside the address, never instead of it. With no wallet, the dock's
  // Publish action connects one.
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
        {/* Starts below the header row so the back pill does not cover it. */}
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
              <PrintDetails
                draft={draft}
                busy={busy}
                initializing={initializing}
                title={title}
                setTitle={setTitle}
                caption={caption}
                setCaption={setCaption}
                detailsError={detailsError}
                solo={solo}
                setSolo={setSolo}
                count={count}
                setCount={setCount}
                priceable={priceable}
                priceText={priceText}
                priceUnit={priceUnit}
                setPriceUnit={setPriceUnit}
                tokenLabel={token?.label ?? null}
                setPriceText={setPriceText}
                priceError={priceError}
                distribution={distribution}
                royaltyBps={royaltyBps}
                setRoyaltyBps={setRoyaltyBps}
                sealable={sealable}
                seekerOnly={seekerOnly}
                setSeekerOnly={setSeekerOnly}
              />
            )}
            <PrintReceipt
              draft={draft}
              quote={quote}
              device={device}
              owner={owner}
              ownerLabel={ownerLabel}
              ownerName={ownerName}
              showWallet={showWallet}
              onToggleWallet={() => setShowWallet((value) => !value)}
            />
            {!published && draft && !busy && (
              <Pill
                label={actions.changeDraft}
                variant="secondary"
                onPress={() => void change()}
              />
            )}
          </ScrollView>
          <View style={[sheetStyles.dock, { paddingBottom: insets.bottom + space.lg }]}>
            <PrintDock
              canPublish={canPublish}
              initializing={initializing}
              access={access}
              unreadable={unreadable}
              availability={availability}
              error={error}
              status={status}
              busy={busy}
              draft={draft}
              published={published}
              valid={valid}
              title={title}
              detailsError={detailsError}
              priceError={priceError}
              topUp={topUp}
              complete={complete}
              storageCanRetry={storageCanRetry}
              agreement={agreement}
              quote={quote}
              onClose={onClose}
              change={change}
              payForStorage={payForStorage}
              publish={publish}
              prepare={prepare}
            />
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

/** A small `Pill`'s height: the row the back action gets to itself, above the photo strip. */
const HEADER_ROW = 46;
const s = StyleSheet.create({
  sheet: { ...sheetStyles.sheet, marginTop: "20%" },
});
