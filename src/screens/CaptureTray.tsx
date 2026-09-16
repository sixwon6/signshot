/**
 * The tray that opens under the readout strip, over the picture, for ONE control. Two faces:
 *
 * Simple: a handful of big choices with visible effect, the way a phone camera offers them.
 * Light in whole stops, Colour as the lights people stand in, Focus as Auto / Near / Far.
 *
 * Pro: a ruler with detents, the way a camera dial works. ISO in third stops, shutter in full
 * stops, Light in the device's own steps, Kelvin by the hundred, focus in fine positions, with
 * the locks and the histogram beside the control they belong to.
 *
 * Presentational: state lives in `useCaptureControls`, and every value shown is what native
 * said it applied.
 */
import React, { useEffect, useRef, useState } from "react";
import {
  Animated,
  Easing,
  Pressable,
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
  formatWhiteBalance,
  type CaptureCapabilities,
  type CaptureSettings,
  type MeterReading,
} from "../capture/model";
import { colors, radius, space } from "../ui/theme";
import { typeScale as type } from "../ui/type";
import { fonts } from "../ui/fonts";
import { Chip, Pill } from "../ui/primitives";
import { captureControls as copy } from "../ui/copy";
import { LIGHT_LABEL, NAME, isoSteps, shutterSteps, type ControlKey } from "./CaptureControls";

// ---------------------------------------------------------------------------------------------
// The ruler

const TICK = 14;
const MAJOR_EVERY_DEFAULT = 3;

