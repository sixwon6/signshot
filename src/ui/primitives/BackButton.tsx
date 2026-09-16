/**
 * BackButton — a chevron and where it goes.
 *
 * There is no tab bar: the camera is home, and Photos, Collection and Settings each carry this at
 * their head to return to it. The photo detail uses the same control to return to Photos. 44 tall,
 * an ink chevron and a muted label; Android's back gesture goes to the same place.
 */
import {
  Pressable,
  StyleSheet,
  Text,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { colors, space } from "../theme";
import { typeScale } from "../type";

interface BackButtonProps {
  /** The destination, as the screen is named: "Camera", "Photos". */
  label: string;
  onPress: () => void;
  /** What a screen reader says, when the label alone is not a sentence: "Back to camera". */
  accessibilityLabel?: string;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function BackButton({
  label,
  onPress,
  accessibilityLabel,
  disabled = false,
  style,
  testID,
}: BackButtonProps) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled }}
      onPress={onPress}
      disabled={disabled}
      testID={testID}
      style={({ pressed }) => [
        styles.back,
        (pressed || disabled) && styles.pressed,
        style,
      ]}
    >
      <Text style={styles.icon}>‹</Text>
      <Text style={styles.label}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  back: {
    height: 44,
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: space.sm,
  },
  pressed: { opacity: 0.7 },
  icon: { color: colors.ink, fontSize: 26, lineHeight: 28, marginTop: -4 },
  label: { ...typeScale.label, color: colors.muted },
});
