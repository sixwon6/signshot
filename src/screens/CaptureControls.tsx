/**
 * The camera's readout cells, the histogram DISP draws on the picture, and the control vocabulary
 * `CaptureAdjust.tsx` shares. The cells keep one order in every mode: AUTO shows brightness alone
 * beside its looks; P and M show all five controls and the look as a sixth. A control the camera
 * lacks is absent; one the mode forbids is dimmed. Presentational: state lives in
 * `useCaptureControls`.
 */
import { StyleSheet, Text, View } from "react-native";
import {
  AUTO_LABEL,
  ISO_LADDER,
  SHUTTER_LADDER_NS,
  UNAVAILABLE,
  formatEv,
  formatFocus,
  formatIso,
  formatShutter,
  type CaptureCapabilities,
  type CaptureSettings,
  type MeterReading,
} from "../capture/model";
import { holdsExposure, type CaptureMode } from "../capture/mode";
import { colors, radius, space } from "../ui/theme";
import { typeScale as type } from "../ui/type";
import { Cell, CHROME_FONT_SCALE } from "../ui/primitives";
import { captureControls as copy } from "../ui/copy";

/** The five camera controls that have a cell and an adjuster. */
export type ControlKey = "iso" | "shutter" | "ev" | "whiteBalance" | "focus";
/** What can be live under the thumb: a camera control, or the look. */
export type LiveKey = ControlKey | "look";

const ORDER: readonly ControlKey[] = ["iso", "shutter", "ev", "whiteBalance", "focus"];

/** A control's full name, spoken. */
export const NAME: Record<ControlKey, string> = {
  iso: copy.iso,
  shutter: copy.shutter,
  ev: copy.ev,
  whiteBalance: copy.whiteBalance,
  focus: copy.focus,
};

/** The short form a cell carries. */
const TAG: Record<ControlKey, string> = {
  iso: copy.tag.iso,
  shutter: copy.tag.shutter,
  ev: copy.tag.ev,
  whiteBalance: copy.tag.whiteBalance,
  focus: copy.tag.focus,
};

/** Which controls THIS camera has, in this mode. The one predicate the cells and the adjuster obey. */
export function controlsOf(caps: CaptureCapabilities, mode: CaptureMode): readonly ControlKey[] {
  const readout = mode !== "auto";
  const kelvin = caps.manualPostProcessing && caps.kelvin !== UNAVAILABLE;
  return ORDER.filter((key) => {
    switch (key) {
      // The pair the dial's M holds: both cells or neither, by the rule that gives the dial its M.
      case "iso":
      case "shutter":
        return readout && holdsExposure(caps);
      case "ev":
        return caps.ev !== UNAVAILABLE && caps.ev.max > caps.ev.min;
      case "whiteBalance":
        return readout && (caps.awbModes.length > 0 || kelvin);
      case "focus":
        return readout && caps.focus !== UNAVAILABLE;
    }
  });
}

/**
 * What the mode forbids of a control this camera has. Brightness steers the meter, and M has
 * none. Such a cell is dimmed and cannot be made live.
 */
export function forbiddenIn(key: ControlKey, mode: CaptureMode): boolean {
  return key === "ev" && mode === "manual";
}

/** The cell that is live when the dial arrives at a mode: what that mode is for. */
export function firstLive(caps: CaptureCapabilities, mode: CaptureMode): ControlKey | null {
  if (mode === "auto") return null;
  const have = controlsOf(caps, mode).filter((key) => !forbiddenIn(key, mode));
  const wanted: ControlKey = mode === "manual" ? "shutter" : "ev";
  return have.includes(wanted) ? wanted : (have[0] ?? null);
}

/** The ISO ladder narrowed to this sensor. Empty when the camera has no manual sensitivity. */
export function isoSteps(caps: CaptureCapabilities): readonly number[] {
  const range = caps.iso;
  if (range === UNAVAILABLE) return [];
  return ISO_LADDER.filter((step) => step >= range.min && step <= range.max);
}

/** The shutter ladder narrowed to this shutter. */
export function shutterSteps(caps: CaptureCapabilities): readonly number[] {
  const range = caps.shutterNs;
  if (range === UNAVAILABLE) return [];
  return SHUTTER_LADDER_NS.filter((step) => step >= range.min && step <= range.max);
}

