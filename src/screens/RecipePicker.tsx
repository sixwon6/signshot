/**
 * The recipe row, in store order: Clean, the starters, one's own recipes oldest first, then `+`.
 * Only one's own recipes offer a long press; starters ship with the build. State is `useRecipes`'.
 */
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
  onChoose: (recipe: Recipe) => void;
  onCustom: () => void;
  onOptions: (recipe: Recipe) => void;
}

export function RecipePicker({
  choices,
  selected,
  disabled = false,
  onChoose,
  onCustom,
  onOptions,
}: RecipePickerProps) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={s.row}
      scrollEnabled={!disabled}
      testID="recipe-row"
    >
      {choices.map((recipe) => {
        const chosen = selected?.id === recipe.id;
        return (
          <View key={recipe.id} style={s.slot}>
            <Chip
              label={recipe.name}
              selected={chosen}
              accessibilityLabel={chosen ? copy.editHint(recipe.name) : recipe.name}
              disabled={disabled}
              onPress={() => onChoose(recipe)}
              onLongPress={recipe.builtIn ? undefined : () => onOptions(recipe)}
              size="small"
              testID={`recipe-chip-${recipe.id}`}
            />
          </View>
        );
      })}
      <View style={s.slot}>
        <Chip
          label={copy.custom}
          accessibilityLabel={copy.customLabel}
          disabled={disabled}
          onPress={onCustom}
          size="small"
          testID="recipe-chip-custom"
        />
      </View>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  row: { gap: space.sm, flexGrow: 1, justifyContent: "center" },
  slot: { position: "relative" },
});
