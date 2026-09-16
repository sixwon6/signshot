/** NetworkLabel — the cluster badge: teal text, 38 % teal hairline, mono 10 · .14em. */
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { colors, radius } from "../theme";
import { typeScale } from "../type";

interface NetworkLabelProps {
  label: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function NetworkLabel({ label, style, testID }: NetworkLabelProps) {
  return (
    <View testID={testID} style={[styles.badge, style]}>
      <Text style={styles.text}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    alignSelf: "flex-start",
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: "rgba(127,240,223,0.38)",
    paddingVertical: 6,
    paddingHorizontal: 10,
  },
  text: { ...typeScale.label, letterSpacing: 1.4, color: colors.tealText },
});
