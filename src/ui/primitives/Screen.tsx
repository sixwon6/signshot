/**
 * Screen — the ground every screen sits on: near-black ground, 18 px side gutter, content
 * starting below the status bar and ending above the system navigation. There is no tab bar
 * to leave room for; the camera is home.
 */
import React from "react";
import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { colors, space } from "../theme";

interface ScreenProps {
  children?: React.ReactNode;
  /** Side gutter. Off for full-bleed screens such as the camera. */
  padded?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function Screen({ children, padded = true, style, testID }: ScreenProps) {
  const insets = useSafeAreaInsets();
  return (
    <View
      testID={testID}
      style={[
        styles.ground,
        {
          paddingTop: insets.top + space.md,
          paddingBottom: insets.bottom,
          paddingHorizontal: padded ? space.gutter : 0,
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  ground: { flex: 1, backgroundColor: colors.ground },
});
