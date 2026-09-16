/**
 * The camera, and the app's home screen. State lives in `useRecipes` (the look) and
 * `useCaptureControls` (the camera); the components they feed stay hook-free.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  AppState,
  Linking,
  PermissionsAndroid,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import MaterialCommunityIcon from "@expo/vector-icons/MaterialCommunityIcons";
import { useIsFocused, useNavigation } from "@react-navigation/native";
import type { BottomTabNavigationProp } from "@react-navigation/bottom-tabs";
import type { HomeTabs } from "../navigators/HomeNavigator";
import { SeekerCamera, SeekerCameraView } from "../../modules/seeker-camera";
import type { Recipe, StageType } from "../recipes/model";
import { colors, radius, space } from "../ui/theme";
import { typeScale as type } from "../ui/type";
import { Chip, Pill, Screen } from "../ui/primitives";
import { actions, camera as cameraCopy, recipes as recipeCopy, captureControls as controlsCopy } from "../ui/copy";
import { needsProControls, simpleCaptureSettings } from "../capture/model";
import { RecipePicker } from "./RecipePicker";
import { RecipeOptions, RecipeSheet, type SheetMode } from "./RecipeSheet";
import { StageBar, StagePanel } from "./RecipeBar";
import { CaptureReadout, controlsOf, type ControlKey } from "./CaptureControls";
import { CaptureTray } from "./CaptureTray";
import { useRecipes } from "./useRecipes";
import { useCaptureControls } from "./useCaptureControls";
import { useAppActive } from "../useAppActive";

/** The shutter's rest-state halo: a handful of fading rings in the working accent. */
const HALO = Array.from({ length: 6 }, (_, i) => ({
  size: 82 + 7 * (i + 1),
  opacity: 0.3 * Math.exp(-(i * i) / 10),
}));
/**
 * The preview stream is a supported 4:3 size on its side (CameraController.kt), so the upright picture is
 * 3:4. GlRenderer fits it inside the view and centres it; the corner marks sit on that picture.
 */
const PICTURE_ASPECT = 3 / 4;
const CORNER = 17;
const CORNER_INSET = 12;
const FOCUS_RING = 72;

function pictureRect(frame: { width: number; height: number }) {
  const width = Math.min(frame.width, frame.height * PICTURE_ASPECT);
  const height = width / PICTURE_ASPECT;
  return {
    left: (frame.width - width) / 2,
    top: (frame.height - height) / 2,
    width,
    height,
  };
}

/**
 * A door beside the shutter: a round icon on the controls sheet with its name under it. Photos
 * and On chain are the same control, so the shutter sits centred between two equals.
 */
function SideButton({
  icon,
  label,
  accessibilityLabel,
  onPress,
  disabled,
  testID,
}: {
  icon: React.ComponentProps<typeof MaterialCommunityIcon>["name"];
  label: string;
  accessibilityLabel: string;
  onPress: () => void;
  disabled: boolean;
  testID: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      disabled={disabled}
      testID={testID}
      style={({ pressed }) => [s.sideControl, pressed && { opacity: 0.7 }]}
    >
      <View style={s.sideIcon}>
        <MaterialCommunityIcon name={icon} size={20} color={colors.ink} />
      </View>
      <Text style={[type.imprint, s.controlLabel]}>{label}</Text>
    </Pressable>
  );
}

