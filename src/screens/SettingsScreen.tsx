import { useCallback, useRef, useState, type ReactNode } from "react";
import {
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from "react-native";
import Constants from "expo-constants";
import { StatusBar } from "expo-status-bar";
import { useIsFocused, useNavigation } from "@react-navigation/native";
import type { BottomTabNavigationProp } from "@react-navigation/bottom-tabs";
import Icon from "@expo/vector-icons/MaterialCommunityIcons";
import type { HomeTabs } from "../navigators/HomeNavigator";
import { colors, radius, space } from "../ui/theme";
import { typeScale as type } from "../ui/type";
import { BackButton, Pill, Screen } from "../ui/primitives";
import { actions, settings as copy, walletTimeout } from "../ui/copy";
import { safeErrorText } from "../ui/errorText";

import {
  useMobileWallet,
  type KitMobileWallet,
} from "@wallet-ui/react-native-kit";

import { CHAIN } from "../solana/cluster";
import {
  isUserCancellation,
  isWalletResponseTimeout,
} from "../solana/walletErrors";
import { useSeekerIdentity } from "../seeker/useSeekerIdentity";
import { useShareStampPref } from "../seeker/shareStampPref";
import { deleteUploadKey, uploadKeyAddress } from "../arweave/uploadKey";
import { walletOwesUpload } from "../prints/creator";
import { storageCreditHeld } from "../../publications/storage";
import { SUPPORT_EMAIL, TERMS_URL } from "../moderation/core";

/**
 * The dApp Store Developer Agreement (§2.1) requires links to the privacy policy and the EULA in
 * the app, not only the listing. The terms are the EULA.
 */
const PRIVACY_URL = "https://erashot.app/privacy";

export function shortAddress(address: string): string {
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

/**
 * Removes a disconnected wallet's upload seed, whose cleartext SecureStore entry name contains the
 * address. Kept while any publication owes an upload: its data-item ids are already on chain and a
 * new seed cannot reproduce them. Kept too while its address holds paid storage credit, which
 * nothing else can spend. Best effort, and fails closed.
 */
async function forgetUploadSeed(wallet: string | null): Promise<void> {
  if (wallet === null) return;
  try {
    if (await walletOwesUpload(wallet)) return;
    const owner = await uploadKeyAddress(wallet);
    if (owner !== null && (await storageCreditHeld(owner))) return;
    await deleteUploadKey(wallet);
  } catch {
    /* The seed stays. Keeping one is a preference entry; removing one wrongly is permanent. */
  }
}

/** No cluster picker: the cluster is a build-time fact (`src/solana/cluster.ts`). */
export function SettingsScreen() {
  const focused = useIsFocused();
  const navigation =
    useNavigation<BottomTabNavigationProp<HomeTabs, "Settings">>();
  const version = Constants.expoConfig?.version ?? "dev";
  const devnet = CHAIN === "solana:devnet";

  const { account, connect, connectAnd, deauthorizeSession, disconnect } =
    useMobileWallet();
  const identity = useSeekerIdentity();
  const stamp = useShareStampPref();

  const [walletBusy, setWalletBusy] = useState(false);
  const [developerTools, setDeveloperTools] = useState(false);
  const [walletError, setWalletError] = useState<string | null>(null);
  // `walletBusy` is state and lands a render late; this is what a second tap actually reads.
  // Two concurrent transact() sessions corrupt each other, so the guard has to be immediate.
  const walletInFlight = useRef(false);

  const onConnect = useCallback(async () => {
    if (walletInFlight.current) return;
    walletInFlight.current = true;
    setWalletBusy(true);
    setWalletError(null);
    try {
      await connect();
    } catch (e) {
      // Dismissing the picker is not an error. A timeout may mean the wallet already authorized,
      // so it gets its own sentence instead of the raw TimeoutException text.
      if (isWalletResponseTimeout(e)) setWalletError(walletTimeout.connect);
      else if (!isUserCancellation(e)) setWalletError(safeErrorText(e));
    } finally {
      walletInFlight.current = false;
      setWalletBusy(false);
    }
  }, [connect]);

  const onDisconnect = useCallback(async () => {
    if (walletInFlight.current) return;
    walletInFlight.current = true;
    setWalletBusy(true);
    setWalletError(null);
    try {
      // A real deauthorization: wallet-ui's `disconnect()` only clears its cache. The cast is
      // needed because wallet-ui 4.3.0 types the callback as `AuthorizeAPI`, while `transact()`
      // passes the full `KitMobileWallet`, which has `deauthorize`.
      const disconnecting = wallet;
      await connectAnd((wallet) =>
        deauthorizeSession(wallet as KitMobileWallet),
      );
      // The .skr stamp was opted into for this wallet only; cleared once the disconnect happened.
      stamp.setEnabled(false);
      await forgetUploadSeed(disconnecting);
    } catch (e) {
      if (isUserCancellation(e)) {
        // The user backed out of the wallet. Still connected, on both sides; show nothing.
        return;
      }
      // The wallet is gone, uninstalled, or refused the session. The token is unusable either
      // way, so the cache is still cleared rather than showing an address the app cannot sign with.
      setWalletError(safeErrorText(e));
      try {
        const disconnecting = wallet;
        await disconnect();
        stamp.setEnabled(false);
        await forgetUploadSeed(disconnecting);
      } catch {
        /* Nothing left to try; the error above is what the user sees. */
      }
    } finally {
      walletInFlight.current = false;
      setWalletBusy(false);
    }
  }, [connectAnd, deauthorizeSession, disconnect, stamp]);

  // These reject only on a device with no browser, where there is nothing useful to show.
  const onPrivacy = useCallback(() => {
    void Linking.openURL(PRIVACY_URL).catch(() => undefined);
  }, []);
  const onTerms = useCallback(() => {
    void Linking.openURL(TERMS_URL).catch(() => undefined);
  }, []);

  // `account.address` is already a kit `Address` — a branded base58 string, no conversion.
  const wallet: string | null = account?.address ?? null;
  const canStamp = wallet !== null && typeof identity.skrName === "string";

  /** One Seeker fact: unknown, checked-absent and present are three different answers. */
  const factText = (
    value: string | null | undefined,
    absent: string,
    present: (v: string) => string,
  ): string => {
    if (wallet === null) return copy.factUnknown;
    if (typeof value === "string") return present(value);
    if (value === null) return absent;
    return identity.checking ? copy.factChecking : copy.factUnavailable;
  };

  return (
    <Screen testID="settings-screen">
      {focused && <StatusBar style="light" />}
      <BackButton
        label={actions.camera}
        accessibilityLabel={actions.backToCamera}
        onPress={() => navigation.navigate("Camera")}
        testID="back-to-camera"
      />
      <ScrollView
        style={s.scroll}
        contentContainerStyle={s.content}
        showsVerticalScrollIndicator={false}
      >
        <Text style={s.heading}>{copy.heading}</Text>

        {/* The `.skr` name is shown beside the address, never instead of it: the name is a
            third-party claim, and the address is what every other surface is checked against. */}
        <View style={s.wallet}>
          <Wash />
          <View style={s.walletTop}>
            <Text style={s.walletLabel}>{copy.walletLabel}</Text>
            <Text selectable style={s.walletName} numberOfLines={1}>
              {wallet
                ? (identity.skrName ?? shortAddress(wallet))
                : copy.walletPlaceholder}
            </Text>
          </View>
          <View style={s.walletFoot}>
            <Text selectable style={s.walletAddress}>
              {wallet && typeof identity.skrName === "string"
                ? shortAddress(wallet)
                : ""}
            </Text>
            <Text style={s.walletNetwork}>
              {devnet ? copy.networkDevnet : copy.networkMainnet}
            </Text>
          </View>
        </View>
        <Pill
          label={
            walletBusy
              ? copy.opening
              : wallet
                ? copy.disconnect
                : copy.connect
          }
          variant={wallet ? "secondary" : "primary"}
          disabled={walletBusy}
          onPress={() => void (wallet ? onDisconnect() : onConnect())}
        />
        {!!walletError && (
          <Text accessibilityLiveRegion="polite" style={s.error}>
            {walletError}
          </Text>
        )}

        <Section title={copy.seekerSection}>
          <Row
            label={copy.genesisRow}
            value={factText(
              identity.sgtMint,
              copy.genesisAbsent,
              () => copy.genesisHeld,
            )}
            emphasis={typeof identity.sgtMint === "string"}
          />
          <Row
            label={copy.skrRow}
            value={factText(identity.skrName, copy.skrAbsent, (v) => v)}
            emphasis={typeof identity.skrName === "string"}
          />
          <Row
            label={copy.networkRow}
            value={devnet ? copy.networkDevnet : copy.networkMainnet}
            last
          />
          {/* The token and name rows are read from mainnet even on a devnet build
              (`getMainnetReadRpc`). Nothing is gated on them; a publication's recorded SGT mint is
              checked again by every reader (`publications/core/genesisToken.ts`). */}
          {devnet && <Text style={s.note}>{copy.seekerSourceDevnet}</Text>}
          {!!identity.error && <Text style={s.error}>{identity.error}</Text>}
          <Pill
            label={identity.checking ? copy.checking : copy.refresh}
            variant="secondary"
            size="small"
            disabled={!wallet || identity.checking}
            onPress={() => void identity.refresh()}
            style={s.sectionAction}
          />
        </Section>

        <Section title={copy.sharingSection}>
          <View style={s.toggleRow}>
            <Text style={s.rowLabel}>{copy.stampRow}</Text>
            <Switch
              accessibilityLabel={copy.stampRow}
              value={stamp.enabled && canStamp}
              onValueChange={stamp.setEnabled}
              disabled={!canStamp || !stamp.loaded}
              trackColor={{ true: colors.teal, false: colors.line }}
              thumbColor={colors.ink}
            />
          </View>
          {!canStamp && <Text style={s.help}>{copy.stampNeedsName}</Text>}
        </Section>

        <Section title={copy.aboutSection}>
          <LinkRow label={copy.privacyLink} onPress={onPrivacy} />
          <LinkRow label={copy.termsLink} onPress={onTerms} />
          <LinkRow
            label={copy.supportLink}
            last
            onPress={() =>
              void Linking.openURL(`mailto:${SUPPORT_EMAIL}`).catch(() =>
                setWalletError("Email is unavailable on this phone."),
              )
            }
          />
        </Section>

        <Text style={s.footer}>
          {`Signshot · v${version} · ${devnet ? "Devnet" : "Mainnet"}`}
        </Text>

        {__DEV__ && (
          <View>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ expanded: developerTools }}
              onPress={() => setDeveloperTools((v) => !v)}
              style={s.linkRow}
            >
              <Text style={s.rowLabel}>{copy.developerTools}</Text>
              <Icon
                name={developerTools ? "chevron-up" : "chevron-down"}
                size={20}
                color={colors.muted}
              />
            </Pressable>
            {developerTools && <Text style={s.help}>{CHAIN}</Text>}
          </View>
        )}
      </ScrollView>
    </Screen>
  );
}

