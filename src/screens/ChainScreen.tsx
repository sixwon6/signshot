/**
 * Collection: the wallet library in Collected and Published views. The route keeps the name
 * `Chain`; every visible word comes from the `collection` export of `src/ui/copy.ts`.
 */
import Icon from "@expo/vector-icons/MaterialCommunityIcons";
import type { BottomTabNavigationProp } from "@react-navigation/bottom-tabs";
import type { RouteProp } from "@react-navigation/native";
import { useIsFocused, useNavigation, useRoute } from "@react-navigation/native";
import { useCallback, useEffect, useMemo, useState } from "react";
import { StatusBar } from "expo-status-bar";
import { ActivityIndicator, FlatList, Image, Linking, Modal, Pressable, RefreshControl, ScrollView, Share, StyleSheet, Text, TextInput, useWindowDimensions, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { KitMobileWallet } from "@solana-mobile/mobile-wallet-adapter-protocol-kit";
import { useMobileWallet } from "@wallet-ui/react-native-kit";
import type { HomeTabs } from "../navigators/HomeNavigator";
import { COLLECT_ORIGIN, COLLECT_PATH } from "../navigators/linking";
import { colors, radius, space } from "../ui/theme";
import { typeScale } from "../ui/type";
import { BackButton, Chip, NetworkLabel, PhotoFrame, Pill, Screen, Tabs } from "../ui/primitives";
import { actions, collect as collectCopy, collection, onChain, price as priceCopy } from "../ui/copy";
import { safeErrorText } from "../ui/errorText";
import { liveAuthorize } from "../solana/liveAuthorize";
import type { WalletSession } from "../solana/walletSession";
import { CollectSheet } from "../prints/CollectSheet";
import { OfferSheet } from "../prints/OfferSheet";
import { formatSol } from "../prints/price";
import { parseCollectLink, type CollectTarget } from "../prints/collect";
import { scanQr, scanQrAvailable } from "../prints/collectQr";
import { CLUSTER_NAME as cluster, IS_MAINNET, RPC_ENDPOINT, assertEndpointCluster, isClusterMismatch } from "../solana/cluster";
import { loadLibrary, type LibraryMode, type LibraryPhoto, type LibraryResult } from "../../publications/core/library";
import { collectUrl, explorerUrl } from "../../publications/core/protocol";
import { albumLabel } from "../../publications/core/album";
import { TRUSTED } from "../../publications/deployments";
import { readKnownCollections, rememberKnownCollections } from "../prints/knownCollections";
import { useAppActive } from "../useAppActive";

const short = (value: string) => `${value.slice(0, 4)}…${value.slice(-4)}`;
/** The two views, in the words the person reads. `Tabs` is generic over exactly these. */
const TAB_LABELS = [collection.collected, collection.published] as const;
type TabLabel = (typeof TAB_LABELS)[number];

/** Paper, cream, no radius — and teal nowhere near it. The frame is `PhotoFrame`. */
function Print({ item, wallet, compact = false }: {
  item: LibraryPhoto; wallet?: string; compact?: boolean;
}) {
  const e = item.photo.edition;
  // The paper follows the photograph: the picture spans the paper and takes the edition's own
  // ratio, so a portrait print is tall and a landscape one wide, with the same border all round.
  const aspectRatio = e.width > 0 && e.height > 0 ? e.width / e.height : 1;
  return <PhotoFrame
    source={{ uri: item.imageUri }}
    title={e.title}
    byline={e.creator === wallet ? collection.byYou : collection.by(short(e.creator))}
    mark={collection.imprint}
    variant={compact ? "grid" : "full"}
    aspectRatio={aspectRatio}
  />;
}

/** The no-wallet state's single blank print: one tilted sheet with nothing on it. */
function BlankPrint() {
  return <PhotoFrame
    byline={collection.noCopy}
    mark={collection.imprint}
    aspectRatio={1}
    style={s.blankPrint}
  >
    <View style={s.blankPicture} />
  </PhotoFrame>;
}

export function ChainScreen() {
  const focused = useIsFocused();
  const active = useAppActive();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const navigation = useNavigation<BottomTabNavigationProp<HomeTabs, "Chain">>();
  // A collect link lands here as route params; see `src/navigators/linking.ts`.
  const route = useRoute<RouteProp<HomeTabs, "Chain">>();
  const { account, chain, connectAnd, identity: appIdentity, store } = useMobileWallet();
  const wallet = account?.address;
  // The same session object the photo sheets build, so the Collect sheet opens a wallet exactly
  // the way publishing and sending do (`liveAuthorize` re-reads the auth token at call time).
  const authorizeSession = useCallback(
    (w: KitMobileWallet) => liveAuthorize({ store, chain, identity: appIdentity }, w),
    [store, chain, appIdentity],
  );
  const session = useMemo<WalletSession>(
    () => ({ connectAnd: connectAnd as unknown as WalletSession["connectAnd"], authorizeSession }),
    [connectAnd, authorizeSession],
  );
  const [mode, setMode] = useState<LibraryMode>("collected");
  const [refresh, setRefresh] = useState(0);
  const [state, setState] = useState<{ key: string; result?: LibraryResult; error?: string; loading?: boolean }>({ key: "" });
  const [selected, setSelected] = useState<string | null>(null);
  const [feedback, setFeedback] = useState("");
  const [album, setAlbum] = useState<string | null>(null);
  const [immersive, setImmersive] = useState(false);
  const [proof, setProof] = useState(false);
  /** The Collect entry: the paste/scan stage, the link being typed, and its one refusal line. */
  const [collectStage, setCollectStage] = useState(false);
  const [link, setLink] = useState("");
  const [collectError, setCollectError] = useState("");
  /** Set means the Collect sheet is open on this edition. */
  const [collectTarget, setCollectTarget] = useState<CollectTarget | null>(null);
  /** Set means the price sheet is open on this edition. The creator's own control. */
  const [priceEdition, setPriceEdition] = useState<LibraryPhoto["photo"]["edition"] | null>(null);
  const key = `${wallet ?? ""}:${cluster}:${mode}`;
  const current = state.key === key ? state : undefined;
  const loading = Boolean(wallet && (!current || current.loading));
  const result = current?.result;
  const items = result?.items ?? [];
  const albums = [...new Map(items.flatMap(item => {
    const a = item.photo.publication.album;
    return a ? [[a.group, albumLabel(a)] as const] : [];
  })).entries()];
  const filtered = items.filter(item => !album || item.photo.publication.album?.group === album);
  const activePhoto = focused && current ? items.find(item => item.id === selected) : undefined;

  useEffect(() => {
    setSelected(null); setFeedback(""); setAlbum(null); setImmersive(false); setProof(false); setPriceEdition(null);
  }, [key]);
  useEffect(() => {
    if (!focused || !active || !wallet) return;
    const controller = new AbortController();
    setState(previous => ({ key, result: previous.key === key ? previous.result : undefined, loading: true }));
    // The endpoint's cluster is checked first; a mismatch shows its own message, since retrying
    // cannot fix configuration. `known` seeds the rescue scan with collections already verified
    // for this wallet, so a collector-only wallet survives a crowd-out.
    assertEndpointCluster()
      .then(() => readKnownCollections(cluster, wallet))
      .then(known => loadLibrary(RPC_ENDPOINT, cluster, wallet, mode, controller.signal, known))
      .then(
        result => {
          if (controller.signal.aborted) return;
          setState({ key, result, loading: false });
          // Every item here was verified, so its collection is a safe seed for the next load.
          void rememberKnownCollections(cluster, wallet,
            result.items.map(item => item.photo.edition.collection));
        },
        (e: unknown) => { if (!controller.signal.aborted) setState(previous => ({ key, result: previous.key === key ? previous.result : undefined, loading: false,
          error: isClusterMismatch(e) ? e.message
            : TRUSTED[cluster].length ? collection.refreshFailed : collection.notOnNetwork })); },
      );
    return () => controller.abort();
  }, [focused, active, wallet, mode, key, refresh]);

  /**
   * Open one collect link. Every route into the sheet goes through here — pasted, scanned or
   * deep-linked — so `parseCollectLink` is the only thing that ever decides what is collectable.
   * It returns null for text that is not one of ours and throws a readable refusal (an album
   * link, another network) for text that is.
   */
  const openLink = useCallback((value: string) => {
    setCollectError("");
    try {
      const parsed = parseCollectLink(value.trim());
      if (!parsed) { setCollectError(collectCopy.linkInvalid); return; }
      setLink("");
      setCollectStage(false);
      setCollectTarget(parsed);
    } catch (e) {
      setCollectError(safeErrorText(e, collectCopy.linkInvalid));
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
    catch { setCollectError(collectCopy.pasteFailed); }
  };
  /** The native scanner, behind its runtime guard. `null` is a cancellation, not a failure. */
  const scan = async () => {
    setCollectError("");
    if (!scanQrAvailable()) { setCollectError(collectCopy.scanUnavailable); return; }
    try {
      const scanned = await scanQr();
      if (scanned === null) return;
      openLink(scanned);
    } catch { setCollectError(collectCopy.scanFailed); }
  };
  const openCollectStage = () => { setCollectError(""); setLink(""); setCollectStage(true); };
  /** A collected copy belongs under Collected, so the view switches and the library re-reads. */
  const onCollected = () => { setMode("collected"); setRefresh(n => n + 1); };

  const retry = () => setRefresh(n => n + 1);
  const close = () => { if (immersive) setImmersive(false); else { setSelected(null); setPriceEdition(null); } };
  const toCamera = () => navigation.navigate("Camera");
  const open = (item: LibraryPhoto) => { setSelected(item.id); setFeedback(""); setProof(false); setImmersive(false); setPriceEdition(null); };
  const iconButton = (name: React.ComponentProps<typeof Icon>["name"], label: string, onPress: () => void, active = false, disabled = false) => <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }} disabled={disabled} onPress={onPress} style={({ pressed }) => [s.iconButton, active && s.iconButtonActive, (pressed || disabled) && s.pressed]}><Icon name={name} size={20} color={active ? colors.onTeal : colors.ink} /></Pressable>;
  const copy = async (value: string, label: string) => { try { await Clipboard.setStringAsync(value); setFeedback(collection.copied(label)); } catch { setFeedback(collection.copyFailed); } };
  const share = () => {
    if (!activePhoto) return;
    Share.share({ message: `${activePhoto.photo.edition.title}\n${collectUrl(activePhoto.photo.edition.edition, cluster)}` }).catch(() => setFeedback(collection.shareFailed));
  };
  const changeAlbum = (group: string) => { setSelected(null); setAlbum(group); };
  const e = activePhoto?.photo.edition;
  const activeIndex = activePhoto ? filtered.findIndex(p => p.id === activePhoto.id) : -1;
  const gridWidth = (width - space.gutter * 2 - space.md) / 2;

  return <Screen>
    {focused && <StatusBar style="light" />}
    <BackButton label={actions.camera} accessibilityLabel={actions.backToCamera} onPress={toCamera} testID="back-to-camera" />
    {/* The chain badge, the Collect entry, then the two tabs. Collecting is offered whether or
        not a wallet is connected: the sheet itself asks for one, after showing the photograph. */}
    <View style={s.header}>
      <NetworkLabel label={collection.networkFlag(IS_MAINNET)} />
      <View style={s.grow} />
      <Pill label={actions.collect} accessibilityHint={onChain.collect} variant="secondary" size="small" onPress={openCollectStage} />
    </View>
    {/* With no wallet there is no list and nothing to switch between, so the display line of
        the screen is the state's own sentence, centred. */}
    {!!wallet && <>
      <Tabs<TabLabel> options={TAB_LABELS} value={mode === "published" ? collection.published : collection.collected}
        onChange={label => setMode(label === collection.published ? "published" : "collected")} style={s.tabs} />
    </>}
    <FlatList data={filtered} keyExtractor={item => item.id} numColumns={2}
      columnWrapperStyle={s.gridRow} keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
      contentContainerStyle={s.list}
      refreshControl={<RefreshControl refreshing={loading && Boolean(result)} onRefresh={retry} tintColor={colors.teal} colors={[colors.teal]} />}
      ListHeaderComponent={<>
        {!!items.length && <>
          {albums.length > 0 && <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.chips}>
            <Chip label={collection.allAlbums} selected={!album} onPress={() => setAlbum(null)} />
            {albums.map(([group, label]) => <Chip key={group} label={label} accessibilityLabel={`Filter album ${label}`} selected={album === group} onPress={() => setAlbum(group)} />)}
          </ScrollView>}
        </>}
        {/* The count, not just a flag: anyone can mint Core assets to any owner and grind addresses
            to sort first, so the owner is told how many the scan's cap hid. */}
        {(current?.error && result || result && (result.unavailable > 0 || result.hiddenCount > 0)) && <View style={s.notice}><Text style={s.noticeText}>{current?.error ? collection.noticeStale : result && result.hiddenCount > 0 ? collection.noticeHidden(result.hiddenCount) : collection.noticeUnavailable}</Text><Pressable accessibilityRole="button" onPress={retry} style={s.textButton}><Text style={s.link}>{collection.tryAgain}</Text></Pressable></View>}
      </>}
      ListEmptyComponent={<View style={s.empty}>
        {/* Each state: one true sentence and the one action that changes it. */}
        {loading && !result ? <><ActivityIndicator color={colors.teal} /><Text style={s.emptyBody}>{collection.loading}</Text></> :
          !wallet ? <><BlankPrint /><Text style={s.emptyTitle}>{collection.disconnectedTitle}</Text><Pill label={collection.disconnectedAction} onPress={() => navigation.navigate("Settings")} style={s.emptyAction} /></> :
          current?.error && !result ? <><Text style={s.emptyTitle}>{collection.failedTitle}</Text><Text style={s.emptyBody}>{current.error}</Text><Pill label={collection.tryAgain} onPress={retry} style={s.emptyAction} /></> :
          items.length > 0 ? <><Text style={s.emptyTitle}>{collection.noMatchTitle}</Text><Pill label={collection.clearFilters} variant="secondary" onPress={() => setAlbum(null)} style={s.emptyAction} /></> :
          result && result.unavailable > 0 ? <><Text style={s.emptyTitle}>{collection.partialTitle}</Text><Pill label={collection.partialAction} onPress={retry} style={s.emptyAction} /></> :
          result && result.hiddenCount > 0 ? <><Text style={s.emptyTitle}>{collection.limitedTitle(result.hiddenCount)}</Text><Pill label={collection.limitedAction} onPress={retry} style={s.emptyAction} /></> :
          <><BlankPrint /><Text style={s.emptyTitle}>{collection.emptyTitle(mode)}</Text><Pill label={collection.emptyAction} onPress={toCamera} style={s.emptyAction} /></>}
      </View>}
      renderItem={({ item }) => <Pressable accessibilityRole="button" accessibilityLabel={collection.openPhoto(item.photo.edition.title, item.number)} onPress={() => open(item)} style={({ pressed }) => [s.item, s.gridItem, { maxWidth: gridWidth }, pressed && s.pressed]}>
        <Print item={item} wallet={wallet} compact />
        <Text style={s.readout} numberOfLines={2}>{item.number ? collection.copyLine(item.number, item.photo.edition.supply) : collection.issuedLine(item.photo.minted, item.photo.edition.supply)}</Text>
      </Pressable>}
    />
    <Modal visible={Boolean(activePhoto)} animationType="slide" onRequestClose={close}>
      {activePhoto && e && (immersive
        ? <Screen padded={false}>
            <View style={s.immersiveNav}>{iconButton("arrow-collapse", collection.exitFullScreen, close)}<View style={s.grow}><Text style={s.navLabel}>{collection.immersiveEyebrow}</Text><Text style={s.navTitle} numberOfLines={1}>{e.title}</Text></View></View>
            <Image source={{ uri: activePhoto.imageUri }} resizeMode="contain" style={s.immersiveImage} />
            <View style={[s.immersiveFooter, { paddingBottom: insets.bottom + space.lg }]}>
              {iconButton("chevron-left", collection.previousPhoto, () => { if (activeIndex > 0) setSelected(filtered[activeIndex - 1].id); }, false, activeIndex <= 0)}
              <Text style={s.readout}>{activeIndex + 1} / {filtered.length}</Text>
              {iconButton("chevron-right", collection.nextPhoto, () => { if (activeIndex >= 0 && activeIndex < filtered.length - 1) setSelected(filtered[activeIndex + 1].id); }, false, activeIndex < 0 || activeIndex >= filtered.length - 1)}
            </View>
          </Screen>
        : <Screen>
            {/* The title is imprinted on the paper and set large below it; a third copy in the
                nav would be the same word three times, so the nav carries only the label. */}
            <View style={s.detailNav}>{iconButton("close", collection.backToCollection, close)}<Text style={[s.navLabel, s.grow]}>{collection.detailEyebrow}</Text>{iconButton("share-variant-outline", collection.shareMoment, share)}</View>
            <ScrollView contentContainerStyle={s.detail} showsVerticalScrollIndicator={false}>
              <Pressable accessibilityRole="button" accessibilityLabel={collection.openFullScreen} onPress={() => setImmersive(true)} style={({ pressed }) => [pressed && s.pressed]}>
                <Print item={activePhoto} wallet={wallet} />
              </Pressable>
              <View style={s.readoutRow}>
                <Text style={s.readout}>{activePhoto.number ? collection.copyOf(activePhoto.number, e.supply) : collection.editionOf(e.supply)}</Text>
                <Text style={s.hint}>{collection.viewPhotograph}</Text>
              </View>
              <Text style={s.detailTitle}>{e.title}</Text>
              <Pressable accessibilityRole="button" accessibilityLabel={collection.copyPublisher} onPress={() => void copy(e.creator, collection.publisherAddress)} style={({ pressed }) => [s.row, pressed && s.pressed]}>
                <View style={s.grow}><Text style={s.fieldLabel}>{collection.publishedBy}</Text><Text style={s.fieldValue}>{e.creator === wallet ? collection.you : short(e.creator)}</Text></View>
                <Icon name="content-copy" size={16} color={colors.muted} />
              </Pressable>
              {!!e.description && <View style={s.caption}><Text style={s.captionText}>{e.description}</Text></View>}
              {activePhoto.photo.publication.album && <Pressable accessibilityRole="button" accessibilityLabel={collection.browseAlbum(albumLabel(activePhoto.photo.publication.album))} onPress={() => changeAlbum(activePhoto.photo.publication.album!.group)} style={({ pressed }) => [s.row, pressed && s.pressed]}>
                <View style={s.grow}><Text style={s.fieldLabel}>{collection.inAlbum(mode)}</Text><Text style={s.fieldValue}>{albumLabel(activePhoto.photo.publication.album)}</Text></View>
                <Icon name="arrow-top-right" size={18} color={colors.ink} />
              </Pressable>}
              <View style={s.receipt}>
                {/* What a copy costs, when it costs anything: a free edition has no offer and
                    says nothing here. */}
                {!!activePhoto.photo.offer && <View style={s.receiptRow}><Text style={s.fieldLabel}>{priceCopy.label}</Text><Text style={s.fieldValue}>{priceCopy.value(formatSol(activePhoto.photo.offer.priceLamports))}</Text></View>}
                <View style={s.receiptRow}><Text style={s.fieldLabel}>{collection.editionSizeLabel}</Text><Text style={s.fieldValue}>{collection.editionSizeValue(e.supply)}</Text></View>
                <View style={s.receiptRow}><Text style={s.fieldLabel}>{collection.issuedLabel}</Text><Text style={s.fieldValue}>{activePhoto.photo.minted} / {e.supply}</Text></View>
                <View style={s.receiptRow}><Text style={s.fieldLabel}>{collection.networkLabel}</Text><Text style={s.fieldValue}>{collection.networkValue(IS_MAINNET)}</Text></View>
              </View>
              <Pressable accessibilityRole="button" accessibilityState={{ expanded: proof }} onPress={() => setProof(!proof)} style={({ pressed }) => [s.proofToggle, pressed && s.pressed]}><Text style={[s.fieldValue, s.grow]}>{collection.proofToggle}</Text><Icon name={proof ? "minus" : "plus"} size={18} color={colors.muted} /></Pressable>
              {proof && <View style={s.proof}>
                <Text style={s.emptyBodyLeft}>{collection.proofBody}</Text>
                <Text selectable style={s.address}>{e.edition}</Text>
                <Pill label={collection.copyEdition} variant="secondary" size="small" onPress={() => void copy(e.edition, collection.editionAddress)} />
                <Pill label={collection.viewOnExplorer} variant="secondary" size="small" onPress={() => { Linking.openURL(explorerUrl(e.edition, cluster)).catch(() => setFeedback(collection.explorerFailed)); }} />
              </View>}
              {/* The creator's own control, on their own publication: the price of the copies
                  nobody has taken yet. Keyed by the edition, so a photograph that never came from
                  this phone can still be priced. */}
              {e.creator === wallet && <Pill label={actions.price} accessibilityHint={onChain.setPrice} variant="secondary" size="small" onPress={() => setPriceEdition(e)} />}
              <Text style={s.note}>{activePhoto.number ? collection.ownershipChecked : collection.ownershipPublished}</Text>
            </ScrollView>
            <View style={[s.bottomBar, { paddingBottom: insets.bottom + space.md }]}>
              {!!feedback && <Text accessibilityLiveRegion="polite" style={s.feedback}>{feedback}</Text>}
              <View style={s.bottomActions}><Pill label={collection.shareMoment} onPress={share} style={s.grow} />{iconButton("link-variant", collection.copyLink, () => void copy(collectUrl(e.edition, cluster), collection.momentLink))}</View>
            </View>
            {priceEdition && <OfferSheet edition={priceEdition} session={session} onClose={() => setPriceEdition(null)} onSaved={() => setRefresh(n => n + 1)} />}
          </Screen>)}
    </Modal>
    {/* The Collect entry: one field and two one-word pills. Paste or scan a link; everything
        else about the edition is the Collect sheet's to show. */}
    <Modal visible={collectStage} animationType="slide" onRequestClose={() => setCollectStage(false)}>
      <Screen>
        <View style={s.detailNav}>{iconButton("close", collection.backToCollection, () => setCollectStage(false))}<Text style={[s.navLabel, s.grow]}>{collectCopy.entryHeading}</Text></View>
        <ScrollView contentContainerStyle={s.detail} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
          <Text style={s.fieldLabel}>{collectCopy.linkLabel}</Text>
          <TextInput style={s.input} value={link} onChangeText={value => { setLink(value); setCollectError(""); }}
            accessibilityLabel={collectCopy.linkLabel} placeholder={collectCopy.linkPlaceholder} placeholderTextColor={colors.muted}
            autoCapitalize="none" autoCorrect={false} multiline />
          <View style={s.collectActions}>
            <Pill label={actions.open} disabled={!link.trim()} onPress={() => openLink(link)} style={s.grow} />
            <Pill label={actions.paste} variant="secondary" onPress={() => void pasteLink()} />
            {/* Offered only when this build's native side actually has the scanner. */}
            {scanQrAvailable() && <Pill label={actions.scan} variant="secondary" onPress={() => void scan()} />}
          </View>
          {!!collectError && <Text accessibilityLiveRegion="polite" style={s.collectError}>{collectError}</Text>}
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

  // --- header, heading, tabs ---------------------------------------------
  header: { flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: 44 },
  iconButton: { width: 44, height: 44, borderRadius: radius.pill, alignItems: "center", justifyContent: "center", backgroundColor: colors.sheet },
  iconButtonActive: { backgroundColor: colors.teal },
  tabs: { marginBottom: space.md },

  // --- the list ----------------------------------------------------------
  list: { flexGrow: 1, paddingBottom: space.lg },
  gridRow: { gap: space.md },
  item: { marginBottom: space.xl, gap: space.sm },
  gridItem: { flex: 1, marginBottom: space.lg },
  readout: { ...typeScale.readout, color: colors.tealText },

  chips: { gap: space.sm, paddingBottom: space.lg },

  notice: { gap: space.xs, padding: space.md, backgroundColor: colors.sheet, borderRadius: radius.small, marginBottom: space.lg },
  noticeText: { ...typeScale.body, color: colors.muted },
  textButton: { minHeight: 36, justifyContent: "center" },
  link: { ...typeScale.body, color: colors.tealText },

  // --- states ------------------------------------------------------------
  empty: { flex: 1, alignItems: "center", justifyContent: "center", gap: space.md, paddingBottom: space.xxl },
  emptyTitle: { ...typeScale.title, color: colors.ink, textAlign: "center", marginTop: space.md },
  emptyBody: { ...typeScale.body, color: colors.muted, textAlign: "center", maxWidth: 300 },
  emptyBodyLeft: { ...typeScale.body, color: colors.muted },
  emptyAction: { alignSelf: "stretch", marginTop: space.sm },
  blankPrint: { width: 244, transform: [{ rotate: "-1.4deg" }] },
  // Paper carries graphite only: the blank sheet is a graphite wash and hairline on the cream.
  blankPicture: { flex: 1, borderWidth: 1, borderStyle: "dashed", borderColor: "rgba(32,37,30,0.28)", backgroundColor: "rgba(32,37,30,0.06)" },

  // --- the photograph's own screen ---------------------------------------
  detailNav: { flexDirection: "row", alignItems: "center", gap: space.md, paddingBottom: space.md },
  navLabel: { ...typeScale.label, color: colors.muted },
  navTitle: { ...typeScale.body, color: colors.ink, marginTop: space.xs },
  detail: { paddingBottom: space.xl, gap: space.md },
  readoutRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.sm },
  hint: { ...typeScale.label, color: colors.muted },
  detailTitle: { ...typeScale.title, color: colors.ink },
  row: { flexDirection: "row", alignItems: "center", gap: space.md, paddingVertical: space.md, borderTopWidth: 1, borderTopColor: colors.line },
  fieldLabel: { ...typeScale.label, color: colors.muted },
  fieldValue: { ...typeScale.body, color: colors.ink, marginTop: space.xs },
  caption: { borderLeftWidth: 2, borderLeftColor: colors.teal, paddingLeft: space.md },
  captionText: { ...typeScale.body, color: colors.ink },
  receipt: { gap: space.md, paddingTop: space.md, borderTopWidth: 1, borderTopColor: colors.line },
  receiptRow: { flexDirection: "row", alignItems: "flex-end", justifyContent: "space-between", gap: space.md },
  proofToggle: { flexDirection: "row", alignItems: "center", gap: space.md, paddingVertical: space.md, borderTopWidth: 1, borderTopColor: colors.line },

  // --- the Collect entry --------------------------------------------------
  input: { ...typeScale.body, fontFamily: typeScale.imprint.fontFamily, fontSize: 13, lineHeight: 20, color: colors.ink, backgroundColor: colors.field, borderWidth: 1, borderColor: colors.line, borderRadius: radius.small, minHeight: 90, padding: 14, textAlignVertical: "top" },
  collectActions: { flexDirection: "row", alignItems: "center", gap: space.sm },
  collectError: { ...typeScale.body, color: colors.danger },

  proof: { gap: space.md },
  address: { ...typeScale.body, fontFamily: typeScale.imprint.fontFamily, color: colors.ink },
  note: { ...typeScale.body, color: colors.muted },
  feedback: { ...typeScale.body, color: colors.tealText, textAlign: "center", paddingBottom: space.sm },
  bottomBar: { paddingTop: space.md, borderTopWidth: 1, borderTopColor: colors.line, backgroundColor: colors.ground },
  bottomActions: { flexDirection: "row", alignItems: "center", gap: space.md },

  // --- full screen -------------------------------------------------------
  immersiveNav: { flexDirection: "row", alignItems: "center", gap: space.md, paddingHorizontal: space.gutter, paddingBottom: space.md },
  immersiveImage: { flex: 1, width: "100%" },
  immersiveFooter: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: space.gutter, paddingTop: space.md },
});
