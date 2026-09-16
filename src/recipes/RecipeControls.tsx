import { useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { effectiveParam, type Recipe, type StageType } from "./model";
import { stageControls } from "./controls";
import { Track } from "../screens/RecipeSheet";
import { paramValue } from "../prints/developCopy";
import { Pill } from "../ui/primitives/Pill";
import { recipes as copy } from "../ui/copy";
import { colors, space } from "../ui/theme";
import { typeScale } from "../ui/type";

/** One drag control; screen-reader users retain exact step adjustments. */
export function RecipeDial({ label, value, min, max, step, readout, disabled, onChange, testID }: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  readout: string;
  disabled?: boolean;
  onChange(value: number): void;
  testID?: string;
}) {
  const widths = useRef<Record<string, number>>({});
  const set = (raw: number) => {
    if (disabled) return;
    const snapped = min + Math.round((raw - min) / step) * step;
    onChange(Number(Math.max(min, Math.min(max, snapped)).toFixed(4)));
  };
  return (
    <View style={s.row}>
      <View style={s.readout}>
        <Text style={s.label}>{label}</Text>
        <Text style={s.value}>{readout}</Text>
      </View>
      <Track
        testID={testID}
        widths={widths}
        widthKey="value"
        fraction={max > min ? (value - min) / (max - min) : 0}
        disabled={disabled}
        accessibilityLabel={`${label}, ${readout}`}
        accessibilityValue={{ min: 0, max: Math.round((max - min) / step), now: Math.round((value - min) / step) }}
        onAt={(fraction) => set(min + fraction * (max - min))}
        onStep={(direction) => set(value + direction * step)}
      />
    </View>
  );
}

/** Main amount first. Opening fine controls never changes the saved recipe. Key by stage. */
export function StageParameters({ recipe, stage, strength, disabled, onParam }: {
  recipe: Recipe;
  stage: StageType;
  strength: number;
  disabled?: boolean;
  onParam(stage: StageType, param: string, value: number): void;
}) {
  const [fine, setFine] = useState(false);
  const controls = stageControls(stage);
  const shown = fine ? [controls.main, ...controls.fine] : [controls.main];
  return (
    <View style={s.controls}>
      {shown.map((param) => {
        const value = effectiveParam(recipe, param, strength);
        return <RecipeDial
          key={param.param}
          testID={`recipe-track-${stage}.${param.param}`}
          label={param.label}
          value={value}
          min={param.min}
          max={param.max}
          step={param.step}
          readout={paramValue(param, value)}
          disabled={disabled}
          onChange={(next) => onParam(stage, param.param, next)}
        />;
      })}
      {controls.fine.length > 0 && <Pill
        label={fine ? copy.hideFineControls : copy.fineControls}
        expanded={fine}
        variant="secondary"
        size="small"
        disabled={disabled}
        onPress={() => setFine((shown) => !shown)}
      />}
    </View>
  );
}

const s = StyleSheet.create({
  controls: { gap: space.sm },
  row: { gap: 2 },
  readout: { flexDirection: "row", justifyContent: "space-between", gap: space.sm },
  label: { ...typeScale.body, color: colors.ink },
  value: { ...typeScale.readout, color: colors.tealText },
});
