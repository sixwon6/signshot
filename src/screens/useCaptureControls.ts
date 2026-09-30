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

/**
 * The camera's capture settings, mode dial, meter and display. Only `src/capture/apply.ts` talks
 * to native; the effective settings it returns (clamped to the device) are what is shown and stored.
 */

/** A moved control reaches the camera within this; a drag cannot ask for more than one per. */
const APPLY_THROTTLE_MS = 60;
/** ...and is written to the store this long after the thumb rests. */
const SAVE_DEBOUNCE_MS = 400;
const APPLY_ATTEMPTS = 8;
const APPLY_RETRY_MS = 150;

interface CaptureControlsInForce {
  applying: boolean;
  applyError: string;
  /** What this camera can do. Null until `captureCapabilities()` has answered. */
  caps: CaptureCapabilities | null;
  /** The controls in force: what native said it applied, never what was asked for. */
  settings: CaptureSettings;
  /** The last reading worth redrawing for, or null until this camera has metered. Chrome only. */
  meter: MeterReading | null;
  /** Where the dial sits: derived from what is held, never stored beside it. */
  mode: CaptureMode;
  /** False on a camera with no manual sensor: the dial has no M. */
  canHoldExposure: boolean;
  /** What DISP shows over the picture in this mode. */
  display: CaptureDisplay;
  /** On AUTO, the position whose settings were set aside and come back with a turn to it. */
  remembered: CaptureMode | null;
  onMeter(reading: MeterReading): void;
  change(next: CaptureSettings): void;
  /** One action, and the camera is choosing everything again, with nothing set aside for later. */
  auto(): void;
  /** False when the dial did not turn: it was already there, or M has nothing to hold yet. */
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
  /** True once the store has been read: nothing is written back before that. */
  const [restored, setRestored] = useState(false);
  /**
   * Both stores are only written over records that were read. A restore that failed leaves the
   * camera on its defaults, and saving those would replace what the photographer had.
   */
  const storeRead = useRef(false);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState("");
  const revision = useRef(0);

  /** The settings in force, read by the effect that re-applies them without depending on them. */
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const mode = captureModeOf(settings, chrome.readout);
  const display = displayIn(chrome.display, mode);
  /** The histogram is drawn from every reading; the strip only from one that says something new. */
  const histogramRef = useRef(false);
  histogramRef.current = display === "histogram";
  /** AUTO shows brightness alone, so only a reading that moves it is worth a render there. */
  const modeRef = useRef(mode);
  modeRef.current = mode;
  /** Every reading, drawn or not: M holds the exposure the camera metered last. */
  const latestReading = useRef<MeterReading | null>(null);
  /**
   * What P and M held when the dial went to AUTO, restored when the dial turns back. The dial marks
   * the position it belongs to, and it is stored so it survives a restart.
   */
  const [parked, setParked] = useState<CaptureSettings | null>(null);
  /** The brightness M set aside: it has no meter to steer, and P gets it back. Stored with it. */
  const [brightnessAside, setBrightnessAside] = useState<number | null>(null);

  const applySoon = useDeferred(() => throttle(APPLY_THROTTLE_MS));
  const saveSoon = useDeferred(() => debounce(SAVE_DEBOUNCE_MS));

  /**
   * Native returns "auto" for automatic controls and both held values for manual exposure.
   * Meter events are separate and never enter saved settings.
   */
  const adopt = useCallback(
    (effective: EffectiveCaptureSettings) => {
      setSettings(settingsFromEffective(effective));
      setApplying(false);
      setApplyError("");
    },
    [],
  );

  // Restore stored settings through the device's ranges: anything this camera cannot honour
  // drops to auto (`clampSettings`) instead of being refused by native.
  useEffect(() => {
    let alive = true;
    Promise.all([captureCapabilities(), loadCapture(), loadCaptureChrome()])
      .then(([device, stored, storedChrome]) => {
        if (!alive) return;
        // AE lock has no key (M holds the metered exposure instead), so a stored one is released
        // rather than left in force with nothing on screen to release it.
        const unlocked = { ...clampSettings(stored.settings, device), aeLock: false };
        // A held value the stored chrome would hide puts the readout up, and keeps it up.
        const kept = chromeHolding(storedChrome, unlocked);
        // AUTO has no cell to show a held brightness, so one stored under it is not brought back
        // either: the camera opens on its own metering, as a phone camera does.
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

  /**
   * One request, for one revision. The view is not up yet on a cold start, so a refusal that says
   * so is retried, as the recipe apply does; whoever asks next takes the revision, and with it the
   * retrying.
   */
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

  // The settings reach the camera once there is one: on the first frame, and again after a
  // restart or a return from another screen, because a fresh view starts on its own defaults.
  useEffect(() => {
    if (!restored || !live) return;
    setApplying(true);
    setApplyError("");
    applyFor(settingsRef.current, ++revision.current);
    return () => {
      // Whatever is waiting belongs to a camera that is gone.
      revision.current++;
      applySoon.cancel();
    };
  }, [restored, live, generation, applyFor, applySoon]);

  // A reading belongs to the camera that metered it. A new view, or none, starts without one: the
  // strip reads AUTO rather than the last scene's numbers, and M waits for something to hold.
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

  /** One control moved: clamped here so the strip changes with the thumb, then applied. */
  const change = (next: CaptureSettings) => {
    if (caps === null || !live) return;
    const requestRevision = ++revision.current;
    setApplying(true);
    setApplyError("");
    const carried = withBrightnessCarried(settings, clampSettings(next, caps), brightnessAside);
    setBrightnessAside(carried.aside);
    const wanted = carried.settings;
    setSettings(wanted);
    // Each apply restarts the repeating request, so native gets the latest value at most once
    // every APPLY_THROTTLE_MS and the last one always lands.
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
    // It is asked for from the AUTO position, and that is where it leaves the dial.
    if (chrome.readout) keepChrome({ ...chrome, readout: false });
    setSettings(DEFAULT_CAPTURE_SETTINGS);
    applyFor(DEFAULT_CAPTURE_SETTINGS, requestRevision);
  };

  const canHoldExposure = caps !== null && holdsExposure(caps);

  const keepChrome = (next: CaptureChrome) => {
    setChrome(next);
    if (storeRead.current) saveCaptureChrome(next).catch(() => {});
  };

  /**
   * The dial turned; `turnDial` says to what. AUTO releases what it cannot show and remembers it,
   * P and M bring it back. `turned.settings` is this render's own object when the camera has
   * nothing new to be told, and then its request is left running.
   */
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

  /** Nothing is shown over the picture before the store has said what was. */
  const cycleDisplay = () => {
    if (restored) keepChrome({ ...chrome, display: nextDisplay(chrome.display, mode) });
  };

  /**
   * Native sends up to ten readings a second. With the histogram hidden, a reading that changes
   * nothing on the strip is dropped, so a still scene re-renders nothing.
   */
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
