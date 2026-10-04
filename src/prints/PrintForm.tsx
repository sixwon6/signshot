import type { Dispatch, SetStateAction } from "react";
import { StyleSheet, Switch, Text, TextInput, View } from "react-native";
import { CostEstimate } from "./CostEstimate";
import { sheetStyles } from "./sheetStyles";
import type { PublicationDraft } from "./creator";
import { ALBUM_NAME_MAX_BYTES, type AlbumRecord, type AlbumSetup } from "./albums";
import { DESCRIPTION_LIMIT } from "../../publications/core/details";
import { MAX_ROYALTY_BPS } from "../../publications/types";
import { colors, radius, space } from "../ui/theme";
import { typeScale as type } from "../ui/type";
import { Chip, Pill } from "../ui/primitives";
import { actions, price as priceCopy, publish as copy } from "../ui/copy";
import type { useTermsAgreement } from "../moderation/store";

/**
 * The publish sheet's fields until a draft exists: title, caption, copies, price and terms. The
 * state and its gates stay with `PrintSheet`.
 */
export function PrintDetails({
  draft,
  busy,
  initializing,
  title,
  setTitle,
  caption,
  setCaption,
  detailsError,
  solo,
  setSolo,
  count,
  setCount,
  priceable,
  priceText,
  setPriceText,
  priceError,
  distribution,
  royaltyBps,
  setRoyaltyBps,
  sealable,
  seekerOnly,
  setSeekerOnly,
}: {
  draft: PublicationDraft | null;
  busy: boolean;
  initializing: boolean;
  title: string;
  setTitle: Dispatch<SetStateAction<string>>;
  caption: string;
  setCaption: Dispatch<SetStateAction<string>>;
  detailsError: string;
  solo: boolean;
  setSolo: Dispatch<SetStateAction<boolean>>;
  count: string;
  setCount: Dispatch<SetStateAction<string>>;
  priceable: boolean;
  priceText: string;
  setPriceText: Dispatch<SetStateAction<string>>;
  priceError: string;
  distribution: boolean;
  royaltyBps: number;
  setRoyaltyBps: Dispatch<SetStateAction<number>>;
  sealable: boolean;
  seekerOnly: boolean;
  setSeekerOnly: Dispatch<SetStateAction<boolean>>;
}) {
  return (
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
      {/* The price of a copy: absent, never disabled, where it cannot apply. */}
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
      {/* The royalty and who may collect. Absent, never disabled, on a deployment that
          takes neither; who may collect only where there is a copy to collect and a
          Genesis Token can be sealed. */}
      {distribution && (
        <View style={s.group}>
          <View style={s.countRow}>
            <Text style={[sheetStyles.label, s.countLabel]}>{copy.royaltyLabel}</Text>
            <View style={s.stepper}>
              <Chip
                label={copy.lessRoyalty}
                size="small"
                disabled={busy || royaltyBps <= 0}
                onPress={() => setRoyaltyBps((bps) => Math.max(0, bps - 100))}
                style={s.step}
              />
              <Text style={s.stepValue}>{copy.royaltyValue(royaltyBps)}</Text>
              <Chip
                label={copy.moreRoyalty}
                size="small"
                disabled={busy || royaltyBps >= MAX_ROYALTY_BPS}
                onPress={() => setRoyaltyBps((bps) => Math.min(MAX_ROYALTY_BPS, bps + 100))}
                style={s.step}
              />
            </View>
          </View>
          {!solo && sealable && (
            <View style={s.countRow}>
              <Text style={[sheetStyles.label, s.countLabel]}>{copy.seekerOnlyLabel}</Text>
              <Switch
                value={seekerOnly}
                onValueChange={setSeekerOnly}
                disabled={busy}
                trackColor={{ true: colors.teal, false: colors.line }}
                thumbColor={colors.ink}
              />
            </View>
          )}
        </View>
      )}
    </>
  );
}

/** The album choice, frozen with the draft like the details: none, an existing one, or a new one. */
export function PrintAlbum({
  draft,
  busy,
  initializing,
  agreement,
  albumMode,
  setAlbumMode,
  selectedAlbum,
  setSelectedAlbum,
  newAlbum,
  setNewAlbum,
  albumQuote,
  setAlbumQuote,
  albumChoices,
  albumChoiceLabel,
  albumOwner,
  albumsReason,
  showCost,
  setShowCost,
  quoteAlbum,
  makeAlbum,
}: {
  draft: PublicationDraft | null;
  busy: boolean;
  initializing: boolean;
  agreement: ReturnType<typeof useTermsAgreement>;
  albumMode: "none" | "existing" | "new";
  setAlbumMode: Dispatch<SetStateAction<"none" | "existing" | "new">>;
  selectedAlbum: string;
  setSelectedAlbum: Dispatch<SetStateAction<string>>;
  newAlbum: string;
  setNewAlbum: Dispatch<SetStateAction<string>>;
  albumQuote: AlbumSetup | null;
  setAlbumQuote: Dispatch<SetStateAction<AlbumSetup | null>>;
  albumChoices: AlbumRecord[];
  albumChoiceLabel(album: AlbumRecord): string;
  albumOwner: string | undefined;
  albumsReason: string;
  showCost: boolean;
  setShowCost: Dispatch<SetStateAction<boolean>>;
  quoteAlbum(): Promise<void>;
  makeAlbum(): Promise<void>;
}) {
  return (
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

const s = StyleSheet.create({
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
  stepper: { flexDirection: "row", alignItems: "center", gap: space.sm },
  step: { width: 44 },
  stepValue: { ...type.readout, color: colors.ink, minWidth: 48, textAlign: "center" },
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
});