export function CameraScreen() {
  const navigation =
    useNavigation<BottomTabNavigationProp<HomeTabs, "Camera">>();
  const focused = useIsFocused();
  const active = useAppActive();
  const [hasPermission, setHasPermission] = useState<boolean | null>(null);
  const [permissionBlocked, setPermissionBlocked] = useState(false);
  const [requestingPermission, setRequestingPermission] = useState(false);
  const [busy, setBusy] = useState(false);
  /** The camera's own trouble: permission, the shutter, the session. Never a recipe's. */
  const [error, setError] = useState("");
  const [cameraGeneration, setCameraGeneration] = useState(0);
  const [frame, setFrame] = useState<{ width: number; height: number } | null>(
    null,
  );
  /** The one stage whose sliders are open over the foot of the picture, or none. */
  const [openStage, setOpenStage] = useState<StageType | null>(null);
  const [sheetMode, setSheetMode] = useState<SheetMode | "closed">("closed");
  const [optionsFor, setOptionsFor] = useState<Recipe | null>(null);
  const [nameDraft, setNameDraft] = useState("");
  const [confirming, setConfirming] = useState(false);
  /** The control whose tray is open under the readout strip, or null. */
  const [controlsFor, setControlsFor] = useState<ControlKey | null>(null);
  const [proSelected, setProSelected] = useState(false);
  /** Where the picture was last tapped to focus, in picture coordinates; the ring drawn there. */
  const [focusRing, setFocusRing] = useState<{ x: number; y: number; at: number } | null>(null);
  const ring = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!focusRing) return;
    ring.setValue(0);
    Animated.sequence([
      Animated.timing(ring, { toValue: 1, duration: 160, useNativeDriver: true }),
      Animated.delay(900),
      Animated.timing(ring, { toValue: 2, duration: 240, useNativeDriver: true }),
    ]).start(({ finished }) => {
      if (finished) setFocusRing((now) => (now?.at === focusRing.at ? null : now));
    });
  }, [focusRing, ring]);
  const captureInFlight = useRef(false);
  /** Measured track widths, so `RecipeSheet` and its rows stay hook-free. */
  const widths = useRef<Record<string, number>>({});

  const live = focused && active && hasPermission === true;
  const recipes = useRecipes({ live, generation: cameraGeneration, busy });
  const capture = useCaptureControls({ live, generation: cameraGeneration });
  const pro = proSelected || needsProControls(capture.settings);
  const chooseSimple = () => {
    setProSelected(false);
    setOpenStage(null);
    setControlsFor(null);
    capture.change(simpleCaptureSettings(capture.settings));
  };
  const { recipe, origin } = recipes;

  const requestPermission = useCallback(async () => {
    setRequestingPermission(true);
    setError("");
    try {
      const result = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.CAMERA,
      );
      setPermissionBlocked(
        result === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN,
      );
      setHasPermission(result === PermissionsAndroid.RESULTS.GRANTED);
    } catch {
      setHasPermission(false);
      setError(cameraCopy.cameraAccessError);
    }
    setRequestingPermission(false);
  }, []);
  useEffect(() => {
    void requestPermission();
  }, [requestPermission]);
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active")
        PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.CAMERA)
          .then(setHasPermission)
          .catch(() => {});
    });
    return () => subscription.remove();
  }, []);

  const closeSheet = () => {
    setSheetMode("closed");
    setOptionsFor(null);
    setConfirming(false);
    recipes.clearError();
  };
  const chooseRecipe = (next: Recipe) => {
    if (captureInFlight.current) return;
    const stage = recipes.choose(next);
    setOpenStage(stage);
    if (stage !== null) setProSelected(true);
  };
  /** `+` asks for a name first; the recipe exists under that name before any slider moves. */
  const chooseCustom = () => {
    if (captureInFlight.current || busy) return;
    recipes.clearError();
    setNameDraft("");
    setSheetMode("new");
  };
  const createNew = async () => {
    if (await recipes.create(nameDraft)) {
      setProSelected(true);
      setOpenStage(null);
      setSheetMode("closed");
    }
  };
  const renameOwned = async (target: Recipe | null) => {
    if (target === null) return;
    if (await recipes.rename(target, nameDraft)) {
      setSheetMode("closed");
      setOptionsFor(null);
    }
  };
  const duplicateOwned = async (target: Recipe | null) => {
    if (target === null) return;
    if (await recipes.duplicate(target)) {
      setOptionsFor(null);
      setSheetMode("closed");
    }
  };
  /** One word of confirmation, then it is gone: the first tap arms, the second removes. */
  const deleteOwned = async (target: Recipe | null) => {
    if (target === null) return;
    if (!confirming) {
      setConfirming(true);
      return;
    }
    setConfirming(false);
    if (await recipes.remove(target)) closeSheet();
  };

  const onShutter = useCallback(async () => {
    if (captureInFlight.current || busy) return;
    captureInFlight.current = true;
    setBusy(true);
    try {
      const taken = await SeekerCamera.capture();
      navigation.navigate("Review", { photo: taken.baseName });
    } catch (cause) {
      setError(cameraCopy.captureError);
      if (__DEV__) console.warn("Camera capture failed", cause);
    }
    captureInFlight.current = false;
    setBusy(false);
  }, [busy, navigation]);
  /** A fresh camera view, and the trouble that asked for it cleared with it. */
  const restart = () => {
    setError("");
    setCameraGeneration((value) => value + 1);
  };
  const openSettings = () =>
    Linking.openSettings().catch(() => setError(cameraCopy.settingsOpenError));

  if (!hasPermission)
    return (
      <Screen>
        {focused && <StatusBar style="light" />}
        <View style={s.permission}>
          <MaterialCommunityIcon
            name="camera-outline"
            color={colors.teal}
            size={40}
          />
          <Text style={[type.display, s.permissionTitle]}>
            {cameraCopy.permissionTitle}
          </Text>
          <Text style={[type.body, s.permissionBody]}>
            {cameraCopy.permissionBody}
          </Text>
          {!!error && <Text style={[type.body, s.errorText]}>{error}</Text>}
          <Pill
            label={
              requestingPermission || hasPermission === null
                ? cameraCopy.waiting
                : permissionBlocked
                  ? cameraCopy.openPhoneSettings
                  : cameraCopy.allow
            }
            loading={requestingPermission || hasPermission === null}
            onPress={permissionBlocked ? openSettings : requestPermission}
            style={s.permissionButton}
          />
          {!permissionBlocked && hasPermission === false && (
            <Pressable
              onPress={openSettings}
              accessibilityRole="button"
              style={s.textButton}
            >
              <Text style={[type.body, s.secondaryText]}>
                {cameraCopy.openPhoneSettings}
              </Text>
            </Pressable>
          )}
          <Pressable
            onPress={() => navigation.navigate("Review")}
            accessibilityRole="button"
            style={s.textButton}
          >
            <Text style={[type.body, s.secondaryText]}>{actions.viewPhotos}</Text>
          </Pressable>
        </View>
      </Screen>
    );

  /** The camera's own trouble, or a recipe that would not apply: one line, one Restart. */
  const notice = error || recipes.applyError || capture.applyError;
  const shutterDisabled = busy || recipes.applying || capture.applying || !live || !!notice || recipe === null;
  const strengthDisabled = busy || recipes.applying || recipes.isClean;
  // What looks unavailable, as against what merely holds a tap for a moment (see slowApply).
  const dimmed = busy || recipes.slowApply || !!notice || recipe === null;
  const strengthDimmed = busy || recipes.slowApply || recipes.isClean;
  const picture = frame ? pictureRect(frame) : null;
  const points = Math.round(recipes.strength * 100);
  return (
    <Screen padded={false}>
      {focused && <StatusBar style="light" />}
      <View style={s.stage}>
        <View style={s.header}>
          <View style={s.modePicker} accessibilityRole="radiogroup" accessibilityLabel="Camera controls">
            <Chip label={controlsCopy.simple} selected={!pro} accessibilityRole="radio"
              accessibilityLabel={controlsCopy.simpleHint} disabled={busy || !live || capture.caps === null}
              onPress={chooseSimple} testID="camera-mode-simple" />
            <Chip label={controlsCopy.pro} selected={pro} accessibilityRole="radio"
              accessibilityLabel={controlsCopy.proHint} disabled={busy || !live || capture.caps === null}
              onPress={() => setProSelected(true)} testID="camera-mode-pro" />
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={cameraCopy.settings}
            onPress={() => navigation.navigate("Settings")}
            disabled={busy}
            testID="camera-settings"
            style={({ pressed }) => [s.settingsButton, (pressed || busy) && { opacity: 0.7 }]}
          >
            <MaterialCommunityIcon name="cog-outline" size={20} color={colors.ink} />
          </Pressable>
        </View>

        {/* The picture has the whole space between the header and the controls, and the native
            view fits the 3:4 frame inside it, so none of the shot hides under the sheet. */}
        <View
          style={s.viewfinderLayer}
          onLayout={(event) => {
            const { width, height } = event.nativeEvent.layout;
            setFrame({ width, height });
          }}
        >
          {live && (
            <SeekerCameraView
              key={cameraGeneration}
              style={s.viewfinder}
              onMeter={(event) => capture.onMeter(event.nativeEvent)}
              onSessionError={(event) => {
                setError(cameraCopy.sessionError);
                if (__DEV__)
                  console.warn(
                    "Camera session failed",
                    event.nativeEvent.message,
                  );
              }}
            />
          )}
          {picture && (
            <>
              <View
                pointerEvents="none"
                style={[
                  s.corner,
                  s.cornerTL,
                  { left: picture.left + CORNER_INSET, top: picture.top + CORNER_INSET },
                ]}
              />
              <View
                pointerEvents="none"
                style={[
                  s.corner,
                  s.cornerTR,
                  {
                    left: picture.left + picture.width - CORNER_INSET - CORNER,
                    top: picture.top + CORNER_INSET,
                  },
                ]}
              />
              <View
                pointerEvents="none"
                style={[
                  s.corner,
                  s.cornerBL,
                  {
                    left: picture.left + CORNER_INSET,
                    top: picture.top + picture.height - CORNER_INSET - CORNER,
                  },
                ]}
              />
              <View
                pointerEvents="none"
                style={[
                  s.corner,
                  s.cornerBR,
                  {
                    left: picture.left + picture.width - CORNER_INSET - CORNER,
                    top: picture.top + picture.height - CORNER_INSET - CORNER,
                  },
                ]}
              />
            </>
          )}
          {/* Tap to focus: the whole picture is the target, under every control drawn over it. */}
          {picture && live && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={cameraCopy.tapToFocus}
              testID="camera-tap-focus"
              style={{
                position: "absolute",
                left: picture.left,
                top: picture.top,
                width: picture.width,
                height: picture.height,
              }}
              onPress={(event) => {
                const { locationX: x, locationY: y } = event.nativeEvent;
                setControlsFor(null);
                setOpenStage(null);
                // A held lens cannot follow a tap; the tap hands focus back to the camera first.
                if (capture.settings.focus !== "auto")
                  capture.change({ ...capture.settings, focus: "auto" });
                setFocusRing({ x, y, at: Date.now() });
                void SeekerCamera.focusAt(x / picture.width, y / picture.height).catch(() => {});
              }}
            />
          )}
          {picture && focusRing && (
            <Animated.View
              pointerEvents="none"
              style={[
                s.focusRing,
                {
                  left: picture.left + focusRing.x - FOCUS_RING / 2,
                  top: picture.top + focusRing.y - FOCUS_RING / 2,
                  opacity: ring.interpolate({ inputRange: [0, 1, 2], outputRange: [0, 1, 0] }),
                  transform: [
                    { scale: ring.interpolate({ inputRange: [0, 1, 2], outputRange: [1.5, 1, 1] }) },
                  ],
                },
              ]}
            />
          )}
          {pro && recipe !== null && openStage !== null && (
            <StagePanel
              recipe={recipe}
              strength={recipes.strength}
              stage={openStage}
              canReset={recipes.canReset}
              busy={busy}
              error={recipes.error}
              onParam={recipes.changeParam}
              onReset={() => void recipes.reset()}
              onClose={() => setOpenStage(null)}
            />
          )}
          {/* The camera's own readout, ON the picture: the column below is untouched. */}
          {capture.caps !== null && (
            <CaptureReadout
              pro={pro}
              caps={capture.caps}
              settings={capture.settings}
              meter={capture.meter}
              histogram={capture.histogram}
              disabled={busy}
              open={controlsFor}
              onOpen={(key) => {
                setSheetMode("closed");
                setOptionsFor(null);
                setOpenStage(null);
                // The same cell again closes its tray.
                setControlsFor((now) => (now === key ? null : key));
              }}
            >
              {/* A control Simple lacks (ISO after exposure is released) closes with its mode. */}
              {controlsFor !== null && controlsOf(capture.caps, pro).includes(controlsFor) && (
                <CaptureTray
                  pro={pro}
                  control={controlsFor}
                  caps={capture.caps}
                  settings={capture.settings}
                  manualExposure={capture.manualExposure}
                  meter={capture.meter}
                  histogram={capture.histogram}
                  busy={busy || !live}
                  onChange={capture.change}
                  onAuto={capture.auto}
                  onHistogram={capture.toggleHistogram}
                  onReleaseFocus={() => void SeekerCamera.releaseFocusPoint().catch(() => {})}
                  onClose={() => setControlsFor(null)}
                />
              )}
            </CaptureReadout>
          )}

          {recipes.slowApply && !notice && (
            <View pointerEvents="none" style={s.loading}>
              <ActivityIndicator color={colors.ink} />
              <Text style={[type.label, s.loadingText]}>{cameraCopy.loading}</Text>
            </View>
          )}

          {!!notice && (
            <View style={s.notice}>
              <Text style={[type.body, s.noticeText]} accessibilityLiveRegion="polite">
                {notice}
              </Text>
              <Pressable
                accessibilityRole="button"
                onPress={restart}
                style={s.noticeButton}
              >
                <Text style={[type.label, s.noticeButtonText]}>
                  {cameraCopy.restart}
                </Text>
              </Pressable>
            </View>
          )}
        </View>

        <View style={s.sheet}>
          {pro && recipe !== null && (
            <StageBar
              recipe={recipe}
              open={openStage}
              disabled={busy}
              onOpen={(stage) => {
                recipes.clearError();
                setOpenStage(stage);
              }}
            />
          )}
          <RecipePicker
            choices={recipes.choices}
            selected={origin}
            disabled={busy}
            onChoose={chooseRecipe}
            onCustom={chooseCustom}
            onOptions={(one) => {
              setConfirming(false);
              recipes.clearError();
              setOptionsFor(one);
            }}
          />

          {/* No − and + buttons: screen readers step the track through its increment/decrement actions. */}
          <View style={[s.strengthRow, strengthDimmed && s.strengthDisabled]}>
            <MaterialCommunityIcon
              name="circle-half-full"
              size={18}
              color={colors.muted}
              importantForAccessibility="no"
            />
            <View
              style={s.strengthTrack}
              testID="camera-strength"
              onLayout={(event) => {
                widths.current.strength = event.nativeEvent.layout.width;
              }}
              onStartShouldSetResponder={() => !strengthDisabled}
              onMoveShouldSetResponder={() => !strengthDisabled}
              onResponderGrant={(event) =>
                recipes.changeStrength(
                  event.nativeEvent.locationX / (widths.current.strength || 1),
                )
              }
              onResponderMove={(event) =>
                recipes.changeStrength(
                  event.nativeEvent.locationX / (widths.current.strength || 1),
                )
              }
              accessible
              accessibilityRole="adjustable"
              accessibilityLabel={recipeCopy.strength}
              accessibilityValue={{ min: 0, max: 100, now: points }}
              accessibilityState={{ disabled: strengthDisabled }}
              accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
              onAccessibilityAction={(event) =>
                recipes.changeStrength(
                  recipes.strength +
                    (event.nativeEvent.actionName === "increment" ? 0.05 : -0.05),
                )
              }
            >
              <View style={s.strengthRail} />
              <View
                style={[s.strengthFill, { width: `${points}%` as `${number}%` }]}
              />
              <View style={[s.strengthThumb, { left: `${points}%` }]} />
            </View>
            <Text style={[type.readout, s.strengthValue]}>{points}</Text>
          </View>

          <View style={s.actionsRow}>
            <SideButton
              icon="image-multiple-outline"
              label={cameraCopy.photos}
              accessibilityLabel={actions.viewPhotos}
              onPress={() => navigation.navigate("Review")}
              disabled={busy}
              testID="camera-photos"
            />

            <Pressable
              onPress={onShutter}
              accessibilityRole="button"
              accessibilityLabel={actions.takePhoto}
              accessibilityState={{ disabled: shutterDisabled, busy }}
              disabled={shutterDisabled}
              testID="camera-shutter"
              style={({ pressed }) => [
                s.shutter,
                pressed && { transform: [{ scale: 0.94 }] },
                dimmed && { opacity: 0.4 },
              ]}
            >
              {HALO.map((band) => (
                <View
                  key={band.size}
                  style={[
                    s.halo,
                    {
                      width: band.size,
                      height: band.size,
                      borderRadius: band.size / 2,
                      opacity: band.opacity,
                    },
                  ]}
                />
              ))}
              <View style={s.shutterRing}>
                {busy ? (
                  <ActivityIndicator color={colors.ink} />
                ) : (
                  <View style={s.shutterCore} />
                )}
              </View>
            </Pressable>

            <SideButton
              icon="link-variant"
              label={cameraCopy.collection}
              accessibilityLabel={cameraCopy.collectionHint}
              onPress={() => navigation.navigate("Chain")}
              disabled={busy}
              testID="camera-chain"
            />
          </View>
        </View>
      </View>

      {sheetMode !== "closed" && optionsFor === null && (
        <RecipeSheet
          mode={sheetMode}
          recipe={sheetMode === "new" ? null : origin}
          name={nameDraft}
          busy={busy}
          error={recipes.error}
          onName={setNameDraft}
          onConfirm={sheetMode === "rename" ? () => void renameOwned(origin) : () => void createNew()}
          onClose={closeSheet}
        />
      )}

      {optionsFor !== null && (
        <RecipeOptions
          recipe={optionsFor}
          confirming={confirming}
          onRename={() => {
            const target = optionsFor;
            setOptionsFor(null);
            recipes.choose(target);
            setNameDraft(target.name);
            setSheetMode("rename");
          }}
          onDuplicate={() => void duplicateOwned(optionsFor)}
          onDelete={() => void deleteOwned(optionsFor)}
          onClose={closeSheet}
        />
      )}
    </Screen>
  );
}

