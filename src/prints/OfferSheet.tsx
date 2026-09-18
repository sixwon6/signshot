import { CostEstimate } from "./CostEstimate";
import { sheetStyles } from "./sheetStyles";
/**
 * OfferSheet — the creator's price for the remaining copies of one edition.
 *
 * Keyed by EDITION, never by photograph: the Collection tab can open this for a publication whose
 * photo is not on this phone, and the price belongs to the publication either way.
 *
 * The same two taps as PrintSheet, SendSheet and CollectSheet: "Continue" connects the wallet only
 * to learn which account is signing and shows a simulated estimate, "Set price" opens the wallet to
 * sign. Only the tap that spends carries the verb, and the estimate on screen always belongs to the
 * check that produced it — a cleared quote can never be approved.
 *
 * The price is the creator's own amount and reaches the creator. The estimate below it is the
 * network fee and rent for the offer account, which the creator pays; the two are never added
 * together here, because nobody pays both.
 */
import { useEffect, useRef, useState } from "react";
import {
  KeyboardAvoidingView,
  Modal,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { WalletSession } from "../solana/walletSession";
import type { CoreMetadata } from "../../publications/types";
import {
  getOffer,
  isOfferWorking,
  prepareOffer,
  sendOffer,
  type OfferQuote,
} from "./offer";
import type { EditionOffer } from "../../publications/core/protocol";
import { formatSol, parseSolPrice } from "./price";
import { colors, space } from "../ui/theme";
import { NetworkLabel, Pill } from "../ui/primitives";
import {
  actions,
  changedEstimate,
  expiredEstimate,
  onChain,
  price as copy,
  walletTimeout,
} from "../ui/copy";
import { safeErrorText } from "../ui/errorText";
import {
  isChangedQuote,
  isExpiredQuote,
  isUserCancellation,
  isWalletResponseTimeout,
} from "../solana/walletErrors";

export function OfferSheet({
  edition,
  session,
  onClose,
  onSaved,
}: {
  edition: CoreMetadata;
  session: WalletSession;
  onClose(): void;
  /** The price changed on chain. The caller re-reads whatever list it is showing. */
  onSaved?(): void;
}) {
  const insets = useSafeAreaInsets(),
    running = useRef(false);
  // Every async result is tagged with the read that asked for it, so a slow answer for an earlier
  // edition can never paint over a newer one.
  const request = useRef(0),
    currentQuote = useRef<OfferQuote | null>(null);
  /** What the chain says now: the current offer, and whether this deployment can hold one. */
  const [current, setCurrent] = useState<EditionOffer | null>(null);
  const [supported, setSupported] = useState<boolean | null>(null);
  const [priceText, setPriceText] = useState("");
  const [quote, setQuote] = useState<OfferQuote | null>(null);
  /** Set means a `set_offer` confirmed in this sheet; the flow is finished. */
  const [saved, setSaved] = useState<EditionOffer | null>(null);
  const [showCost, setShowCost] = useState(false);
  const [busy, setBusy] = useState(false),
    [status, setStatus] = useState<string>(copy.loading),
    [error, setError] = useState("");

  function clearQuote() {
    currentQuote.current = null;
    setQuote(null);
  }

  /** Read the edition's price. Opens no wallet, so it runs on its own. */
  useEffect(() => {
    let live = true;
    const id = ++request.current;
    clearQuote();
    setCurrent(null);
    setSupported(null);
    setSaved(null);
    setError("");
    setStatus(copy.loading);
    void (async () => {
      try {
        const next = await getOffer(edition);
        if (!live || id !== request.current) return;
        setSupported(next.supported);
        setCurrent(next.offer);
        // The field starts at the price that is already set, so leaving it alone changes nothing
        // and clearing it is how a creator makes the edition free again.
        setPriceText(next.offer ? formatSol(next.offer.priceLamports) : "");
        setStatus(next.supported ? "" : copy.unsupported);
      } catch (e) {
        if (live && id === request.current) {
          setStatus("");
          setError(safeErrorText(e, copy.unavailable));
        }
      }
    })();
    return () => {
      live = false;
    };
  }, [edition.edition]);

  /** "Continue": simulate `set_offer` and show what it would cost. Nothing is signed here. */
  async function review() {
    if (running.current || !supported || finished) return;
    if (isOfferWorking(edition.edition)) {
      setStatus(copy.working);
      return;
    }
    let lamports: bigint;
    try {
      lamports = parseSolPrice(priceText);
    } catch (e) {
      clearQuote();
      setError(safeErrorText(e, copy.invalid));
      setStatus("");
      return;
    }
    running.current = true;
    setBusy(true);
    setError("");
    // The estimate belongs to this check. Cleared first so a refusal cannot leave the old one up.
    clearQuote();
    setStatus("");
    try {
      const next = await prepareOffer(edition, lamports);
      currentQuote.current = next;
      setQuote(next);
    } catch (e) {
      clearQuote();
      // A cost check opens the wallet only to learn which account is signing, so nothing can have
      // been changed by it.
      const timedOut = isWalletResponseTimeout(e);
      setError(isUserCancellation(e) || timedOut ? "" : safeErrorText(e, copy.invalid));
      setStatus(
        timedOut
          ? walletTimeout.offerCostCheck
          : isUserCancellation(e)
            ? copy.cancelled
            : "",
      );
    } finally {
      running.current = false;
      setBusy(false);
    }
  }

  /** "Set price": the one tap that opens the wallet to sign. */
  async function send() {
    if (running.current || !quote || currentQuote.current !== quote) return;
    running.current = true;
    setBusy(true);
    setError("");
    try {
      const next = await sendOffer(edition, quote, session, (phase) =>
        setStatus(phase === "wallet" ? copy.progressWallet : copy.progressConfirming),
      );
      clearQuote();
      setCurrent(next);
      setSaved(next);
      setStatus("");
      onSaved?.();
    } catch (e) {
      clearQuote();
      // Seed Vault broadcasts first and answers only when its success screen is closed, so a
      // timeout usually means the price is already set. The re-read below is what decides, never
      // the error.
      const timedOut = isWalletResponseTimeout(e);
      const expired = isExpiredQuote(e);
      const changed = isChangedQuote(e);
      if (timedOut) setStatus(walletTimeout.offerChecking);
      const after = await getOffer(edition).catch(() => null);
      if (after) {
        setSupported(after.supported);
        setCurrent(after.offer);
      }
      // A fresh read can resolve an approval whose own answer was lost. Its verdict supersedes the
      // error: never leave retry instructions under a price that is already set.
      // Both halves, the way `offer.ts` verifies it itself: the price must be the approved one AND
      // the revision must have moved past the one this quote was built against. The revision is
      // what makes "set it free" provable — a cancelled free change and a confirmed one would
      // otherwise both read as a price of zero.
      const landed =
        !expired &&
        !changed &&
        !!after &&
        (after.offer?.revision ?? 0) > quote.fromRevision &&
        (after.offer?.priceLamports ?? 0n) === quote.priceLamports;
      if (landed) {
        setSaved(after.offer ?? { priceLamports: 0n, revision: 0 });
        setError("");
        setStatus(timedOut ? walletTimeout.offerFound : "");
        onSaved?.();
        return;
      }
      setError(
        isUserCancellation(e) || timedOut || expired || changed ? "" : safeErrorText(e, copy.invalid),
      );
      setStatus(
        timedOut
          ? walletTimeout.offerPending
          : changed
            ? changedEstimate.offer
            : expired
              ? expiredEstimate.offer
              : isUserCancellation(e)
                ? copy.cancelled
                : "",
      );
    } finally {
      running.current = false;
      setBusy(false);
    }
  }

  const finished = saved !== null;
  const devnet = edition.cluster === "devnet";
  const shown = saved ?? current;
  return (
    <Modal
      animationType="slide"
      onRequestClose={() => {
        if (!busy) onClose();
      }}
    >
      <KeyboardAvoidingView behavior="height" style={sheetStyles.root}>
        <View style={[sheetStyles.headerRow, { paddingTop: insets.top + space.md }]}>
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
            keyboardDismissMode="on-drag"
            showsVerticalScrollIndicator={false}
          >
            <NetworkLabel label={devnet ? copy.networkTest : copy.network} />
            <Text style={sheetStyles.title}>{finished ? copy.headingSet : copy.heading}</Text>
            {/* Which edition this price belongs to, in its own words. */}
            <Text style={sheetStyles.readout}>{edition.title}</Text>
            <View style={sheetStyles.box}>
              <Row
                label={copy.currentLabel}
                value={
                  shown ? copy.value(formatSol(shown.priceLamports)) : copy.free
                }
              />
            </View>
            {supported && !finished && (
              <View style={sheetStyles.field}>
                <Text style={sheetStyles.label}>{copy.newLabel}</Text>
                <TextInput
                  style={sheetStyles.input}
                  accessibilityLabel={copy.newLabel}
                  value={priceText}
                  onChangeText={(value) => {
                    setPriceText(value);
                    clearQuote();
                    setError("");
                  }}
                  editable={!busy}
                  keyboardType="decimal-pad"
                  placeholder={copy.publishPlaceholder}
                  placeholderTextColor={colors.muted}
                  maxLength={24}
                />
              </View>
            )}
            {quote && (
              <View style={sheetStyles.box}>
                <Row
                  label={copy.label}
                  value={
                    quote.priceLamports > 0n
                      ? copy.value(formatSol(quote.priceLamports))
                      : copy.free
                  }
                />
                <CostEstimate prepared={quote.prepared} expanded={showCost}
                  onToggle={() => setShowCost((v) => !v)} />
              </View>
            )}
          </ScrollView>
          <View style={[sheetStyles.dock, { paddingBottom: insets.bottom + space.lg }]}>
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
            {finished || supported === false ? (
              <Pill label={actions.done} disabled={busy} onPress={onClose} />
            ) : quote ? (
              <Pill
                label={actions.setPrice}
                accessibilityHint={onChain.setPrice}
                disabled={busy}
                onPress={() => void send()}
              />
            ) : (
              <Pill
                label={actions.continueToPublish}
                accessibilityHint={onChain.setPrice}
                disabled={busy || !supported}
                onPress={() => void review()}
              />
            )}
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

/** One label/value line of a box. */
function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={sheetStyles.rowLine}>
      <Text style={sheetStyles.label}>{label}</Text>
      <Text style={sheetStyles.rowValue}>{value}</Text>
    </View>
  );
}
