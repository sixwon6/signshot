import { useEffect, useMemo, useRef, useState } from "react";
import {
  Image,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import type { CaptureRecord, PhotoEdit } from "../../modules/seeker-camera";
import { developPhoto } from "../recipes/apply";
import {
  RECIPE_NAME_LIMIT,
  STAGES,
  neutralRecipe,
  sameLook,
  withParam,
  type Recipe,
  type StageType,
} from "../recipes/model";
import { retiredById } from "../recipes/retired";
import { allRecipes, saveRecipe } from "../recipes/store";
import { colors, radius, space } from "../ui/theme";
import { typeScale } from "../ui/type";
import { Chip, PhotoFrame, Pill, Screen } from "../ui/primitives";
import { safeErrorText } from "../ui/errorText";
import {
  develop as copy,
  pixelValue,
  strengthValue,
} from "./developCopy";
import type { DevelopedEdit } from "./photoPresentation";
import { createDevelopQueue, type DevelopOutcome } from "./developQueue";
import { StageBar } from "../screens/RecipeBar";
import { RecipeDial, StageParameters } from "../recipes/RecipeControls";

/** Develop the canonical frame using the capture recipes. */

/** How long a slider is left alone before the frame is developed again. */
const DEVELOP_DEBOUNCE_MS = 180;

export function PhotoEditor({
  record,
  initial,
  onSave,
  onClose,
}: {
  record: CaptureRecord;
  initial?: PhotoEdit;
  onSave(edit: DevelopedEdit): void | Promise<void>;
  onClose(): void;
}) {
  const [recipes, setRecipes] = useState<readonly Recipe[]>([]);
  const [recipe, setRecipe] = useState<Recipe>(neutralRecipe());
  /** 0..1, the global mix. The sidecar keeps it as an integer 0..100. */
  const [strength, setStrength] = useState((initial?.intensity ?? record.intensity) / 100);
  const [preview, setPreview] = useState<PhotoEdit | undefined>(initial);
  const [outcome, setOutcome] = useState<DevelopOutcome | null>(null);
  const [restored, setRestored] = useState(false);
  const [error, setError] = useState("");
  const [original, setOriginal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const [showAdjustments, setShowAdjustments] = useState(false);
  const [openStage, setOpenStage] = useState<StageType | null>(null);

  const live = useRef(true);
  /** Restore the saved recipe snapshot, or fall back to the current recipe row. */
  useEffect(() => {
    void allRecipes()
      .then((list) => {
        if (!live.current) return;
        setRecipes(list);
        // A saved version carries the recipe that made it, so it reopens with exactly that look
        // even if the recipe is gone. A version without a snapshot falls back to the row by id.
        const snapshot = (initial as DevelopedEdit | undefined)?.recipe;
        if (snapshot) {
          const restored: Recipe = {
            id: snapshot.manifest.profileId,
            name: snapshot.name,
            manifest: snapshot.manifest,
            lut: snapshot.lut,
            builtIn: false,
          };
          // Use the row's recipe (so its chip reads as chosen) only when it is the same look;
          // a recipe edited since must not redevelop this version at different values.
          const inRow = list.find((item) => item.id === restored.id);
          setRecipe(inRow && sameLook(inRow, restored) ? inRow : restored);
          return;
        }
        const id = initial?.profileId ?? record.profileId;
        // A starter that no longer ships is off the row, but still develops its own photographs.
        const found = list.find((item) => item.id === id) ?? retiredById(id);
        if (found) setRecipe(found);
      })
      .catch((e: unknown) => {
        if (live.current) setError(safeErrorText(e));
      })
      .finally(() => {
        if (live.current) setRestored(true);
      });
    // Once, on opening: the store is a local read and the row does not change under the screen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const queue = useMemo(
    () =>
      createDevelopQueue(
        (request) => developPhoto(record.baseName, request.recipe, request.strength),
        (outcome) => {
          if (!live.current) return;
          setOutcome(outcome);
          setError(outcome.error ?? "");
          if (outcome.edit) setPreview(outcome.edit);
        },
      ),
    [record.baseName],
  );
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      queue.cancel();
    };
  }, [queue]);
  useEffect(() => {
    if (!restored) return;
    queue.request({ recipe, strength }, DEVELOP_DEBOUNCE_MS);
    return () => queue.cancel();
  }, [queue, recipe, strength, restored]);

  /** A recipe with a parameter moved carries an unsaved id of its own, so it is not in the row. */
  const edited = !recipe.builtIn && recipes.every((item) => item.id !== recipe.id);
  // Saving requires the pixels from these exact controls, even before effect cleanup runs.
  const busy = !restored || outcome?.request.recipe !== recipe || outcome.request.strength !== strength;
  const working = busy || saving;
  const stage = STAGES.find((item) => item.type === openStage);

  function choose(next: Recipe) {
    if (working) return;
    setRecipe(next);
  }
  function adjust(stage: StageType, param: string, value: number) {
    if (saving) return;
    try {
      setRecipe(withParam(recipe, stage, param, value));
    } catch (e) {
      setError(safeErrorText(e));
    }
  }
  function keepRecipe() {
    if (working) return;
    setSaving(true);
    void saveRecipe(recipe, name)
      .then(async (saved) => {
        const list = await allRecipes();
        if (!live.current) return;
        setRecipes(list);
        setRecipe(list.find((item) => item.id === saved.id) ?? saved);
        setNaming(false);
        setError("");
      })
      .catch((e: unknown) => {
        if (live.current) setError(safeErrorText(e));
      })
      .finally(() => {
        if (live.current) setSaving(false);
      });
  }
  function use() {
    if (!outcome?.edit || working || error) return;
    setSaving(true);
    // The recipe's NAME travels with the saved version; its id is already in `profileId`.
    Promise.resolve(
      onSave({
        ...outcome.edit,
        recipeName: recipe.name,
        recipe: { manifest: recipe.manifest, lut: recipe.lut, name: recipe.name },
      }),
    )
      .catch((e: unknown) => setError(safeErrorText(e)))
      .finally(() => {
        if (live.current) setSaving(false);
      });
  }

  return (
    <Modal
      animationType="slide"
      onRequestClose={() => {
        if (!saving) onClose();
      }}
    >
      <Screen>
          <View style={s.headerRow}>
            <Text style={s.heading}>{copy.heading}</Text>
            <Pill
              label={copy.close}
              variant="secondary"
              size="small"
              disabled={saving}
              onPress={onClose}
            />
          </View>
        <ScrollView style={s.scroll} contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">
          {/* Press and hold for the canonical frame with no recipe on it. */}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={copy.original}
            onPressIn={() => setOriginal(true)}
            onPressOut={() => setOriginal(false)}
            testID="develop-hold-original"
          >
            <PhotoFrame imageHeight={240}>
              <Image
                source={{
                  uri: original ? record.cleanUri : (preview?.uri ?? record.cleanUri),
                }}
                resizeMode="contain"
                style={s.photo}
                accessibilityLabel={original ? copy.original : copy.heading}
              />
            </PhotoFrame>
          </Pressable>
          <Text style={s.label}>{copy.recipe}</Text>
          <View style={s.chips} accessibilityRole="radiogroup">
            {recipes.map((item) => (
              <Chip
                key={item.id}
                label={item.name}
                accessibilityRole="radio"
                selected={!edited && item.id === recipe.id}
                disabled={working}
                onPress={() => choose(item)}
              />
            ))}
            {edited && <Chip label={copy.custom} selected accessibilityRole="radio" />}
          </View>
          <View style={s.stage}>
            <RecipeDial
              testID="develop-strength"
              label={copy.strength}
              value={strength}
              min={0}
              max={1}
              step={0.05}
              readout={strengthValue(strength)}
              disabled={saving}
              onChange={(value) => setStrength(value)}
            />
          </View>
          <Pill
            label={showAdjustments ? copy.hideAdjustments : copy.adjustments}
            variant="secondary"
            size="small"
            disabled={saving}
            expanded={showAdjustments}
            onPress={() => setShowAdjustments((shown) => !shown)}
          />
          {showAdjustments && <>
            <StageBar recipe={recipe} open={openStage} disabled={saving} onOpen={setOpenStage} />
            {/* Use the same adjustment groups as the camera, opening only one at a time. */}
            {stage && <View style={s.stage}>
              <StageParameters key={stage.type} recipe={recipe} stage={stage.type}
                strength={strength} disabled={saving} onParam={adjust} />
            </View>}
          {naming ? (
            <View style={s.stage}>
              <TextInput
                value={name}
                onChangeText={setName}
                placeholder={copy.name}
                placeholderTextColor={colors.muted}
                maxLength={RECIPE_NAME_LIMIT}
                accessibilityLabel={copy.name}
                style={s.input}
                testID="develop-recipe-name"
              />
              <View style={s.row}>
                <Pill
                  label={copy.keep}
                  variant="secondary"
                  size="small"
                  disabled={working}
                  onPress={keepRecipe}
                  style={s.flex}
                />
                <Pill
                  label={copy.cancel}
                  variant="secondary"
                  size="small"
                  disabled={saving}
                  onPress={() => setNaming(false)}
                  style={s.flex}
                />
              </View>
            </View>
          ) : (
            <Pill
              label={copy.saveRecipe}
              variant="secondary"
              size="small"
              disabled={working}
              onPress={() => {
                setName(recipe.name);
                setNaming(true);
              }}
            />
          )}
          </>}
        </ScrollView>
        <View style={s.dock}>
          <Text style={s.readout}>
            {[recipe.name, strengthValue(strength), preview && pixelValue(preview.width, preview.height)]
              .filter(Boolean)
              .join(" · ")}
          </Text>
          {!!error && (
            <Text style={s.error} accessibilityLiveRegion="polite">
              {error}
            </Text>
          )}
          <Pill
            label={busy ? copy.developing : saving ? copy.saving : copy.use}
            disabled={working || !!error || !outcome?.edit}
            onPress={use}
          />
        </View>
      </Screen>
    </Modal>
  );
}

const s = StyleSheet.create({
  scroll: { flex: 1 },
  dock: { gap: space.sm, paddingVertical: space.md, borderTopWidth: 1, borderTopColor: colors.line },
  content: { gap: space.md, paddingBottom: space.xxl },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.sm,
    paddingBottom: space.md,
  },
  heading: { ...typeScale.title, color: colors.ink },
  photo: { width: "100%", height: "100%" },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  label: { ...typeScale.label, color: colors.muted, paddingTop: space.sm },
  stage: { gap: space.sm, paddingTop: space.sm },
  input: {
    ...typeScale.body,
    color: colors.ink,
    backgroundColor: colors.field,
    borderRadius: radius.small,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
  },
  row: { flexDirection: "row", gap: space.sm },
  flex: { flex: 1 },
  readout: { ...typeScale.readout, color: colors.muted },
  error: { ...typeScale.body, color: colors.danger },
});
