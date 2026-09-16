/**
 * The recipe's stages as a bar of tabs above the recipe row, and ONE open stage's sliders in a
 * panel over the foot of the picture. Tapping a stage opens it and closes the one before; the
 * picture stays live above. Hook-free: every piece of state belongs to `useRecipes`.
 */
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { STAGES, type Recipe, type StageType } from "../recipes/model";
import { StageParameters } from "../recipes/RecipeControls";
import { colors, radius, space } from "../ui/theme";
import { typeScale as type } from "../ui/type";
import { fonts } from "../ui/fonts";
import { Pill } from "../ui/primitives";
import { recipes as copy } from "../ui/copy";

/** How many of a stage's parameters the recipe moves, at any strength. */
function movedCount(recipe: Recipe, stage: StageType): number {
  const held = recipe.manifest.stages.find((s) => s.type === stage);
  if (!held) return 0;
  return STAGES.find((s) => s.type === stage)!.params.filter((p) => {
    const curve = held.intensityCurve?.[p.param];
    if (curve && curve.length) return curve.some(([, y]) => y !== p.neutral);
    return (held.params[p.param] ?? p.neutral) !== p.neutral;
  }).length;
}

interface StageBarProps {
  recipe: Recipe;
  open: StageType | null;
  disabled?: boolean;
  onOpen: (stage: StageType | null) => void;
}

export function StageBar({ recipe, open, disabled = false, onOpen }: StageBarProps) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={s.bar}
      scrollEnabled={!disabled}
      testID="recipe-stage-bar"
    >
      {STAGES.map((stage) => {
        const moved = movedCount(recipe, stage.type) > 0;
        const active = open === stage.type;
        return (
          <Pressable
            key={stage.type}
            accessibilityRole="button"
            accessibilityState={{ selected: active, disabled }}
            accessibilityLabel={stage.label}
            disabled={disabled}
            onPress={() => onOpen(active ? null : stage.type)}
            style={({ pressed }) => [s.tab, active && s.tabActive, { opacity: pressed ? 0.8 : 1 }]}
            testID={`recipe-stage-${stage.type}`}
          >
            <Text style={[s.tabLabel, active && s.tabLabelActive, moved && !active && s.tabLabelMoved]}>
              {stage.label}
            </Text>
            {moved && <View style={[s.dot, active && s.dotActive]} />}
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

interface StagePanelProps {
  recipe: Recipe;
  strength: number;
  stage: StageType;
  /** True when the recipe differs from what Reset would bring back. */
  canReset: boolean;
  busy?: boolean;
  error?: string;
  onParam: (stage: StageType, param: string, value: number) => void;
  onReset: () => void;
  onClose: () => void;
}

export function StagePanel({
  recipe,
  strength,
  stage,
  canReset,
  busy = false,
  error = "",
  onParam,
  onReset,
  onClose,
}: StagePanelProps) {
  const spec = STAGES.find((s) => s.type === stage)!;
  return (
    <View style={s.panel} testID="recipe-panel">
      <View style={s.panelHead}>
        <Text style={[type.label, s.panelTitle]}>{spec.label}</Text>
        <View style={s.grow} />
        {canReset && (
          <Pill
            label={copy.reset}
            size="small"
            variant="secondary"
            onPress={onReset}
            testID="recipe-reset"
          />
        )}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={copy.close}
          onPress={onClose}
          style={s.closeHit}
          testID="recipe-panel-close"
        >
          <Text style={[type.label, s.closeMark]}>×</Text>
        </Pressable>
      </View>
      <StageParameters key={stage} recipe={recipe} strength={strength}
        stage={stage} disabled={busy} onParam={onParam} />
      {!!error && (
        <Text style={[type.body, s.error]} accessibilityLiveRegion="polite">
          {error}
        </Text>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  bar: { gap: space.xs, paddingHorizontal: space.gutter },
  tab: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    height: 30,
    paddingHorizontal: 10,
    borderRadius: radius.pill,
  },
  tabActive: { backgroundColor: colors.field },
  tabLabel: {
    fontFamily: fonts.mono,
    fontSize: 10,
    letterSpacing: 1,
    textTransform: "uppercase",
    color: colors.muted,
  },
  tabLabelActive: { color: colors.ink, fontFamily: fonts.monoStrong },
  tabLabelMoved: { color: colors.tealText },
  dot: { width: 4, height: 4, borderRadius: 2, backgroundColor: colors.teal },
  dotActive: { backgroundColor: colors.ink },
  panel: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    gap: space.sm,
    paddingHorizontal: space.gutter,
    paddingTop: space.sm,
    paddingBottom: space.md,
    backgroundColor: "rgba(11, 12, 14, 0.78)",
  },
  panelHead: { flexDirection: "row", alignItems: "center", gap: space.sm },
  panelTitle: { color: colors.ink },
  grow: { flexGrow: 1 },
  closeHit: { paddingHorizontal: space.sm, paddingVertical: space.xs },
  closeMark: { color: colors.muted, fontSize: 16 },
  error: { color: colors.danger },
});
