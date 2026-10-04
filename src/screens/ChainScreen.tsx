/**
 * Wallet: the address, what it holds, and what it published. The route keeps the name `Chain` so
 * deep links and saved navigation state keep working; every visible word comes from the
 * `collection` export of `src/ui/copy.ts`.
 *
 * The chrome is set in type, as on the camera: a `TextKey` navigates or switches the view, and
 * anything that acts on the chain or the clipboard is a small outlined `Chip`. Teal means "yours"
 * and appears once per screen: the wallet address on the list, the copy number on a held print.
 */
import type { BottomTabNavigationProp } from "@react-navigation/bottom-tabs";
import type { RouteProp } from "@react-navigation/native";
import { useIsFocused, useNavigation, useRoute } from "@react-navigation/native";
import { useCallback, useEffect, useRef, useState } from "react";
import { StatusBar } from "expo-status-bar";
import { ActivityIndicator, FlatList, Image, Linking, Modal, Pressable, RefreshControl, ScrollView, Share, StyleSheet, Text, TextInput, useWindowDimensions, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useMobileWallet } from "@wallet-ui/react-native-kit";
import type { HomeTabs } from "../navigators/HomeNavigator";
import { COLLECT_ORIGIN, COLLECT_PATH } from "../navigators/linking";
import { colors, radius, space } from "../ui/theme";
import { typeScale } from "../ui/type";
import { BackButton, Cell, Chip, PhotoFrame, Screen, TextKey } from "../ui/primitives";
import { actions, collect as collectCopy, collection, moderation as moderationCopy, price as priceCopy } from "../ui/copy";
import { safeErrorText } from "../ui/errorText";
import { useWalletSession } from "../solana/useWalletSession";
import { isUserCancellation } from "../solana/walletErrors";
import { CollectSheet } from "../prints/CollectSheet";
import { OfferSheet } from "../prints/OfferSheet";
import { SendSheet } from "../prints/SendSheet";
import { heldCopy, type TransferTarget } from "../prints/transfer";
import { formatSol } from "../prints/price";
import { loadPriceToken, priceValue } from "../prints/priceToken";
import { parseCollectLink, type CollectTarget } from "../prints/collect";
import { scanQr, scanQrAvailable } from "../prints/collectQr";
import { useSeekerIdentity } from "../seeker/useSeekerIdentity";
import { CLUSTER_NAME as cluster, IS_MAINNET, RPC_ENDPOINT, assertEndpointCluster, isClusterMismatch } from "../solana/cluster";
import { request } from "../../publications/rpc";
import { loadLibrary, type LibraryMode, type LibraryPhoto, type LibraryResult } from "../../publications/core/library";
import { collectUrl, explorerUrl } from "../../publications/core/document";
import { readKnownCollections, rememberKnownCollections } from "../prints/knownCollections";
import { useAppActive } from "../useAppActive";
import { reportMailto, type Veil } from "../moderation/core";
import { useModeration } from "../moderation/store";

const short = (value: string) => `${value.slice(0, 4)}…${value.slice(-4)}`;
/** A small chip is 32 tall and a fingertip is 44. */
const CHIP_SLOP = { top: 6, bottom: 6 } as const;
/** How long a key says what it just did before it goes back to being a key. */
const SAID_MS = 1200;
const LAMPORTS_PER_SOL = 1_000_000_000n;
/**
 * The balance, to three figures. Truncated rather than rounded: a wallet's own number is never
 * shown larger than it is, and the exact amount is the wallet app's to state.
 */
const solText = (lamports: bigint) =>
  `${lamports / LAMPORTS_PER_SOL}.${String((lamports % LAMPORTS_PER_SOL) / 1_000_000n).padStart(3, "0")}`;

/**
 * The paper print. In the grid it is uncaptioned and square, so a row of tiles keeps one baseline
 * and the readouts line up; on the photograph's own screen it is captioned and takes the
 * edition's own ratio. Paper carries graphite only, never teal.
 */