interface RulerProps {
  /** How many detents, and which is in force. */
  count: number;
  index: number;
  /** The label under a major tick, or null for a minor one. */
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
                <Text style={s.tickLabel} numberOfLines={1}>
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
// The tray

interface CaptureTrayProps {
  pro: boolean;
  control: ControlKey;
  caps: CaptureCapabilities;
  settings: CaptureSettings;
  manualExposure: boolean;
  meter: MeterReading | null;
  histogram: boolean;
  busy?: boolean;
  onChange: (settings: CaptureSettings) => void;
  onAuto: () => void;
  onHistogram: () => void;
  /** Focus handed back to the camera: a tapped subject is released along with a held lens. */
  onReleaseFocus?: () => void;
  onClose: () => void;
}

/** Simple offers the five everyday lights; Pro offers every mode the camera lists. */
const SIMPLE_LIGHT_MODES: readonly string[] = ["daylight", "cloudy-daylight", "shade", "incandescent", "fluorescent"];

const nearestIndex = (ladder: readonly number[], want: number): number => {
  let best = 0;
  for (let i = 1; i < ladder.length; i++)
    if (Math.abs(ladder[i] - want) < Math.abs(ladder[best] - want)) best = i;
  return best;
};

/**
 * Simple's brightness choices: whole stops that fit the device's range, -2 to +2. A camera whose
 * range is narrower than a stop either way falls back to half stops, so there are always choices.
 */
function simpleEvChoices(caps: CaptureCapabilities): { steps: number; label: string }[] {
  const range = caps.ev === UNAVAILABLE ? null : caps.ev;
  if (!range || range.step <= 0) return [];
  const build = (stop: number) => {
    const out: { steps: number; label: string }[] = [];
    for (let ev = -2; ev <= 2 + 1e-9; ev += stop) {
      const steps = Math.round(ev / range.step);
      if (steps < range.min || steps > range.max) continue;
      const shown = Math.round(ev * 10) / 10;
      out.push({ steps, label: shown === 0 ? "0" : `${shown > 0 ? "+" : "-"}${Math.abs(shown) % 1 === 0 ? Math.abs(shown) : Math.abs(shown).toFixed(1)}` });
    }
    return out;
  };
  const whole = build(1);
  return whole.length >= 3 ? whole : build(0.5);
}

export function CaptureTray({
  pro,
  control,
  caps,
  settings,
  manualExposure,
  meter,
  histogram,
  busy = false,
  onChange,
  onAuto,
  onHistogram,
  onReleaseFocus,
  onClose,
}: CaptureTrayProps) {
  const focusAuto = () => {
    onReleaseFocus?.();
    set({ focus: "auto" });
  };
  const resetAll = () => {
    onReleaseFocus?.();
    onAuto();
  };
  // A short drop into place; the readout it hangs from does not move.
  const entrance = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    entrance.setValue(0);
    Animated.timing(entrance, { toValue: 1, duration: 180, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
  }, [control, entrance]);

  const set = (patch: Partial<CaptureSettings>) => onChange({ ...settings, ...patch });
  const ev = caps.ev === UNAVAILABLE ? null : caps.ev;
  const kelvin = caps.manualPostProcessing && caps.kelvin !== UNAVAILABLE ? caps.kelvin : null;
  const lens = caps.focus === UNAVAILABLE ? null : caps.focus;
  const heldKelvin = typeof settings.whiteBalance === "object" ? settings.whiteBalance.kelvin : null;

  let value: string;
  let pinned: boolean;
  let body: React.ReactNode;

  switch (control) {
    case "iso": {
      const isos = isoSteps(caps);
      const index = nearestIndex(isos, settings.iso === "auto" ? (meter?.iso ?? isos[0]) : settings.iso);
      // The tray is headed ISO already, so the formatter's word is dropped: a number, never a digit.
      const plain = (iso: CaptureSettings["iso"]) => formatIso(iso).replace(/^ISO /, "");
      value = settings.iso === "auto" ? `${AUTO_LABEL} · ${plain(meter?.iso ?? "auto")}` : plain(settings.iso);
      pinned = settings.iso !== "auto";
      body = (
        <>
          <Ruler
            count={isos.length}
            index={index}
            labelAt={(i) => (i % MAJOR_EVERY_DEFAULT === 0 ? String(isos[i]) : null)}
            disabled={busy || isos.length === 0}
            accessibilityLabel={copy.readingOf(NAME.iso, formatIso(settings.iso))}
            onIndex={(i) => set({ iso: isos[i] })}
            testID="capture-ruler-iso"
          />
          <View style={s.chips}>
            <Chip size="small" label={copy.autoExposure} selected={!manualExposure} disabled={busy}
              onPress={() => set({ iso: "auto", shutterNs: "auto" })} testID="capture-auto-iso" />
            {caps.aeLock && (
              <Chip size="small" label={copy.aeLock} selected={settings.aeLock} disabled={busy || manualExposure}
                onPress={() => set({ aeLock: !settings.aeLock })} testID="capture-ae-lock" />
            )}
          </View>
          {manualExposure && <Text style={[type.imprint, s.hint]}>{copy.manualHint}</Text>}
        </>
      );
      break;
    }
    case "shutter": {
      const shutters = shutterSteps(caps);
      const index = nearestIndex(shutters, settings.shutterNs === "auto" ? (meter?.shutterNs ?? shutters[0]) : settings.shutterNs);
      value = settings.shutterNs === "auto"
        ? `${AUTO_LABEL} · ${formatShutter(meter?.shutterNs ?? "auto")}`
        : formatShutter(settings.shutterNs);
      pinned = settings.shutterNs !== "auto";
      body = (
        <>
          <Ruler
            count={shutters.length}
            index={index}
            labelAt={(i) => (i % 2 === 0 ? formatShutter(shutters[i]) : null)}
            disabled={busy || shutters.length === 0}
            accessibilityLabel={copy.readingOf(NAME.shutter, formatShutter(settings.shutterNs))}
            onIndex={(i) => set({ shutterNs: shutters[i] })}
            testID="capture-ruler-shutter"
          />
          <View style={s.chips}>
            <Chip size="small" label={copy.autoExposure} selected={!manualExposure} disabled={busy}
              onPress={() => set({ iso: "auto", shutterNs: "auto" })} testID="capture-auto-shutter" />
            {caps.aeLock && (
              <Chip size="small" label={copy.aeLock} selected={settings.aeLock} disabled={busy || manualExposure}
                onPress={() => set({ aeLock: !settings.aeLock })} testID="capture-ae-lock" />
            )}
          </View>
          {manualExposure && <Text style={[type.imprint, s.hint]}>{copy.manualHint}</Text>}
        </>
      );
      break;
    }
    case "ev": {
      value = formatEv(settings.ev, caps);
      pinned = settings.ev !== 0;
      if (ev === null) { body = null; break; }
      if (!pro) {
        const choices = simpleEvChoices(caps);
        const current = nearestIndex(choices.map((c) => c.steps), settings.ev);
        body = (
          <View style={s.choices}>
            {choices.map((choice, i) => (
              <Chip
                key={choice.steps}
                label={choice.label}
                selected={i === current}
                disabled={busy || manualExposure}
                onPress={() => set({ ev: choice.steps })}
                accessibilityLabel={copy.readingOf(NAME.ev, choice.label)}
                testID={`capture-ev-${choice.label}`}
              />
            ))}
          </View>
        );
        break;
      }
      const count = ev.max - ev.min + 1;
      const perStop = Math.max(1, Math.round(1 / ev.step));
      body = (
        <>
          <View style={manualExposure ? s.quiet : undefined}>
            <Ruler
              count={count}
              index={settings.ev - ev.min}
              labelAt={(i) => ((i + ev.min) % perStop === 0 ? formatEv(i + ev.min, caps) : null)}
              disabled={busy || manualExposure}
              accessibilityLabel={copy.readingOf(NAME.ev, formatEv(settings.ev, caps))}
              onIndex={(i) => set({ ev: i + ev.min })}
              testID="capture-ruler-ev"
            />
          </View>
          {manualExposure && <Text style={[type.imprint, s.hint]}>{copy.evManualHint}</Text>}
          <View style={s.chips}>
            <Chip size="small" label={copy.zero} selected={settings.ev === 0} disabled={busy || manualExposure}
              onPress={() => set({ ev: 0 })} testID="capture-ev-zero" />
            <Chip size="small" label={copy.histogram} selected={histogram} disabled={busy}
              onPress={onHistogram} accessibilityLabel={copy.readingOf(copy.histogram, histogram ? copy.on : copy.off)}
              testID="capture-histogram-toggle" />
          </View>
        </>
      );
      break;
    }
    case "whiteBalance": {
      value = settings.whiteBalance === "auto" ? AUTO_LABEL
        : typeof settings.whiteBalance === "string"
          ? (LIGHT_LABEL[settings.whiteBalance] ?? settings.whiteBalance).toUpperCase()
          : formatWhiteBalance(settings.whiteBalance);
      pinned = settings.whiteBalance !== "auto";
      const presets = caps.awbModes
        .filter((mode) => mode !== "auto" && mode !== "off" && (pro || SIMPLE_LIGHT_MODES.includes(mode)))
        .map((mode) => ({ mode, label: LIGHT_LABEL[mode] ?? mode }));
      body = (
        <>
          <View style={s.choices}>
            <Chip label={copy.auto} selected={settings.whiteBalance === "auto"} disabled={busy}
              onPress={() => set({ whiteBalance: "auto" })} testID="capture-auto-whiteBalance" />
            {presets.map((p) => (
              <Chip key={p.mode} label={p.label} selected={settings.whiteBalance === p.mode} disabled={busy}
                onPress={() => set({ whiteBalance: p.mode })} testID={`capture-wb-${p.mode}`} />
            ))}
          </View>
          {pro && kelvin !== null && (() => {
            const count = Math.floor((kelvin.max - kelvin.min) / 100) + 1;
            const index = heldKelvin === null ? Math.round((6500 - kelvin.min) / 100) : Math.round((heldKelvin - kelvin.min) / 100);
            return (
              <>
                <Ruler
                  count={count}
                  index={Math.max(0, Math.min(count - 1, index))}
                  labelAt={(i) => ((kelvin.min + i * 100) % 1000 === 0 ? `${(kelvin.min + i * 100) / 1000}K` : null)}
                  disabled={busy}
                  accessibilityLabel={copy.readingOf(copy.kelvin, heldKelvin === null ? AUTO_LABEL : formatKelvin(heldKelvin))}
                  onIndex={(i) => set({ whiteBalance: { kelvin: kelvin.min + i * 100 } })}
                  testID="capture-ruler-kelvin"
                />
                <View style={s.chips}>
                  {caps.awbLock && (
                    <Chip size="small" label={copy.awbLock} selected={settings.awbLock} disabled={busy || heldKelvin !== null}
                      onPress={() => set({ awbLock: !settings.awbLock })} testID="capture-awb-lock" />
                  )}
                </View>
              </>
            );
          })()}
        </>
      );
      break;
    }
    case "focus": {
      value = formatFocus(settings.focus, caps);
      pinned = settings.focus !== "auto";
      if (lens === null) { body = null; break; }
      const span = lens.maxDiopters - lens.minDiopters;
      if (!pro) {
        const at = settings.focus === "auto" ? null : clampFocus(settings.focus, caps);
        const near = at !== null && at > lens.minDiopters + span / 2;
        body = (
          <View style={s.choices}>
            <Chip label={copy.auto} selected={settings.focus === "auto"} disabled={busy}
              onPress={focusAuto} testID="capture-auto-focus" />
            <Chip label={copy.near} selected={at !== null && near} disabled={busy || span <= 0}
              onPress={() => set({ focus: lens.maxDiopters })} testID="capture-focus-near" />
            <Chip label={copy.far} selected={at !== null && !near} disabled={busy || span <= 0}
              onPress={() => set({ focus: lens.minDiopters })} testID="capture-focus-far" />
          </View>
        );
        break;
      }
      const count = 51;
      const at = settings.focus === "auto" ? lens.minDiopters : clampFocus(settings.focus, caps);
      const index = span > 0 ? Math.round(((at - lens.minDiopters) / span) * (count - 1)) : 0;
      body = (
        <>
          <Ruler
            count={count}
            index={index}
            labelAt={(i) => (i % 10 === 0 ? `${i * 2}%` : null)}
            disabled={busy || span <= 0}
            accessibilityLabel={copy.readingOf(NAME.focus, formatFocus(settings.focus, caps))}
            onIndex={(i) => set({ focus: lens.minDiopters + (i / (count - 1)) * span })}
            testID="capture-ruler-focus"
          />
          <View style={s.chips}>
            <Chip size="small" label={copy.auto} selected={settings.focus === "auto"} disabled={busy}
              onPress={focusAuto} testID="capture-auto-focus" />
          </View>
        </>
      );
      break;
    }
  }

  return (
    <Animated.View
      style={[
        s.tray,
        {
          opacity: entrance,
          transform: [{ translateY: entrance.interpolate({ inputRange: [0, 1], outputRange: [-8, 0] }) }],
        },
      ]}
      testID="capture-tray"
    >
      <View style={s.head}>
        <Text style={[type.label, s.name]}>{NAME[control]}</Text>
        <Text style={[type.readout, pinned ? s.valuePinned : s.valueAuto]} testID={`capture-value-${control}`}>
          {value}
        </Text>
        <View style={s.grow} />
        {pro && (
          <Pill label={copy.reset} size="small" variant="secondary" disabled={busy} onPress={resetAll} testID="capture-auto" />
        )}
        <Pressable accessibilityRole="button" accessibilityLabel={copy.close} onPress={onClose} style={s.closeHit}>
          <Text style={[type.label, s.closeMark]}>×</Text>
        </Pressable>
      </View>
      {!pro && <Text style={[type.imprint, s.hint]}>{copy.help[control]}</Text>}
      {body}
    </Animated.View>
  );
}

const s = StyleSheet.create({
  tray: {
    gap: space.sm,
    padding: space.sm,
    paddingBottom: space.md,
    borderRadius: radius.small,
    backgroundColor: "rgba(11, 12, 14, 0.82)",
  },
  head: { flexDirection: "row", alignItems: "center", gap: space.sm },
  name: { color: colors.ink },
  valueAuto: { color: colors.muted },
  valuePinned: { color: colors.tealText },
  grow: { flexGrow: 1 },
  closeHit: { paddingHorizontal: space.sm, paddingVertical: space.xs },
  closeMark: { color: colors.muted, fontSize: 16 },
  hint: { color: colors.muted, textTransform: "none", letterSpacing: 0 },
  choices: { flexDirection: "row", flexWrap: "wrap", gap: space.xs },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: space.xs },
  quiet: { opacity: 0.35 },
  ruler: { height: 52, justifyContent: "flex-end" },
  tickCell: { width: TICK, alignItems: "center", justifyContent: "flex-end", height: 52 },
  tick: { width: 1, height: 10, backgroundColor: "rgba(245,244,240,0.35)" },
  tickMajor: { height: 18, backgroundColor: "rgba(245,244,240,0.7)" },
  tickActive: { backgroundColor: colors.teal },
  tickLabel: {
    position: "absolute",
    top: 0,
    fontFamily: fonts.mono,
    fontSize: 9,
    letterSpacing: 0.5,
    color: colors.muted,
    width: TICK * 4,
    textAlign: "center",
  },
  mark: {
    position: "absolute",
    left: "50%",
    marginLeft: -1,
    bottom: 0,
    width: 2,
    height: 26,
    borderRadius: 1,
    backgroundColor: colors.teal,
  },
});
