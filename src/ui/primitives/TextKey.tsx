/**
 * TextKey — a word that is a key. No border and no fill: on the camera the picture is the only
 * thing allowed weight, so its chrome is set in type. Rest is muted, `on` is ink, and `held` reads
 * in the accent, as a held value does on the readout. `index` draws the mark a dial has under the
 * position it is turned to.
 */
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { colors } from "../theme";
import { typeScale } from "../type";

/** Fixed-height chrome: the type may grow with the system's setting, but not out of its row. */
export const CHROME_FONT_SCALE = 1.3;

interface TextKeyProps {
  label: string;
  on?: boolean;
  held?: boolean;
  index?: boolean;
  /** `readout` for the dial's positions, `label` for the keys beside them. */
  size?: "readout" | "label";
  onPress?: () => void;
  onLongPress?: () => void;
  disabled?: boolean;
  accessibilityLabel?: string;
  accessibilityRole?: "button" | "radio";
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function TextKey({
  label,
  on = false,
  held = false,
  index = false,
  size = "label",
  onPress,
  onLongPress,
  disabled = false,
  accessibilityLabel,
  accessibilityRole = "button",
  style,
  testID,
}: TextKeyProps) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole={accessibilityRole}
      accessibilityState={
        accessibilityRole === "radio" ? { selected: on, checked: on, disabled } : { selected: on, disabled }
      }
      accessibilityLabel={accessibilityLabel ?? label}
      disabled={disabled}
      onPress={onPress}
      onLongPress={onLongPress}
      style={({ pressed }) => [styles.key, { opacity: disabled ? 0.4 : pressed ? 0.7 : 1 }, style]}
    >
      <Text
        maxFontSizeMultiplier={CHROME_FONT_SCALE}
        numberOfLines={1}
        style={[
          size === "readout" ? typeScale.readout : typeScale.label,
          { color: on ? colors.ink : held ? colors.tealText : colors.muted },
        ]}
      >
        {label}
      </Text>
      {index && <View style={[styles.index, !on && styles.indexOff]} />}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  key: { minWidth: 44, height: 44, paddingHorizontal: 6, alignItems: "center", justifyContent: "center" },
  /** Kept in the layout when off, so the word does not move as the dial turns. */
  index: { position: "absolute", bottom: 5, width: 14, height: 2, borderRadius: 1, backgroundColor: colors.ink },
  indexOff: { opacity: 0 },
});
