/** Rounded choice or action. */
import { Pressable, StyleSheet, Text, type Insets, type StyleProp, type ViewStyle } from "react-native";
import { colors, radius } from "../theme";
import { fonts } from "../fonts";

interface ChipProps {
  label: string;
  selected?: boolean;
  /** Selected fill; must be light enough for the dark label. Defaults to teal. */
  fill?: string;
  /** Unselected but holding a user value: label in the accent. */
  held?: boolean;
  onPress?: () => void;
  onLongPress?: () => void;
  disabled?: boolean;
  accessibilityLabel?: string;
  accessibilityRole?: "button" | "radio";
  style?: StyleProp<ViewStyle>;
  testID?: string;
  size?: "regular" | "small";
  /** Small chips are 32 tall; pad the touch target to 44. */
  hitSlop?: Insets;
}

export function Chip({
  label,
  selected = false,
  fill,
  held = false,
  onPress,
  onLongPress,
  disabled = false,
  accessibilityLabel,
  accessibilityRole = "button",
  style,
  testID,
  size = "regular",
  hitSlop,
}: ChipProps) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole={accessibilityRole}
      accessibilityState={
        accessibilityRole === "radio"
          ? { selected, checked: selected, disabled }
          : { selected, disabled }
      }
      accessibilityLabel={accessibilityLabel ?? label}
      disabled={disabled}
      hitSlop={hitSlop}
      onPress={onPress}
      onLongPress={onLongPress}
      style={({ pressed }) => [
        styles.chip,
        size === "small" && styles.small,
        selected ? styles.selected : styles.unselected,
        selected && fill ? { backgroundColor: fill } : null,
        { opacity: disabled ? 0.4 : pressed ? 0.82 : 1 },
        style,
      ]}
    >
      <Text
        style={[
          styles.label,
          selected ? styles.labelSelected : styles.labelUnselected,
          held && !selected && styles.labelHeld,
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  chip: {
    height: 44,
    borderRadius: radius.pill,
    alignItems: "center",
    justifyContent: "center",
  },
  small: { height: 32 },
  selected: { backgroundColor: colors.teal, paddingHorizontal: 15 },
  unselected: {
    borderWidth: 1,
    borderColor: "rgba(245,244,240,0.22)",
    // 14 + 1px border = selected's 15, so selection doesn't shift neighbours.
    paddingHorizontal: 14,
  },
  label: { fontSize: 10, letterSpacing: 1, textTransform: "uppercase" },
  labelSelected: { color: colors.onTeal, fontFamily: fonts.monoStrong },
  labelUnselected: { color: "rgba(245,244,240,0.72)", fontFamily: fonts.mono },
  labelHeld: { color: colors.tealText },
});
