import { useCallback, useEffect, useRef, useState } from "react";
import {
  clampSettings,
  DEFAULT_CAPTURE_SETTINGS,
  readoutChanged,
  settingsFromEffective,
  type CaptureCapabilities,
  type CaptureSettings,
  type EffectiveCaptureSettings,
  type MeterReading,
} from "../capture/model";
import {
  captureModeOf,
  chromeHolding,
  DEFAULT_CAPTURE_CHROME,
  displayIn,
  holdsExposure,
  nextDisplay,
  rememberedFor,
  rememberedMode,
  turnDial,
  withBrightnessCarried,
  type CaptureChrome,
  type CaptureDisplay,
  type CaptureMode,
} from "../capture/mode";
import {
  applyCaptureSettings,
  captureCapabilities,
  isCameraViewNotReady,
} from "../capture/apply";
import { loadCapture, saveCapture } from "../capture/store";
import { loadCaptureChrome, saveCaptureChrome } from "./captureChrome";
import { debounce, throttle, useDeferred } from "../timing";
import { captureControls as copy } from "../ui/copy";

// Capture settings, mode dial, meter and DISP. Only `src/capture/apply.ts` talks to native; the
// effective (device-clamped) settings it returns are what is shown and stored.

/** At most one native apply per this interval while dragging. */
const APPLY_THROTTLE_MS = 60;
/** Persist this long after the last change. */
const SAVE_DEBOUNCE_MS = 400;
const APPLY_ATTEMPTS = 8;
const APPLY_RETRY_MS = 150;

interface CaptureControlsInForce {
  applying: boolean;
  applyError: string;
  /** Null until `captureCapabilities()` resolves. */
  caps: CaptureCapabilities | null;
  /** What native reports it applied, not what was requested. */
  settings: CaptureSettings;
  /** Last reading worth a re-render; null until the first meter event. Display only. */
  meter: MeterReading | null;
  /** Derived from the held settings, never stored. */
  mode: CaptureMode;
  /** False without manual sensor control; the dial then has no M. */
  canHoldExposure: boolean;
  display: CaptureDisplay;
  /** On AUTO, the mode whose settings are parked for its return. */
  remembered: CaptureMode | null;
  onMeter(reading: MeterReading): void;
  change(next: CaptureSettings): void;
  /** Full reset to auto, discarding parked settings. */
  auto(): void;
  /** False if the mode didn't change (already there, or M has no reading to hold yet). */
  chooseMode(next: CaptureMode): boolean;
  cycleDisplay(): void;
}

