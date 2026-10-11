/**
 * Horizontal row of looks in store order, then `+`. User recipes get a long-press menu. Keeps the
 * selected look scrolled into view. Stateless; refs only track scroll geometry.
 */
import { useEffect, useRef } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import type { Recipe } from "../recipes/model";
import { space } from "../ui/theme";
import { Chip } from "../ui/primitives";
import { recipes as copy } from "../ui/copy";

interface RecipePickerProps {
  choices: readonly Recipe[];
  selected: Recipe | null;
  disabled?: boolean;
  /** Accessibility label for the selected chip, describing a second tap. Absent in AUTO. */
  againHint?: (name: string) => string;
  onChoose: (recipe: Recipe) => void;
  /** Omit to hide `+`. */
  onCustom?: () => void;
  onOptions: (recipe: Recipe) => void;
  /** Bleed past the parent on each side; pass the parent's padding. */
  bleed?: { left: number; right: number };
}

/** Pads a 32 dp chip to a 44 dp touch target. */
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

  /** Scrolls the selected chip into view with a small margin; no-op if already visible. */
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
  // Only a selection change scrolls; `reveal` reads everything else from refs.
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
      // Scrolls requested before content sizing are clamped to 0, so retry here.
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
