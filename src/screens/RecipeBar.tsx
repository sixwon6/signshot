/**
 * The recipe's stages as a bar of tabs, and the camera's editor: that bar over one open stage's
 * sliders, in a panel over the foot of the picture. Tapping a stage opens it and closes the one
 * before; tapping the open one closes the editor. No state of its own: the recipe is
 * `useRecipes`', the open stage its caller's, and the bar's refs only park it on the open tab.
 */
import { useRef } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { STAGES, type Recipe, type StageType } from "../recipes/model";
import { StageParameters } from "../recipes/RecipeControls";
import { colors, radius, space } from "../ui/theme";
import { typeScale as type } from "../ui/type";
import { fonts } from "../ui/fonts";
import { Pill, PILL_SMALL_HEIGHT } from "../ui/primitives";
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
  const scroll = useRef<ScrollView>(null);
  /**
   * A bar that mounts with a stage open parks on its tab, once: the open tab is the only thing
   * naming the stage, and it may lie past the edge. A tab already in view is left where it is,
   * and after that the bar is the thumb's.
   */
  const parked = useRef(open === null);
  const sized = useRef(false);
  const viewport = useRef<number | null>(null);
  const openTab = useRef<{ x: number; width: number } | null>(null);
  const park = () => {
    if (parked.current || !sized.current || viewport.current === null || openTab.current === null) return;
    parked.current = true;
    const { x, width } = openTab.current;
    if (x + width > viewport.current) {
      scroll.current?.scrollTo({ x: Math.max(0, x - space.gutter), animated: false });
    }
  };
  return (
    <ScrollView
      ref={scroll}
      horizontal
      // The three measurements arrive in no promised order; the bar parks when it has them all.
      onLayout={(event) => {
        viewport.current = event.nativeEvent.layout.width;
        park();
      }}
      onContentSizeChange={() => {
        sized.current = true;
        park();
      }}
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
            onLayout={
              active
                ? (event) => {
                    openTab.current = { x: event.nativeEvent.layout.x, width: event.nativeEvent.layout.width };
                    park();
                  }
                : undefined
            }
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
  /** Another stage, or null when the open one is tapped again. */
  onStage: (stage: StageType | null) => void;
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
  onStage,
  onReset,
  onClose,
}: StagePanelProps) {
  return (
    <View style={s.panel} testID="recipe-panel">
      {/* The open tab names the stage, so the head does not say it twice. */}
      <View style={s.panelHead}>
        <View style={s.panelBar}>
          <StageBar recipe={recipe} open={stage} disabled={busy} onOpen={onStage} />
        </View>
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
      <View style={s.panelBody}>
        <StageParameters key={stage} recipe={recipe} strength={strength}
          stage={stage} disabled={busy} onParam={onParam} />
        {!!error && (
          <Text style={[type.body, s.error]} accessibilityLiveRegion="polite">
            {error}
          </Text>
        )}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  /** Centred, for a bar given more height than its tabs: the camera's panel head is as tall as Reset. */
  bar: { gap: space.xs, paddingHorizontal: space.gutter, alignItems: "center" },
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
    paddingTop: space.sm,
    paddingBottom: space.md,
    backgroundColor: "rgba(11, 12, 14, 0.78)",
  },
  /** The bar bleeds to the panel's left edge. As tall as Reset, so the tabs hold still when it appears. */
  panelHead: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    minHeight: PILL_SMALL_HEIGHT,
    paddingRight: space.gutter,
  },
  panelBar: { flex: 1 },
  panelBody: { gap: space.sm, paddingHorizontal: space.gutter },
  closeHit: { paddingHorizontal: space.sm, paddingVertical: space.xs },
  closeMark: { color: colors.muted, fontSize: 16 },
  error: { color: colors.danger },
});
