/** Local developer tool. App.tsx loads this only in an explicitly configured devnet debug build. */
import { useEffect, useRef, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useMobileWallet, type KitMobileWallet } from "@wallet-ui/react-native-kit";
import { address, createNoopSigner, getBase64Encoder, getBase64EncodedWireTransaction, getSignatureFromTransaction, getTransactionDecoder } from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import { confirmTransaction, prepareTransaction, request } from "../../publications/rpc";
import { matchesReviewedMessage, reviewedFingerprint } from "../../publications/core/transferReceipt";
import { liveAuthorize } from "../solana/liveAuthorize";
import type { WalletSession } from "../solana/walletSession";
import { CHAIN } from "../solana/cluster";
import { Pill } from "../ui/primitives/Pill";
import { colors } from "../ui/theme";
import { safeErrorText } from "../ui/errorText";

const endpoint = "https://api.devnet.solana.com";
/** The session's whole budget, as its `balance` command prints it ("total"). */
const target = Number(process.env.EXPO_PUBLIC_DEVNET_TEST_LAMPORTS ?? "");
type Review = { source: string; balance: number; amount: number };
type Attempt = { signature: string; lastValidBlockHeight: string; confirmed?: boolean; wire?: string; quoteId?: string };
const sol = (value: number) => (value / 1_000_000_000).toFixed(9).replace(/\.?0+$/, "");

