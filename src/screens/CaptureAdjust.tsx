/**
 * The adjust row: the live control's dial, directly above the readout cells. Each control is a
 * detented ruler: ISO in third stops, shutter in full stops, brightness in the device's own steps,
 * Kelvin by the hundred, focus in 2 % positions. The key at the row's end hands the control back
 * to the camera. The live cell below shows the value, so the row does not repeat it.
 * Presentational: state lives in `useCaptureControls`, and every value is what native applied.
 */
import React, { useEffect, useRef, useState } from "react";
import {
  ScrollView,
  StyleSheet,
  Text,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import {
  AUTO_LABEL,
  UNAVAILABLE,
  clampFocus,
  formatEv,
  formatFocus,
  formatIso,
  formatKelvin,
  formatShutter,
  type CaptureCapabilities,
  type CaptureSettings,
  type MeterReading,
} from "../capture/model";
import type { CaptureMode } from "../capture/mode";
import { colors, space } from "../ui/theme";
import { typeScale as type } from "../ui/type";
import { Chip, CHROME_FONT_SCALE } from "../ui/primitives";
import { captureControls as copy } from "../ui/copy";
import { LIGHT_LABEL, NAME, isoSteps, shutterSteps, type ControlKey } from "./CaptureControls";

// ---------------------------------------------------------------------------------------------
// The ruler

const TICK = 14;
/** A label every third detent: 42 dp apart, which the longest of them ("1/8000", "12800") fits. */
const MAJOR_EVERY_DEFAULT = 3;
/** The row's height: the ruler fills it, and the chips sit on its centre line. */
export const ADJUST_HEIGHT = 48;

interface RulerProps {
  /** How many detents, and which is in force. */
  count: number;
  index: number;
  /** The label over a major tick, or null for a minor one. */
  labelAt: (index: number) => string | null;
  disabled?: boolean;
  accessibilityLabel: string;
  onIndex: (index: number) => void;
  testID?: string;
}

/**
 * A horizontal dial: ticks scroll under a fixed centre mark and snap to the nearest detent. The
 * detent under the mark is the value; dragging is the only way to change it, so a value the
 * camera changes on its own (auto exposure metering) rolls the ruler rather than the reverse.
 */
function Ruler({ count, index, labelAt, disabled = false, accessibilityLabel, onIndex, testID }: RulerProps) {
  const scroll = useRef<ScrollView>(null);
  const [width, setWidth] = useState(0);
  const dragging = useRef(false);
  const emitted = useRef(index);
  const clamp = (i: number) => Math.max(0, Math.min(count - 1, i));

  // Follow the value in force unless a thumb is on the ruler.
  useEffect(() => {
    if (width === 0 || dragging.current || emitted.current === index) return;
    emitted.current = index;
    scroll.current?.scrollTo({ x: index * TICK, animated: true });
  }, [index, width]);

  const onScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    if (!dragging.current) return;
    const at = clamp(Math.round(event.nativeEvent.contentOffset.x / TICK));
    if (at !== emitted.current) {
      emitted.current = at;
      onIndex(at);
    }
  };
  const side = Math.max(0, width / 2 - TICK / 2);
  return (
    <View
      style={[s.ruler, disabled && s.quiet]}
      testID={testID}
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel={accessibilityLabel}
      accessibilityValue={{ min: 0, max: count - 1, now: index }}
      onAccessibilityAction={(event) => {
        if (event.nativeEvent.actionName === "increment") onIndex(clamp(index + 1));
        if (event.nativeEvent.actionName === "decrement") onIndex(clamp(index - 1));
      }}
      accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
    >
      <ScrollView
        ref={scroll}
        horizontal
        // The content exists only now: park the ruler on the value in force, without animation.
        onContentSizeChange={() => {
          if (!dragging.current) scroll.current?.scrollTo({ x: emitted.current * TICK, animated: false });
        }}
        showsHorizontalScrollIndicator={false}
        scrollEnabled={!disabled}
        snapToInterval={TICK}
        decelerationRate="fast"
        scrollEventThrottle={16}
        contentContainerStyle={{ paddingHorizontal: side }}
        onScrollBeginDrag={() => { dragging.current = true; }}
        onScroll={onScroll}
        onMomentumScrollEnd={(event) => {
          onScroll(event);
          dragging.current = false;
        }}
        onScrollEndDrag={(event) => {
          // No momentum follows a slow release; settle on the nearest detent ourselves.
          const at = clamp(Math.round(event.nativeEvent.contentOffset.x / TICK));
          if (Math.abs(event.nativeEvent.velocity?.x ?? 0) < 0.05) {
            dragging.current = false;
            if (at !== emitted.current) { emitted.current = at; onIndex(at); }
            scroll.current?.scrollTo({ x: at * TICK, animated: true });
          }
        }}
      >
        {Array.from({ length: count }, (_, i) => {
          const label = labelAt(i);
          return (
            <View key={i} style={s.tickCell}>
              <View style={[s.tick, label !== null && s.tickMajor, i === index && s.tickActive]} />
              {label !== null && (
                <Text maxFontSizeMultiplier={CHROME_FONT_SCALE} style={[type.imprint, s.tickLabel]} numberOfLines={1}>
                  {label}
                </Text>
              )}
            </View>
          );
        })}
      </ScrollView>
      <View pointerEvents="none" style={s.mark} />
    </View>
  );
}

