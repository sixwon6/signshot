import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { CameraScreen } from "../screens/CameraScreen";
import { ReviewScreen } from "../screens/ReviewScreen";
import { SettingsScreen } from "../screens/SettingsScreen";
import { ChainScreen } from "../screens/ChainScreen";

export type HomeTabs = {
  Camera: undefined;
  Review: { photo?: string } | undefined;
  /**
   * `core` and `cluster` are the query string of a collect link, handed over by React Navigation's
   * `linking` config (src/navigators/linking.ts). Both are optional and both are strings, because
   * a URL is untrusted input: the screen validates them through `parseCollectLink` rather than
   * trusting the types here.
   */
  Chain: { core?: string; cluster?: string } | undefined;
  Settings: undefined;
};
/**
 * The app's one param list, registered as React Navigation's default root type so
 * `NavigationContainer`, its `linking` prop and `useNavigation` are all checked against it
 * without a type argument at every call site:
 * https://reactnavigation.org/docs/typescript/#specifying-default-types-for-usenavigation-link-ref-etc
 */
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace ReactNavigation {
    interface RootParamList extends HomeTabs {}
  }
}

const Tab = createBottomTabNavigator<HomeTabs>();

/**
 * The camera is home: a tab navigator with no bar (no extra native dependency), where Android back
 * lands on the camera. `Review` is titled Photos and `Chain` is titled Collection.
 */
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
