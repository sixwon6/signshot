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
  canSealGenesis,
  createDraft,
  prepareSetup,
  sendSetup,
  discardDraft,
  getPrintsAvailability,
  getPublicationState,
  payStorage,
  savedDraftPresent,
  type PublicationDraft,
  type PublicationState,
} from "./creator";
import { useStorageTopUp } from "./useStorageTopUp";
import { terms } from "../../publications/core/protocol";
import { useDeviceVerdict } from "../seeker/useDeviceVerdict";
import { normalizeDescription } from "../../publications/core/details";
import { readPhotoEdit } from "./photoStorage";
import { parseSolPrice } from "./price";
import { shortAddress } from "./photoPresentation";
import {
  configuredProgram,
  programFeatures,
} from "../../publications/deployments";
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
  changedEstimate,
  expiredEstimate,
  publish as copy,
  walletTimeout,
} from "../ui/copy";
import { safeErrorText } from "../ui/errorText";
import { assertReviewedProgram } from "../../publications/programImage";
import { useTermsAgreement } from "../moderation/store";
import { CLUSTER_NAME as cluster, IS_MAINNET, RPC_ENDPOINT } from "../solana/cluster";
import {
  isChangedQuote,
  isExpiredQuote,
  isUserCancellation,
  isWalletResponseTimeout,
} from "../solana/walletErrors";
import { useSheetOperation } from "./useSheetOperation";
import { PrintDetails } from "./PrintForm";
import { PrintReceipt } from "./PrintReceipt";
import { PrintDock } from "./PrintDock";

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
  // The terms are agreed to once, before anything is published; an upload owed by an edition
  // already on Solana is never held behind them.
  const agreement = useTermsAgreement();
  const [draft, setDraft] = useState<PublicationDraft | null>(null);
  const [edit, setEdit] = useState<PhotoEdit>();
  const [title, setTitle] = useState("");
  // The optional caption. Like the title, it is hashed into the document when the draft is
  // created and cannot change without discarding the draft.
  const [caption, setCaption] = useState("");
  // A saved draft this build cannot read. `draft` is null in that case, so this flag is what
  // offers the discard action.
  const [unreadable, setUnreadable] = useState(false);
  const [showWallet, setShowWallet] = useState(false);
  const [count, setCount] = useState("10"),
    [solo, setSolo] = useState(true);
  /** The price of a copy, as typed, in SOL; empty is free. Offered only where `priceable`. */
  const [priceText, setPriceText] = useState("");
  const [offers, setOffers] = useState(false);
  /**
   * The royalty, in basis points and whole percents, and whether only Seeker Genesis Token holders
   * may collect. Frozen into the draft like the price, and offered only where the deployment a
   * fresh publication uses takes them.
   */
  const [royaltyBps, setRoyaltyBps] = useState(DEFAULT_ROYALTY_BPS);
  const [seekerOnly, setSeekerOnly] = useState(DEFAULT_SEEKER_ONLY);
  const [distribution, setDistribution] = useState(false);
  // Seeker-only is sealed with the creator's Genesis Token, which only a mainnet build can send.
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
  // The review's Device row: a draft not yet sent is judged now, a published one at its block time.
  const device = useDeviceVerdict(draft?.edition, published);
  // Storage bought again, once the provider refused the upload or found its credit short.
  const topUp = useStorageTopUp(published ? draft : null);

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
        // The deployment a fresh publication would use decides which terms can be set.
        // `configuredProgram` throws when publishing is unavailable, already its own screen state.
        const features = (() => {
          try {
            return available.enabled ? programFeatures(configuredProgram(cluster)) : null;
          } catch {
            return null;
          }
        })();
        setOffers(!!features?.offers);
        setDistribution(!!features?.royaltiesAndSeekerOnly);
        setSealable(!!features && canSealGenesis(configuredProgram(cluster)));
        await applyPublicationState(state);
        if (!live) return;
        if (state.draft) {
          setTitle(state.draft.edition.title);
          setCaption(state.draft.edition.description);
          setSolo(state.draft.edition.supply === 1);
          setCount(String(state.draft.edition.supply));
          setRoyaltyBps(state.draft.royaltyBps);
          setSeekerOnly(state.draft.seekerOnly);
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
    return run(async () => {
      setError("");
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
          // Zero or no price publishes free.
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
            lamports,
            // An edition of 1 has nobody to collect it, so it keeps the default rule. `createDraft`
            // records Seeker-only only with the wallet's Genesis Token to seal.
            distribution ? { royaltyBps, seekerOnly: sealable && (solo || seekerOnly) } : undefined,
          );
          setDraft(current);
          onChanged?.();
        }
        await readPublicationStatus(current);
      } catch (e) {
        // A cost check opens the wallet only to learn which account is publishing, so a wallet
        // that never answers has still published nothing.
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

  // A saved draft is previewed from the validated draft, not the text field, so the screen shows
  // exactly the hashed text. An unpublishable caption is an error here, never a silent trim.
  let detailsError = "";
  try {
    normalizeDescription(draft ? draft.edition.description : caption);
  } catch (e) {
    detailsError = safeErrorText(e);
  }
  const previewTitle = draft?.edition.title ?? title.trim();

  // A price only where there is a copy to sell (an edition of 1 keeps its single copy) and the
  // program has `set_offer`; otherwise nothing on the sheet mentions a price.
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

  const valid =
    title.trim().length > 0 &&
    !detailsError &&
    !priceError &&
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