// ---------------------------------------------------------------------------------------------
// The row

interface CaptureAdjustProps {
  mode: CaptureMode;
  control: ControlKey;
  caps: CaptureCapabilities;
  settings: CaptureSettings;
  meter: MeterReading | null;
  busy?: boolean;
  onChange: (settings: CaptureSettings) => void;
  /** Focus handed back to the camera: a tapped subject is released along with a held lens. */
  onReleaseFocus?: () => void;
}

const nearestIndex = (ladder: readonly number[], want: number): number => {
  let best = 0;
  for (let i = 1; i < ladder.length; i++)
    if (Math.abs(ladder[i] - want) < Math.abs(ladder[best] - want)) best = i;
  return best;
};

/** A ruler, and the key at its end that gives the control back to the camera. */
function Dial({ ruler, handBack }: { ruler: React.ReactNode; handBack: React.ReactNode }) {
  return (
    <View style={s.row}>
      <View style={s.grow}>{ruler}</View>
      {handBack}
    </View>
  );
}

export function CaptureAdjust({
  mode,
  control,
  caps,
  settings,
  meter,
  busy = false,
  onChange,
  onReleaseFocus,
}: CaptureAdjustProps) {
  const set = (patch: Partial<CaptureSettings>) => onChange({ ...settings, ...patch });
  /** M: ISO and shutter are held, so the exposure's hand-back key is off. */
  const held = mode === "manual";
  const kelvin = caps.manualPostProcessing && caps.kelvin !== UNAVAILABLE ? caps.kelvin : null;
  const heldKelvin = typeof settings.whiteBalance === "object" ? settings.whiteBalance.kelvin : null;
  /** Colour has two faces in one row: the lights people stand in, and the Kelvin ruler. */
  const [kelvinUp, setKelvinUp] = useState(heldKelvin !== null);

  /** "The camera's choice" is on: ink, because the accent is the photographer's. */
  const handBack = (on: boolean, onPress: () => void, testID: string, label: string = copy.auto) => (
    <Chip size="small" label={label} selected={on} fill={colors.ink} disabled={busy} onPress={onPress} testID={testID} />
  );
  const releaseExposure = () => set({ iso: "auto", shutterNs: "auto" });

  switch (control) {
    case "iso": {
      const isos = isoSteps(caps);
      const index = nearestIndex(isos, settings.iso === "auto" ? (meter?.iso ?? isos[0]) : settings.iso);
      return (
        <Dial
          ruler={
            <Ruler
              count={isos.length}
              index={index}
              labelAt={(i) => (i % MAJOR_EVERY_DEFAULT === 0 ? String(isos[i]) : null)}
              disabled={busy || isos.length === 0}
              accessibilityLabel={copy.readingOf(NAME.iso, formatIso(settings.iso))}
              onIndex={(i) => set({ iso: isos[i] })}
              testID="capture-ruler-iso"
            />
          }
          handBack={handBack(!held, releaseExposure, "capture-auto-iso")}
        />
      );
    }
    case "shutter": {
      const shutters = shutterSteps(caps);
      const index = nearestIndex(shutters, settings.shutterNs === "auto" ? (meter?.shutterNs ?? shutters[0]) : settings.shutterNs);
      return (
        <Dial
          ruler={
            <Ruler
              count={shutters.length}
              index={index}
              labelAt={(i) => (i % MAJOR_EVERY_DEFAULT === 0 ? formatShutter(shutters[i]) : null)}
              disabled={busy || shutters.length === 0}
              accessibilityLabel={copy.readingOf(NAME.shutter, formatShutter(settings.shutterNs))}
              onIndex={(i) => set({ shutterNs: shutters[i] })}
              testID="capture-ruler-shutter"
            />
          }
          handBack={handBack(!held, releaseExposure, "capture-auto-shutter")}
        />
      );
    }
    case "ev": {
      const ev = caps.ev === UNAVAILABLE ? null : caps.ev;
      if (ev === null) return null;
      const count = ev.max - ev.min + 1;
      const perStop = Math.max(1, Math.round(1 / ev.step));
      return (
        <Dial
          ruler={
            <Ruler
              count={count}
              index={settings.ev - ev.min}
              labelAt={(i) => ((i + ev.min) % perStop === 0 ? formatEv(i + ev.min, caps) : null)}
              disabled={busy}
              accessibilityLabel={copy.readingOf(NAME.ev, formatEv(settings.ev, caps))}
              onIndex={(i) => set({ ev: i + ev.min })}
              testID="capture-ruler-ev"
            />
          }
          handBack={handBack(settings.ev === 0, () => set({ ev: 0 }), "capture-ev-zero", copy.zero)}
        />
      );
    }
    case "whiteBalance": {
      if (kelvinUp && kelvin !== null) {
        const count = Math.floor((kelvin.max - kelvin.min) / 100) + 1;
        const index = heldKelvin === null ? Math.round((6500 - kelvin.min) / 100) : Math.round((heldKelvin - kelvin.min) / 100);
        return (
          <Dial
            ruler={
              <Ruler
                count={count}
                index={Math.max(0, Math.min(count - 1, index))}
                labelAt={(i) => ((kelvin.min + i * 100) % 1000 === 0 ? `${(kelvin.min + i * 100) / 1000}K` : null)}
                disabled={busy}
                accessibilityLabel={copy.readingOf(copy.kelvin, heldKelvin === null ? AUTO_LABEL : formatKelvin(heldKelvin))}
                onIndex={(i) => set({ whiteBalance: { kelvin: kelvin.min + i * 100 } })}
                testID="capture-ruler-kelvin"
              />
            }
            // Every ruler ends in the same key: colour goes back to the camera, and the row to its lights.
            handBack={handBack(
              settings.whiteBalance === "auto",
              () => {
                set({ whiteBalance: "auto" });
                setKelvinUp(false);
              },
              "capture-auto-whiteBalance",
            )}
          />
        );
      }
      const presets = caps.awbModes
        .filter((light) => light !== "auto" && light !== "off")
        .map((light) => ({ light, label: LIGHT_LABEL[light] ?? light }));
      return (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.bleed}
          contentContainerStyle={[s.row, s.bleedContent]} testID="capture-wb-row">
          {handBack(settings.whiteBalance === "auto", () => set({ whiteBalance: "auto" }), "capture-auto-whiteBalance")}
          {presets.map((p) => (
            <Chip key={p.light} size="small" label={p.label} selected={settings.whiteBalance === p.light} disabled={busy}
              onPress={() => set({ whiteBalance: p.light })} testID={`capture-wb-${p.light}`} />
          ))}
          {kelvin !== null && (
            <Chip size="small" label={copy.kelvinKey} selected={heldKelvin !== null} disabled={busy}
              onPress={() => setKelvinUp(true)} accessibilityLabel={copy.kelvin} testID="capture-wb-kelvin" />
          )}
          {caps.awbLock && (
            <Chip size="small" label={copy.awbLock} selected={settings.awbLock} disabled={busy || heldKelvin !== null}
              onPress={() => set({ awbLock: !settings.awbLock })} testID="capture-awb-lock" />
          )}
        </ScrollView>
      );
    }
    case "focus": {
      const lens = caps.focus === UNAVAILABLE ? null : caps.focus;
      if (lens === null) return null;
      const span = lens.maxDiopters - lens.minDiopters;
      const count = 51;
      const at = settings.focus === "auto" ? lens.minDiopters : clampFocus(settings.focus, caps);
      const index = span > 0 ? Math.round(((at - lens.minDiopters) / span) * (count - 1)) : 0;
      return (
        <Dial
          ruler={
            <Ruler
              count={count}
              index={index}
              labelAt={(i) => (i % 10 === 0 ? `${i * 2}%` : null)}
              disabled={busy || span <= 0}
              accessibilityLabel={copy.readingOf(NAME.focus, formatFocus(settings.focus, caps))}
              onIndex={(i) => set({ focus: lens.minDiopters + (i / (count - 1)) * span })}
              testID="capture-ruler-focus"
            />
          }
          handBack={handBack(
            settings.focus === "auto",
            () => {
              onReleaseFocus?.();
              set({ focus: "auto" });
            },
            "capture-auto-focus",
          )}
        />
      );
    }
  }
}