function Print({ item, wallet, compact = false, veil = null }: {
  item: LibraryPhoto; wallet?: string; compact?: boolean;
  /** Hidden or blocked: blank paper carrying the word, with no picture and no title. */
  veil?: Veil;
}) {
  const e = item.photo.edition;
  if (veil) return <PhotoFrame variant={compact ? "grid" : "full"}>
    <View style={s.veil}><Text style={s.state}>{moderationCopy[veil]}</Text></View>
  </PhotoFrame>;
  if (compact) return <PhotoFrame source={{ uri: item.imageUri }} variant="grid" />;
  const aspectRatio = e.width > 0 && e.height > 0 ? e.width / e.height : 1;
  return <PhotoFrame
    source={{ uri: item.imageUri }}
    title={e.title}
    byline={e.creator === wallet ? collection.byYou : collection.by(short(e.creator))}
    mark={collection.imprint}
    aspectRatio={aspectRatio}
  />;
}

/** One fact under a photograph: its tag, then its value. The accent is for a value that is yours. */
function Fact({ tag, value, yours = false, verbatim = false, onPress, accessibilityLabel, testID }: {
  tag: string; value: string; yours?: boolean;
  /** The value as written: an address is case-sensitive. */
  verbatim?: boolean;
  onPress?: () => void; accessibilityLabel?: string; testID?: string;
}) {
  const body = <>
    <Text style={s.factTag}>{tag}</Text>
    <Text numberOfLines={1} style={[s.factValue, verbatim && s.verbatim, yours && s.yours]}>{value}</Text>
  </>;
  return onPress
    ? <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel} testID={testID}
        onPress={onPress} style={({ pressed }) => [s.fact, pressed && s.pressed]}>{body}</Pressable>
    : <View style={s.fact} testID={testID}>{body}</View>;
}

