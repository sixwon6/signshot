import { CostEstimate } from "./CostEstimate";
import { sheetStyles } from "./sheetStyles";
import { useEffect, useRef, useState } from "react";
import {
  Linking,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { WalletSession } from "../solana/walletSession";
import {
  getTransferState,
  prepareTransfer,
  sendTransfer,
  type TransferQuote,
  type TransferState,
  type TransferTarget,
} from "./transfer";
import { colors, radius, space } from "../ui/theme";
import { typeScale as type } from "../ui/type";
import { NetworkLabel, PhotoFrame, Pill } from "../ui/primitives";
import {
  actions,
  changedEstimate,
  expiredEstimate,
  onChain,
  send as copy,
  walletTimeout,
} from "../ui/copy";
import { safeErrorText } from "../ui/errorText";
import {
  isChangedQuote,
  isExpiredQuote,
  isUserCancellation,
  isWalletResponseTimeout,
} from "../solana/walletErrors";

/** One sheet for print #1 on the photo page and for any copy the WALLET screen holds. */
export function SendSheet({
  target,
  image,
  session,
  onClose,
  onSent,
}: {
  target: TransferTarget;
  /** The copy's picture on its paper; absent for a hidden or blocked one. */
  image?: string;
  session: WalletSession;
  onClose(): void;
  /** A send from this sheet confirmed. */
  onSent?(): void;
}) {
  const insets = useSafeAreaInsets(),
    running = useRef(false);
  const request = useRef(0),
    currentState = useRef<TransferState | null>(null),
    currentQuote = useRef<TransferQuote | null>(null);
  const [recipient, setRecipient] = useState(""),
    [quote, setQuote] = useState<TransferQuote | null>(null);
  const [newTransfer, setNewTransfer] = useState(false);
  const [showCost, setShowCost] = useState(false);
  const [state, setState] = useState<Awaited<
    ReturnType<typeof getTransferState>
  > | null>(null);
  const [busy, setBusy] = useState(false),
    [status, setStatus] = useState("Checking previous sends…"),
    [error, setError] = useState("");

  function clearQuote() {
    currentQuote.current = null;
    setQuote(null);
  }
  function applyState(next: TransferState) {
    currentState.current = next;
    setState(next);
    clearQuote();
    setError("");
    setStatus(next.reason ?? "");
    if (!canReview(next)) setNewTransfer(false);
  }
  useEffect(() => {
    let live = true;
    const id = ++request.current;
    currentState.current = null;
    setState(null);
    clearQuote();
    setNewTransfer(false);
    setRecipient("");
    setStatus("Checking previous sends…");
    void getTransferState(target)
      .then((next) => {
        if (live && id === request.current) {
          applyState(next);
          if (next.attempt) setRecipient(next.attempt.recipient);
        }
      })
      .catch((e) => {
        if (live && id === request.current) setError(safeErrorText(e));
      });
    return () => {
      live = false;
    };
  }, [target.edition.edition, target.number]);
  async function check() {
    if (running.current) return;
    const id = ++request.current;
    clearQuote();
    running.current = true;
    setBusy(true);
    setError("");
    try {
      const next = await getTransferState(target);
      if (id === request.current) {
        // A send that timed out in the wallet can confirm on a later check.
        if (next.status === "sent" && currentState.current?.status !== "sent") onSent?.();
        applyState(next);
      }
    } catch (e) {
      currentState.current = null;
      setState(null);
      setError(safeErrorText(e));
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  async function review() {
    if (running.current || !canReview(currentState.current)) return;
    clearQuote();
    running.current = true;
    setBusy(true);
    setError("");
    setStatus("Checking…");
    try {
      const owner = await session.connectAnd((wallet) =>
        session.authorizeSession(wallet),
      );
      const next = await prepareTransfer(
        target,
        recipient.trim(),
        owner.address,
      );
      currentQuote.current = next;
      setQuote(next);
      setStatus("Check the full recipient address.");
    } catch (e) {
      clearQuote();
      // A review opens the wallet only to learn which account holds the copy, so a wallet that
      // never answers has still sent nothing.
      const timedOut = isWalletResponseTimeout(e);
      if (!isUserCancellation(e)) {
        const next = await getTransferState(target).catch(() => null);
        if (next) applyState(next);
        else {
          currentState.current = null;
          setState(null);
        }
      }
      setError(isUserCancellation(e) || timedOut ? "" : safeErrorText(e));
      setStatus(
        timedOut
          ? walletTimeout.transferReview
          : isUserCancellation(e)
            ? "Wallet closed."
            : "",
      );
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  async function send() {
    if (
      running.current ||
      !quote ||
      currentQuote.current !== quote ||
      !canReview(currentState.current)
    )
      return;
    running.current = true;
    setBusy(true);
    setError("");
    try {
      await sendTransfer(target, session, quote, (phase) =>
        setStatus(
          phase === "wallet"
            ? "Approve this transfer in your wallet…"
            : "Waiting for Solana confirmation…",
        ),
      );
      clearQuote();
      onSent?.();
      const next = await getTransferState(target);
      applyState(next);
      setNewTransfer(false);
    } catch (e) {
      clearQuote();
      // Seed Vault broadcasts first and replies only when its success screen is closed, so a
      // timeout usually means the copy was already sent.
      const timedOut = isWalletResponseTimeout(e);
      const expired = isExpiredQuote(e);
      const changed = isChangedQuote(e);
      setError(
        isUserCancellation(e) || timedOut || expired || changed
          ? ""
          : safeErrorText(e),
      );
      if (timedOut) setStatus(walletTimeout.sendChecking);
      // The same read "Check transfer status" performs, run by the sheet itself.
      const next = await getTransferState(target).catch(() => null);
      if (next) applyState(next);
      else {
        currentState.current = null;
        setState(null);
      }
      setNewTransfer(false);
      // A fresh read can resolve a send whose initial receipt check failed. Its result
      // supersedes that error; do not put retry instructions beneath a confirmed transfer.
      if (next?.status === "sent" && !expired && !changed &&
          next.attempt?.recipient === quote.recipient) {
        onSent?.();
        setError("");
        if (timedOut) setStatus(walletTimeout.sendFound);
        return;
      }
      setError(isUserCancellation(e) || timedOut || expired || changed ? "" : safeErrorText(e));
      setStatus(
        timedOut
          ? next?.status === "sent"
            ? walletTimeout.sendFound
            : walletTimeout.sendPending
          : changed
            ? changedEstimate.transfer
            : expired
              ? expiredEstimate.transfer
              : `${isUserCancellation(e) ? "Wallet closed. " : ""}Check the transfer status before retrying.`,
      );
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  const sent = state?.status === "sent",
    unresolved = state?.status === "unresolved",
    history = sent || unresolved,
    blocked = !canReview(state),
    showRecipient = !history || newTransfer;
  const devnet = target.edition.cluster === "devnet";
  const heading =
    sent && !newTransfer
      ? copy.headingConfirmed
      : unresolved && !newTransfer
        ? copy.headingUnknown
        : copy.heading;
  return (
    <Modal
      animationType="slide"
      onRequestClose={() => {
        if (!busy) onClose();
      }}
    >
      <View style={sheetStyles.root}>
        {/* The copy being sent, on its paper, above the sheet. */}
        <View
          style={[sheetStyles.print, { top: insets.top + space.xl }]}
          pointerEvents="none"
        >
          <PhotoFrame
            source={image ? { uri: image } : undefined}
            imageHeight={220}
          />
        </View>
        <View style={sheetStyles.scrim} pointerEvents="none" />
        <View style={[sheetStyles.headerRow, { paddingTop: insets.top + space.md }]}>
          <Pill
            label={actions.backToPhoto}
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
            showsVerticalScrollIndicator={false}
          >
            <NetworkLabel label={devnet ? copy.networkTest : copy.network} />
            <Text style={sheetStyles.title}>{heading}</Text>
            <Text style={sheetStyles.readout}>{copy.copyLine(target.number, target.edition.supply)}</Text>
            {showRecipient && (
              <View style={sheetStyles.field}>
                <Text style={sheetStyles.label}>{copy.recipientLabel}</Text>
                <TextInput
                  style={s.input}
                  value={recipient}
                  onChangeText={(value) => {
                    setRecipient(value);
                    clearQuote();
                    setError("");
                  }}
                  editable={!busy && !blocked}
                  autoCapitalize="none"
                  autoCorrect={false}
                  multiline
                  accessibilityLabel="Recipient Solana wallet address"
                  placeholder={copy.recipientPlaceholder}
                  placeholderTextColor={colors.muted}
                />
              </View>
            )}
            {quote && (
              <View style={sheetStyles.box}>
                <Text style={sheetStyles.label}>From</Text>
                <Text style={s.address} selectable>
                  {quote.owner}
                </Text>
                <Text style={sheetStyles.label}>To</Text>
                <Text style={s.address} selectable>
                  {quote.recipient}
                </Text>
                <CostEstimate prepared={quote.prepared} expanded={showCost}
                  onToggle={() => setShowCost((v) => !v)} label={copy.costLabel} includeAccountCost={false} />
                <Text style={sheetStyles.body}>{copy.consequence}</Text>
              </View>
            )}
            {history && state?.attempt && (
              <View style={sheetStyles.box}>
                <Text style={sheetStyles.label}>
                  {sent ? copy.confirmedRecipient : copy.earlierRecipient}
                </Text>
                <Text style={s.address} selectable>
                  {state.attempt.recipient}
                </Text>
                {!sent && <Text style={sheetStyles.body}>{copy.unresolvedBody}</Text>}
                {state.eligibility === "review" && (
                  <Text style={sheetStyles.help}>{copy.stillHeld}</Text>
                )}
              </View>
            )}
            {state?.eligibility === "moved" && (
              <Text style={sheetStyles.body}>{copy.moved}</Text>
            )}
            {state?.eligibility === "burned" && (
              <Text style={sheetStyles.body}>{copy.burned}</Text>
            )}
            {state?.eligibility === "frozen" && (
              <Text style={sheetStyles.body}>{copy.frozen}</Text>
            )}
            {state?.attempt?.signature && (
              <Pill
                label={actions.viewTransactionShort}
                variant="secondary"
                onPress={() => {
                  void Linking.openURL(
                    `https://explorer.solana.com/tx/${state.attempt!.signature}${devnet ? "?cluster=devnet" : ""}`,
                  ).catch((e) => setError(safeErrorText(e)));
                }}
              />
            )}
            {history && !newTransfer && !blocked && (
              <Pill
                label={actions.reviewNewTransfer}
                variant="secondary"
                disabled={busy}
                onPress={() => {
                  if (running.current || !canReview(currentState.current))
                    return;
                  setNewTransfer(true);
                  setRecipient("");
                  clearQuote();
                  setError("");
                  setStatus(copy.recheck);
                }}
              />
            )}
            {state && (sent || (!blocked && !(unresolved && !newTransfer))) && (
              <Pill
                label={busy ? "Checking status…" : actions.checkTransfer}
                variant="secondary"
                disabled={busy}
                onPress={() => void check()}
              />
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
            {sent && !newTransfer ? (
              <Pill label={actions.done} onPress={onClose} />
            ) : blocked || (unresolved && !newTransfer) ? (
              <Pill
                label={busy ? "Checking…" : actions.checkTransfer}
                disabled={busy}
                onPress={() => void check()}
              />
            ) : quote ? (
              <Pill
                label={busy ? "Sending…" : actions.approveAndSend}
                accessibilityHint={onChain.send}
                disabled={busy}
                onPress={() => void send()}
              />
            ) : (
              <Pill
                label={busy ? "Checking…" : actions.reviewTransfer}
                disabled={busy || !recipient.trim()}
                onPress={() => void review()}
              />
            )}
          </View>
        </View>
      </View>
    </Modal>
  );
}
function canReview(state: TransferState | null): boolean {
  return (
    !!state &&
    state.eligibility === "review" &&
    (state.status === "none" ||
      state.status === "sent" ||
      state.status === "unresolved")
  );
}
const s = StyleSheet.create({
  sheet: { ...sheetStyles.sheet, marginTop: "20%" },
  input: {
    ...type.imprint,
    textTransform: "none",
    fontSize: 13,
    lineHeight: 20,
    color: colors.ink,
    backgroundColor: colors.field,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.small,
    minHeight: 90,
    padding: 14,
    textAlignVertical: "top",
  },
  address: { ...type.imprint, textTransform: "none", fontSize: 12, lineHeight: 19, color: colors.ink },
});
