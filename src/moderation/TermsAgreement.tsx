/**
 * The one-time agreement, in a sheet's dock in place of the action it comes before: the terms,
 * and the word that accepts them. Shown until `useTermsAgreement` reports the current version.
 */
import { Linking, StyleSheet, View } from "react-native";
import { Pill } from "../ui/primitives";
import { space } from "../ui/theme";
import { moderation as copy } from "../ui/copy";
import { TERMS_URL } from "./core";

export function TermsAgreement({
  agreed,
  onAgree,
}: {
  /** `null` while storage is being read: Agree waits for it. */
  agreed: boolean | null;
  onAgree(): void;
}) {
  return (
    <View style={s.row}>
      <Pill
        label={copy.terms}
        variant="secondary"
        onPress={() => void Linking.openURL(TERMS_URL).catch(() => undefined)}
        style={s.half}
      />
      <Pill
        label={copy.agree}
        disabled={agreed !== false}
        onPress={onAgree}
        style={s.half}
        testID="terms-agree"
      />
    </View>
  );
}

const s = StyleSheet.create({
  row: { flexDirection: "row", gap: space.sm },
  half: { flex: 1 },
});
