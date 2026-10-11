import { useCallback, useEffect } from "react";
import { StyleSheet } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { MobileWalletProvider } from "@wallet-ui/react-native-kit";
import * as SplashScreen from "expo-splash-screen";
import { AppNavigator } from "./src/navigators/AppNavigator";
import { CLUSTER, createAppClient } from "./src/solana/cluster";
import { APP_IDENTITY } from "./src/solana/appIdentity";
import { authorizationCache } from "./src/solana/authorizationCache";
import { colors } from "./src/ui/theme";
import { useAppFonts } from "./src/ui/fonts";

// Hold the splash until fonts load so nothing paints in the system font and reflows.
// `useAppFonts` also reports ready on failure, falling back to the system font.
void SplashScreen.preventAutoHideAsync().catch(() => {});

export default function App() {
  const ready = useAppFonts();

  const reveal = useCallback(() => {
    void SplashScreen.hideAsync().catch(() => {});
  }, []);

  useEffect(() => {
    if (ready) reveal();
  }, [ready, reveal]);

  if (!ready) return null;

  return (
    <MobileWalletProvider
      cluster={CLUSTER}
      identity={APP_IDENTITY}
      cache={authorizationCache}
      createClient={createAppClient}
    >
      <SafeAreaProvider style={styles.shell}>
        <AppNavigator />
      </SafeAreaProvider>
    </MobileWalletProvider>
  );
}

const styles = StyleSheet.create({
  shell: { flex: 1, backgroundColor: colors.ground },
});