const s = StyleSheet.create({
  /** Header, picture, controls: a column, so the picture is never under either of the others. */
  stage: { flex: 1 },
  viewfinderLayer: {
    flex: 1,
    backgroundColor: colors.ground,
    overflow: "hidden",
  },
  viewfinder: { flex: 1 },
  /** Placed on the picture's own corners at render time (`pictureRect`). */
  corner: {
    position: "absolute",
    width: CORNER,
    height: CORNER,
    borderColor: colors.ink,
    opacity: 0.3,
  },
  cornerTL: { borderTopWidth: 1, borderLeftWidth: 1 },
  cornerTR: { borderTopWidth: 1, borderRightWidth: 1 },
  cornerBL: { borderBottomWidth: 1, borderLeftWidth: 1 },
  cornerBR: { borderBottomWidth: 1, borderRightWidth: 1 },
  header: {
    paddingHorizontal: space.gutter,
    paddingBottom: space.sm,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  modePicker: { flexDirection: "row", gap: space.sm },
  settingsButton: {
    width: 44,
    height: 44,
    borderRadius: radius.pill,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.sheet,
  },
  loading: {
    position: "absolute",
    top: "45%",
    alignSelf: "center",
    gap: space.sm,
    alignItems: "center",
  },
  loadingText: { color: colors.ink },
  /** The tap-to-focus mark: a square the accent colour, the size of a fingertip. */
  focusRing: {
    position: "absolute",
    width: FOCUS_RING,
    height: FOCUS_RING,
    borderWidth: 2,
    borderColor: colors.teal,
    borderRadius: radius.small,
  },
  /** Over the foot of the picture, so an error never resizes the viewfinder. */
  notice: {
    position: "absolute",
    left: space.gutter,
    right: space.gutter,
    bottom: space.md,
    backgroundColor: colors.sheet,
    borderRadius: radius.small,
    padding: space.lg,
  },
  noticeText: { color: colors.ink },
  noticeButton: { alignSelf: "flex-start", marginTop: space.sm, paddingVertical: space.xs },
  noticeButtonText: { color: colors.tealText },
  sheet: {
    backgroundColor: colors.sheet,
    borderTopLeftRadius: radius.card,
    borderTopRightRadius: radius.card,
    paddingHorizontal: space.gutter,
    paddingTop: space.lg,
    paddingBottom: space.lg,
    gap: space.lg,
  },
  strengthDisabled: { opacity: 0.35 },
  strengthRow: { flexDirection: "row", alignItems: "center", gap: space.md },
  /** Three digits wide, flush against the track gap like the icon on the other side, so the
      distance track→number equals icon→track and the track never shifts as digits change. */
  strengthValue: { width: 40, textAlign: "left", color: colors.tealText },
  strengthTrack: {
    height: 32,
    flexGrow: 1,
    flexShrink: 1,
    justifyContent: "center",
  },
  strengthRail: {
    height: 3,
    borderRadius: radius.pill,
    backgroundColor: colors.line,
  },
  strengthFill: {
    position: "absolute",
    left: 0,
    height: 3,
    borderRadius: radius.pill,
    backgroundColor: colors.teal,
  },
  strengthThumb: {
    position: "absolute",
    marginLeft: -10,
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: colors.ink,
  },
  actionsRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  /**
   * Half the row's spare width each, so the shutter stays centred between the two doors. The
   * door is as tall as the shutter and its icon sits in the middle of that height, so the
   * three circles share one axis; the name hangs under the icon and does not pull it down.
   */
  sideControl: {
    flex: 1,
    minWidth: 72,
    height: 94,
    alignItems: "center",
    justifyContent: "center",
  },
  controlLabel: {
    position: "absolute",
    top: 94 / 2 + 44 / 2 + space.xs,
    color: colors.muted,
  },
  /** The same round button as the Settings gear, one step lighter so it shows on the sheet. */
  sideIcon: {
    width: 44,
    height: 44,
    borderRadius: radius.pill,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.field,
  },
  shutter: {
    width: 94,
    height: 94,
    alignItems: "center",
    justifyContent: "center",
  },
  halo: {
    position: "absolute",
    borderWidth: 1,
    borderColor: colors.teal,
    pointerEvents: "none",
  },
  shutterRing: {
    width: 76,
    height: 76,
    borderRadius: 38,
    borderWidth: 3,
    borderColor: colors.ink,
    alignItems: "center",
    justifyContent: "center",
  },
  shutterCore: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: colors.ink,
  },
  permission: {
    flex: 1,
    justifyContent: "center",
    alignItems: "flex-start",
    gap: space.sm,
  },
  permissionTitle: { color: colors.ink, marginTop: space.lg },
  permissionBody: {
    color: colors.muted,
    marginTop: space.sm,
    marginBottom: space.md,
  },
  permissionButton: { width: "100%", marginTop: space.sm },
  textButton: { paddingVertical: space.md, alignSelf: "center" },
  secondaryText: { color: colors.muted },
  errorText: { color: colors.danger, marginBottom: space.md },
});
