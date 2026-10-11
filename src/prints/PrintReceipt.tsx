import { Pressable, StyleSheet, Text, View } from "react-native";
import { costSol as sol } from "./CostEstimate";
import { sheetStyles } from "./sheetStyles";
import type { prepareSetup, PublicationDraft } from "./creator";
import { costRows } from "./price";
import { priceValue } from "./priceToken";
import { draftPrice } from "./creator";
import type { Price } from "../../publications/candy/edition";

/** The draft's price; an unreadable one is shown as free rather than taking the receipt down. */
function readDraftPrice(d: PublicationDraft): Price {
  try {
    return draftPrice(d);
  } catch {
    return { kind: "free" };
  }
}
import { shortAddress } from "./photoPresentation";
import { deviceName, securityLevelName } from "../../publications/core/attestation";
import { deviceValue, type DeviceCheck } from "../seeker/useDeviceVerdict";
import { colors, radius, space } from "../ui/theme";
import { typeScale as type } from "../ui/type";
import {
  collect as collectCopy,
  estimate,
  price as priceCopy,
  publish as copy,
} from "../ui/copy";

/**
 * Rows come from the validated draft, never the text fields, so they match the hashed document.
 * With no draft yet, only the wallet row.
 */
export function PrintReceipt({
  draft,
  quote,
  device,
  owner,
  ownerLabel,
  ownerName,
  showWallet,
  onToggleWallet,
}: {
  draft: PublicationDraft | null;
  quote: Awaited<ReturnType<typeof prepareSetup>> | null;
  device: DeviceCheck | null;
  owner: string | undefined;
  ownerLabel: string;
  ownerName: string | null;
  showWallet: boolean;
  onToggleWallet(): void;
}) {
  const shownPrice = draft ? priceValue(readDraftPrice(draft)) : null;
  return draft ? (
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
      {/* A buyer's price: shown beside the copies, never added into the estimate. */}
      {shownPrice !== null && <Row label={priceCopy.label} value={shownPrice} />}
      {(
        <Row label={copy.rowRoyalty} value={copy.royaltyValue(draft.royaltyBps)} />
      )}
      {draft.edition.supply > 1 && (
        <Row label={copy.rowCollectors}
          value={draft.seekerOnly ? collectCopy.seekerOnly : collectCopy.anyone} />
      )}
      {!!draft.edition.description && (
        <Row label={copy.rowMoment} value={draft.edition.description} />
      )}
      <Row
        label={copy.rowImage}
        value={`${draft.edition.width} × ${draft.edition.height}`}
      />
      {/* From the certificate sealed in the document; always shown, so missing evidence is visible. */}
      <Row
        label={copy.rowDevice}
        value={deviceValue(draft.edition, device, (a) => `${deviceName(a)} · ${securityLevelName(a)}`)}
      />
      {/* Looked up on mainnet when the draft was made. */}
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
        onToggle={onToggleWallet}
      />
      {quote?.step === "sign" && (
        <>
          <View style={sheetStyles.rule} />
          <Row
            label={estimate.networkFee}
            value={`${sol(quote.prepared.estimateBreakdown.networkFee)} SOL`}
          />
          {/* The balance delta includes the network fee, which has its own row. */}
          <Row
            label={estimate.accountCost}
            value={`${sol(costRows(quote.prepared).accounts)} SOL`}
          />
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
        onToggle={onToggleWallet}
      />
    </View>
  );
}

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

/** Address with the `.skr` name beside it. Tap for the full address. Never uppercased: base58 is case-sensitive. */
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

const s = StyleSheet.create({
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
});