export function ChainScreen() {
  const focused = useIsFocused();
  const active = useAppActive();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const navigation = useNavigation<BottomTabNavigationProp<HomeTabs, "Chain">>();
  // A collect link lands here as route params; see `src/navigators/linking.ts`.
  const route = useRoute<RouteProp<HomeTabs, "Chain">>();
  const { account, connect } = useMobileWallet();
  const wallet = account?.address;
  // Whatever the app already knows about this wallet's `.skr` name. `false` starts no lookup from
  // here: the name is a label on the address, never a reason to reach for the network.
  const seeker = useSeekerIdentity(false);
  // Signshot's list and this phone's blocks. A collected copy of somebody else's photograph is
  // veiled here as it is on the Collect sheet; the wallet's own publications never are.
  const moderation = useModeration();
  const veilOf = (item: LibraryPhoto) =>
    moderation.veil(item.photo.edition.edition, item.photo.edition.creator, wallet);
  // The same session object the photo sheets build, so the Collect sheet opens a wallet exactly
  // the way publishing and sending do.
  const session = useWalletSession();
  const [mode, setMode] = useState<LibraryMode>("collected");
  const [refresh, setRefresh] = useState(0);
  // `error` is the sentence for a failure retrying cannot fix; `failed` is every failure.
  const [state, setState] = useState<{ key: string; result?: LibraryResult; error?: string; failed?: boolean; loading?: boolean }>({ key: "" });
  const [selected, setSelected] = useState<string | null>(null);
  const [immersive, setImmersive] = useState(false);
  /** The wallet's own SOL, or null when it has not been read. */
  const [balance, setBalance] = useState<bigint | null>(null);
  /** Connecting from this screen: the wallet app is up, or it came back without authorizing. */
  const [walletBusy, setWalletBusy] = useState(false);
  const [connectFailed, setConnectFailed] = useState(false);
  // `walletBusy` is state and lands a render late; this is what a second tap actually reads.
  const walletInFlight = useRef(false);
  /** What a key says in place of its own label for a moment, and which key says it. */
  const [said, setSaid] = useState<{ id: string; label: string } | null>(null);
  const saidTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The Collect entry: the paste/scan stage, the link being typed, and its one refusal. */
  const [collectStage, setCollectStage] = useState(false);
  const [link, setLink] = useState("");
  const [collectError, setCollectError] = useState<{ text: string; word?: boolean } | null>(null);
  /** Set means the Collect sheet is open on this edition. */
  const [collectTarget, setCollectTarget] = useState<CollectTarget | null>(null);
  /** Set means the price sheet is open on this edition. The creator's own control. */
  const [priceEdition, setPriceEdition] = useState<LibraryPhoto["photo"]["edition"] | null>(null);
  /** Set means the Send sheet is open on this copy; `sent` once a send from it confirmed. */
  const [sending, setSending] = useState<{ item: LibraryPhoto; target: TransferTarget; sent?: boolean } | null>(null);
  const key = `${wallet ?? ""}:${cluster}:${mode}`;
  const current = state.key === key ? state : undefined;
  const loading = Boolean(wallet && (!current || current.loading));
  const result = current?.result;
  const items = result?.items ?? [];
  // The copy being sent stays on screen while its sheet is open, even once a re-read drops it.
  const activePhoto = focused && current
    ? items.find(item => item.id === selected) ?? (sending?.item.id === selected ? sending.item : undefined)
    : undefined;

  useEffect(() => {
    setSelected(null); setImmersive(false); setPriceEdition(null); setSending(null); setSaid(null);
    // A different wallet clears the last failed connect.
    setConnectFailed(false);
  }, [key]);
  useEffect(() => {
    if (!focused || !active || !wallet) return;
    const controller = new AbortController();
    setState(previous => ({ key, result: previous.key === key ? previous.result : undefined, loading: true }));
    // The endpoint's cluster is checked first; a mismatch keeps its own sentence, since retrying
    // cannot fix configuration. `known` seeds the rescue scan with collections already verified
    // for this wallet, so its prints are still found when other assets crowd the first page.
    assertEndpointCluster()
      .then(() => readKnownCollections(cluster, wallet))
      .then(async known => { await loadPriceToken().catch(() => null); return loadLibrary(RPC_ENDPOINT, cluster, wallet, mode, controller.signal, known); })
      .then(
        result => {
          if (controller.signal.aborted) return;
          setState({ key, result, loading: false });
          // Every item here was verified, so its collection is a safe seed for the next load.
          void rememberKnownCollections(cluster, wallet,
            result.items.map(item => item.photo.edition.collection));
        },
        (e: unknown) => { if (!controller.signal.aborted) setState(previous => ({ key, result: previous.key === key ? previous.result : undefined, loading: false, failed: true,
          error: isClusterMismatch(e) ? e.message
            : undefined })); },
      );
    return () => controller.abort();
  }, [focused, active, wallet, mode, key, refresh]);

  /**
   * The balance beside the address, read when the screen comes back and whenever the list is
   * refreshed. A balance nobody could read carries no number rather than a zero.
   */
  useEffect(() => {
    setBalance(null);
    if (!focused || !active || !wallet) return;
    let live = true;
    request<{ value: number }>(RPC_ENDPOINT, "getBalance", [wallet, { commitment: "confirmed" }])
      .then(({ value }) => { if (live && Number.isSafeInteger(value) && value >= 0) setBalance(BigInt(value)); })
      .catch(() => { /* The line simply carries no number. */ });
    return () => { live = false; };
  }, [focused, active, wallet, refresh]);

  useEffect(() => () => { if (saidTimer.current) clearTimeout(saidTimer.current); }, []);
  /** Feedback in place: the key that was tapped says what happened, then goes back to its label. */
  const say = (id: string, label: string) => {
    if (saidTimer.current) clearTimeout(saidTimer.current);
    setSaid({ id, label });
    saidTimer.current = setTimeout(() => setSaid(null), SAID_MS);
  };
  const labelOf = (id: string, label: string) => (said?.id === id ? said.label : label);

  /**
   * Open one collect link. Every route into the sheet goes through here — pasted, scanned or
   * deep-linked — so `parseCollectLink` is the only thing that ever decides what is collectable.
   * It returns null for text that is not one of ours and throws a readable refusal (another
   * network) for text that is.
   */
  const openLink = useCallback((value: string) => {
    setCollectError(null);
    try {
      const parsed = parseCollectLink(value.trim());
      if (!parsed) { setCollectError({ text: collection.notOurLink, word: true }); return; }
      setLink("");
      setCollectStage(false);
      setCollectTarget(parsed);
    } catch (e) {
      // The refusal's own reason: a wrong network cannot be a retry.
      setCollectError({ text: safeErrorText(e, collection.notOurLink) });
      setCollectStage(true);
    }
  }, []);

  /**
   * An Android App Link that reached this tab. The query string is rebuilt into the link shape
   * `parseCollectLink` validates rather than trusted as a target: the params are URL text from
   * outside the app, and the address and the cluster both have to be checked.
   */
  const core = route.params?.core, linkCluster = route.params?.cluster;
  useEffect(() => {
    if (!core) return;
    // Consumed immediately: a link is a one-shot instruction, and params left on the route would
    // reopen this sheet every time the tab regains focus.
    navigation.setParams({ core: undefined, cluster: undefined });
    openLink(`${COLLECT_ORIGIN}/${COLLECT_PATH}/?core=${encodeURIComponent(core)}` +
      (linkCluster ? `&cluster=${encodeURIComponent(linkCluster)}` : ""));
  }, [core, linkCluster, navigation, openLink]);

  const pasteLink = async () => {
    try { openLink(await Clipboard.getStringAsync()); }
    catch { setCollectError({ text: collectCopy.pasteFailed }); }
  };
  /** The native scanner, behind its runtime guard. `null` is a cancellation, not a failure. */
  const scan = async () => {
    setCollectError(null);
    if (!scanQrAvailable()) { setCollectError({ text: collection.noScanner, word: true }); return; }
    try {
      const scanned = await scanQr();
      if (scanned === null) return;
      openLink(scanned);
    } catch { setCollectError({ text: collectCopy.scanFailed }); }
  };
  const openCollectStage = () => { setCollectError(null); setLink(""); setCollectStage(true); };
  /** A collected copy belongs under Collected, so the view switches and the library re-reads. */
  const onCollected = () => { setMode("collected"); setRefresh(n => n + 1); };
  /**
   * The wallet is connected here, on the screen that is about it. Disconnecting stays in Settings:
   * it deauthorizes the session and clears the upload seed, which is one careful piece of code.
   */
  const onConnect = async () => {
    if (walletInFlight.current) return;
    walletInFlight.current = true;
    setWalletBusy(true);
    setConnectFailed(false);
    try {
      await connect();
    } catch (e) {
      // Dismissing the picker is not a failure; a timeout is, even though the wallet may have
      // authorized — in which case the address arrives on its own and replaces the word.
      if (!isUserCancellation(e)) setConnectFailed(true);
    } finally {
      walletInFlight.current = false;
      setWalletBusy(false);
    }
  };

  const retry = () => setRefresh(n => n + 1);
  const close = () => { if (immersive) setImmersive(false); else { setSelected(null); setPriceEdition(null); setSaid(null); } };
  const toCamera = () => navigation.navigate("Camera");
  const open = (item: LibraryPhoto) => { setSelected(item.id); setImmersive(false); setPriceEdition(null); setSending(null); setSaid(null); };
  const copy = async (id: string, value: string) => {
    try { await Clipboard.setStringAsync(value); say(id, collection.copied); }
    catch { say(id, collection.copyFailed); }
  };
  const share = () => {
    if (!activePhoto) return;
    Share.share({ message: `${activePhoto.photo.edition.title}\n${collectUrl(activePhoto.photo.edition.edition, cluster)}` })
      .catch(() => say("share", collection.shareFailed));
  };
  const e = activePhoto?.photo.edition;
  const activeVeil = activePhoto ? veilOf(activePhoto) : null;
  const activeBlocked = !!e && moderation.isBlocked(e.creator);
  /** Only a copy this wallet was read holding can be sent from here. */
  const sendable = activePhoto ? heldCopy(activePhoto, wallet) : null;
  const activeIndex = activePhoto ? items.findIndex(p => p.id === activePhoto.id) : -1;
  const gridWidth = (width - space.gutter * 2 - space.md) / 2;
  /** The wallet's value word: the address, or where the connection got to. */
  const walletValue = wallet ? short(wallet)
    : walletBusy ? collection.opening
    : connectFailed ? collection.notConnected
    : collection.noWallet;

  return <Screen>
    {focused && <StatusBar style="light" />}
    {/* The way back, the chain these copies were read from, and the Collect entry. Collecting is
        offered whether or not a wallet is connected: the sheet itself asks for one. */}
    <View style={s.header}>
      <BackButton label={actions.camera} accessibilityLabel={actions.backToCamera} onPress={toCamera} testID="back-to-camera" />
      <View style={s.grow} />
      <Text style={s.network}>{collection.networkFlag(IS_MAINNET)}</Text>
      <Chip size="small" label={actions.collect} onPress={openCollectStage} hitSlop={CHIP_SLOP} testID="wallet-collect" />
    </View>
    {/* The wallet itself, read like the camera's cells: a tag over its value. The `.skr` name is
        the tag and never replaces the address, which is the thing every other surface matches. */}
    <View style={s.walletRow}>
      <Cell
        tag={labelOf("wallet", typeof seeker.skrName === "string" ? seeker.skrName : collection.wallet)}
        value={walletValue}
        held={Boolean(wallet)}
        verbatim={Boolean(wallet)}
        accessibilityLabel={wallet ? collection.copyWalletAddress : walletValue}
        onPress={wallet ? () => void copy("wallet", wallet) : undefined}
        style={s.walletCell}
        testID="wallet-address" />
      <View style={s.grow} />
      {wallet
        ? <Cell tag={collection.sol} value={balance === null ? collection.noBalance : solText(balance)}
            accessibilityLabel={balance === null ? collection.noBalance : priceCopy.value(solText(balance))} />
        : <TextKey label={collection.connect} disabled={walletBusy} onPress={() => void onConnect()} testID="wallet-connect" />}
    </View>
    {/* The two views, turned like the camera's dial: the one in force carries the index bar. */}
    {!!wallet && <View style={s.dial} accessibilityRole="radiogroup">
      <TextKey size="readout" index label={collection.collected} on={mode === "collected"}
        accessibilityRole="radio" onPress={() => setMode("collected")} testID="wallet-view-collected" />
      <TextKey size="readout" index label={collection.published} on={mode === "published"}
        accessibilityRole="radio" onPress={() => setMode("published")} testID="wallet-view-published" />
    </View>}
    <FlatList data={items} keyExtractor={item => item.id} numColumns={2}
      columnWrapperStyle={s.gridRow} keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
      contentContainerStyle={s.list}
      refreshControl={<RefreshControl refreshing={loading && Boolean(result)} onRefresh={retry} tintColor={colors.muted} colors={[colors.muted]} />}
      ListHeaderComponent={<>
        {/* A count, not just a flag: anyone can mint Core assets to any wallet and grind addresses
            to sort first, so the line says how many the scan's cap hid. It carries the only RETRY
            over a list that still has rows. */}
        {(current?.failed || result && (result.unavailable > 0 || result.hiddenCount > 0)) && !!result && <View style={s.notice}>
          <Text style={s.state}>{current?.failed ? collection.notRefreshed
            : result.unavailable > 0 ? collection.unread(result.unavailable)
            : collection.notShown(result.hiddenCount)}</Text>
          {/* Nothing to retry for the scan's own cap: the next read meets the same one. */}
          {(current?.failed || result.unavailable > 0) && <TextKey label={collection.retry} onPress={retry} testID="wallet-retry" />}
        </View>}
      </>}
      ListEmptyComponent={!wallet ? null : <View style={s.empty}>
        {/* With no wallet this stays empty: the wallet line above reads NO WALLET beside CONNECT. */}
        {loading && !result ? <><ActivityIndicator color={colors.muted} /><Text style={s.state}>{collection.loading}</Text></> :
          current?.failed && !result ? (current.error
            ? <Text style={s.stateLine}>{current.error}</Text>
            : <><Text style={s.state}>{collection.loadFailed}</Text><TextKey label={collection.retry} onPress={retry} testID="wallet-retry" /></>) :
          items.length > 0 ? <Text style={s.state}>{collection.noMatch}</Text> :
          <Text style={s.state}>{collection.empty(mode)}</Text>}
      </View>}
      renderItem={({ item }) => { const veil = veilOf(item); return <Pressable accessibilityRole="button" accessibilityLabel={collection.openPhoto(veil ? moderationCopy[veil] : item.photo.edition.title, item.number)} onPress={() => open(item)} style={({ pressed }) => [s.item, { maxWidth: gridWidth }, pressed && s.pressed]}>
        <Print item={item} wallet={wallet} compact veil={veil} />
        <Text style={s.readout}>{collection.tally(item.number ?? item.photo.minted, item.photo.edition.supply)}</Text>
      </Pressable>; }}
    />
    <Modal visible={Boolean(activePhoto)} animationType="slide" onRequestClose={close}>
      {activePhoto && e && (immersive
        ? <Screen padded={false}>
            <View style={s.immersiveNav}>
              <BackButton label={collection.edition} accessibilityLabel={collection.exitFullScreen} onPress={close} />
            </View>
            {activeVeil
              ? <View style={[s.immersiveImage, s.veil]}><Text style={s.state}>{moderationCopy[activeVeil]}</Text></View>
              : <Image source={{ uri: activePhoto.imageUri }} resizeMode="contain" style={s.immersiveImage} />}
            <View style={[s.immersiveFooter, { paddingBottom: insets.bottom + space.lg }]}>
              <TextKey size="readout" label="‹" accessibilityLabel={collection.previousPhoto}
                disabled={activeIndex <= 0} onPress={() => setSelected(items[activeIndex - 1].id)} />
              <Text style={s.readout}>{activeIndex + 1} / {items.length}</Text>
              <TextKey size="readout" label="›" accessibilityLabel={collection.nextPhoto}
                disabled={activeIndex < 0 || activeIndex >= items.length - 1} onPress={() => setSelected(items[activeIndex + 1].id)} />
            </View>
          </Screen>
        : <Screen>
            {/* The paper imprints the title and the byline, so the nav carries the way back and
                nothing else. */}
            <View style={s.header}>
              <BackButton label={collection.wallet} accessibilityLabel={collection.backToWallet} onPress={close} testID="wallet-close" />
            </View>
            <ScrollView contentContainerStyle={s.detail} showsVerticalScrollIndicator={false}>
              <Pressable accessibilityRole="button" accessibilityLabel={collection.openFullScreen} disabled={!!activeVeil} onPress={() => setImmersive(true)} style={({ pressed }) => [pressed && s.pressed]}>
                <Print item={activePhoto} wallet={wallet} veil={activeVeil} />
              </Pressable>
              <Text style={[s.readout, activePhoto.number ? s.yours : null]}>{activePhoto.number ? collection.copyOf(activePhoto.number, e.supply) : collection.editionOf(e.supply)}</Text>
              {/* The creator's own words, and the only proportional face on the screen. */}
              {!!e.description && !activeVeil && <Text style={s.caption}>{e.description}</Text>}
              <View>
                <Fact tag={labelOf("by", collection.byLabel)} value={e.creator === wallet ? collection.you : short(e.creator)}
                  yours={e.creator === wallet} verbatim={e.creator !== wallet} accessibilityLabel={collection.copyPublisher}
                  onPress={() => void copy("by", e.creator)} />
                <Fact tag={collection.issuedLabel} value={collection.tally(activePhoto.photo.minted, e.supply)} />
                {activePhoto.photo.seekerOnly && <Fact tag="COLLECTORS" value="Seeker holders only" />}
                {/* What a copy costs, and on the creator's own publication the way to change it:
                    the price of the copies nobody has taken yet. Keyed by the edition, so a
                    photograph that never came from this phone can still be priced. */}
                <Fact tag={priceCopy.label}
                  value={priceValue(activePhoto.photo.offer)}
                  accessibilityLabel={actions.setPrice} testID="wallet-price"
                  onPress={e.creator === wallet ? () => setPriceEdition(e) : undefined} />
              </View>
              <View style={s.proof}>
                <Text style={s.factTag}>{collection.edition}</Text>
                <Text selectable style={s.address}>{e.edition}</Text>
                <View style={s.chipRow}>
                  <Chip size="small" label={labelOf("edition", collection.copyEdition)} accessibilityLabel={collection.copyEditionAddress} onPress={() => void copy("edition", e.edition)} hitSlop={CHIP_SLOP} />
                  <Chip size="small" label={labelOf("explorer", collection.explorer)} accessibilityLabel={collection.viewOnExplorer} hitSlop={CHIP_SLOP}
                    onPress={() => { Linking.openURL(explorerUrl(e.edition, cluster)).catch(() => say("explorer", collection.couldNotOpen)); }} />
                </View>
              </View>
            </ScrollView>
            <View style={[s.bottomBar, { paddingBottom: insets.bottom + space.sm }]}>
              <View style={s.chipRow}>
                {!activeVeil && <Chip size="small" label={labelOf("share", actions.share)} accessibilityLabel={collection.shareMoment} onPress={share} hitSlop={CHIP_SLOP} testID="wallet-share" />}
                {sendable && <Chip size="small" label={actions.send} hitSlop={CHIP_SLOP} testID="wallet-send"
                  onPress={() => setSending({ item: activePhoto, target: sendable })} />}
                <Chip size="small" label={labelOf("link", collection.copyLink)} accessibilityLabel={collection.copyMomentLink} hitSlop={CHIP_SLOP} testID="wallet-copy-link"
                  onPress={() => void copy("link", collectUrl(e.edition, cluster))} />
                {/* Somebody else's photograph: report it, or stop this phone showing its publisher. */}
                {e.creator !== wallet && <>
                  <Chip size="small" label={labelOf("report", moderationCopy.report)} hitSlop={CHIP_SLOP} testID="wallet-report"
                    onPress={() => { Linking.openURL(reportMailto(e.edition, collectUrl(e.edition, cluster))).catch(() => say("report", collection.couldNotOpen)); }} />
                  <Chip size="small" label={activeBlocked ? moderationCopy.unblock : moderationCopy.block} hitSlop={CHIP_SLOP} testID="wallet-block"
                    onPress={() => void moderation.setBlocked(e.creator, !activeBlocked)} />
                </>}
              </View>
            </View>
            {priceEdition && <OfferSheet edition={priceEdition} session={session} onClose={() => setPriceEdition(null)} onSaved={() => setRefresh(n => n + 1)} />}
            {/* A confirmed send re-reads the wallet at once; closing then goes back to the grid,
                which no longer holds the copy. */}
            {sending && <SendSheet target={sending.target} image={activeVeil ? undefined : sending.item.imageUri} session={session}
              onSent={() => { setSending(s => s && { ...s, sent: true }); setRefresh(n => n + 1); }}
              onClose={() => { if (sending.sent) setSelected(null); setSending(null); }} />}
          </Screen>)}
    </Modal>
    {/* The Collect entry: one field and three chips. Paste or scan a link; everything else about
        the edition is the Collect sheet's to show. */}
    <Modal visible={collectStage} animationType="slide" onRequestClose={() => setCollectStage(false)}>
      <Screen>
        <View style={s.header}>
          <BackButton label={collection.wallet} accessibilityLabel={collection.backToWallet} onPress={() => setCollectStage(false)} testID="wallet-close" />
          <View style={s.grow} />
          <Text style={s.network}>{collectCopy.entryHeading}</Text>
        </View>
        <ScrollView contentContainerStyle={s.detail} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
          <TextInput style={s.input} value={link} onChangeText={value => { setLink(value); setCollectError(null); }}
            accessibilityLabel={collectCopy.linkLabel} placeholder={collectCopy.linkPlaceholder} placeholderTextColor={colors.muted}
            autoCapitalize="none" autoCorrect={false} multiline />
          <View style={s.chipRow}>
            <Chip size="small" label={actions.open} disabled={!link.trim()} onPress={() => openLink(link)} hitSlop={CHIP_SLOP} />
            <Chip size="small" label={actions.paste} onPress={() => void pasteLink()} hitSlop={CHIP_SLOP} />
            {/* Offered only when this build's native side actually has the scanner. */}
            {scanQrAvailable() && <Chip size="small" label={actions.scan} onPress={() => void scan()} hitSlop={CHIP_SLOP} />}
          </View>
          {!!collectError && <Text accessibilityLiveRegion="polite" style={collectError.word ? s.refusalWord : s.refusal}>{collectError.text}</Text>}
        </ScrollView>
      </Screen>
    </Modal>
    {collectTarget && <CollectSheet
      target={collectTarget}
      session={session}
      walletAddress={wallet}
      onClose={() => setCollectTarget(null)}
      onCollected={onCollected}
    />}
  </Screen>;
}

