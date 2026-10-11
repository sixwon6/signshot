/** One camera readout value. `live`: its adjuster is the row above; `forbidden`: dimmed and inert. */
import { Pressable, StyleSheet, Text, type StyleProp, type ViewStyle } from "react-native";
import { colors, radius } from "../theme";
import { typeScale } from "../type";
import { CHROME_FONT_SCALE } from "./TextKey";

interface CellProps {
  tag: string;
  value: string;
  live?: boolean;
  held?: boolean;
  forbidden?: boolean;
  disabled?: boolean;
  /** Skip upper-casing: addresses are case-sensitive. */
  verbatim?: boolean;
  onPress?: () => void;
  accessibilityLabel: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  valueTestID?: string;
}

export function Cell({
  tag,
  value,
  live = false,
  held = false,
  forbidden = false,
  disabled = false,
  verbatim = false,
  onPress,
  accessibilityLabel,
  style,
  testID,
  valueTestID,
}: CellProps) {
  const inert = disabled || forbidden;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityState={{ selected: live, disabled: inert }}
      accessibilityLabel={accessibilityLabel}
      disabled={inert || !onPress}
      onPress={onPress}
      style={({ pressed }) => [
        styles.cell,
        live && styles.live,
        { opacity: forbidden ? 0.35 : pressed ? 0.7 : 1 },
        style,
      ]}
    >
      <Text maxFontSizeMultiplier={CHROME_FONT_SCALE} numberOfLines={1} style={[typeScale.imprint, styles.tag]}>
        {tag}
      </Text>
      <Text
        testID={valueTestID}
        maxFontSizeMultiplier={CHROME_FONT_SCALE}
        numberOfLines={1}
        adjustsFontSizeToFit
        minimumFontScale={0.7}
        style={[
          typeScale.readout,
          styles.value,
          verbatim && styles.verbatim,
          { color: held ? colors.tealText : colors.ink },
        ]}
      >
        {value}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  cell: {
    height: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.small,
    paddingHorizontal: 2,
  },
  live: { backgroundColor: colors.field },
  tag: { color: colors.muted },
  /** Stretch so trailing letter-spacing doesn't push the glyphs off centre. */
  value: { textAlign: "center", alignSelf: "stretch" },
  verbatim: { textTransform: "none" },
});
