/**
 * The readout strip over the picture and its histogram, plus the vocabulary the tray shares
 * (`CaptureTray.tsx`). Presentational: state lives in `useCaptureControls`. A control the camera
 * lacks is absent; one the state forbids is dimmed.
 */
import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import {
  AUTO_LABEL,
  ISO_LADDER,
  SHUTTER_LADDER_NS,
  UNAVAILABLE,
  formatEv,
  formatFocus,
  formatIso,
  formatShutter,
  formatWhiteBalance,
  type CaptureCapabilities,
  type CaptureSettings,
  type MeterReading,
} from "../capture/model";
import { colors, radius, space } from "../ui/theme";
import { typeScale as type } from "../ui/type";
import { captureControls as copy } from "../ui/copy";

/** The five controls that have a cell in the strip and a tray under it. */
export type ControlKey = "iso" | "shutter" | "ev" | "whiteBalance" | "focus";

const ORDER: readonly ControlKey[] = ["iso", "shutter", "ev", "whiteBalance", "focus"];

/** The name a tray carries, from copy and nowhere else. */
export const NAME: Record<ControlKey, string> = {
  iso: copy.iso,
  shutter: copy.shutter,
  ev: copy.ev,
  whiteBalance: copy.whiteBalance,
  focus: copy.focus,
};

/** The short form the strip carries. */
const TAG: Record<ControlKey, string> = {
  iso: copy.tag.iso,
  shutter: copy.tag.shutter,
  ev: copy.tag.ev,
  whiteBalance: copy.tag.whiteBalance,
  focus: copy.tag.focus,
};

/** Which controls THIS camera has, in this mode. The one predicate the strip and the tray obey. */
export function controlsOf(caps: CaptureCapabilities, pro = true): readonly ControlKey[] {
  const kelvin = caps.manualPostProcessing && caps.kelvin !== UNAVAILABLE;
  return ORDER.filter((key) => {
    switch (key) {
      case "iso":
        return pro && caps.manualSensor && caps.iso !== UNAVAILABLE;
      case "shutter":
        return pro && caps.manualSensor && caps.shutterNs !== UNAVAILABLE;
      case "ev":
        return caps.ev !== UNAVAILABLE && caps.ev.max > caps.ev.min;
      case "whiteBalance":
        return caps.awbModes.length > 0 || kelvin;
      case "focus":
        return caps.focus !== UNAVAILABLE;
    }
  });
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

interface Reading {
  key: ControlKey;
  label: string;
  /** What the cell says: the metered value in auto, the held value when one is pinned. */
  value: string;
  /** True while the photographer is holding this control by hand. */
  pinned: boolean;
}

/** The lights people stand in, for the white-balance modes Camera2 names. Strip and tray agree. */
export const LIGHT_LABEL: Record<string, string> = {
  daylight: copy.lights.daylight,
  "cloudy-daylight": copy.lights.cloudy,
  shade: copy.lights.shade,
  incandescent: copy.lights.indoor,
  fluorescent: copy.lights.fluorescent,
  "warm-fluorescent": copy.lights.warmFluorescent,
  twilight: copy.lights.twilight,
};

/**
 * The strip's readings, in strip order. AUTO is what a formatter returns when nothing has been
 * metered yet, so a cold camera reads AUTO rather than an invented number.
 */
function readings(
  settings: CaptureSettings,
  caps: CaptureCapabilities,
  meter: MeterReading | null,
  pro: boolean,
): readonly Reading[] {
  return controlsOf(caps).map((key): Reading => {
    switch (key) {
      case "iso": {
        const pinned = settings.iso !== "auto";
        return {
          key,
          label: TAG.iso,
          value: formatIso(pinned ? settings.iso : (meter?.iso ?? "auto")),
          pinned,
        };
      }
      case "shutter": {
        const pinned = settings.shutterNs !== "auto";
        return {
          key,
          label: TAG.shutter,
          value: formatShutter(pinned ? settings.shutterNs : (meter?.shutterNs ?? "auto")),
          pinned,
        };
      }
      case "ev": {
        const pinned = settings.ev !== 0;
        return {
          key,
          label: TAG.ev,
          value: formatEv(pinned ? settings.ev : (meter?.ev ?? 0), caps),
          pinned,
        };
      }
      case "whiteBalance": {
        const pinned = settings.whiteBalance !== "auto";
        const shown = pinned ? formatWhiteBalance(settings.whiteBalance) : (meter?.awbMode ?? AUTO_LABEL);
        return {
          key,
          label: TAG.whiteBalance,
          value: LIGHT_LABEL[shown] ?? shown,
          pinned,
        };
      }
      case "focus": {
        const pinned = settings.focus !== "auto";
        const value = settings.focus === "auto"
          // Simple names the selected mode; a metered distance looks like manual focus there.
          ? formatFocus(pro ? meter?.focusDistance ?? "auto" : "auto", caps)
          : pro
            ? formatFocus(settings.focus, caps)
            : nearOrFar(settings.focus, caps);
        return { key, label: TAG.focus, value, pinned };
      }
    }
  });
}

/** Simple's word for a held focus: the half of the lens's travel it sits in. */
function nearOrFar(focus: number, caps: CaptureCapabilities): string {
  const lens = caps.focus;
  if (lens === UNAVAILABLE) return AUTO_LABEL;
  return focus > lens.minDiopters + (lens.maxDiopters - lens.minDiopters) / 2 ? copy.near : copy.far;
}

/**
 * The strip carries the word ISO itself, so the formatter's copy of it is not said twice. This
 * is the only place a formatted value is touched at all, and it removes a word — never a digit.
 */
const cellValue = (value: string): string =>
  value.startsWith("ISO ") ? value.slice(4) : value;

/** Clipping as a percentage of the pixels the meter sampled: `0.0`, `3.2`. */
const clippedPercent = (fraction: number): string =>
  (Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0)) * 100).toFixed(1);

