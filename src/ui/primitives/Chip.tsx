/**
 * Chip — the recipe picker's chip, h 44, mono 10 label.
 *
 * Selected carries the fill colour and a darker mono label; unselected is a 22 % ink hairline
 * with the label at 72 %. A caller may pass its own `fill`, which must be a light theme accent
 * so the dark label still reads.
 */
import { Pressable, StyleSheet, Text, type StyleProp, type ViewStyle } from "react-native";
import { colors, radius } from "../theme";
import { fonts } from "../fonts";

interface ChipProps {
  label: string;
  selected?: boolean;
  /** The selected fill. Teal unless given; a light theme accent, under the dark label. */
  fill?: string;
  onPress?: () => void;
  /** A long press on a chip the photographer owns: its Rename / Copy / Delete options. */
  onLongPress?: () => void;
  disabled?: boolean;
  accessibilityLabel?: string;
  accessibilityRole?: "button" | "radio";
  style?: StyleProp<ViewStyle>;
  testID?: string;
  size?: "regular" | "small";
}

export function Chip({
  label,
  selected = false,
  fill,
  onPress,
  onLongPress,
  disabled = false,
  accessibilityLabel,
  accessibilityRole = "button",
  style,
  testID,
  size = "regular",
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
      <Text style={[styles.label, selected ? styles.labelSelected : styles.labelUnselected]}>
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
    paddingHorizontal: 13,
  },
  label: { fontSize: 10, letterSpacing: 1, textTransform: "uppercase" },
  labelSelected: { color: colors.onTeal, fontFamily: fonts.monoStrong },
  labelUnselected: { color: "rgba(245,244,240,0.72)", fontFamily: fonts.mono },
});
