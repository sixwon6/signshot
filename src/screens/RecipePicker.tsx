/**
 * The look row, in store order: Clean, the starters, one's own recipes oldest first, then `+`.
 * Only one's own recipes offer a long press; starters ship with the build. It runs out to the
 * screen's edges rather than ending at a wall inside them, and it keeps the look in force in
 * view, so the chosen chip is never the one cut off. No state of its own: the recipes are
 * `useRecipes`', and the row's refs only keep the selection in view.
 */
import { useEffect, useRef } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import type { Recipe } from "../recipes/model";
import { space } from "../ui/theme";
import { Chip } from "../ui/primitives";
import { recipes as copy } from "../ui/copy";

interface RecipePickerProps {
  /** Clean and the starters, then the photographer's own, in the order they are shown. */
  choices: readonly Recipe[];
  /** The recipe in force. */
  selected: Recipe | null;
  disabled?: boolean;
  /** What a second tap on the look in force leads to, spoken with its name. Absent in AUTO. */
  againHint?: (name: string) => string;
  onChoose: (recipe: Recipe) => void;
  /** Absent where a new recipe cannot be made: the `+` is absent with it. */
  onCustom?: () => void;
  onOptions: (recipe: Recipe) => void;
  /** How far the row bleeds past its parent on each side: the parent's own padding. */
  bleed?: { left: number; right: number };
}

/** A small chip is 32 tall; the touch around it makes up the fingertip. */
const HIT = { top: 6, bottom: 6 };

export function RecipePicker({
  choices,
  selected,
  disabled = false,
  againHint,
  onChoose,
  onCustom,
  onOptions,
  bleed = { left: space.gutter, right: space.gutter },
}: RecipePickerProps) {
  const scroll = useRef<ScrollView>(null);
  const viewport = useRef(0);
  const offset = useRef(0);
  const slots = useRef<Record<string, { x: number; width: number }>>({});

  /** Brings the look in force into view, with a chip's gap of air, and leaves it if it already is. */
  const reveal = (animated: boolean) => {
    const slot = selected === null ? undefined : slots.current[selected.id];
    if (!slot || viewport.current === 0) return;
    const air = space.sm;
    if (slot.x - air < offset.current) {
      scroll.current?.scrollTo({ x: Math.max(0, slot.x - bleed.left), animated });
    } else if (slot.x + slot.width + air > offset.current + viewport.current) {
      scroll.current?.scrollTo({ x: slot.x + slot.width + bleed.right - viewport.current, animated });
    }
  };
  const selectedId = selected?.id;
  // Only a change of look moves the row; `reveal` reads the rest from refs.
  useEffect(() => reveal(true), [selectedId]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <ScrollView
      ref={scroll}
      horizontal
      showsHorizontalScrollIndicator={false}
      style={[s.scroll, { marginLeft: -bleed.left, marginRight: -bleed.right }]}
      contentContainerStyle={[s.row, { paddingLeft: bleed.left, paddingRight: bleed.right }]}
      scrollEnabled={!disabled}
      scrollEventThrottle={32}
      onScroll={(event) => { offset.current = event.nativeEvent.contentOffset.x; }}
      onLayout={(event) => {
        viewport.current = event.nativeEvent.layout.width;
        reveal(false);
      }}
      // The content exists only now: a scroll asked for before it is sized is clamped to the start,
      // which is how the look in force came up cut off at the row's edge on the phone.
      onContentSizeChange={() => requestAnimationFrame(() => reveal(false))}
      testID="recipe-row"
    >
      {choices.map((recipe) => {
        const chosen = selected?.id === recipe.id;
        return (
          <View
            key={recipe.id}
            onLayout={(event) => {
              slots.current[recipe.id] = { x: event.nativeEvent.layout.x, width: event.nativeEvent.layout.width };
              if (chosen) reveal(false);
            }}
          >
            <Chip
              label={recipe.name}
              selected={chosen}
              accessibilityLabel={chosen && againHint ? againHint(recipe.name) : recipe.name}
              disabled={disabled}
              onPress={() => onChoose(recipe)}
              onLongPress={recipe.builtIn ? undefined : () => onOptions(recipe)}
              size="small"
              hitSlop={HIT}
              testID={`recipe-chip-${recipe.id}`}
            />
          </View>
        );
      })}
      {onCustom && (
        <Chip
          label={copy.custom}
          accessibilityLabel={copy.customLabel}
          disabled={disabled}
          onPress={onCustom}
          size="small"
          hitSlop={HIT}
          testID="recipe-chip-custom"
        />
      )}
    </ScrollView>
  );
}

const s = StyleSheet.create({
  scroll: { flexGrow: 0 },
  row: { gap: space.sm, alignItems: "center", height: 44 },
});