/**
 * 64 bars of preview luma, plain Views. Scaled to the tallest bin, because a histogram is read
 * for its shape; the two numbers beneath it are the absolute fact.
 */
function Histogram({ meter }: { meter: MeterReading | null }) {
  const bins = meter?.histogram ?? [];
  const peak = bins.reduce((high, bin) => (bin > high ? bin : high), 0);
  return (
    <View style={s.histogram} testID="capture-histogram" pointerEvents="none">
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
        <Text style={[type.imprint, s.clippedLabel]}>{copy.black}</Text>
        <Text style={[type.imprint, s.clippedValue]} testID="capture-clipped-black">
          {clippedPercent(meter?.clippedBlack ?? 0)}
        </Text>
        <Text style={[type.imprint, s.clippedLabel]}>{copy.white}</Text>
        <Text style={[type.imprint, s.clippedValue]} testID="capture-clipped-white">
          {clippedPercent(meter?.clippedWhite ?? 0)}
        </Text>
      </View>
    </View>
  );
}

interface CaptureReadoutProps {
  pro: boolean;
  caps: CaptureCapabilities;
  settings: CaptureSettings;
  meter: MeterReading | null;
  /** Whether the histogram is drawn. The choice is the photographer's and it is remembered. */
  histogram: boolean;
  disabled?: boolean;
  /** The cell whose tray is open, so it reads as pressed. */
  open?: ControlKey | null;
  onOpen: (key: ControlKey) => void;
  /** The open tray, rendered under the cells and above the histogram. */
  children?: React.ReactNode;
}

/** The strip over the picture. Absolutely placed by the camera, so it pushes nothing. */
export function CaptureReadout({
  pro,
  caps,
  settings,
  meter,
  histogram,
  disabled = false,
  open = null,
  onOpen,
  children,
}: CaptureReadoutProps) {
  const visible = controlsOf(caps, pro);
  const cells = readings(settings, caps, meter, pro).filter((cell) => visible.includes(cell.key));
  if (cells.length === 0 && !(pro && histogram)) return null;
  return (
    <View style={s.strip} testID="capture-readout">
      {cells.length > 0 && (
        <View style={s.cells}>
          {cells.map((cell) => (
            <Pressable
              key={cell.key}
              accessibilityRole="button"
              accessibilityState={{ expanded: open === cell.key }}
              accessibilityLabel={copy.openOf(NAME[cell.key], cell.value)}
              disabled={disabled}
              onPress={() => onOpen(cell.key)}
              testID={`capture-readout-${cell.key}`}
              style={({ pressed }) => [s.cell, open === cell.key && s.cellOpen, pressed && { opacity: 0.7 }]}
            >
              <Text style={[type.imprint, s.cellLabel]}>{cell.label}</Text>
              <Text
                style={[type.label, cell.pinned ? s.cellPinned : s.cellAuto]}
                numberOfLines={1}
                testID={`capture-cell-${cell.key}`}
              >
                {cellValue(cell.value)}
              </Text>
            </Pressable>
          ))}
        </View>
      )}
      {children}
      {pro && histogram && <Histogram meter={meter} />}
    </View>
  );
}

const s = StyleSheet.create({
  /** Over the picture, not in the column, so it never moves the controls below. */
  strip: {
    position: "absolute",
    left: space.gutter,
    right: space.gutter,
    top: space.sm,
    gap: space.sm,
  },
  cells: { flexDirection: "row", justifyContent: "space-between", gap: space.xs },
  cell: {
    flexGrow: 1,
    flexBasis: 0,
    alignItems: "center",
    paddingVertical: space.xs,
    borderRadius: radius.small,
  },
  cellOpen: { backgroundColor: "rgba(11, 12, 14, 0.82)" },
  cellLabel: { color: colors.muted },
  cellAuto: { color: colors.ink },
  /** A value the photographer pinned reads in the accent. */
  cellPinned: { color: colors.tealText },
  histogram: {
    alignSelf: "flex-end",
    width: 128,
    gap: 2,
    padding: space.xs,
    borderRadius: radius.small,
    backgroundColor: "rgba(11,12,14,0.55)",
  },
  bars: { flexDirection: "row", alignItems: "flex-end", height: 36 },
  bar: { flexGrow: 1, flexBasis: 0, backgroundColor: colors.ink, opacity: 0.85, minHeight: 1 },
  clipped: { flexDirection: "row", alignItems: "baseline", gap: space.xs },
  clippedLabel: { color: colors.muted },
  clippedValue: { color: colors.ink, marginRight: space.xs },
});
