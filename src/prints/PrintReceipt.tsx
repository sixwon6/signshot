import { Pressable, StyleSheet, Text, View } from "react-native";
import { costSol as sol } from "./CostEstimate";
import { sheetStyles } from "./sheetStyles";
import type { prepareSetup, PublicationDraft } from "./creator";
import { costRows, formatSol } from "./price";
import { shortAddress } from "./photoPresentation";
import { deviceName, securityLevelName } from "../../publications/core/attestation";
import { programFeatures } from "../../publications/deployments";
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
 * The publish sheet's receipt. The rows come from the validated draft, never the text fields, so
 * they match the hashed document exactly; with no draft yet it holds the wallet row alone.
 */
export function PrintReceipt({
  draft,
  quote,
  device,
  previewAlbum,
  owner,
  ownerLabel,
  ownerName,
  showWallet,
  onToggleWallet,
}: {
  draft: PublicationDraft | null;
  quote: Awaited<ReturnType<typeof prepareSetup>> | null;
  device: DeviceCheck | null;
  previewAlbum: string;
  owner: string | undefined;
  ownerLabel: string;
  ownerName: string | null;
  showWallet: boolean;
  onToggleWallet(): void;
}) {
  /** The price the draft itself committed to, read back like every other receipt row. */
  const draftPrice = draftPriceLamports(draft);
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
      {/* Sealed at publish beside the price, where the deployment takes them. */}
      {programFeatures(draft.edition.program).royaltiesAndSeekerOnly && (
        <Row label={copy.rowRoyalty} value={copy.royaltyValue(draft.royaltyBps)} />
      )}
      {/* Always stated: the switch may ask for Seeker-only on a wallet with no token to seal. */}
      {programFeatures(draft.edition.program).royaltiesAndSeekerOnly && draft.edition.supply > 1 && (
        <Row label={copy.rowCollectors}
          value={draft.seekerOnly ? collectCopy.seekerOnly : collectCopy.anyone} />
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
        onToggle={onToggleWallet}
      />
      {quote?.step === "sign" && (
        <>
          <View style={sheetStyles.rule} />
          <Row
            label={estimate.networkFee}
            value={`${sol(quote.prepared.estimateBreakdown.networkFee)} SOL`}
          />
          {/* The simulated balance delta contains the network fee and the storage
              transfer; each is stated on its own row rather than twice. */}
          <Row
            label={estimate.accountCost}
            value={`${sol(costRows(quote.prepared, quote.storageLamports).accounts)} SOL`}
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
        onToggle={onToggleWallet}
      />
    </View>
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
