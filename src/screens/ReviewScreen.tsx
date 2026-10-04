import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  Alert,
  FlatList,
  Image,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  View,
  Pressable,
  useWindowDimensions,
} from "react-native";
import {
  useFocusEffect,
  useIsFocused,
  useNavigation,
  useRoute,
  type RouteProp,
} from "@react-navigation/native";
import type { BottomTabNavigationProp } from "@react-navigation/bottom-tabs";
import { useMobileWallet } from "@wallet-ui/react-native-kit";
import * as Sharing from "expo-sharing";
import { StatusBar } from "expo-status-bar";
import { useWalletSession } from "../solana/useWalletSession";
import type { HomeTabs } from "../navigators/HomeNavigator";
import {
  SeekerCamera,
  saveToGallery,
  type CaptureRecord,
  type PhotoEdit,
} from "../../modules/seeker-camera";
import { useSeekerIdentity } from "../seeker/useSeekerIdentity";
import { useShareStampPref } from "../seeker/shareStampPref";
import {
  forgetPublicationDraft,
  getPublicationState,
  getSavedPublicationState,
  payStorage,
  publicationDataItems,
  retryPublicationStorage,
  isPublicationWorking,
} from "../prints/creator";
import { useStorageTopUp } from "../prints/useStorageTopUp";
import { isUserCancellation } from "../solana/walletErrors";
import {
  forgetTransferAttempt,
  getTransferState,
  isTransferWorking,
  photoTransfer,
} from "../prints/transfer";
import { deletePhotoAfterFreshChecks } from "../prints/photoDeletion";
import { photoShareStamp } from "../prints/photoShareStamp";
import {
  canExportPublicationBundle,
  publicationBundleDocument,
} from "../prints/publicationBundle";
import { getOffer } from "../prints/offer";
import { formatSol } from "../prints/price";
import { PrintSheet } from "../prints/PrintSheet";
import { OfferSheet } from "../prints/OfferSheet";
import { PhotoEditor } from "../prints/PhotoEditor";
import { ProofSheet } from "../prints/ProofSheet";
import { SendSheet } from "../prints/SendSheet";
import { readPhotoEdit, savePhotoEdit } from "../prints/photoStorage";
import {
  canDevelop,
  developedRecipeName,
  photoMark,
  photoStatus,
  selectPhotoPresentation,
  selectedPhotoUri,
  selectedShareSource,
  shortAddress,
  type PhotoPublication,
} from "../prints/photoPresentation";
import { develop as developCopy } from "../prints/developCopy";
import { allRecipes } from "../recipes/store";
import { qrMatrix } from "../ui/qr";
import { colors, space } from "../ui/theme";
import { typeScale } from "../ui/type";
import { BackButton, PhotoFrame, Pill, Screen } from "../ui/primitives";
import {
  actions,
  editionLine,
  onChain,
  photos as photoCopy,
  price as priceCopy,
} from "../ui/copy";
import { safeErrorText } from "../ui/errorText";
import { useAppActive } from "../useAppActive";
import { loadPhotosInStages } from "../prints/photoLoading";

interface PhotoEntry {
  record: CaptureRecord;
  edit?: PhotoEdit;
  publication: PhotoPublication;
  error?: string;
}

