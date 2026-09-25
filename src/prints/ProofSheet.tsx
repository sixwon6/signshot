import { sheetStyles } from "./sheetStyles";
import React, { useState } from "react";
import { Linking, Modal, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Clipboard from "expo-clipboard";
import type { PhotoProof } from "./photoProof";
import { colors, space } from "../ui/theme";
import { typeScale as type } from "../ui/type";
import { NetworkLabel, Pill } from "../ui/primitives";
import { actions, proof as copy } from "../ui/copy";
import { safeErrorText } from "../ui/errorText";
import { albumPublicUrl } from "./albums";
import {
  deviceName,
  securityLevelName,
  type AttestationSummary,
} from "../../publications/core/attestation";
import { useGenesisStanding } from "../seeker/useGenesisStanding";
import { genesisDisplay } from "../../publications/core/genesisToken";

export function ProofSheet({
  proof,
  onClose,
}: {
  proof: PhotoProof;
  onClose(): void;
}) {
  const insets = useSafeAreaInsets(),
    [error, setError] = useState("");
  const draft = proof.kind === "core" ? proof.draft : null;
  const genesisCheck = useGenesisStanding(draft?.edition.genesisMint, draft?.edition.creator);
  const genesis = genesisCheck && draft
    ? genesisDisplay(genesisCheck, { cluster: draft.edition.cluster, sealed: !!draft.edition.genesisSealed })
    : null;
  const published = proof.confirmation === "confirmed";
  const cached = proof.confirmation === "cached";
  // `safeErrorText`: Android's `Linking`/`Clipboard` errors quote the URL they were given.
  function open(url: string) {
    void Linking.openURL(url).catch((e) => setError(safeErrorText(e)));
  }
  return (
    <Modal animationType="slide" onRequestClose={onClose}>
      <View style={sheetStyles.root}>
        <View style={[sheetStyles.headerRow, { paddingTop: insets.top + space.md }]}>
          <Pill
            label={actions.backToPhoto}
            variant="secondary"
            size="small"
            onPress={onClose}
          />
        </View>
        <View style={sheetStyles.sheet}>
          <View style={sheetStyles.grabber} />
          <ScrollView
            style={sheetStyles.scroll}
            contentContainerStyle={sheetStyles.content}
            showsVerticalScrollIndicator={false}
          >
            {/* Only when the record names a network; never inherit this build's. */}
            {!!proof.cluster && (
              <NetworkLabel
                label={
                  proof.cluster === "devnet" ? copy.networkTest : copy.network
                }
              />
            )}
            <Text style={sheetStyles.title}>{copy.heading}</Text>
            <View style={sheetStyles.box}>
              <Text style={s.boxTitle}>
                {published
                  ? "Publication confirmed"
                  : cached
                    ? "Previously confirmed · current status unavailable"
                    : proof.confirmation === "unavailable"
                      ? "Current status unavailable"
                      : proof.kind === "local"
                        ? "Photo file details"
                        : "Publication not confirmed"}
              </Text>
              {!published && !cached && proof.kind !== "local" && (
                <Text style={sheetStyles.body}>
                  {proof.confirmation === "unavailable"
                    ? "Couldn’t verify this publication. Details below are from this phone."
                    : "Not confirmed on Solana. Details below are from this phone."}
                </Text>
              )}
              {proof.reason && <Text style={sheetStyles.help}>{proof.reason}</Text>}
            </View>
            <Row label="Publishing wallet" mono>
              {proof.publisher ?? "Not available."}
            </Row>
            {proof.cluster && (
              <Row label="Network">
                {proof.cluster === "devnet" ? "Devnet test" : "Solana mainnet"}
              </Row>
            )}
            {draft && (
              <>
                <Row label={copy.titleLabel}>{draft.edition.title}</Row>
                {!!draft.edition.description && (
                  <Row label={copy.momentLabel}>{draft.edition.description}</Row>
                )}
                <Row label={copy.publicPhotoLabel}>
                  {`${draft.edition.width} × ${draft.edition.height} pixels · ${copy.editionSize(draft.edition.supply)}`}
                </Row>
                <Text style={sheetStyles.help}>
                  {draft.storage === "available"
                    ? "Upload confirmed."
                    : "Upload not confirmed. Check it from the photo."}
                </Text>
                <Row label="Public image fingerprint · SHA-256" mono>
                  {draft.edition.imageHash}
                </Row>
                <Row label="Edition address" mono>
                  {draft.edition.edition}
                </Row>
                <Row label="Metaplex Core collection" mono>
                  {draft.edition.collection}
                </Row>
                {!!draft.album && (
                  <>
                    {/* The name is a renameable label; the group address is the evidence. */}
                    <Row label={copy.albumLabel}>
                      {draft.albumName ?? copy.albumUnnamed}
                    </Row>
                    <Text style={s.value} selectable>
                      {draft.album}
                    </Text>
                  </>
                )}
                <Text style={sheetStyles.help}>{copy.standard}</Text>
                <Row label={copy.attestationLabel}>
                  {draft.edition.attestation
                    ? attestationLine(draft.edition.attestation)
                    : draft.edition.attestationProblem
                      ? copy.attestationProblem(draft.edition.attestationProblem)
                      : copy.attestationNone}
                </Row>
                {draft.edition.attestation && (
                  <Text style={sheetStyles.help}>{copy.attestationBody}</Text>
                )}
                {/* The document's claim, checked on mainnet when this sheet opens. */}
                <Row label={copy.genesisLabel}>
                  {genesis ? copy.genesisStanding[genesis.line] : copy.genesisNone}
                </Row>
                {!!draft.edition.genesisMint && (
                  <Text style={s.value} selectable>
                    {draft.edition.genesisMint}
                  </Text>
                )}
                {genesis?.sealed && (
                  <Text style={sheetStyles.help}>{copy.genesisSealed}</Text>
                )}
              </>
            )}
            <Row label="Captured photo fingerprint · SHA-256" mono>
              {proof.capturedHash ?? "Not available."}
            </Row>
            <Row label="Capture time reported by the phone">
              {proof.capturedAtMs === undefined
                ? "Not available."
                : new Date(proof.capturedAtMs).toLocaleString()}
            </Row>
            {!!draft?.album && (
              <Pill
                label={actions.openAlbumPage}
                variant="secondary"
                onPress={() => open(albumPublicUrl(draft.album!))}
              />
            )}
            {proof.explorerUrl && (
              <Pill
                label={actions.viewEdition}
                variant="secondary"
                onPress={() => open(proof.explorerUrl!)}
              />
            )}
            {proof.transactionUrl && (
              <Pill
                label={actions.viewTransaction}
                variant="secondary"
                onPress={() => open(proof.transactionUrl!)}
              />
            )}
            <Pill
              label={actions.copyRecord}
              variant="secondary"
              onPress={() => {
                void Clipboard.setStringAsync(
                  JSON.stringify(proof.details, null, 2),
                )
                  .then(() => setError("Record details copied."))
                  .catch((e) => setError(safeErrorText(e)));
              }}
            />
          </ScrollView>
          <View style={[sheetStyles.dock, { paddingBottom: insets.bottom + space.lg }]}>
            {!!error && (
              <Text style={sheetStyles.help} accessibilityLiveRegion="polite">
                {error}
              </Text>
            )}
            {proof.publicUrl ? (
              <>
                <Pill
                  label={actions.openPublicPage}
                  onPress={() => open(proof.publicUrl!)}
                />
              </>
            ) : (
              <Pill label={actions.done} variant="secondary" onPress={onClose} />
            )}
          </View>
        </View>
      </View>
    </Modal>
  );
}

/**
 * The attested facts in one line: device, key security level, boot state. Every word is derived
 * from the certificate inside the document, by `publications/core/attestation.ts`.
 */
function attestationLine(a: AttestationSummary): string {
  const boot = a.verifiedBoot === "verified" && a.deviceLocked
    ? "verified boot, bootloader locked"
    : `boot ${a.verifiedBoot}, bootloader ${a.deviceLocked ? "locked" : "unlocked"}`;
  return `Signed on a ${deviceName(a)} · ${securityLevelName(a)} · ${boot}`;
}

/** One labelled fact. The value is a readout when it is an address or a hash. */
function Row({
  label,
  mono = false,
  children,
}: {
  label: string;
  mono?: boolean;
  children: React.ReactNode;
}) {
  return (
    <View style={s.row}>
      <Text style={sheetStyles.label}>{label}</Text>
      <Text selectable style={mono ? s.value : sheetStyles.body}>
        {children}
      </Text>
    </View>
  );
}

const s = StyleSheet.create({
  boxTitle: { ...type.body, fontSize: 17, lineHeight: 24, color: colors.ink },
  row: { gap: space.xs },
  value: {
    ...type.imprint,
    textTransform: "none",
    fontSize: 12,
    lineHeight: 19,
    color: colors.ink,
  },
});