export function DevnetFunding({ onClose }: { onClose(): void }) {
  const { account, chain, identity, store, connectAnd } = useMobileWallet();
  const withWallet = connectAnd as unknown as WalletSession["connectAnd"];
  const recipient = process.env.EXPO_PUBLIC_DEVNET_TEST_PAYER ?? "";
  const key = `seedshot.devnet-funding.v1:${recipient}`;
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [review, setReview] = useState<Review | null>(null);
  const [done, setDone] = useState(false);
  const [status, setStatus] = useState("Use your S2 wallet to fund this development test session.");

  // Public diagnostics only: never log the wallet object, authorization token, or signing data.
  useEffect(() => {
    console.info("Devnet funding state", JSON.stringify({ chain, recipient,
      source: account?.address ?? null, review, busy, done, status }));
  }, [chain, recipient, account?.address, review, busy, done, status]);
  useEffect(() => {
    let live = true;
    void AsyncStorage.getItem(key).then(async saved => {
      if (!saved) { console.info("Devnet funding receipt: none saved"); return; }
      const attempt = JSON.parse(saved) as Attempt;
      const { signature, lastValidBlockHeight, confirmed } = attempt;
      console.info("Devnet funding receipt", JSON.stringify({ signature, lastValidBlockHeight, confirmed }));
      const { value } = await request<{ value: ({ err: unknown; confirmationStatus: string } | null)[] }>(
        endpoint, "getSignatureStatuses", [[signature], { searchTransactionHistory: true }]);
      if (value[0] && !value[0].err && ["confirmed", "finalized"].includes(value[0].confirmationStatus)) {
        await AsyncStorage.setItem(key, JSON.stringify({ ...attempt, confirmed: true }));
        if (live) { setDone(true); setStatus(`Devnet funding confirmed.\n${signature}`); }
      }
    }).catch(error => console.warn("Devnet funding receipt read failed", safeErrorText(error)));
    return () => { live = false; };
  }, [key]);

  async function guard() {
    if (CHAIN !== "solana:devnet" || chain !== "solana:devnet")
      throw new Error("This tool requires a devnet build.");
    if (!Number.isSafeInteger(target) || target <= 0)
      throw new Error("EXPO_PUBLIC_DEVNET_TEST_LAMPORTS is not set to the session's total.");
    address(recipient);
    if (await request(endpoint, "getGenesisHash", []) !== "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG")
      throw new Error("The connection is not devnet.");
  }

  async function balance(account: string) {
    const { value } = await request<{ value: number }>(endpoint, "getBalance", [account, { commitment: "confirmed" }]);
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid devnet balance.");
    return value;
  }

  async function alreadyFunded() {
    const saved = await AsyncStorage.getItem(key);
    if (saved) {
      const previous = JSON.parse(saved) as Attempt;
      if (!previous.confirmed) {
        // Recover the same signed transaction after a transport failure; never sign a second one.
        await submit(previous);
        await AsyncStorage.setItem(key, JSON.stringify({ ...previous, confirmed: true }));
      }
      setDone(true);
      setStatus(`Devnet funding confirmed.\n${previous.signature}`);
      return true;
    }
    if (await balance(recipient) >= target) {
      setDone(true);
      setStatus("The test session is already funded.");
      return true;
    }
    return false;
  }

  async function submit(attempt: Attempt) {
    const { value: statuses } = await request<{ value: ({ err: unknown; confirmationStatus: string } | null)[] }>(
      endpoint, "getSignatureStatuses", [[attempt.signature], { searchTransactionHistory: true }]);
    const previous = statuses[0];
    if (previous && ["confirmed", "finalized"].includes(previous.confirmationStatus)) {
      if (previous.err) throw new Error(`Funding transaction failed: ${JSON.stringify(previous.err)}`);
      return;
    }
    if (attempt.wire && attempt.quoteId) {
      const transaction = getTransactionDecoder().decode(getBase64Encoder().encode(attempt.wire));
      if (getSignatureFromTransaction(transaction) !== attempt.signature ||
        !matchesReviewedMessage(new Uint8Array(transaction.messageBytes), attempt.quoteId))
        throw new Error("The saved funding transaction does not match its review.");
      const { value: simulation } = await request<{ value: { err: unknown } }>(endpoint, "simulateTransaction",
        [attempt.wire, { encoding: "base64", commitment: "confirmed", sigVerify: true }]);
      if (simulation.err) throw new Error(`Devnet simulation failed: ${JSON.stringify(simulation.err)}`);
      await guard();
      const submitted = await request(endpoint, "sendTransaction",
        [attempt.wire, { encoding: "base64", preflightCommitment: "confirmed", maxRetries: 5 }]);
      if (submitted !== attempt.signature) throw new Error("Unexpected receipt. Check funding before doing anything else.");
    }
    await confirmTransaction(endpoint, attempt.signature, BigInt(attempt.lastValidBlockHeight));
  }

  async function run(send: boolean) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      await guard();
      if (await alreadyFunded()) return;
      if (!send) {
        setStatus("Choose S2 in the wallet. This first step only checks its devnet balance.");
        const account = await connectAnd(wallet =>
          liveAuthorize({ store, chain, identity }, wallet as KitMobileWallet));
        if (!account) throw new Error("Wallet connection was cancelled. Choose S2 to continue.");
        if (account.address === recipient) throw new Error("Select S2, not the temporary test wallet.");
        const [sourceBalance, recipientBalance] = await Promise.all([balance(account.address), balance(recipient)]);
        const amount = Math.max(0, target - recipientBalance);
        if (sourceBalance < amount + 100_000) throw new Error(`Selected wallet has ${sol(sourceBalance)} devnet SOL; ${sol(amount)} plus the network fee is needed. Choose S2.`);
        setReview({ source: account.address, balance: sourceBalance, amount });
        setStatus("Review the transfer below, then approve it in your S2 wallet.");
        return;
      }
      if (!review || review.amount <= 0) throw new Error("Check the wallet balance again.");
      const quoted = review;
      setStatus("Waiting for the S2 wallet to sign the devnet transfer…");
      const attempt = await withWallet(async rawWallet => {
        const wallet = rawWallet as KitMobileWallet;
        const account = await liveAuthorize({ store, chain, identity }, wallet);
        if (account.address !== quoted.source) throw new Error("The selected wallet changed. Check S2 again.");
        await guard();
        if (await alreadyFunded()) return;
        if (Math.max(0, target - await balance(recipient)) !== quoted.amount)
          throw new Error("The test balance changed. Check the amount again.");
        const prepared = await prepareTransaction(endpoint, quoted.source, [getTransferSolInstruction({
          source: createNoopSigner(address(quoted.source)), destination: address(recipient), amount: quoted.amount,
        })], [], BigInt(quoted.amount));
        const signed = await wallet.signTransactions({ transactions: [prepared.transaction] });
        const quoteId = reviewedFingerprint(new Uint8Array(prepared.transaction.messageBytes));
        if (signed.length !== 1) throw new Error("The wallet did not return one signed transfer.");
        const transaction = signed[0];
        const signature = getSignatureFromTransaction(transaction);
        const wire = getBase64EncodedWireTransaction(transaction);
        // Keep the signed candidate even if validation fails, so it can be diagnosed without
        // another approval. Sign-only has not broadcast it.
        await AsyncStorage.setItem(`${key}:signed`, JSON.stringify({ wire, quoteId, signature }));
        if (!matchesReviewedMessage(new Uint8Array(transaction.messageBytes), quoteId))
          throw new Error("The signed transfer changed its recipient, amount or allowed fee. Nothing was submitted.");
        const attempt: Attempt = { signature, lastValidBlockHeight: String(prepared.lastValidBlockHeight), wire, quoteId };
        await AsyncStorage.setItem(key, JSON.stringify(attempt));
        return attempt;
      });
      if (!attempt) return;
      // End the wallet association before polling. Android can suspend this app's timers while
      // the wallet is foreground, making a confirmed transfer look stuck or time out.
      setStatus("Confirming the devnet transfer…");
      await submit(attempt);
      await AsyncStorage.setItem(key, JSON.stringify({ ...attempt, confirmed: true }));
      setDone(true);
      setStatus(`Devnet funding confirmed.\n${attempt.signature}`);
    } catch (error) {
      setStatus(safeErrorText(error));
      setReview(null);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return <SafeAreaView style={s.safe}><ScrollView contentContainerStyle={s.content}>
    <Text style={s.title}>Fund devnet tests</Text>
    <Text style={s.text}>DEVNET · Test tokens only</Text>
    <Text style={s.text}>Funds the program deployment and publishing, collecting and sales tests. The temporary session needs a total balance of {sol(target)} devnet SOL.</Text>
    <Text style={s.text}>Test recipient</Text>
    <Text selectable style={s.address}>{recipient}</Text>
    {review && <View style={s.review}>
      <Text style={s.text}>From S2 (selected wallet)</Text>
      <Text selectable style={s.address}>{review.source}</Text>
      <Text style={s.text}>Available: {sol(review.balance)} devnet SOL</Text>
      <Text style={s.text}>Send: {sol(review.amount)} devnet SOL + network fee</Text>
    </View>}
    <Text selectable accessibilityLiveRegion="polite" style={s.text}>{status}</Text>
    {!done && <Pill label={review ? `Approve ${sol(review.amount)} devnet SOL` : "Check S2 wallet / funding"}
      loading={busy} disabled={busy} onPress={() => void run(review !== null)} />}
    <Pill label="Back to camera" variant="secondary" disabled={busy} onPress={onClose} />
  </ScrollView></SafeAreaView>;
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.ground },
  content: { padding: 24, gap: 18 },
  title: { color: colors.ink, fontSize: 28, fontWeight: "600" },
  text: { color: colors.ink, fontSize: 16, lineHeight: 23 },
  address: { color: colors.teal, fontSize: 15, lineHeight: 22 },
  review: { gap: 12, paddingVertical: 12 },
});