/**
 * The wallet card's ground-to-teal wash, with no gradient dependency: eased colour bands under
 * ground-alpha columns. The counts keep each step below the Seeker panel's visible quantisation.
 */
const WASH_BANDS = 64;
const WASH_COLUMNS = 48;
/** Smoothstep: flat at 0 and 1, the change in the middle. */
const ease = (t: number) => t * t * (3 - 2 * t);
function channels(hex: string): [number, number, number] {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [
    number,
    number,
    number,
  ];
}
function mix(from: string, to: string, amount: number): string {
  const a = channels(from);
  const b = channels(to);
  const [r, g, bl] = a.map((v, i) => Math.round(v + (b[i] - v) * amount));
  return `rgb(${r}, ${g}, ${bl})`;
}
function withAlpha(hex: string, alpha: number): string {
  const [r, g, b] = channels(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
function Wash() {
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      <View style={s.washStack}>
        {Array.from({ length: WASH_BANDS }, (_, i) => (
          <View
            key={i}
            style={{
              flex: 1,
              backgroundColor: mix(
                colors.ground,
                colors.teal,
                ease(i / (WASH_BANDS - 1)),
              ),
            }}
          />
        ))}
      </View>
      <View style={[StyleSheet.absoluteFill, s.washColumns]}>
        {Array.from({ length: WASH_COLUMNS }, (_, i) => (
          <View
            key={i}
            style={{
              flex: 1,
              backgroundColor: withAlpha(
                colors.ground,
                0.5 * ease(1 - i / (WASH_COLUMNS - 1)),
              ),
            }}
          />
        ))}
      </View>
    </View>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <View style={s.section}>
      <Text style={s.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

/** One Seeker fact. The label is body text; the value is a readout, in teal when it is there. */
function Row({
  label,
  value,
  emphasis = false,
  last = false,
}: {
  label: string;
  value: string;
  emphasis?: boolean;
  last?: boolean;
}) {
  return (
    <View style={[s.row, last && s.rowLast]}>
      <Text style={s.rowLabel}>{label}</Text>
      <Text
        selectable
        numberOfLines={1}
        style={[s.rowValue, emphasis && s.rowValueEmphasis]}
      >
        {value}
      </Text>
    </View>
  );
}

function LinkRow({
  label,
  onPress,
  last = false,
}: {
  label: string;
  onPress(): void;
  last?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [
        s.linkRow,
        last && s.rowLast,
        pressed && s.pressed,
      ]}
    >
      <Text style={s.rowLabel}>{label}</Text>
      <Icon name="chevron-right" size={20} color={colors.muted} />
    </Pressable>
  );
}

const s = StyleSheet.create({
  scroll: { flex: 1 },
  content: { gap: space.lg, paddingBottom: space.xl },
  heading: { ...type.display, color: colors.ink, paddingTop: space.sm },

  wallet: {
    height: 158,
    borderRadius: radius.card,
    padding: space.gutter,
    overflow: "hidden",
    justifyContent: "space-between",
  },
  washStack: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0 },
  washColumns: { flexDirection: "row" },
  walletTop: { gap: space.sm },
  walletLabel: { ...type.label, color: colors.ink, opacity: 0.78 },
  walletName: { ...type.title, color: colors.ink },
  walletFoot: {
    flexDirection: "row",
    alignItems: "flex-end",
    justifyContent: "space-between",
    gap: space.md,
  },
  walletAddress: { ...type.imprint, textTransform: "none", color: colors.onTeal, opacity: 0.82 },
  walletNetwork: { ...type.imprint, color: colors.onTeal, opacity: 0.82 },

  section: { gap: space.xs },
  sectionTitle: {
    ...type.label,
    color: colors.muted,
    paddingBottom: space.sm,
  },
  sectionAction: { alignSelf: "flex-start", marginTop: space.md },

  row: {
    minHeight: 52,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  rowLast: { borderBottomWidth: 0 },
  rowLabel: { ...type.body, color: colors.ink, flexShrink: 1 },
  rowValue: { ...type.imprint, color: colors.muted, flexShrink: 1 },
  rowValueEmphasis: { color: colors.purpleText },

  toggleRow: {
    minHeight: 52,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.md,
  },

  linkRow: {
    minHeight: 52,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  pressed: { opacity: 0.6 },

  help: { ...type.body, color: colors.muted },
  note: { ...type.imprint, color: colors.muted, paddingTop: space.sm },
  error: { ...type.body, color: colors.danger },
  footer: {
    ...type.label,
    color: colors.muted,
    textAlign: "center",
    paddingTop: space.sm,
  },
});