export function useCaptureControls({
  live,
  generation,
}: {
  live: boolean;
  generation: number;
}): CaptureControlsInForce {
  const [caps, setCaps] = useState<CaptureCapabilities | null>(null);
  const [settings, setSettings] = useState<CaptureSettings>(DEFAULT_CAPTURE_SETTINGS);
  const [meter, setMeter] = useState<MeterReading | null>(null);
  const [chrome, setChrome] = useState<CaptureChrome>(DEFAULT_CAPTURE_CHROME);
  const [restored, setRestored] = useState(false);
  // Only write after a successful read; otherwise a failed restore would overwrite saved
  // settings with defaults.
  const storeRead = useRef(false);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState("");
  const revision = useRef(0);

  /** Lets the re-apply effect read current settings without depending on them. */
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const mode = captureModeOf(settings, chrome.readout);
  const display = displayIn(chrome.display, mode);
  const histogramRef = useRef(false);
  histogramRef.current = display === "histogram";
  const modeRef = useRef(mode);
  modeRef.current = mode;
  /** Every reading, rendered or not: M holds the last metered exposure. */
  const latestReading = useRef<MeterReading | null>(null);
  /** P/M settings parked on switching to AUTO, restored on return. Persisted. */
  const [parked, setParked] = useState<CaptureSettings | null>(null);
  /** EV parked by M (no meter to steer), returned to P. Persisted. */
  const [brightnessAside, setBrightnessAside] = useState<number | null>(null);

  const applySoon = useDeferred(() => throttle(APPLY_THROTTLE_MS));
  const saveSoon = useDeferred(() => debounce(SAVE_DEBOUNCE_MS));

  // Native returns "auto" for automatic controls and both held values for manual exposure.
  // Meter readings never enter saved settings.
  const adopt = useCallback(
    (effective: EffectiveCaptureSettings) => {
      setSettings(settingsFromEffective(effective));
      setApplying(false);
      setApplyError("");
    },
    [],
  );

  // Clamp restored settings to the device; unsupported values fall back to auto instead of
  // being rejected by native.
  useEffect(() => {
    let alive = true;
    Promise.all([captureCapabilities(), loadCapture(), loadCaptureChrome()])
      .then(([device, stored, storedChrome]) => {
        if (!alive) return;
        // There is no AE lock control in the UI, so never restore one.
        const unlocked = { ...clampSettings(stored.settings, device), aeLock: false };
        // Force the readout on if a held value would otherwise be hidden.
        const kept = chromeHolding(storedChrome, unlocked);
        // AUTO can't show a held EV, so drop it.
        const held = kept.readout ? unlocked : { ...unlocked, ev: 0 };
        const remembered = rememberedFor(
          held,
          kept.readout,
          stored.parked === null ? null : clampSettings(stored.parked, device),
          stored.aside,
        );
        storeRead.current = true;
        setCaps(device);
        setSettings(held);
        setParked(remembered.parked);
        setBrightnessAside(remembered.aside);
        setChrome(kept);
        if (kept !== storedChrome) saveCaptureChrome(kept).catch(() => {});
        setRestored(true);
      })
      .catch(() => {
        if (alive) setRestored(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  // Applies one revision. On cold start the view may not be ready, so that refusal is retried;
  // a newer revision supersedes the retries.
  const applyFor = useCallback(
    (wanted: CaptureSettings, requestRevision: number, left = APPLY_ATTEMPTS) => {
      if (requestRevision !== revision.current) return;
      applyCaptureSettings(wanted)
        .then((effective) => {
          if (requestRevision === revision.current) adopt(effective);
        })
        .catch((cause) => {
          if (requestRevision !== revision.current) return;
          if (isCameraViewNotReady(cause) && left > 1) {
            setTimeout(() => applyFor(wanted, requestRevision, left - 1), APPLY_RETRY_MS);
            return;
          }
          if (__DEV__) console.warn("Camera settings failed to apply", cause);
          setApplying(false);
          setApplyError(copy.applyError);
        });
    },
    [adopt],
  );

  // Re-apply whenever a camera view appears: a fresh view starts on its own defaults.
  useEffect(() => {
    if (!restored || !live) return;
    setApplying(true);
    setApplyError("");
    applyFor(settingsRef.current, ++revision.current);
    return () => {
      revision.current++;
      applySoon.cancel();
    };
  }, [restored, live, generation, applyFor, applySoon]);

  // Readings belong to one view; clear them so a new view shows AUTO rather than stale numbers.
  useEffect(
    () => () => {
      latestReading.current = null;
      setMeter(null);
    },
    [live, generation],
  );

  useEffect(() => {
    if (!restored || !storeRead.current || applying || applyError) {
      saveSoon.cancel();
      return;
    }
    saveSoon.run(() => {
      void saveCapture({ settings, parked, aside: brightnessAside }).catch(() => {});
    });
  }, [settings, parked, brightnessAside, restored, applying, applyError, saveSoon]);

  /** Clamped locally so the readout tracks the thumb, then applied (throttled). */
  const change = (next: CaptureSettings) => {
    if (caps === null || !live) return;
    const requestRevision = ++revision.current;
    setApplying(true);
    setApplyError("");
    const carried = withBrightnessCarried(settings, clampSettings(next, caps), brightnessAside);
    setBrightnessAside(carried.aside);
    const wanted = carried.settings;
    setSettings(wanted);
    // Each apply restarts the repeating request; throttled, with the last value guaranteed to land.
    applySoon.run(() => applyFor(wanted, requestRevision));
  };

  const auto = () => {
    if (!live) return;
    const requestRevision = ++revision.current;
    setApplying(true);
    setApplyError("");
    applySoon.cancel();
    setBrightnessAside(null);
    setParked(null);
    if (chrome.readout) keepChrome({ ...chrome, readout: false });
    setSettings(DEFAULT_CAPTURE_SETTINGS);
    applyFor(DEFAULT_CAPTURE_SETTINGS, requestRevision);
  };

  const canHoldExposure = caps !== null && holdsExposure(caps);

  const keepChrome = (next: CaptureChrome) => {
    setChrome(next);
    if (storeRead.current) saveCaptureChrome(next).catch(() => {});
  };

  // AUTO parks what it can't show; P and M restore it. `turnDial` returns the same settings
  // object when nothing changed, in which case no apply is sent.
  const chooseMode = (next: CaptureMode): boolean => {
    if (caps === null || !live) return false;
    if (next === "manual" && !canHoldExposure) return false;
    const turned = turnDial({ settings, readout: chrome.readout, parked }, next, latestReading.current, caps);
    if (turned === null) return false;
    setParked(turned.parked);
    if (turned.readout !== chrome.readout) keepChrome({ ...chrome, readout: turned.readout });
    if (turned.settings !== settings) change(turned.settings);
    return true;
  };

  /** Ignored until the stored display has loaded. */
  const cycleDisplay = () => {
    if (restored) keepChrome({ ...chrome, display: nextDisplay(chrome.display, mode) });
  };

  // Native sends up to 10 readings/s. Without the histogram, drop readings that change nothing
  // visible (in AUTO, only EV is shown).
  const onMeter = useCallback((reading: MeterReading) => {
    latestReading.current = reading;
    setMeter((now) => {
      if (histogramRef.current) return reading;
      if (modeRef.current === "auto") return now === null || now.ev !== reading.ev ? reading : now;
      return readoutChanged(now, reading) ? reading : now;
    });
  }, []);

  return {
    applying,
    applyError,
    caps,
    settings,
    meter,
    mode,
    canHoldExposure,
    display,
    remembered: mode === "auto" ? rememberedMode(parked) : null,
    onMeter,
    change,
    auto,
    chooseMode,
    cycleDisplay,
  };
}
