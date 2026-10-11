import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { CameraScreen } from "../screens/CameraScreen";
import { ReviewScreen } from "../screens/ReviewScreen";
import { SettingsScreen } from "../screens/SettingsScreen";
import { ChainScreen } from "../screens/ChainScreen";

export type HomeTabs = {
  Camera: undefined;
  Review: { photo?: string } | undefined;
  /** Collect-link query params. Untrusted URL input: validated by `parseCollectLink`, not these types. */
  Chain: { core?: string; cluster?: string } | undefined;
  Settings: undefined;
};
// Default root param list for useNavigation/linking:
// https://reactnavigation.org/docs/typescript/#specifying-default-types-for-usenavigation-link-ref-etc
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace ReactNavigation {
    interface RootParamList extends HomeTabs {}
  }
}

const Tab = createBottomTabNavigator<HomeTabs>();

/** Tab navigator with no bar (no extra native dependency); Android back returns to the camera. */
export function HomeNavigator() {
  return (
    <Tab.Navigator
      backBehavior="initialRoute"
      tabBar={() => null}
      screenOptions={{ headerShown: false }}
    >
      <Tab.Screen name="Camera" component={CameraScreen} />
      <Tab.Screen
        name="Review"
        component={ReviewScreen}
        options={{ title: "Photos" }}
      />
      <Tab.Screen
        name="Chain"
        component={ChainScreen}
        options={{ title: "Collection" }}
      />
      <Tab.Screen name="Settings" component={SettingsScreen} />
    </Tab.Navigator>
  );
}