/** Each photograph keeps one selected version and one lifecycle across capture, review and publication. */
export function ReviewScreen() {
  const focused = useIsFocused();
  const active = useAppActive();
  const navigation =
    useNavigation<BottomTabNavigationProp<HomeTabs, "Review">>();
  const route = useRoute<RouteProp<HomeTabs, "Review">>();
  const { height, width } = useWindowDimensions();
  const [photos, setPhotos] = useState<PhotoEntry[]>([]),
    [loading, setLoading] = useState(true),
    [error, setError] = useState("");
  const [openBaseName, setOpenBaseName] = useState<string | null>(null);
  const [sheet, setSheet] = useState<
    "publish" | "edit" | "proof" | "send" | "offer" | null
  >(null);
  const [busy, setBusy] = useState(false),
    [feedback, setFeedback] = useState("");
  /** Recipe ids to names: the fallback for a camera frame whose sidecar records only the id. */
  const [recipeNames, setRecipeNames] = useState<Record<string, string>>({});
  /**
   * The open photograph's price, read from the chain rather than from its draft, so a price set
   * from the Wallet screen or another device is the one shown here. `supported` is false for a
   * deployment without prices, which has nothing to set.
   */
  const [offer, setOffer] = useState<{
    edition: string;
    supported: boolean;
    offer: { priceLamports: bigint; revision: number } | null;
  } | null>(null);
  const request = useRef(0),
    operation = useRef(false);
  const { account } = useMobileWallet();
  const identity = useSeekerIdentity(),
    stampPref = useShareStampPref();
  const session = useWalletSession();
  const detail = photos.find((p) => p.record.baseName === openBaseName);
  /**
   * A capture the camera just handed over. The list stays out of sight until its photograph
   * opens, for three seconds at most, so the shutter leads to the photograph and nothing else.
   */
  const target = route.params?.photo;
  const awaited = useRef(target);
  awaited.current = target;
  /** The capture whose three seconds are up. Kept by name, so the next capture starts unseen. */
  const [waitedFor, setWaitedFor] = useState<string>();
  useEffect(() => {
    if (!target) return;
    const timer = setTimeout(() => setWaitedFor(target), 3000);
    return () => clearTimeout(timer);
  }, [target]);
  /**
   * The photograph the shutter just made, while it is the one open: it opens without the fade
   * (which would show the list through it), the list stays unseen under it, and Develop is not
   * offered, since its look was chosen a moment ago. Opened from Photos it is like any other.
   */
  const [takenBaseName, setTakenBaseName] = useState<string | null>(null);
  const justTaken = !!detail && openBaseName === takenBaseName;
  const arriving = (!!target && waitedFor !== target && !detail) || justTaken;
  /** The ratio of a camera version, known once its picture has loaded. */
  const [measured, setMeasured] = useState<{ uri: string; aspect: number } | null>(null);

  /**
   * True from the start of a full read until its list lands. A re-read of one photograph asked
   * for meanwhile reads them all: alone it would cancel the list and leave the grid short.
   */
  const listing = useRef(false);
  const load = useCallback(async (only?: CaptureRecord) => {
    const record = listing.current ? undefined : only;
    const id = ++request.current;
    if (!record) listing.current = true;
    try {
      const records = record ? [record] : await SeekerCamera.listCaptures();
      const readLocal = async (record: CaptureRecord): Promise<PhotoEntry> => {
        const [publication, selection] = await Promise.all([
          getSavedPublicationState(record),
          readPhotoEdit(record)
            .then((edit) => ({
              edit,
              error: undefined as string | undefined,
            }))
            .catch((e) => ({ edit: undefined, error: safeErrorText(e) })),
        ]);
        return { record, publication, ...selection };
      };
      // The capture the camera handed over is read first, so its photograph opens at once.
      const first = record ? undefined : records.find((r) => r.baseName === awaited.current);
      if (first) {
        const entry = await readLocal(first);
        if (id !== request.current) return;
        setPhotos((previous) =>
          previous.some((p) => p.record.baseName === first.baseName) ? previous : [entry, ...previous]);
      } else if (!record && awaited.current && id === request.current) {
        // Not among the captures: there is nothing to open, now or on a later read.
        navigation.setParams({ photo: undefined });
      }
      await loadPhotosInStages<CaptureRecord, PhotoEntry>({
        records,
        readLocal,
        showLocal: (next) => {
          if (!record) listing.current = false;
          setPhotos(previous => record
            ? previous.map(entry => entry.record.baseName === record.baseName ? next[0] : entry)
            : next);
          setLoading(false);
          setError("");
        },
        refresh: async (entry) => ({ ...entry, publication: await getPublicationState(entry.record) }),
        showFresh: (fresh) => setPhotos(previous => previous.map(entry =>
          entry.record.baseName === fresh.record.baseName
            ? { ...entry, publication: fresh.publication } : entry)),
        isCurrent: () => id === request.current,
      });
    } catch (e) {
      if (id === request.current) {
        setError(safeErrorText(e));
        if (!record) {
          listing.current = false;
          // The captures could not be read: the hand-over ends here, and the error shows.
          if (awaited.current) navigation.setParams({ photo: undefined });
        }
      }
    } finally {
      if (id === request.current) setLoading(false);
    }
  }, [navigation]);
  useFocusEffect(
    useCallback(() => {
      if (!active) return;
      void load();
      return () => { request.current++; };
    }, [load, active]),
  );
  useEffect(() => {
    let live = true;
    void allRecipes()
      .then((list) => {
        if (live)
          setRecipeNames(Object.fromEntries(list.map((item) => [item.id, item.name])));
      })
      .catch(() => {
        // A name is a nicety; the photograph and its status do not depend on it.
      });
    return () => {
      live = false;
    };
  }, []);
  useEffect(
    () => () => {
      request.current++;
    },
    [],
  );
  useEffect(() => {
    const target = route.params?.photo;
    if (target && photos.some((p) => p.record.baseName === target)) {
      setOpenBaseName(target);
      setTakenBaseName(target);
      setSheet(null);
      setFeedback("");
      navigation.setParams({ photo: undefined });
    }
  }, [photos, route.params?.photo, navigation]);

  async function perform(work: () => Promise<void>) {
    if (operation.current) return;
    operation.current = true;
    setBusy(true);
    setFeedback("");
    try {
      await work();
    } catch (e) {
      setFeedback(safeErrorText(e));
    } finally {
      operation.current = false;
      setBusy(false);
    }
  }
  function open(entry: PhotoEntry) {
    setOpenBaseName(entry.record.baseName);
    setTakenBaseName(null);
    setSheet(null);
    setFeedback("");
    // Opening a photograph is the status check. There is no button for it.
    void load(entry.record);
  }
  function close() {
    if (!busy) {
      setOpenBaseName(null);
      setTakenBaseName(null);
      setSheet(null);
    }
  }
  function closeSheet() {
    setSheet(null);
    setFeedback("");
    if (detail) void load(detail.record);
  }
  async function save(entry: PhotoEntry) {
    const d = entry.publication.draft;
    if (
      d &&
      d.sourceHash !== entry.record.styled.sha256 &&
      entry.edit?.sha256 !== d.sourceHash
    ) {
      throw new Error(photoCopy.missingFullSize);
    }
    await saveToGallery(
      entry.record.baseName,
      d?.sourceHash === entry.record.styled.sha256 ? undefined : entry.edit,
    );
    setFeedback(photoCopy.savedToGallery);
  }
  async function share(entry: PhotoEntry) {
    const r = entry.record,
      d = entry.publication.draft;
    const stamp = photoShareStamp({
      publication: entry.publication,
      enabled: stampPref.enabled,
      wallet: identity.wallet,
      name: identity.skrName,
    });
    // Every share is a copy under `cacheDir/share`: expo-sharing's FileProvider grants read access
    // it never revokes, so the originals under `filesDir/captures` are not addressable.
    const source = selectedShareSource(r, entry.edit, d);
    const uri = stamp
      ? await SeekerCamera.stampSelectedShareCopy(
          r.baseName,
          stamp.uri,
          stamp.expectedHash,
          stamp.text,
        )
      : await SeekerCamera.shareCopy(
          r.baseName,
          source.uri,
          source.expectedHash,
        );
    await Sharing.shareAsync(uri, {
      mimeType: "image/jpeg",
      dialogTitle: d?.edition.title ?? "Share photograph",
    });
  }
  /**
   * One JSON file (metadata, image, signed data items, draft) for a confirmed publication whose
   * upload is unfinished, re-hashed natively against the signed `image_hash`, then shared. There is
   * no import. Items that cannot be rebuilt leave the rest of the bundle.
   */
  async function exportBundle(entry: PhotoEntry) {
    const d = entry.publication.draft;
    if (!d) return;
    const items = await publicationDataItems(d).catch(() => undefined);
    const uri = await SeekerCamera.exportPublicationBundle(
      entry.record.baseName,
      `file://${d.imagePath}`,
      d.edition.imageHash,
      JSON.stringify(publicationBundleDocument(d, Date.now(), items)),
    );
    await Sharing.shareAsync(uri, {
      mimeType: "application/json",
      dialogTitle: `${d.edition.title} — publication bundle`,
    });
    setFeedback(photoCopy.exportBundleDone);
  }
  async function shareCard(entry: PhotoEntry) {
    const d = entry.publication.draft;
    // The public link comes from the derived view, never rebuilt here.
    const url = entry.publication.view?.publicUrl;
    if (!d || !url) return;
    const qr = qrMatrix(url);
    const uri = await SeekerCamera.sharePrintCard(
      entry.record.baseName,
      d.sourceHash,
      d.edition.title,
      d.edition.supply,
      qr.modules,
      qr.size,
    );
    await Sharing.shareAsync(uri, {
      mimeType: "image/png",
      dialogTitle: "Share photo and record",
    });
  }
  function deletePhoto(entry: PhotoEntry) {
    const d = entry.publication.draft;
    if (
      entry.publication.status === "unavailable" ||
      (d &&
        (entry.publication.status !== "published" || d.storage !== "available"))
    ) {
      setFeedback(photoCopy.deleteBlocked);
      return;
    }
    Alert.alert(
      photoCopy.deleteTitle,
      photoCopy.deleteBody,
      [
        { text: photoCopy.deleteKeep, style: "cancel" },
        {
          text: photoCopy.deleteConfirm,
          style: "destructive",
          onPress: () =>
            void perform(async () => {
              await deletePhotoAfterFreshChecks(entry.record.baseName, {
                readCapture: async (baseName) =>
                  (await SeekerCamera.listCaptures()).find(
                    (record) => record.baseName === baseName,
                  ),
                readPublication: getPublicationState,
                readTransfer: (record, draft) => getTransferState(photoTransfer(record, draft)),
                publicationWorking: isPublicationWorking,
                transferWorking: isTransferWorking,
                removeFiles: async (record, draft) => {
                  await SeekerCamera.deleteCapture(record.baseName);
                  await savePhotoEdit(record);
                  // Drop the stored draft and transfer attempt too, or they stay unreachable for
                  // the life of the install. Only after `deleteCapture` resolves.
                  await forgetPublicationDraft(record);
                  if (draft) await forgetTransferAttempt(draft);
                },
              });
              setOpenBaseName(null);
              await load();
            }),
        },
      ],
    );
  }

  const record = detail?.record,
    d = detail?.publication.draft;
  const newPublished = detail?.publication.status === "published";
  const presentation = detail
    ? selectPhotoPresentation(detail.record, detail.publication)
    : undefined;
  const knownPublished = presentation?.proof.kind === "core" &&
    (presentation.proof.confirmation === "confirmed" || presentation.proof.confirmation === "cached");
  const owner = presentation?.proof.publisher;
  const ownerLabel = owner
    ? owner === identity.wallet && identity.skrName
      ? identity.skrName
      : shortAddress(owner)
    : undefined;
  const storageCanRetry =
    !d?.storageError ||
    d.storageError.retryable ||
    d.storageError.kind === "quota";
  /**
   * Confirmed but not uploaded: this phone holds the only copy. Not gated on `storageCanRetry`,
   * because a non-retryable error is when the bytes most need a way off the device.
   */
  const canExportBundle = newPublished && canExportPublicationBundle(d);
  /** An unfinished upload resumes once per opening of the photograph. No wallet is involved. */
  const resumedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!detail || !d || !newPublished || d.storage === "available") return;
    if (!storageCanRetry || resumedFor.current === detail.record.baseName) return;
    resumedFor.current = detail.record.baseName;
    void perform(async () => {
      try {
        await retryPublicationStorage(detail.record, d);
      } finally {
        await load(detail.record);
      }
    });
    // `perform` is a plain function of this render; the guards above are what matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail, d, newPublished, storageCanRetry, load]);
  useEffect(() => {
    if (openBaseName === null) resumedFor.current = null;
  }, [openBaseName]);
  /** Storage bought again, once the provider refused the upload or found its credit short. */
  const topUp = useStorageTopUp(newPublished ? d : null);
  async function payForStorage(entry: PhotoEntry) {
    const draft = entry.publication.draft;
    if (!draft || !topUp) return;
    try {
      await payStorage(entry.record, draft, session, topUp);
    } catch (e) {
      if (!isUserCancellation(e)) throw e;
    } finally {
      await load(entry.record);
    }
  }
  /** The price of the open, published photograph. One read, and never a wallet. */
  useEffect(() => {
    if (!d || !newPublished) {
      setOffer(null);
      return;
    }
    let live = true;
    const key = d.edition.edition;
    void getOffer(d.edition).then(
      (next) => {
        if (live) setOffer({ edition: key, ...next });
      },
      () => {
        // An unreadable price shows nothing; nothing else on this photograph depends on it.
        if (live) setOffer(null);
      },
    );
    return () => {
      live = false;
    };
  }, [d, newPublished]);
  /** A transaction that may still land is re-read every 4 s while its photograph is open. */
  useEffect(() => {
    if (!focused || !active || detail?.publication.status !== "pending") return;
    const timer = setTimeout(() => void load(detail.record), 4000);
    return () => clearTimeout(timer);
  }, [detail, load, focused, active]);
  const publishedCount = photos.filter(
    (p) => p.publication.status === "published",
  ).length;
  // Two prints to a row on the 18 px gutter: the picture is the cell less the paper border, at
  // a slightly landscape ratio.
  const cellWidth = (width - space.gutter * 2 - GRID_GAP) / 2;
  const gridPicture = Math.max(
    96,
    Math.round((cellWidth - CAPTION_PAD * 2) * 0.9),
  );
  /** What developed this photograph, by name: the saved version's recipe, else the capture's. */
  const nameOf = (source: CaptureRecord, edit?: PhotoEdit): string | null =>
    developedRecipeName(edit) ??
    recipeNames[edit?.profileId ?? source.profileId] ??
    null;
  /** A print's title: the published edition's own, else the recipe's name, else one word. */
  const titleOf = (entry: PhotoEntry): string =>
    entry.publication.draft?.edition.title ??
    nameOf(entry.record, entry.edit) ??
    developCopy.untitled;
  const detailName = record ? nameOf(record, detail?.edit) : null;
  const pixels = d
    ? `${d.edition.width} × ${d.edition.height}`
    : detail?.edit
      ? `${detail.edit.width} × ${detail.edit.height}`
      : "";
  const metaLine = record
    ? [detailName, imprintDate(record.capturedAtMs), pixels]
        .filter(Boolean)
        .join(" · ")
    : "";
  /** Null for a photograph nothing has been done to: the readout then ends at its size. */
  const detailStatus = detail ? photoStatus(detail.publication) : null;
  /**
   * The print takes the photograph's ratio (draft, else saved edit, else the loaded picture). The picture is
   * capped in height and the paper narrows, so a portrait photo makes a portrait print.
   */
  const detailPixels = d
    ? { width: d.edition.width, height: d.edition.height }
    : detail?.edit
      ? { width: detail.edit.width, height: detail.edit.height }
      : null;
  const detailUri = record ? selectedPhotoUri(record, detail?.edit, d) : "";
  const detailAspect =
    detailPixels && detailPixels.width > 0 && detailPixels.height > 0
      ? detailPixels.width / detailPixels.height
      : measured?.uri === detailUri
        ? measured.aspect
        : 3 / 4;
  /**
   * The price, only for the photograph it was read for: `offer` outlives one render of another
   * photograph otherwise, and a price shown under the wrong picture is worse than none.
   */
  const currentOffer =
    offer && d && offer.edition === d.edition.edition ? offer : null;
  const priceLine =
    currentOffer?.offer && currentOffer.offer.priceLamports > 0n
      ? `${priceCopy.label} ${priceCopy.value(formatSol(currentOffer.offer.priceLamports))}`
      : "";
  const detailPad = CAPTION_PAD;
  const detailPictureMax = Math.min(440, Math.round(height * 0.5));
  const detailPictureWidth = Math.min(
    width - space.gutter * 2 - detailPad * 2,
    Math.round(detailPictureMax * detailAspect),
  );
  return (
    <Screen>
      {focused && <StatusBar style="light" />}
      <View style={[s.flex, arriving && s.unseen]} pointerEvents={arriving ? "none" : "auto"}>
      <BackButton
        label={actions.camera}
        accessibilityLabel={actions.backToCamera}
        onPress={() => navigation.navigate("Camera")}
        testID="back-to-camera"
      />
      <View style={s.header}>
        <Text style={s.heading}>{photoCopy.heading}</Text>
        <Text style={s.count}>
          {photoCopy.photographs(photos.length)}
          {publishedCount > 0 ? (
            <Text style={s.countPublished}>
              {` · ${photoCopy.publishedCount(publishedCount)}`}
            </Text>
          ) : null}
        </Text>
      </View>
      <FlatList
        data={photos}
        keyExtractor={(p) => p.record.baseName}
        numColumns={2}
        columnWrapperStyle={s.gridRow}
        contentContainerStyle={s.grid}
        refreshing={loading}
        onRefresh={() => {
          setLoading(true);
          void load();
        }}
        renderItem={({ item }) => {
          const title = titleOf(item);
          const published = item.publication.status === "published";
          const status = photoStatus(item.publication);
          const mark = photoMark(item.publication);
          return (
            <Pressable
              style={({ pressed }) => [s.cell, pressed && s.pressed]}
              accessibilityRole="button"
              accessibilityLabel={status ? `${title}, ${status}` : title}
              onPress={() => open(item)}
            >
              {/* An empty `mark` suppresses PhotoFrame's default wordmark on unpublished prints. */}
              <PhotoFrame
                source={{
                  uri: selectedPhotoUri(
                    item.record,
                    item.edit,
                    item.publication.draft,
                  ),
                }}
                title={title}
                byline={imprintDate(item.record.capturedAtMs)}
                mark={
                  published && item.publication.draft
                    ? photoCopy.copyMark(
                        1,
                        item.publication.draft.edition.supply,
                      )
                    : ""
                }
                variant="grid"
                imageHeight={gridPicture}
              />
              {/* Status sits under the paper, which carries graphite only. */}
              {mark && (
                <Text
                  style={[
                    s.gridMark,
                    mark === "published" ? s.gridMarkPublished : s.gridMarkAttention,
                  ]}
                  testID={`photo-mark-${mark}`}
                >
                  {mark === "published"
                    ? photoCopy.statusPublished
                    : photoCopy.statusAttention}
                </Text>
              )}
            </Pressable>
          );
        }}
        ListHeaderComponent={error ? <Text style={s.error}>{error}</Text> : null}
        ListEmptyComponent={
          <View style={s.empty}>
            <PhotoFrame style={s.emptyPrint} imageHeight={120} variant="grid">
              <View style={s.emptyPicture} />
            </PhotoFrame>
            <Text style={s.emptyHeading}>
              {loading ? photoCopy.loading : photoCopy.emptyHeading}
            </Text>
            <Pill
              label={actions.openCamera}
              onPress={() => navigation.navigate("Camera")}
            />
          </View>
        }
      />
      </View>
      <Modal visible={!!detail} animationType={justTaken ? "none" : "fade"} onRequestClose={close}>
        {detail && record && (
          <Screen>
            <BackButton
              label={actions.back}
              accessibilityLabel="Back to photos"
              onPress={close}
              disabled={busy}
            />
            <ScrollView contentContainerStyle={s.detailContent}>
              {/* Uncropped: the one place a person checks what they actually took. */}
              <PhotoFrame
                aspectRatio={detailAspect}
                style={{
                  width: detailPictureWidth + detailPad * 2,
                  alignSelf: "center",
                }}
              >
                <Image
                  source={{ uri: detailUri }}
                  style={s.detailPhoto}
                  resizeMode="contain"
                  onLoad={({ nativeEvent: { source } }) => {
                    if (source.width > 0 && source.height > 0)
                      setMeasured({ uri: detailUri, aspect: source.width / source.height });
                  }}
                  accessibilityLabel={d?.edition.title ?? titleOf(detail)}
                />
              </PhotoFrame>
              <View style={s.captionBlock}>
                <Text style={s.photoTitle}>{titleOf(detail)}</Text>
                {d?.edition.description ? (
                  <Text style={s.moment}>{d.edition.description}</Text>
                ) : null}
                {/* Capture facts and status in one mono readout; publisher and edition are body text. */}
                <Text style={s.meta}>
                  {metaLine}
                  {detailStatus && metaLine ? " · " : ""}
                  {detailStatus && (
                    <Text style={newPublished ? s.metaPublished : undefined}>
                      {detailStatus}
                    </Text>
                  )}
                </Text>
                {ownerLabel ? (
                  <Text style={s.body}>
                    {`${presentation?.publisherLabel} ${ownerLabel}`}
                  </Text>
                ) : null}
                {d && (
                  <Text style={s.body}>
                    {knownPublished ? "" : "Publication draft · "}
                    {editionLine(d.edition.supply)}
                    {d.edition.cluster === "devnet" ? " · Devnet" : ""}
                  </Text>
                )}
                {/* What a buyer pays for one of the remaining copies. Absent for a free edition. */}
                {!!priceLine && <Text style={s.body}>{priceLine}</Text>}
              </View>
              {detail.publication.reason && (
                <Text style={s.body}>{detail.publication.reason}</Text>
              )}
              {detail.error && <Text style={s.error}>{detail.error}</Text>}
              {/* No status or upload buttons: status is read on open and while pending, and an
                  unfinished upload resumes by itself. */}
              {presentation?.publishLabel && (
                <Pill
                  label={presentation.publishLabel}
                  disabled={busy || !!detail.error}
                  onPress={() => setSheet("publish")}
                />
              )}
              {knownPublished && d && (
                <Pill
                  label={actions.share}
                  accessibilityHint={onChain.shareLink}
                  disabled={busy || d.storage !== "available"}
                  onPress={() => void perform(() => shareCard(detail))}
                />
              )}
              {/* The creator's own control. Offered only where the edition's deployment can hold
                  a price at all; the sheet itself is where the amount is reviewed and approved. */}
              {knownPublished && d && currentOffer?.supported && (
                <Pill
                  label={actions.price}
                  accessibilityHint={onChain.setPrice}
                  variant="secondary"
                  size="small"
                  disabled={busy}
                  onPress={() => setSheet("offer")}
                />
              )}
              {d?.storageError && (
                <Text style={s.error}>{d.storageError.message}</Text>
              )}
              {topUp && (
                <Pill
                  label={actions.payStorage(formatSol(topUp.lamports))}
                  disabled={busy}
                  onPress={() => void perform(() => payForStorage(detail))}
                />
              )}
              <View style={s.actionRow}>
                <Pill
                  label={actions.save}
                  variant="secondary"
                  size="small"
                  wrap
                  disabled={busy}
                  onPress={() => void perform(() => save(detail))}
                  style={s.flex}
                />
                {knownPublished && d ? (
                  <Pill
                    label={actions.send}
                    accessibilityHint={onChain.send}
                    variant="secondary"
                    size="small"
                    wrap
                    disabled={busy || !newPublished}
                    onPress={() => setSheet("send")}
                    style={s.flex}
                  />
                ) : (
                  <Pill
                    label={actions.share}
                    variant="secondary"
                    size="small"
                    wrap
                    disabled={busy}
                    onPress={() => void perform(() => share(detail))}
                    style={s.flex}
                  />
                )}
                {canDevelop(detail.publication) && !detail.error && !justTaken && (
                  <Pill
                    label={developCopy.develop}
                    variant="secondary"
                    size="small"
                    wrap
                    disabled={busy}
                    onPress={() => setSheet("edit")}
                    style={s.flex}
                  />
                )}
              </View>
              {!!feedback && (
                <Text style={s.feedback} accessibilityLiveRegion="polite">
                  {feedback}
                </Text>
              )}
              {canDevelop(detail.publication) &&
                !detail.error &&
                detail.edit && (
                  <Pill
                    label={actions.useCameraVersion}
                    variant="secondary"
                    size="small"
                    disabled={busy}
                    onPress={() =>
                      void perform(async () => {
                        await savePhotoEdit(record);
                        await load();
                      })
                    }
                  />
                )}
              {/* The only way an un-uploaded publication's bytes leave the phone. */}
              {canExportBundle && (
                <Pill
                  label={busy ? actions.exportingBundle : actions.exportBundle}
                  variant="secondary"
                  size="small"
                  disabled={busy}
                  onPress={() => void perform(() => exportBundle(detail))}
                />
              )}
              {(!!d || knownPublished) && (
                <Pill
                  label={actions.details}
                  variant="secondary"
                  size="small"
                  onPress={() => setSheet("proof")}
                />
              )}
              {/* The destructive action sits apart, behind its own rule. */}
              <View style={s.danger}>
                <Pill
                  label={actions.delete}
                  variant="destructive"
                  size="small"
                  disabled={busy}
                  onPress={() => deletePhoto(detail)}
                />
              </View>
            </ScrollView>
            {sheet === "publish" && (
              <PrintSheet
                record={record}
                session={session}
                walletAddress={account?.address}
                walletName={identity.skrName ?? undefined}
                onClose={closeSheet}
                onChanged={() => void load(record)}
              />
            )}
            {sheet === "proof" && presentation && (
              <ProofSheet proof={presentation.proof} onClose={closeSheet} />
            )}
            {sheet === "send" && d && (
              <SendSheet
                target={photoTransfer(record, d)}
                image={`file://${d.imagePath}`}
                session={session}
                onClose={closeSheet}
              />
            )}
            {sheet === "offer" && d && (
              <OfferSheet
                edition={d.edition}
                session={session}
                onClose={closeSheet}
                onSaved={() => void load(record)}
              />
            )}
            {sheet === "edit" && (
              <PhotoEditor
                record={record}
                initial={detail.edit}
                onClose={closeSheet}
                onSave={async (edit) => {
                  await savePhotoEdit(record, edit);
                  setSheet(null);
                  await load(record);
                }}
              />
            )}
          </Screen>
        )}
      </Modal>
    </Screen>
  );
}
/** The gap between two prints in the grid, and the paper border a captioned print takes. */
const GRID_GAP = 14;
const CAPTION_PAD = 10;

