import { CostEstimate } from "./CostEstimate";
import { sheetStyles } from "./sheetStyles";
import { Row } from "./SheetRow";
/**
 * CollectSheet: taking one numbered copy of somebody else's edition into this wallet.
 *
 * "Connect" learns which account is collecting, "Continue" simulates the claim and shows the
 * estimate, and only the last tap opens the wallet to sign. The estimate always belongs to the
 * check that produced it, and a cleared quote can never be approved. A priced edition shows the
 * publisher's price and the network costs on separate lines, so neither reads as the other.
 */
import { useEffect, useRef, useState } from "react";
import { Linking, Modal, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { WalletSession } from "../solana/walletSession";
import {
  getCollectState,
  isCollectWorking,
  loadCollectable,
  prepareCollect,
  sendCollect,
  type Collectable,
  type CollectQuote,
  type CollectState,
  type CollectTarget,
} from "./collect";
import { shortAddress } from "./photoPresentation";
import { formatSol } from "./price";
import { priceValue, tokenValue } from "./priceToken";
import { colors, space } from "../ui/theme";
import { NetworkLabel, PhotoFrame, Pill } from "../ui/primitives";
import {
  actions,
  changedEstimate,
  collect as copy,
  expiredEstimate,
  moderation as moderationCopy,
  onChain,
  price as priceCopy,
  walletTimeout,
} from "../ui/copy";
import { safeErrorText } from "../ui/errorText";
import { CLUSTER_NAME as cluster, IS_MAINNET } from "../solana/cluster";
import { collectUrl, explorerUrl } from "../../publications/core/document";
import { reportMailto } from "../moderation/core";
import { useModeration, useTermsAgreement } from "../moderation/store";
import { TermsAgreement } from "../moderation/TermsAgreement";
import { isUserCancellation } from "../solana/walletErrors";
import { useSheetOperation, walletOutcome } from "./useSheetOperation";

export function CollectSheet({
  target,
  session,
  walletAddress,
  onClose,
  onCollected,
}: {
  target: CollectTarget;
  session: WalletSession;
  walletAddress?: string;
  onClose(): void;
  onCollected?(): void;
}) {
  const insets = useSafeAreaInsets();
  const moderation = useModeration(),
    terms = useTermsAgreement();
  const {
    running,
    request,
    busy,
    status,
    setStatus,
    error,
    setError,
    quote,
    currentQuote,
    setQuote,
    clearQuote,
    showCost,
    setShowCost,
    run,
    showCheckFailure,
  } = useSheetOperation<CollectQuote>();
  const currentCollectable = useRef<Collectable | null>(null);
  const [collectable, setCollectable] = useState<Collectable | null>(null);
  const [state, setState] = useState<CollectState | null>(null);
  // The wallet this sheet is acting for: the connected one, or the one Connect just authorized.
  const [wallet, setWallet] = useState(walletAddress ?? "");
  // The copy number a confirmed collect returned. Present means the flow is finished.
  const [collected, setCollected] = useState<number | null>(null);

  // A link for another chain is refused before anything is read: on the wrong cluster the address
  // could name an unrelated account.
  const wrongNetwork = target.cluster !== cluster;

  /**
   * Re-read the edition after a refusal. A refused review or buy is most often the offer moving
   * under the quote (OfferChanged, PaymentRequired), and the price on screen must be the one the
   * chain holds now, not the one that was just refused. Best effort: a failed re-read keeps the
   * last good edition rather than blanking the sheet.
   */
  async function reload(): Promise<Collectable | null> {
    const fresh = await loadCollectable(target.edition).catch(() => null);
    if (fresh) {
      currentCollectable.current = fresh;
      setCollectable(fresh);
    }
    return fresh ?? currentCollectable.current;
  }

  /** Read the edition, then this wallet's eligibility for it. One pass, one request id. */
  useEffect(() => {
    if (wrongNetwork) {
      setStatus("");
      setError(copy.wrongNetwork);
      return;
    }
    let live = true;
    const id = ++request.current;
    currentCollectable.current = null;
    setCollectable(null);
    setState(null);
    setCollected(null);
    clearQuote();
    setError("");
    setStatus(copy.loading);
    void (async () => {
      try {
        const next = await loadCollectable(target.edition);
        if (!live || id !== request.current) return;
        currentCollectable.current = next;
        setCollectable(next);
        setStatus(wallet ? copy.checking : "");
        if (!wallet) return;
        const eligibility = await getCollectState(next, wallet);
        if (!live || id !== request.current) return;
        setState(eligibility);
        setStatus(eligibility.reason ?? "");
      } catch (e) {
        if (live && id === request.current) {
          setStatus("");
          setError(safeErrorText(e));
        }
      }
    })();
    return () => {
      live = false;
    };
  }, [target.edition, target.cluster, wallet, wrongNetwork]);

  /** Re-read this wallet's eligibility. Opens no wallet, so it is safe to run on any tap. */
  async function check() {
    const current = currentCollectable.current;
    if (!current || !wallet) return;
    return run(async () => {
      const id = ++request.current;
      clearQuote();
      setError("");
      setStatus(copy.checking);
      try {
        const next = await getCollectState(current, wallet);
        if (id !== request.current) return;
        setState(next);
        setStatus(next.reason ?? "");
      } catch (e) {
        setState(null);
        setStatus("");
        setError(safeErrorText(e));
      }
    });
  }

  /**
   * "Connect": the wallet is opened only to learn which account is collecting. The effect above
   * re-runs on the new address and reads eligibility for it.
   */
  async function connect() {
    return run(async () => {
      setError("");
      setStatus("");
      try {
        const owner = await session.connectAnd((w) => session.authorizeSession(w));
        setWallet(owner.address);
      } catch (e) {
        showCheckFailure(e, { timedOut: walletTimeout.connect, cancelled: copy.cancelled });
      }
    });
  }

  /** "Continue": simulate the collect and show what it would cost. Nothing is signed here. */
  async function review() {
    const current = currentCollectable.current;
    if (running.current || !current || !wallet || state?.eligibility !== "collect") return;
    if (isCollectWorking(current.edition.edition)) {
      setStatus(copy.working);
      return;
    }
    return run(async () => {
      setError("");
      // The estimate belongs to this check. Cleared first so a refusal cannot leave the old one up.
      clearQuote();
      setStatus("");
      try {
        const next = await prepareCollect(current, wallet);
        setQuote(next);
      } catch (e) {
        clearQuote();
        // A cost check signs nothing; eligibility may have moved, so it is re-read.
        showCheckFailure(e, { timedOut: walletTimeout.collectCostCheck, cancelled: copy.cancelled });
        if (!isUserCancellation(e)) {
          const latest = (await reload()) ?? current;
          const next = await getCollectState(latest, wallet).catch(() => null);
          if (next) setState(next);
        }
      }
    });
  }

  /** "Collect": the one tap that opens the wallet to sign. */
  async function send() {
    const current = currentCollectable.current;
    if (!current || !quote || currentQuote.current !== quote || !wallet) return;
    return run(async () => {
      setError("");
      try {
        const receipt = await sendCollect(current, quote, session, (phase) =>
          setStatus(phase === "wallet" ? copy.progressWallet : phase === "cosigner" ? copy.progressCosigner : copy.progressConfirming),
        );
        clearQuote();
        setCollected(receipt.number);
        setStatus("");
        onCollected?.();
        // The count issued so far now includes this copy.
        void reload();
      } catch (e) {
        clearQuote();
        // Seed Vault broadcasts first and answers only when its success screen is closed, so a
        // timeout usually means the copy has already been collected. The state read below is what
        // decides, never the error.
        const { cancelled, timedOut, expired, changed, quiet } = walletOutcome(e);
        if (timedOut) setStatus(walletTimeout.collectChecking);
        const latest = cancelled ? current : ((await reload()) ?? current);
        const next = await getCollectState(latest, wallet).catch(() => null);
        if (next) setState(next);
        // A fresh read can resolve a collect whose own receipt check failed. Its verdict supersedes
        // the error: never leave retry instructions under a copy that is confirmed.
        if (next?.eligibility === "already" && next.number !== undefined && !expired && !changed) {
          setCollected(next.number);
          setError("");
          setStatus(timedOut ? walletTimeout.collectFound : "");
          onCollected?.();
          return;
        }
        setError(quiet ? "" : safeErrorText(e));
        setStatus(
          timedOut
            ? walletTimeout.collectPending
            : changed
              ? changedEstimate.collect
              : expired
                ? expiredEstimate.collect
                : cancelled
                  ? copy.cancelled
                  : "",
        );
      }
    });
  }

  const e = collectable?.edition;
  /**
   * Somebody else's publication as this phone may show it: hidden by Signshot's list, blocked by
   * this viewer, or shown. A veiled edition keeps its record and loses its picture, title and
   * caption, and is not collected from here.
   */
  const veil = e ? moderation.veil(e.edition, e.creator, wallet) : null;
  const blocked = !!e && moderation.isBlocked(e.creator);
  function report() {
    void Linking.openURL(reportMailto(target.edition, collectUrl(target.edition, cluster))).catch(
      (problem) => setError(safeErrorText(problem)),
    );
  }
  // The edition's price, or null when free (`Collectable.offer`).
  const offer = collectable?.offer ?? null;
  const priced = offer !== null;
  // Buying or collecting: once there is a quote it decides, being what the wallet will approve.
  const buying = quote ? quote.kind === "buy" : priced;
  const hint = buying ? onChain.buy : onChain.collect;
  // The paper follows the photograph: the picture takes the edition's own ratio, so a portrait
  // print is tall and a landscape one wide, with the same border all round.
  const aspectRatio = e && e.width > 0 && e.height > 0 ? e.width / e.height : 1;
  const eligibility = state?.eligibility;
  const finished = collected !== null;
  const canCollect =
    !wrongNetwork && !!wallet && eligibility === "collect" && !finished && !veil;
  const heading = finished
    ? copy.headingCollected
    : wrongNetwork || eligibility === "unavailable"
      ? copy.headingUnavailable
      : veil
        ? moderationCopy[veil]
        : (e?.title ?? copy.heading);
  // The one state sentence under the readout, when the wallet cannot collect right now.
  const blocker = finished
    ? null
    : wrongNetwork
      ? copy.wrongNetwork
      : !wallet
        ? copy.needWallet
        : eligibility === "already"
          ? state?.reason ?? copy.already
          : eligibility === "soldOut"
            ? copy.soldOut
            : eligibility === "unavailable"
                ? copy.unavailable
                : // `needsGenesis` is said once, by the status beside the action.
                  null;

  return (
    <Modal
      animationType="slide"
      onRequestClose={() => {
        if (!busy) onClose();
      }}
    >
      <View style={sheetStyles.root}>
        <View style={[sheetStyles.headerRow, { paddingTop: insets.top + space.md }]}>
          {/* Always "Close": the dock carries the one terminal action, and the same word twice
              on one screen would be two answers to the same question. */}
          <Pill
            label={actions.close}
            variant="secondary"
            size="small"
            disabled={busy}
            onPress={onClose}
          />
        </View>
        <View style={sheetStyles.sheet}>
          <View style={sheetStyles.grabber} />
          <ScrollView
            style={sheetStyles.scroll}
            contentContainerStyle={sheetStyles.content}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            {/* The badge names the chain this copy would be created on. */}
            <NetworkLabel label={IS_MAINNET ? copy.network : copy.networkTest} />
            {!!e && !veil && (
              <PhotoFrame
                source={collectable?.imageUri ? { uri: collectable.imageUri } : undefined}
                title={e.title}
                byline={copy.by(shortAddress(e.creator))}
                aspectRatio={aspectRatio}
              />
            )}
            {!!e && !!collectable && (
              <Text style={sheetStyles.readout}>
                {finished
                  ? copy.yourCopy(collected, e.supply)
                  : state?.number !== undefined
                    ? copy.yourCopy(state.number, e.supply)
                    : // "COPY 3 OF 10 · 0.25 SOL": the copy this would take, and what it asks for
                      // it. A free edition says nothing, because nothing is what it asks.
                      copy.nextCopy(collectable.minted, e.supply) +
                      (offer ? ` · ${priceValue(offer)}` : "")}
              </Text>
            )}
            <Text style={sheetStyles.title}>{heading}</Text>
            {/* The caption the publisher wrote, set apart the way the Collection sets it apart. */}
            {!!e?.description && !veil && (
              <View style={s.caption}>
                <Text style={sheetStyles.label}>{copy.momentLabel}</Text>
                <Text style={sheetStyles.body}>{e.description}</Text>
              </View>
            )}
            {!!e && (
              <View style={sheetStyles.box}>
                <Row label={copy.publishedBy} value={shortAddress(e.creator)} />
                {!!collectable && (
                  <Row
                    label={copy.issuedLabel}
                    value={copy.issuedValue(collectable.minted, e.supply)}
                  />
                )}
                {!!collectable?.seekerOnly && <Row label={copy.collectorsLabel} value={copy.seekerOnly} />}
              </View>
            )}
            {!!blocker && <Text style={sheetStyles.body}>{blocker}</Text>}
            {!!collectable?.anomaly && <Text style={sheetStyles.help}>{collectable.anomaly}</Text>}
            {/* The edition itself, always: the record this sheet is reading from. */}
            {!wrongNetwork && (
              <Pill
                label={actions.viewEditionShort}
                variant="secondary"
                onPress={() => {
                  void Linking.openURL(explorerUrl(target.edition, cluster)).catch((problem) =>
                    setError(safeErrorText(problem)),
                  );
                }}
              />
            )}
            {!!e && e.creator !== wallet && (
              <View style={s.pair}>
                <Pill
                  label={moderationCopy.report}
                  variant="secondary"
                  onPress={report}
                  style={s.half}
                />
                <Pill
                  label={blocked ? moderationCopy.unblock : moderationCopy.block}
                  variant="secondary"
                  onPress={() => void moderation.setBlocked(e.creator, !blocked)}
                  style={s.half}
                />
              </View>
            )}
            {!!wallet && !finished && !wrongNetwork && !!collectable && (
              <Pill
                label={actions.checkCollect}
                variant="secondary"
                disabled={busy}
                onPress={() => void check()}
              />
            )}
          </ScrollView>
          <View style={[sheetStyles.dock, { paddingBottom: insets.bottom + space.lg }]}>
            {/* Keep the reviewed amount beside the action, even when the photo fills the scroll area. */}
            {quote && !finished && !wrongNetwork && (
              <>
                {quote.kind === "buy" && (
                  <Row label={priceCopy.label} value={priceValue(quote.price)} />
                )}
                {/* A buy's estimate already holds its price, so the total is the estimate alone. */}
                <CostEstimate prepared={quote.prepared} apart={quote.priceLamports} expanded={showCost}
                  onToggle={() => setShowCost(v => !v)} />
                {quote.kind === "buy" && (
                  <Row label={priceCopy.totalLabel}
                    value={quote.price.kind === "token"
                      ? `${tokenValue(quote.tokens)} + ${priceCopy.value(formatSol(quote.prepared.estimatedLamports))}`
                      : priceCopy.value(formatSol(quote.prepared.estimatedLamports))} />
                )}
              </>
            )}
            {!!status && (
              <Text style={sheetStyles.help} accessibilityLiveRegion="polite">
                {status}
              </Text>
            )}
            {!!error && (
              <Text style={sheetStyles.error} accessibilityLiveRegion="polite">
                {error}
              </Text>
            )}
            {finished || wrongNetwork ? (
              <Pill label={actions.done} disabled={busy} onPress={onClose} />
            ) : terms.agreed !== true ? (
              <TermsAgreement agreed={terms.agreed} onAgree={() => void terms.agree()} />
            ) : !wallet ? (
              <Pill
                label={actions.connectWallet}
                accessibilityHint={hint}
                disabled={busy}
                onPress={() => void connect()}
              />
            ) : quote ? (
              <Pill
                label={
                  quote.kind === "buy" ? actions.confirmBuy : actions.confirmCollect
                }
                accessibilityHint={hint}
                disabled={busy}
                onPress={() => void send()}
              />
            ) : eligibility === "unavailable" ? (
              <Pill
                label={actions.checkCollect}
                disabled={busy || !collectable}
                onPress={() => void check()}
              />
            ) : (
              /* Always "Continue": the first tap spends nothing, whether this is a collect or a
                 buy, and only the tap that spends carries the verb. */
              <Pill
                label={actions.continueToCollect}
                accessibilityHint={hint}
                disabled={busy || !canCollect}
                onPress={() => void review()}
              />
            )}
          </View>
        </View>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  caption: { gap: space.xs, borderLeftWidth: 2, borderLeftColor: colors.teal, paddingLeft: space.md },
  pair: { flexDirection: "row", gap: space.sm },
  half: { flex: 1 },
});
