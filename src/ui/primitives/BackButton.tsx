/** Chevron plus destination. Must go where Android's back gesture goes. */
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
  /** e.g. "Back to camera" when the label alone is not a sentence. */
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
