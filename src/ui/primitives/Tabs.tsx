/** Tabs — the two-up segmented control: active = ink pill inside a step-1 track, h 48, track hairline #262A31. */
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { colors, radius } from "../theme";
import { fonts } from "../fonts";

interface TabsProps<T extends string> {
  options: readonly T[];
  value: T;
  onChange: (value: T) => void;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function Tabs<T extends string>({ options, value, onChange, style, testID }: TabsProps<T>) {
  return (
    <View testID={testID} accessibilityRole="tablist" style={[styles.track, style]}>
      {options.map((option) => {
        const active = option === value;
        return (
          <Pressable
            key={option}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            accessibilityLabel={option}
            onPress={() => onChange(option)}
            style={[styles.item, active && styles.itemActive]}
          >
            <Text style={[styles.label, active ? styles.labelActive : styles.labelIdle]}>
              {option}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    height: 48,
    flexDirection: "row",
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.sheet,
    padding: 4,
    gap: 4,
  },
  item: {
    flex: 1,
    borderRadius: radius.pill,
    alignItems: "center",
    justifyContent: "center",
  },
  itemActive: { backgroundColor: colors.ink },
  label: { fontSize: 14 },
  labelActive: { color: colors.ground, fontFamily: fonts.bodyStrong },
  labelIdle: { color: colors.muted, fontFamily: fonts.body },
});