const s = StyleSheet.create({
  grow: { flex: 1, minWidth: 0 },
  pressed: { opacity: 0.7 },

  // --- header, the wallet line, the view dial ------------------------------
  header: { flexDirection: "row", alignItems: "center", gap: space.md, minHeight: 44 },
  network: { ...typeScale.label, color: colors.muted },
  /** The screen's one hairline: under the wallet, which the rest of it is about. */
  walletRow: { flexDirection: "row", alignItems: "center", gap: space.md, minHeight: 44, borderBottomWidth: 1, borderBottomColor: colors.line },
  /** Content width, so the address sits on the gutter; capped so a long `.skr` name cannot push
      the balance off the row. */
  walletCell: { maxWidth: 200 },
  /** A key's word is inset 6 by its own padding; the row pulls that back to the paper's edge. */
  dial: { flexDirection: "row", gap: space.xs, marginTop: space.sm, marginLeft: -6 },

  // --- the list ----------------------------------------------------------
  list: { flexGrow: 1, paddingTop: space.xl, paddingBottom: space.lg },
  gridRow: { gap: space.md },
  /** The readout binds to its own print, so the gap under the paper is the smallest one. */
  item: { flex: 1, gap: 6, marginBottom: space.xl },
  readout: { ...typeScale.readout, color: colors.muted },
  /** The accent, and its one meaning: this is yours. */
  yours: { color: colors.tealText },


  notice: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.sm, paddingBottom: space.lg, marginRight: -6 },

  // --- states ------------------------------------------------------------
  empty: { flex: 1, alignItems: "center", justifyContent: "center", gap: space.sm, paddingBottom: space.xxl },
  state: { ...typeScale.readout, color: colors.muted },
  /** Where a hidden or blocked photograph would be: the picture's place, unexposed. */
  veil: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.field },
  stateLine: { ...typeScale.body, color: colors.muted, textAlign: "center", maxWidth: 300 },

  // --- the photograph's own screen ---------------------------------------
  detail: { paddingBottom: space.xl, gap: space.md },
  caption: { ...typeScale.body, color: colors.ink },
  fact: { minHeight: 44, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.md, borderBottomWidth: 1, borderBottomColor: colors.line },
  factTag: { ...typeScale.label, color: colors.muted },
  factValue: { ...typeScale.readout, color: colors.ink, flexShrink: 1, textAlign: "right" },
  verbatim: { textTransform: "none" },
  proof: { gap: space.sm },
  address: { ...typeScale.body, fontFamily: typeScale.imprint.fontFamily, color: colors.ink },
  chipRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.sm },
  bottomBar: { paddingTop: space.md, borderTopWidth: 1, borderTopColor: colors.line, backgroundColor: colors.ground },

  // --- the Collect entry --------------------------------------------------
  input: { ...typeScale.body, fontFamily: typeScale.imprint.fontFamily, fontSize: 13, lineHeight: 20, color: colors.ink, backgroundColor: colors.field, borderWidth: 1, borderColor: colors.line, borderRadius: radius.small, minHeight: 90, padding: 14, textAlignVertical: "top" },
  refusal: { ...typeScale.body, color: colors.danger },
  refusalWord: { ...typeScale.readout, color: colors.danger },

  // --- full screen -------------------------------------------------------
  immersiveNav: { paddingHorizontal: space.gutter, paddingBottom: space.md },
  immersiveImage: { flex: 1, width: "100%" },
  immersiveFooter: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: space.gutter - 6, paddingTop: space.md },
});