const s = StyleSheet.create({
  row: { height: ADJUST_HEIGHT, flexDirection: "row", alignItems: "center", gap: space.sm },
  grow: { flex: 1 },
  /** A scrolling row runs out to the screen's edges rather than ending at a wall inside them. */
  bleed: { marginHorizontal: -space.gutter, flexGrow: 0 },
  bleedContent: { paddingHorizontal: space.gutter },
  quiet: { opacity: 0.35 },
  ruler: { height: ADJUST_HEIGHT, justifyContent: "flex-end" },
  tickCell: { width: TICK, alignItems: "center", justifyContent: "flex-end", height: ADJUST_HEIGHT },
  tick: { width: 1, height: 10, backgroundColor: "rgba(245,244,240,0.35)" },
  tickMajor: { height: 16, backgroundColor: "rgba(245,244,240,0.7)" },
  tickActive: { backgroundColor: colors.teal },
  /** Tighter than `imprint`'s own tracking: a ruler's figures sit closer than a caption's letters. */
  tickLabel: {
    position: "absolute",
    top: 2,
    color: colors.muted,
    letterSpacing: 0.4,
    width: TICK * MAJOR_EVERY_DEFAULT,
    textAlign: "center",
  },
  mark: {
    position: "absolute",
    left: "50%",
    marginLeft: -1,
    bottom: 0,
    width: 2,
    height: 24,
    borderRadius: 1,
    backgroundColor: colors.teal,
  },
});
