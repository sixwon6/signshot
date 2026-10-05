import { CostEstimate } from "./CostEstimate";
import { sheetStyles } from "./sheetStyles";
import { Row } from "./SheetRow";
/**
 * OfferSheet: the creator's price for the remaining copies of one edition.
 *
 * Keyed by edition, not photograph: the Collection tab can open it for a publication whose photo is
 * not on this phone. "Continue" prepares the change and shows the estimate; only the next tap
 * opens the wallet, and a cleared quote can never be approved. The price reaches the creator; the
 * estimate is what the creator pays to change it, so the two are never added.
 */
import { useEffect, useState } from "react";
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
  prepareClose,
  prepareOffer,
  samePrice,
  sendOffer,
  type EditionOffer,
  type OfferQuote,
} from "./offer";
import { formatSol, formatUnits, parseSolPrice, parseUnits } from "./price";
import { priceOf, priceToken, priceValue } from "./priceToken";
import type { Price } from "../../publications/candy/edition";
import { colors, space } from "../ui/theme";
import { Chip, NetworkLabel, Pill } from "../ui/primitives";
import {
  actions,
  onChain,
  price as copy,
  walletTimeout,
} from "../ui/copy";
import { safeErrorText } from "../ui/errorText";
import { useSheetOperation, walletOutcome } from "./useSheetOperation";

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
  const insets = useSafeAreaInsets();
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
  } = useSheetOperation<OfferQuote>(copy.loading);
  /** What the chain says now: the current offer, and whether this app can price the edition. */
  const [current, setCurrent] = useState<EditionOffer | null>(null);
  const [supported, setSupported] = useState<boolean | null>(null);
  const [priceText, setPriceText] = useState("");
  const [priceUnit, setPriceUnit] = useState<"sol" | "token">("sol");
  // The sale was closed in this sheet: the heading and the row say so, not "Price set" and "Free".
  const [closed, setClosed] = useState(false);
  const token = priceToken();
  /** Set means a price change confirmed in this sheet; the flow is finished. */
  const [saved, setSaved] = useState<EditionOffer | null>(null);

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
        const offer = next.offer;
        setPriceUnit(offer?.kind === "token" ? "token" : "sol");
        const known = priceToken();
        setPriceText(offer?.kind === "sol" ? formatSol(offer.lamports)
          : offer?.kind === "token" && known ? formatUnits(offer.amount, known.decimals) : "");
        setStatus(next.supported ? "" : next.reason ?? copy.unsupported);
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

  /** "Continue": prepare the change and show what it would cost. Nothing is signed here. */
  async function review() {
    if (running.current || !supported || finished) return;
    if (isOfferWorking(edition.edition)) {
      setStatus(copy.working);
      return;
    }
    let price: Price;
    try {
      const known = priceToken();
      price = priceUnit === "token" && known
        ? priceOf("token", parseUnits(priceText, known.decimals))
        : priceOf("sol", parseSolPrice(priceText));
    } catch (e) {
      clearQuote();
      setError(safeErrorText(e, copy.invalid));
      setStatus("");
      return;
    }
    return run(async () => {
      setError("");
      // The estimate belongs to this check. Cleared first so a refusal cannot leave the old one up.
      clearQuote();
      setStatus("");
      try {
        const next = await prepareOffer(edition, price);
        setQuote(next);
      } catch (e) {
        clearQuote();
        // A cost check signs nothing, so nothing can have changed.
        showCheckFailure(e, {
          timedOut: walletTimeout.offerCostCheck,
          cancelled: copy.cancelled,
          fallback: copy.invalid,
        });
      }
    });
  }

  /** "Close sale": review closing, simulated and costed. Nothing is signed here. */
  async function reviewClose() {
    if (running.current || !supported || finished) return;
    return run(async () => {
      setError("");
      clearQuote();
      setStatus("");
      try {
        setQuote(await prepareClose(edition));
      } catch (e) {
        clearQuote();
        showCheckFailure(e, { timedOut: walletTimeout.offerCostCheck, cancelled: copy.cancelled, fallback: copy.invalid });
      }
    });
  }

  /** "Set price": the one tap that opens the wallet to sign. */
  async function send() {
    if (!quote || currentQuote.current !== quote) return;
    return run(async () => {
      setError("");
      try {
        const next = await sendOffer(edition, quote, session, (phase) =>
          setStatus(phase === "wallet" ? copy.progressWallet : copy.progressConfirming),
        );
        clearQuote();
        setCurrent(next);
        setSaved(next ?? { kind: "free" });
        setStatus("");
        if (quote.action === "close") {
          setSupported(false);
          setClosed(true);
        }
        onSaved?.();
      } catch (e) {
        clearQuote();
        // Seed Vault broadcasts first and answers only when its success screen is closed, so a
        // timeout usually means the price is already set. The re-read below is what decides, never
        // the error.
        const { cancelled, timedOut, quiet } = walletOutcome(e);
        if (timedOut) setStatus(walletTimeout.offerChecking);
        const after = await getOffer(edition).catch(() => null);
        if (after) {
          setSupported(after.supported);
          setCurrent(after.offer);
        }
        // A fresh read can resolve an approval whose answer was lost, and then supersedes the
        // error. Checked as `offer.ts` does: the approved price, or a closed sale.
        const landed =
          !!after &&
          (quote.action === "close" ? !after.supported : after.supported && samePrice(after.offer, quote.price));
        if (landed) {
          setSaved(after.offer ?? { kind: "free" });
          setClosed(quote.action === "close");
          setError("");
          setStatus(timedOut ? walletTimeout.offerFound : "");
          onSaved?.();
          return;
        }
        setError(quiet ? "" : safeErrorText(e, copy.invalid));
        setStatus(
          timedOut
            ? walletTimeout.offerPending
            : cancelled
              ? copy.cancelled
              : "",
        );
      }
    });
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
            <Text style={sheetStyles.title}>{closed ? copy.headingClosed : finished ? copy.headingSet : copy.heading}</Text>
            {/* Which edition this price belongs to, in its own words. */}
            <Text style={sheetStyles.readout}>{edition.title}</Text>
            <View style={sheetStyles.box}>
              <Row
                label={copy.currentLabel}
                value={closed ? copy.closedValue : priceValue(shown)}
              />
            </View>
            {supported && !finished && (
              <View style={sheetStyles.field}>
                <Text style={sheetStyles.label}>{token ? "New price" : copy.newLabel}</Text>
                {!!token && (
                  <View style={{ flexDirection: "row", gap: space.sm }} accessibilityRole="radiogroup">
                    <Chip label="SOL" size="small" accessibilityRole="radio" selected={priceUnit === "sol"}
                      disabled={busy} onPress={() => { setPriceUnit("sol"); clearQuote(); }} style={{ flex: 1 }} />
                    <Chip label={token.label} size="small" accessibilityRole="radio" selected={priceUnit === "token"}
                      disabled={busy} onPress={() => { setPriceUnit("token"); clearQuote(); }} style={{ flex: 1 }} />
                  </View>
                )}
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
                    quote.action === "close" ? "Closed" : priceValue(quote.price)
                  }
                />
                <CostEstimate prepared={quote.prepared} expanded={showCost}
                  onToggle={() => setShowCost((v) => !v)} />
                {quote.action === "close" && <Text style={sheetStyles.body}>Closing ends the sale.</Text>}
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
                label={quote.action === "close" ? "Close sale" : actions.setPrice}
                accessibilityHint={onChain.setPrice}
                disabled={busy}
                onPress={() => void send()}
              />
            ) : (
              <>
                <Pill
                  label={actions.continueToPublish}
                  accessibilityHint={onChain.setPrice}
                  disabled={busy || !supported}
                  onPress={() => void review()}
                />
                <Pill label="Close sale" variant="secondary" disabled={busy || !supported} onPress={() => void reviewClose()} />
              </>
            )}
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
