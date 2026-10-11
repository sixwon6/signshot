/** Recipe name sheet, options sheet, and the shared {@link Track} slider. Presentational. */
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
import { type Recipe } from "../recipes/model";
import { colors, radius, space } from "../ui/theme";
import { typeScale as type } from "../ui/type";
import { Pill } from "../ui/primitives";
import { recipes as copy } from "../ui/copy";

/** Shared slider (rail, fill, thumb). Screen readers step it via accessibility actions. */
export function Track({
  fraction,
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
  /** Touch target height; defaults to 32. */
  height?: number;
  disabled?: boolean;
  accessibilityLabel: string;
  accessibilityValue: { min: number; max: number; now: number };
  /** Position along the track, 0..1. */
  onAt: (fraction: number) => void;
  onStep: (direction: 1 | -1) => void;
  /** Measured widths owned by the parent, so Track needs no state. */
  widths: { current: Record<string, number> };
  widthKey: string;
  testID?: string;
}) {
  const touch = useRef<{ x: number; y: number; left: number; axis: "horizontal" | "vertical" | null } | null>(null);
  const percent = Math.max(0, Math.min(100, fraction * 100));
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
        // Don't act on touch-down: it may become a vertical scroll.
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
      <View pointerEvents="none" style={[s.fill, { width: `${percent}%` }]} />
      <View pointerEvents="none" style={[s.thumb, { left: `${percent}%` }]} />
    </View>
  );
}

export type SheetMode = "new" | "rename";

interface RecipeSheetProps {
  mode: SheetMode;
  /** Null when creating. */
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

/** Long-press menu for a user recipe. */
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
    left: 0,
    height: 3,
    borderRadius: radius.pill,
    backgroundColor: colors.teal,
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