/** The lights people stand in, for the white-balance modes Camera2 names. */
export const LIGHT_LABEL: Record<string, string> = {
  daylight: copy.lights.daylight,
  "cloudy-daylight": copy.lights.cloudy,
  shade: copy.lights.shade,
  incandescent: copy.lights.indoor,
  fluorescent: copy.lights.fluorescent,
  "warm-fluorescent": copy.lights.warmFluorescent,
  twilight: copy.lights.twilight,
};

/** The same lights in a cell's width. A long name is for the chip; the cell says it short. */
const LIGHT_TAG: Record<string, string> = {
  fluorescent: copy.lightTags.fluorescent,
  "warm-fluorescent": copy.lightTags.warmFluorescent,
  twilight: copy.lightTags.twilight,
};

interface Reading {
  key: ControlKey;
  tag: string;
  /** What the cell says: the metered value in auto, the held value when one is held. */
  value: string;
  /** The same, in full, for a screen reader. */
  spoken: string;
  /** True while the photographer is holding this control by hand. */
  held: boolean;
  /** `forbiddenIn` this mode: dimmed, and it cannot be made live. */
  forbidden: boolean;
}

/**
 * The cells' readings, in order. AUTO is what a formatter returns when nothing has been metered
 * yet, so a cold camera reads AUTO rather than an invented number. The cell carries the tag
 * itself, so a formatter's copy of it is dropped: a word, never a digit.
 */
function readings(
  settings: CaptureSettings,
  caps: CaptureCapabilities,
  meter: MeterReading | null,
  mode: CaptureMode,
): readonly Reading[] {
  return controlsOf(caps, mode).map((key): Reading => {
    const forbidden = forbiddenIn(key, mode);
    switch (key) {
      case "iso": {
        const held = settings.iso !== "auto";
        const spoken = formatIso(held ? settings.iso : (meter?.iso ?? "auto"));
        return { key, tag: TAG.iso, value: spoken.replace(/^ISO /, ""), spoken, held, forbidden };
      }
      case "shutter": {
        const held = settings.shutterNs !== "auto";
        const spoken = formatShutter(held ? settings.shutterNs : (meter?.shutterNs ?? "auto"));
        return { key, tag: TAG.shutter, value: spoken, spoken, held, forbidden };
      }
      case "ev": {
        const held = settings.ev !== 0;
        const spoken = formatEv(held ? settings.ev : (meter?.ev ?? 0), caps);
        return { key, tag: TAG.ev, value: spoken, spoken, held, forbidden };
      }
      case "whiteBalance": {
        const wb = settings.whiteBalance;
        const held = wb !== "auto";
        if (typeof wb === "object") {
          const kelvin = `${Math.round(wb.kelvin)}K`;
          return { key, tag: TAG.whiteBalance, value: kelvin, spoken: kelvin, held, forbidden };
        }
        const light = held ? wb : (meter?.awbMode ?? "auto");
        const spoken = light === "auto" ? AUTO_LABEL : (LIGHT_LABEL[light] ?? light);
        return {
          key,
          tag: TAG.whiteBalance,
          value: light === "auto" ? AUTO_LABEL : (LIGHT_TAG[light] ?? LIGHT_LABEL[light] ?? light),
          spoken,
          held,
          forbidden,
        };
      }
      case "focus": {
        const held = settings.focus !== "auto";
        const spoken = formatFocus(held ? settings.focus : (meter?.focusDistance ?? "auto"), caps);
        return { key, tag: TAG.focus, value: spoken, spoken, held, forbidden };
      }
    }
  });
}

interface ReadoutCellsProps {
  mode: CaptureMode;
  caps: CaptureCapabilities;
  settings: CaptureSettings;
  meter: MeterReading | null;
  /** The cell whose adjuster is up in the row above. */
  live: LiveKey | null;
  /** The look in force, for the sixth cell. */
  look: string;
  disabled?: boolean;
  onLive: (key: LiveKey) => void;
}

