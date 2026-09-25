/**
 * The recipe name sheet, the options sheet for one's own recipes, and the {@link Track} every
 * slider uses. Presentational: state lives in `CameraScreen` and `useRecipes`.
 */
import { useRef } from "react";
import {
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { type ParamSpec, type Recipe } from "../recipes/model";
import { colors, radius, space } from "../ui/theme";
import { typeScale as type } from "../ui/type";
import { Pill } from "../ui/primitives";
import { recipes as copy } from "../ui/copy";

const decimals = (step: number): number => {
  const text = String(step);
  const point = text.indexOf(".");
  return point < 0 ? 0 : text.length - point - 1;
};

/** A raw 0..1 track position as a value this parameter will accept, on its own step. */
export function quantize(spec: ParamSpec, raw: number): number {
  const stepped = Math.round((raw - spec.min) / spec.step) * spec.step + spec.min;
  const clamped = Math.min(spec.max, Math.max(spec.min, stepped));
  return Number(clamped.toFixed(4));
}

/** The mono readout beside a row. Digits only: the unit is the row's own business. */
export function readValue(spec: ParamSpec, value: number): string {
  switch (spec.unit) {
    case "unit":
      return String(Math.round(value * 100));
    case "signed": {
      const points = Math.round(value * 100);
      return points > 0 ? `+${points}` : String(points);
    }
    case "factor":
      return value.toFixed(2);
    case "refPixels":
      return value.toFixed(decimals(spec.step));
    case "frame":
      return (value * 100).toFixed(1);
  }
}

/**
 * The one slider shape: rail, fill and thumb, dragged directly; screen readers step it through
 * its accessibility actions. Also used by `CaptureAdjust.tsx` and `RecipeControls.tsx`.
 */
export function Track({
  fraction,
  origin = 0,
  marks,
  height,
  disabled,
  accessibilityLabel,
  accessibilityValue,
  onAt,
  onStep,
  widths,
  widthKey,
  testID,
}: {
  fraction: number;
  /** Where the fill starts, 0..1: the left end, or the zero of a value that runs both ways. */
  origin?: number;
  /** Points marked on the rail, 0..1 each. */
  marks?: readonly number[];
  /** The touch target's height where the row has more to give than the track's own 32. */
  height?: number;
  disabled?: boolean;
  accessibilityLabel: string;
  accessibilityValue: { min: number; max: number; now: number };
  /** A 0..1 position along the track. */
  onAt: (fraction: number) => void;
  onStep: (direction: 1 | -1) => void;
  /** Measured widths shared with the owning controls. */
  widths: { current: Record<string, number> };
  widthKey: string;
  testID?: string;
}) {
  const touch = useRef<{ x: number; y: number; left: number; axis: "horizontal" | "vertical" | null } | null>(null);
  // Unrounded, so the thumb sits exactly on a mark when the value does.
  const percent = Math.max(0, Math.min(100, fraction * 100));
  const from = Math.max(0, Math.min(100, origin * 100));
  const at = (x: number) => {
    const width = widths.current[widthKey] ?? 0;
    if (disabled || width <= 0) return;
    onAt(Math.max(0, Math.min(1, x / width)));
  };
  return (
    <View
      testID={testID}
      style={[s.track, height !== undefined && { height }]}
      onLayout={(event) => {
        widths.current[widthKey] = event.nativeEvent.layout.width;
      }}
      onStartShouldSetResponder={() => !disabled}
      onResponderGrant={({ nativeEvent: event }) => {
        // Wait for a tap to finish or a horizontal drag. Touch-down may be a scroll.
        touch.current = { x: event.pageX, y: event.pageY, left: event.pageX - event.locationX, axis: null };
      }}
      onResponderMove={({ nativeEvent: event }) => {
        const start = touch.current;
        if (!start) return;
        if (event.touches.length !== 1) { touch.current = null; return; }
        const dx = Math.abs(event.pageX - start.x), dy = Math.abs(event.pageY - start.y);
        if (!start.axis && Math.max(dx, dy) > 6) start.axis = dx > dy ? "horizontal" : "vertical";
        if (start.axis === "horizontal") at(event.pageX - start.left);
      }}
      onResponderRelease={({ nativeEvent: event }) => {
        const start = touch.current;
        touch.current = null;
        if (!start) return;
        const tap = !start.axis && Math.max(Math.abs(event.pageX - start.x), Math.abs(event.pageY - start.y)) <= 6;
        if (tap || start.axis === "horizontal") at(event.pageX - start.left);
      }}
      onResponderTerminationRequest={() => touch.current?.axis !== "horizontal"}
      onResponderTerminate={() => { touch.current = null; }}
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel={accessibilityLabel}
      accessibilityValue={accessibilityValue}
      accessibilityState={{ disabled: !!disabled }}
      accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
      onAccessibilityAction={(event) => {
        if (!disabled) onStep(event.nativeEvent.actionName === "increment" ? 1 : -1);
      }}
    >
      <View pointerEvents="none" style={s.rail} />
      <View
        pointerEvents="none"
        style={[s.fill, { left: `${Math.min(from, percent)}%`, width: `${Math.abs(percent - from)}%` }]}
      />
      {marks?.map((mark) => (
        <View key={mark} pointerEvents="none" style={[s.mark, { left: `${mark * 100}%` }]} />
      ))}
      <View pointerEvents="none" style={[s.thumb, { left: `${percent}%` }]} />
    </View>
  );
}

/** What the name sheet is for: a new recipe or a rename. */
export type SheetMode = "new" | "rename";

interface RecipeSheetProps {
  mode: SheetMode;
  /** The recipe being named, for the title; null for a new one. */
  recipe: Recipe | null;
  name: string;
  busy?: boolean;
  error?: string;
  onName: (text: string) => void;
  onConfirm: () => void;
  onClose: () => void;
}

export function RecipeSheet({
  mode,
  recipe,
  name,
  busy = false,
  error = "",
  onName,
  onConfirm,
  onClose,
}: RecipeSheetProps) {
  const insets = useSafeAreaInsets();
  return (
    <Modal transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <View style={s.root}>
        <Pressable
          style={s.scrim}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel={copy.close}
        />
        <View style={[s.sheet, { paddingBottom: insets.bottom + space.lg }]} testID="recipe-sheet">
          <View style={s.grabber} />
          <Text style={[type.title, s.title]} numberOfLines={1}>
            {mode === "new" ? copy.newLabel : (recipe?.name ?? copy.customLabel)}
          </Text>
          <View style={s.naming}>
            <Text style={[type.label, s.stageLabel]}>{copy.nameLabel}</Text>
            <TextInput
              testID="recipe-name"
              value={name}
              onChangeText={onName}
              placeholder={copy.namePlaceholder}
              placeholderTextColor={colors.muted}
              autoFocus
              multiline={false}
              numberOfLines={1}
              style={[type.body, s.input]}
              accessibilityLabel={copy.nameLabel}
            />
          </View>
          {!!error && (
            <Text style={[type.body, s.error]} accessibilityLiveRegion="polite">
              {error}
            </Text>
          )}
          <View style={s.actions}>
            <Pill
              label={mode === "new" ? copy.continueLabel : copy.save}
              size="small"
              loading={busy}
              onPress={onConfirm}
              style={s.action}
              testID="recipe-save-confirm"
            />
            <Pill
              label={copy.cancel}
              size="small"
              variant="secondary"
              onPress={onClose}
              style={s.action}
            />
          </View>
        </View>
      </View>
    </Modal>
  );
}

/** Long-press on one of the photographer's own chips: the three things it can do. */
export function RecipeOptions({
  recipe,
  confirming,
  onRename,
  onDuplicate,
  onDelete,
  onClose,
}: {
  recipe: Recipe;
  confirming: boolean;
  onRename: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  return (
    <Modal transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <View style={s.root}>
        <Pressable
          style={s.scrim}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel={copy.close}
        />
        <View style={[s.sheet, { paddingBottom: insets.bottom + space.lg }]} testID="recipe-options">
          <View style={s.grabber} />
          <Text style={[type.title, s.title]} numberOfLines={1}>
            {recipe.name}
          </Text>
          <View style={s.actions}>
            <Pill
              label={copy.rename}
              size="small"
              variant="secondary"
              onPress={onRename}
              style={s.action}
              testID="options-rename"
            />
            <Pill
              label={copy.duplicate}
              size="small"
              variant="secondary"
              onPress={onDuplicate}
              style={s.action}
              testID="options-duplicate"
            />
            <Pill
              label={confirming ? copy.sure : copy.delete}
              size="small"
              variant="destructive"
              onPress={onDelete}
              style={s.action}
              testID="options-delete"
            />
          </View>
          <Pill label={copy.close} size="small" variant="secondary" onPress={onClose} />
        </View>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, justifyContent: "flex-end" },
  /** Dims the picture enough to read the rows over it, and closes the sheet when tapped. */
  scrim: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(0, 0, 0, 0.45)",
  },
  sheet: {
    gap: space.md,
    backgroundColor: colors.sheet,
    borderTopWidth: 1,
    borderTopColor: colors.line,
    borderTopLeftRadius: radius.card,
    borderTopRightRadius: radius.card,
    paddingHorizontal: space.gutter,
    paddingTop: space.md,
  },
  grabber: {
    width: 40,
    height: 4,
    borderRadius: radius.pill,
    backgroundColor: colors.line,
    alignSelf: "center",
  },
  title: { color: colors.ink, flexShrink: 1 },
  stageLabel: { color: colors.muted },
  naming: { gap: space.sm },
  input: {
    color: colors.ink,
    backgroundColor: colors.field,
    borderRadius: radius.small,
    paddingHorizontal: space.md,
    height: 48,
  },
  error: { color: colors.danger },
  actions: { flexDirection: "row", gap: space.sm },
  action: { flexGrow: 1, flexBasis: 0 },
  track: { height: 32, justifyContent: "center" },
  rail: { height: 3, borderRadius: radius.pill, backgroundColor: colors.line },
  fill: {
    position: "absolute",
    height: 3,
    borderRadius: radius.pill,
    backgroundColor: colors.teal,
  },
  /** A point on the rail, in the ruler's tick colour: wider than the rail, smaller than the thumb. */
  mark: {
    position: "absolute",
    marginLeft: -3,
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: "rgba(245,244,240,0.7)",
  },
  thumb: {
    position: "absolute",
    marginLeft: -9,
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: colors.ink,
  },
});
