/** The app's only button shape. At most one `primary` per screen; `destructive` is never filled. */
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { colors, radius } from "../theme";
import { fonts } from "../fonts";

type PillVariant = "primary" | "secondary" | "destructive";
type PillSize = "large" | "small";

interface PillProps {
  label: string;
  onPress?: () => void;
  variant?: PillVariant;
  size?: PillSize;
  loading?: boolean;
  disabled?: boolean;
  /** For buttons that reveal or collapse another set of controls. */
  expanded?: boolean;
  /** Let the label take two lines instead of truncating; the fixed height becomes a minimum. */
  wrap?: boolean;
  accessibilityHint?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

const SKIN: Record<PillVariant, { background: string; border: string; text: string }> = {
  primary: { background: colors.ink, border: "transparent", text: colors.ground },
  secondary: { background: "transparent", border: "rgba(245,244,240,0.26)", text: colors.ink },
  destructive: { background: "transparent", border: "rgba(255,145,126,0.5)", text: colors.danger },
};

/** For rows that must not change height when a pill appears. */
export const PILL_SMALL_HEIGHT = 46;

const SIZES: Record<PillSize, { height: number; fontSize: number; paddingHorizontal: number }> = {
  large: { height: 54, fontSize: 16, paddingHorizontal: 24 },
  small: { height: PILL_SMALL_HEIGHT, fontSize: 13, paddingHorizontal: 16 },
};

export function Pill({
  label,
  onPress,
  variant = "primary",
  size = "large",
  loading = false,
  disabled = false,
  expanded,
  wrap = false,
  accessibilityHint,
  style,
  testID,
}: PillProps) {
  const skin = SKIN[variant];
  const metrics = SIZES[size];
  const inert = disabled || loading;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityState={{ disabled: inert, busy: loading, expanded }}
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      disabled={inert}
      onPress={onPress}
      style={({ pressed }) => [
        styles.pill,
        wrap
          ? { minHeight: metrics.height, paddingVertical: 6 }
          : { height: metrics.height },
        {
          paddingHorizontal: wrap ? metrics.paddingHorizontal - 4 : metrics.paddingHorizontal,
          backgroundColor: skin.background,
          borderColor: skin.border,
          borderWidth: variant === "primary" ? 0 : 1,
          opacity: inert ? 0.45 : pressed ? 0.82 : 1,
        },
        style,
      ]}
    >
      {loading ? (
        <View style={styles.busy}>
          <ActivityIndicator color={skin.text} size="small" />
        </View>
      ) : (
        <Text
          numberOfLines={wrap ? 2 : 1}
          style={[
            styles.label,
            wrap && { lineHeight: Math.round(metrics.fontSize * 1.25) },
            {
              color: skin.text,
              fontSize: metrics.fontSize,
              fontFamily: variant === "primary" ? fonts.bodyStrong : fonts.body,
            },
          ]}
        >
          {label}
        </Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pill: {
    borderRadius: radius.pill,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
  },
  label: { letterSpacing: -0.16, textAlign: "center" },
  busy: { alignItems: "center", justifyContent: "center" },
});