/** The readout, in the sheet. Every cell this camera has shares the row's width equally. */
export function ReadoutCells({
  mode,
  caps,
  settings,
  meter,
  live,
  look,
  disabled = false,
  onLive,
}: ReadoutCellsProps) {
  const cells = readings(settings, caps, meter, mode);
  return (
    <View style={s.cells} testID="capture-readout">
      {cells.map((cell) => (
        <Cell
          key={cell.key}
          tag={cell.tag}
          value={cell.value}
          live={live === cell.key}
          held={cell.held}
          forbidden={cell.forbidden}
          disabled={disabled}
          onPress={() => onLive(cell.key)}
          accessibilityLabel={(cell.forbidden ? copy.readingOf : copy.openOf)(NAME[cell.key], cell.spoken)}
          style={s.cell}
          testID={`capture-readout-${cell.key}`}
          valueTestID={`capture-cell-${cell.key}`}
        />
      ))}
      <Cell
        tag={copy.tag.look}
        value={look}
        live={live === "look"}
        disabled={disabled}
        onPress={() => onLive("look")}
        accessibilityLabel={copy.openOf(copy.look, look)}
        style={s.lookCell}
        testID="capture-readout-look"
        valueTestID="capture-cell-look"
      />
    </View>
  );
}

/** AUTO's one cell, pinned beside its looks. */
export function BrightCell({
  caps,
  settings,
  meter,
  live,
  disabled = false,
  onPress,
}: {
  caps: CaptureCapabilities;
  settings: CaptureSettings;
  meter: MeterReading | null;
  live: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  const cell = readings(settings, caps, meter, "auto").find((one) => one.key === "ev");
  if (!cell) return null;
  return (
    <Cell
      tag={cell.tag}
      value={cell.value}
      live={live}
      held={cell.held}
      disabled={disabled}
      onPress={onPress}
      accessibilityLabel={copy.openOf(NAME.ev, cell.spoken)}
      style={s.lightCell}
      testID="capture-readout-ev"
      valueTestID="capture-cell-ev"
    />
  );
}

/** Clipping as a percentage of the pixels the meter sampled: `0.0`, `3.2`. */
const clippedPercent = (fraction: number): string =>
  (Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0)) * 100).toFixed(1);

/**
 * 64 bars of preview luma, plain Views, on the picture's top corner. Scaled to the tallest bin,
 * because a histogram is read for its shape; the two numbers beneath it are the absolute fact.
 * Each sits under the end of the scale it counts, so neither needs a word.
 */
export function Histogram({ meter }: { meter: MeterReading | null }) {
  const bins = meter?.histogram ?? [];
  const peak = bins.reduce((high, bin) => (bin > high ? bin : high), 0);
  const black = clippedPercent(meter?.clippedBlack ?? 0);
  const white = clippedPercent(meter?.clippedWhite ?? 0);
  return (
    <View
      style={s.histogram}
      testID="capture-histogram"
      pointerEvents="none"
      accessible
      accessibilityLabel={copy.histogramOf(black, white)}
    >
      <View style={s.bars} testID="capture-histogram-bars">
        {bins.map((bin, index) => (
          <View
            key={index}
            style={[
              s.bar,
              { height: (peak > 0 ? Math.round((bin / peak) * 100) : 0) + "%" as `${number}%` },
            ]}
          />
        ))}
      </View>
      <View style={s.clipped}>
        <Text maxFontSizeMultiplier={CHROME_FONT_SCALE} style={[type.imprint, s.clippedValue]} testID="capture-clipped-black">
          {black}
        </Text>
        <Text maxFontSizeMultiplier={CHROME_FONT_SCALE} style={[type.imprint, s.clippedValue]} testID="capture-clipped-white">
          {white}
        </Text>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  cells: { flexDirection: "row", gap: 2 },
  cell: { flexGrow: 1, flexBasis: 0 },
  /** A name, not a number: the look's cell is half as wide again. */
  lookCell: { flexGrow: 1.5, flexBasis: 0 },
  lightCell: { width: 64 },
  histogram: {
    position: "absolute",
    top: space.sm,
    right: space.gutter,
    width: 128,
    gap: 2,
    padding: space.xs,
    borderRadius: radius.small,
    backgroundColor: "rgba(11,12,14,0.55)",
  },
  bars: { flexDirection: "row", alignItems: "flex-end", height: 36 },
  bar: { flexGrow: 1, flexBasis: 0, backgroundColor: colors.ink, opacity: 0.85, minHeight: 1 },
  clipped: { flexDirection: "row", justifyContent: "space-between" },
  clippedValue: { color: colors.ink },
});