/** Imprinted under a print's title, in the phone's own locale: "12 SEP 2026". */
function imprintDate(ms: number) {
  return new Date(ms).toLocaleDateString(undefined, {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}
const s = StyleSheet.create({
  header: { gap: 6, paddingBottom: space.lg },
  heading: { ...typeScale.display, color: colors.ink },
  count: { ...typeScale.label, color: colors.muted },
  /** Purple is the sparse emphasis the tokens reserve for a count like this one. */
  countPublished: { color: colors.purpleText },
  grid: { gap: GRID_GAP, paddingBottom: space.lg, flexGrow: 1 },
  gridRow: { gap: GRID_GAP },
  cell: { flex: 1, maxWidth: "50%" },
  /** A print's status, on the ground under the paper. Purple is the published emphasis. */
  gridMark: { ...typeScale.label, marginTop: space.sm },
  gridMarkPublished: { color: colors.purpleText },
  gridMarkAttention: { color: colors.ink },
  pressed: { opacity: 0.7 },
  empty: {
    flex: 1,
    justifyContent: "center",
    gap: space.lg,
    paddingBottom: space.xxl,
  },
  emptyPrint: {
    alignSelf: "center",
    width: 150,
    transform: [{ rotate: "-7deg" }],
    marginBottom: space.sm,
  },
  emptyPicture: { width: "100%", height: "100%", backgroundColor: colors.field },
  emptyHeading: {
    ...typeScale.title,
    color: colors.ink,
    textAlign: "center",
  },
  /** Room under the destructive pill at the foot, so the scroll never ends on it. */
  detailContent: {
    gap: space.md,
    paddingBottom: space.xxl,
  },
  detailPhoto: { width: "100%", height: "100%" },
  captionBlock: { gap: 7, paddingTop: space.xs },
  photoTitle: { ...typeScale.title, color: colors.ink },
  /** The Moment: the publisher's own caption, and the only body line up here. */
  moment: { ...typeScale.body, color: colors.ink },
  meta: { ...typeScale.readout, color: colors.muted },
  metaPublished: { color: colors.purpleText },
  body: { ...typeScale.body, color: colors.muted },
  actionRow: { flexDirection: "row", gap: space.sm },
  flex: { flex: 1 },
  unseen: { opacity: 0 },
  danger: {
    marginTop: space.sm,
    paddingTop: space.lg,
    borderTopWidth: 1,
    borderTopColor: colors.line,
  },
  error: { ...typeScale.body, color: colors.danger },
  feedback: { ...typeScale.body, color: colors.ink },
});
