import { DarkTheme, NavigationContainer } from "@react-navigation/native";
import { HomeNavigator, type HomeTabs } from "./HomeNavigator";
import { linking } from "./linking";
import { colors } from "../ui/theme";

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

/** The `HomeTabs` argument type-checks the linking config against the routes. */
export function AppNavigator() {
  return (
    <NavigationContainer<HomeTabs> theme={navigationTheme} linking={linking}>
      <HomeNavigator />
    </NavigationContainer>
  );
}
