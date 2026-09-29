import { DarkTheme, NavigationContainer } from "@react-navigation/native";
import { HomeNavigator, type HomeTabs } from "./HomeNavigator";
import { linking } from "./linking";
import { colors } from "../ui/theme";

/** React Navigation's own theme, mapped to the app's own colour tokens. */
const navigationTheme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    primary: colors.teal,
    background: colors.ground,
    card: colors.sheet,
    text: colors.ink,
    border: colors.line,
    notification: colors.purple,
  },
};

/** The navigation root. The `HomeTabs` argument checks the linking config against its routes. */
export function AppNavigator() {
  return (
    <NavigationContainer<HomeTabs> theme={navigationTheme} linking={linking}>
      <HomeNavigator />
    </NavigationContainer>
  );
}
