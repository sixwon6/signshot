/**
 * The camera, and the app's home screen. One layout under a mode dial, and one grammar in every
 * mode: the bottom row chooses, the row above it adjusts, the shutter shoots. All of it is in the
 * sheet, under the thumb, and the picture carries nothing at rest.
 *
 * AUTO is the point-and-shoot: the row chooses a look, with brightness pinned beside them, and
 * the row above is the look's strength. P and M are the same camera with its readout up: the row
 * is the readout's cells, the look among them as it is in a camera's quick menu, and the row
 * above is the live cell's dial. Nothing moves between modes; the dial only decides how much
 * there is. State lives in `useRecipes` (the look) and `useCaptureControls` (the camera and its
 * dial); the components they feed keep none of their own.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  AppState,
  Linking,
  PanResponder,
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
import { STAGES, type Recipe, type StageType } from "../recipes/model";
import { colors, radius, space } from "../ui/theme";
import { typeScale as type } from "../ui/type";
import { Chip, CHROME_FONT_SCALE, Pill, Screen, TextKey } from "../ui/primitives";
import { actions, camera as cameraCopy, recipes as recipeCopy, captureControls as controlsCopy } from "../ui/copy";
import type { CaptureMode } from "../capture/mode";
import { autoEvSpan, formatEv } from "../capture/model";
import { RecipePicker } from "./RecipePicker";
import { RecipeOptions, RecipeSheet, Track, type SheetMode } from "./RecipeSheet";
import { StagePanel } from "./RecipeBar";
import {
  Histogram,
  BrightCell,
  ReadoutCells,
  controlsOf,
  firstLive,
  forbiddenIn,
  type LiveKey,
} from "./CaptureControls";
import { ADJUST_HEIGHT, CaptureAdjust } from "./CaptureAdjust";
import { useRecipes } from "./useRecipes";
import { useCaptureControls } from "./useCaptureControls";
import { useAppActive } from "../useAppActive";

/**
 * The preview stream is a supported 4:3 size on its side (CameraController.kt), so the upright picture is
 * 3:4. GlRenderer fits it inside the view and centres it; what is drawn on the picture is placed on that rect.
 */
const PICTURE_ASPECT = 3 / 4;
const FOCUS_RING = 72;
/** A finger's travel on the picture for one stop of brightness, and how far it moves before it is a drag. */
const DP_PER_STOP = 80;
const DRAG_SLOP = 10;
/** The brightness readout, drawn clear of the finger while it drags. */
const BRIGHT_READOUT = { width: 84, height: 44, above: 96 };
/** The dial's positions, in the order a camera prints them. */
const MODES: readonly CaptureMode[] = ["auto", "program", "manual"];
/** DISP's grid: the picture in thirds. */
const THIRDS = [1 / 3, 2 / 3];

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
  /** The recipe editor: the one stage open over the foot of the picture, or null when it is shut. */
  const [openStage, setOpenStage] = useState<StageType | null>(null);
  const [sheetMode, setSheetMode] = useState<SheetMode | "closed">("closed");
  const [optionsFor, setOptionsFor] = useState<Recipe | null>(null);
  const [nameDraft, setNameDraft] = useState("");
  const [confirming, setConfirming] = useState(false);
  /**
   * The cell the photographer made live, or null for the mode's own: brightness in P, the shutter
   * in M, nothing in AUTO (its adjust row is the look's strength until BRIGHT is tapped).
   */
  const [chosenCell, setChosenCell] = useState<LiveKey | null>(null);
  /** With the look live: its row of looks, or, after a second tap on the one in force, its strength. */
  const [lookDepth, setLookDepth] = useState<"pick" | "strength">("pick");
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
  /**
   * The picture answers two touches, as a phone's camera does: a tap focuses and meters there, and
   * a drag up or down is brightness, in the camera's own steps. What the handlers need changes
   * with every render, so they read it from `pictureTouch`, set just before the screen is drawn.
   */
  const [brightDrag, setBrightDrag] = useState<{ x: number; y: number; steps: number } | null>(null);
  const brightFade = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (brightFade.current) clearTimeout(brightFade.current); }, []);
  const pictureTouch = useRef<{
    tap: (x: number, y: number) => void;
    /** Null where brightness is not the photographer's to set: M, a capture in flight, no control. */
    bright: ((steps: number) => void) | null;
    range: { min: number; max: number; step: number } | null;
    steps: number;
  }>({ tap: () => {}, bright: null, range: null, steps: 0 });
  const drag = useRef({ x: 0, y: 0, from: 0, last: 0, on: false });
  const picturePan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onPanResponderGrant: (event) => {
        const { locationX, locationY } = event.nativeEvent;
        const steps = pictureTouch.current.steps;
        drag.current = { x: locationX, y: locationY, from: steps, last: steps, on: false };
      },
      onPanResponderMove: (_event, gesture) => {
        const now = pictureTouch.current;
        const d = drag.current;
        if (!now.bright || !now.range) return;
        if (!d.on) {
          // Up or down, and far enough that it is not a tap that slipped.
          if (Math.abs(gesture.dy) < DRAG_SLOP || Math.abs(gesture.dy) < Math.abs(gesture.dx)) return;
          d.on = true;
          if (brightFade.current) clearTimeout(brightFade.current);
          setBrightDrag({ x: d.x, y: d.y, steps: d.last });
        }
        const moved = Math.round(-gesture.dy / DP_PER_STOP / now.range.step);
        // A value from beyond the range (P's, carried into AUTO) comes in from where it is, not with a jump.
        const low = Math.min(now.range.min, d.from), high = Math.max(now.range.max, d.from);
        const steps = Math.max(low, Math.min(high, d.from + moved));
        if (steps === d.last) return;
        d.last = steps;
        now.bright(steps);
        setBrightDrag({ x: d.x, y: d.y, steps });
      },
      onPanResponderRelease: () => {
        const d = drag.current;
        if (!d.on) pictureTouch.current.tap(d.x, d.y);
        else brightFade.current = setTimeout(() => setBrightDrag(null), 700);
      },
      onPanResponderTerminate: () => {
        if (drag.current.on) brightFade.current = setTimeout(() => setBrightDrag(null), 700);
      },
    }),
  ).current;
  const captureInFlight = useRef(false);
  /** Measured track widths, so `Track` stays hook-free. */
  const widths = useRef<Record<string, number>>({});

  const live = focused && active && hasPermission === true;
  const recipes = useRecipes({ live, generation: cameraGeneration, busy });
  const capture = useCaptureControls({ live, generation: cameraGeneration });
  /** Off AUTO: the readout is up. */
  const readout = capture.mode !== "auto";
  /**
   * The live cell, read off the mode rather than kept in step with it: when the dial turns to M by
   * itself (a ruler moved in P) a live BRIGHT is forbidden, and the shutter is live in its place.
   */
  const liveCell: LiveKey | null =
    capture.caps === null
      ? null
      : !readout
        ? chosenCell === "ev" && controlsOf(capture.caps, capture.mode).includes("ev") ? "ev" : null
        : chosenCell === "look" ||
            (chosenCell !== null &&
              controlsOf(capture.caps, capture.mode).includes(chosenCell) &&
              !forbiddenIn(chosenCell, capture.mode))
          ? chosenCell
          : firstLive(capture.caps, capture.mode);
  /** Only a dial that turned changes anything here: each mode arrives on its own live cell. */
  const chooseMode = (next: CaptureMode) => {
    if (!capture.chooseMode(next)) return;
    setChosenCell(null);
    setLookDepth("pick");
    if (next === "auto") {
      setOpenStage(null);
      // AUTO is the camera choosing: a tapped subject is released with everything else held.
      void SeekerCamera.releaseFocusPoint().catch(() => {});
    }
  };
  /**
   * AUTO held down: everything back to the camera and nothing set aside, where a tap on AUTO keeps
   * what P and M held for their return. The two-button reset a camera body has.
   */
  const resetAll = () => {
    setChosenCell(null);
    setLookDepth("pick");
    void SeekerCamera.releaseFocusPoint().catch(() => {});
    capture.auto();
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
  /**
   * Another look is chosen and the editor shuts. The look in force, tapped again off AUTO, turns
   * its row to its strength; AUTO has that row up already.
   */
  const chooseRecipe = (next: Recipe) => {
    if (captureInFlight.current) return;
    const again = recipes.choose(next) !== null;
    setOpenStage(null);
    if (again && readout) setLookDepth("strength");
    if (!readout) setChosenCell(null);
  };
  /** The look's stages, opened on the first one it moves. */
  const openEditor = () => {
    if (captureInFlight.current || origin === null) return;
    const stage = recipes.choose(origin);
    if (stage !== null) setOpenStage(stage);
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
      // Every stage is at neutral, so the editor opens on the first for the sliders to start.
      setChosenCell("look");
      setLookDepth("strength");
      setOpenStage(STAGES[0].type);
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

  const picture = frame ? pictureRect(frame) : null;
  const evRange = capture.caps !== null && typeof capture.caps.ev === "object" ? capture.caps.ev : null;
  // In AUTO the drag goes as far as the slider does; P has the camera's whole range.
  const autoSpan = capture.caps !== null && capture.mode === "auto" ? autoEvSpan(capture.caps) : null;
  // M holds the exposure, so brightness there is not the photographer's to move.
  const canBright =
    !busy && capture.caps !== null && controlsOf(capture.caps, capture.mode).includes("ev") && !forbiddenIn("ev", capture.mode);
  // After every render, so the handlers always act on the settings now in force. A hook, so it
  // stays above the permission screen's early return.
  useEffect(() => {
    pictureTouch.current = {
      tap: (x, y) => {
        if (!picture) return;
        setOpenStage(null);
        // AUTO's adjust row goes back to the look's strength; P and M always have a dial up.
        if (!readout) setChosenCell(null);
        // A held lens cannot follow a tap; the tap hands focus back to the camera first.
        if (capture.settings.focus !== "auto") capture.change({ ...capture.settings, focus: "auto" });
        setFocusRing({ x, y, at: Date.now() });
        void SeekerCamera.focusAt(x / picture.width, y / picture.height).catch(() => {});
      },
      bright: canBright ? (steps) => capture.change({ ...capture.settings, ev: steps }) : null,
      range: evRange && autoSpan ? { ...evRange, ...autoSpan } : evRange,
      steps: capture.settings.ev,
    };
  });

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
  const points = Math.round(recipes.strength * 100);
  const dialDisabled = busy || !live || capture.caps === null;

  /** The look's strength: its name and number as a cell would say them, then the dial itself. */
  const strengthRow = (trailing?: React.ReactNode) => (
    <View style={[s.adjustRow, strengthDimmed && s.strengthDisabled]}>
      {/* No − and + buttons: screen readers step the track through its increment/decrement actions. */}
      <View style={s.strengthCell} importantForAccessibility="no-hide-descendants">
        <Text maxFontSizeMultiplier={CHROME_FONT_SCALE} style={[type.imprint, s.muted]}>{recipeCopy.strength}</Text>
        <Text maxFontSizeMultiplier={CHROME_FONT_SCALE} style={[type.readout, s.strengthValue]}>{points}</Text>
      </View>
      <View style={s.strengthTrack}>
        <Track
          testID="camera-strength"
          widths={widths}
          widthKey="strength"
          height={ADJUST_HEIGHT}
          fraction={recipes.strength}
          disabled={strengthDisabled}
          accessibilityLabel={recipeCopy.strength}
          accessibilityValue={{ min: 0, max: 100, now: points }}
          onAt={(fraction) => recipes.changeStrength(fraction)}
          onStep={(direction) => recipes.changeStrength(recipes.strength + direction * 0.05)}
        />
      </View>
      {trailing}
    </View>
  );
  const lookRow = (bleed?: { left: number; right: number }) => (
    <RecipePicker
      choices={recipes.choices}
      selected={origin}
      disabled={busy}
      againHint={readout ? recipeCopy.strengthHint : undefined}
      onChoose={chooseRecipe}
      onCustom={readout ? chooseCustom : undefined}
      onOptions={(one) => {
        setConfirming(false);
        recipes.clearError();
        setOptionsFor(one);
      }}
      bleed={bleed}
    />
  );

  return (
    <Screen padded={false}>
      {focused && <StatusBar style="light" />}
      <View style={s.stage}>
        <View style={s.header}>
          {/* The dial: three positions set in type, an index mark under the one it is turned to. */}
          <View style={s.dial} accessibilityRole="radiogroup" accessibilityLabel={controlsCopy.modeDial}>
            {MODES.filter((one) => one !== "manual" || capture.canHoldExposure).map((one) => (
              <TextKey
                key={one}
                size="readout"
                label={controlsCopy.modes[one]}
                on={capture.mode === one}
                index
                // On AUTO, the position that kept the photographer's settings reads in the accent.
                held={capture.remembered === one}
                accessibilityRole="radio"
                accessibilityLabel={capture.remembered === one
                  ? controlsCopy.modeHeld(controlsCopy.modeNames[one])
                  : controlsCopy.modeNames[one]}
                // M holds what this camera metered, so it waits for a first reading.
                disabled={dialDisabled || (one === "manual" && capture.mode !== "manual" && capture.meter === null)}
                onPress={() => chooseMode(one)}
                onLongPress={one === "auto" ? resetAll : undefined}
                testID={`camera-mode-${one}`}
              />
            ))}
          </View>
          <View style={s.grow} />
          <TextKey
            label={controlsCopy.disp}
            on={capture.display !== "plain"}
            accessibilityLabel={controlsCopy.readingOf(controlsCopy.display, controlsCopy.displays[capture.display])}
            onPress={capture.cycleDisplay}
            disabled={busy}
            testID="camera-disp"
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={cameraCopy.settings}
            onPress={() => navigation.navigate("Settings")}
            disabled={busy}
            testID="camera-settings"
            style={({ pressed }) => [s.gear, (pressed || busy) && { opacity: 0.7 }]}
          >
            <MaterialCommunityIcon name="cog-outline" size={20} color={colors.muted} />
          </Pressable>
        </View>

        {/* The picture has the whole space between the header and the sheet, and the native
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
          {picture && capture.display === "grid" &&
            THIRDS.map((at) => (
              <React.Fragment key={at}>
                <View
                  pointerEvents="none"
                  style={[s.gridLine, { left: picture.left + picture.width * at, top: picture.top, width: 1, height: picture.height }]}
                />
                <View
                  pointerEvents="none"
                  style={[s.gridLine, { left: picture.left, top: picture.top + picture.height * at, width: picture.width, height: 1 }]}
                />
              </React.Fragment>
            ))}
          {/* The whole picture is the target, under whatever is drawn over it: a tap focuses and
              meters there, a drag up or down is brightness (`picturePan`). */}
          {picture && live && (
            <View
              accessible
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
              {...picturePan.panHandlers}
            />
          )}
          {picture && brightDrag && capture.caps !== null && (
            <View
              pointerEvents="none"
              style={[
                s.brightReadout,
                {
                  left: picture.left + Math.max(0, Math.min(picture.width - BRIGHT_READOUT.width, brightDrag.x - BRIGHT_READOUT.width / 2)),
                  top: picture.top + Math.max(0, brightDrag.y - BRIGHT_READOUT.above),
                },
              ]}
            >
              <Text maxFontSizeMultiplier={CHROME_FONT_SCALE} style={[type.imprint, s.brightTag]}>{controlsCopy.tag.ev}</Text>
              <Text
                maxFontSizeMultiplier={CHROME_FONT_SCALE}
                style={[type.readout, { color: brightDrag.steps === 0 ? colors.ink : colors.tealText }]}
                testID="camera-bright-value"
              >
                {formatEv(brightDrag.steps, capture.caps)}
              </Text>
            </View>
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
          {capture.display === "histogram" && <Histogram meter={capture.meter} />}
          {readout && recipe !== null && openStage !== null && (
            <StagePanel
              recipe={recipe}
              strength={recipes.strength}
              stage={openStage}
              canReset={recipes.canReset}
              busy={busy}
              error={recipes.error}
              onParam={recipes.changeParam}
              onStage={(stage) => {
                recipes.clearError();
                setOpenStage(stage);
              }}
              onReset={() => void recipes.reset()}
              onClose={() => setOpenStage(null)}
            />
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
          {/* ADJUST: the live cell's dial; with no cell live, the look's strength. */}
          {capture.caps !== null && liveCell !== null && liveCell !== "look" ? (
            <CaptureAdjust
              key={liveCell}
              mode={capture.mode}
              control={liveCell}
              caps={capture.caps}
              settings={capture.settings}
              meter={capture.meter}
              busy={busy || !live}
              onChange={capture.change}
              onReleaseFocus={() => void SeekerCamera.releaseFocusPoint().catch(() => {})}
            />
          ) : liveCell === "look" && lookDepth === "pick" ? (
            <View style={s.adjustSlot}>{lookRow()}</View>
          ) : (
            strengthRow(
              readout ? (
                <Chip size="small" label={recipeCopy.edit} selected={openStage !== null} disabled={busy || recipe === null}
                  onPress={() => (openStage === null ? openEditor() : setOpenStage(null))}
                  hitSlop={{ top: 6, bottom: 6 }} testID="camera-look-edit" />
              ) : undefined,
            )
          )}

          {/* CHOOSE: AUTO chooses a look, with brightness pinned beside them; P and M choose a cell. */}
          {readout && capture.caps !== null ? (
            <View style={s.chooseCells}>
            <ReadoutCells
              mode={capture.mode}
              caps={capture.caps}
              settings={capture.settings}
              meter={capture.meter}
              live={liveCell}
              look={origin?.name ?? ""}
              disabled={busy}
              onLive={(key) => {
                setChosenCell(key);
                // The look cell again turns its row between the looks and the strength of the one in force.
                setLookDepth(key === "look" && liveCell === "look" && lookDepth === "pick" ? "strength" : "pick");
              }}
            />
            </View>
          ) : (
            <View style={s.chooseRow}>
              <View style={s.grow}>{lookRow({ left: space.gutter, right: 0 })}</View>
              {/* Brightness is set on the picture. Its key is here only while it is off zero, or
                  open: a held value is never hidden, and at rest the row is the looks alone. */}
              {capture.caps !== null && (capture.settings.ev !== 0 || liveCell === "ev") && (
                <>
                  <View style={s.divider} />
                  <BrightCell
                    caps={capture.caps}
                    settings={capture.settings}
                    meter={capture.meter}
                    live={liveCell === "ev"}
                    disabled={busy}
                    onPress={() => setChosenCell(liveCell === "ev" ? null : "ev")}
                  />
                </>
              )}
            </View>
          )}

          {/* SHOOT: the shutter, and the two doors out of the camera set as words on its axis. */}
          <View style={s.shootRow}>
            <TextKey
              label={cameraCopy.photos}
              accessibilityLabel={actions.viewPhotos}
              onPress={() => navigation.navigate("Review")}
              disabled={busy}
              style={s.door}
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
              {busy ? <ActivityIndicator color={colors.ink} /> : <View style={s.shutterCore} />}
            </Pressable>
            <TextKey
              label={cameraCopy.collection}
              accessibilityLabel={cameraCopy.collectionHint}
              onPress={() => navigation.navigate("Chain")}
              disabled={busy}
              style={s.door}
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
  /** Header, picture, sheet: a column, so the picture is never under either of the others. */
  stage: { flex: 1 },
  viewfinderLayer: {
    flex: 1,
    backgroundColor: colors.ground,
    overflow: "hidden",
  },
  viewfinder: { flex: 1 },
  header: {
    height: 52,
    paddingHorizontal: space.gutter - 6,
    flexDirection: "row",
    alignItems: "center",
  },
  dial: { flexDirection: "row", gap: space.xs },
  grow: { flex: 1 },
  gear: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  gridLine: { position: "absolute", backgroundColor: colors.ink, opacity: 0.25 },
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
  /** Brightness while it is dragged: a tag over its value, on the histogram's backing. */
  brightReadout: {
    position: "absolute",
    width: BRIGHT_READOUT.width,
    height: BRIGHT_READOUT.height,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.small,
    backgroundColor: "rgba(0,0,0,0.55)",
  },
  brightTag: { color: colors.muted },
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
  /** The same height in every mode, so the picture never resizes as the dial turns. */
  sheet: {
    backgroundColor: colors.sheet,
    borderTopLeftRadius: radius.card,
    borderTopRightRadius: radius.card,
    paddingHorizontal: space.gutter,
    paddingTop: 16,
    paddingBottom: space.md,
  },
  adjustRow: { height: ADJUST_HEIGHT, flexDirection: "row", alignItems: "center", gap: space.sm },
  /** A scrolling row in the adjust position: a column, so it takes the width and can bleed past it. */
  adjustSlot: { height: ADJUST_HEIGHT, justifyContent: "center" },
  chooseRow: { height: 44, marginTop: space.sm, flexDirection: "row", alignItems: "center" },
  chooseCells: { height: 44, marginTop: space.sm },
  divider: { width: 1, height: 28, marginHorizontal: space.sm, backgroundColor: colors.line },
  muted: { color: colors.muted },
  strengthDisabled: { opacity: 0.35 },
  strengthCell: { width: 64, alignItems: "flex-start", justifyContent: "center" },
  strengthValue: { color: colors.tealText },
  /** The thumb is 18 wide and centred on the value, so the rail starts half a thumb in. */
  strengthTrack: { flex: 1, paddingHorizontal: 9 },
  shootRow: {
    height: 84,
    marginTop: space.md,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  /** Half the row's spare width each, so the shutter stays centred between the two doors. */
  door: { flex: 1, height: 84 },
  shutter: {
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
