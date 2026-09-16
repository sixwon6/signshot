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
  applyCaptureSettings,
  captureCapabilities,
  isCameraViewNotReady,
} from "../capture/apply";
import { loadCaptureSettings, saveCaptureSettings } from "../capture/store";
import { loadHistogramShown, saveHistogramShown } from "./captureChrome";
import { debounce, throttle, useDeferred } from "../timing";
import { captureControls as copy } from "../ui/copy";

/**
 * The camera's capture settings, meter and histogram. Only `src/capture/apply.ts` talks to native;
 * the effective settings it returns (clamped to the device) are what is shown and stored.
 */

/** A moved control reaches the camera within this; a drag cannot ask for more than one per. */
const APPLY_THROTTLE_MS = 60;
/** ...and is written back this long after the thumb rests, like the strength dial beside it. */
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
  /** AE is off and both ISO and shutter are being held. */
  manualExposure: boolean;
  /** The last reading worth redrawing for. Chrome only. */
  meter: MeterReading | null;
  histogram: boolean;
  onMeter(reading: MeterReading): void;
  change(next: CaptureSettings): void;
  /** One action, and the camera is choosing everything again. */
  auto(): void;
  toggleHistogram(): void;
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
  const [manualExposure, setManualExposure] = useState(false);
  const [meter, setMeter] = useState<MeterReading | null>(null);
  const [histogram, setHistogram] = useState(false);
  /** True once the store has been read: nothing is written back before that. */
  const [restored, setRestored] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState("");
  const revision = useRef(0);

  /** The settings in force, read by the effect that re-applies them without depending on them. */
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  /** The histogram is drawn from every reading; the strip only from one that says something new. */
  const histogramRef = useRef(histogram);
  histogramRef.current = histogram;

  const applySoon = useDeferred(() => throttle(APPLY_THROTTLE_MS));
  const saveSoon = useDeferred(() => debounce(SAVE_DEBOUNCE_MS));

  /**
   * Native returns "auto" for automatic controls and both held values for manual exposure.
   * Meter events are separate and never enter saved settings.
   */
  const adopt = useCallback(
    (effective: EffectiveCaptureSettings) => {
      setSettings(settingsFromEffective(effective));
      setManualExposure(effective.manualExposure);
      setApplying(false);
      setApplyError("");
    },
    [],
  );

  // Restore stored settings through the device's ranges: anything this camera cannot honour
  // drops to auto (`clampSettings`) instead of being refused by native.
  useEffect(() => {
    let alive = true;
    Promise.all([captureCapabilities(), loadCaptureSettings(), loadHistogramShown()])
      .then(([device, stored, shown]) => {
        if (!alive) return;
        setCaps(device);
        setSettings(clampSettings(stored, device));
        setHistogram(shown);
        setRestored(true);
      })
      .catch(() => {
        if (alive) setRestored(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  // The settings reach the camera once there is one: on the first frame, and again after a
  // restart or a return from another screen, because a fresh view starts on its own defaults.
  useEffect(() => {
    if (!restored || !live) return;
    let cancelled = false;
    let attempts = 0;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const requestRevision = ++revision.current;
    setApplying(true);
    setApplyError("");
    const run = () => {
      if (cancelled || requestRevision !== revision.current) return;
      attempts++;
      const requested = settingsRef.current;
      applyCaptureSettings(requested)
        .then((effective) => {
          if (!cancelled && requestRevision === revision.current) adopt(effective);
        })
        .catch((cause) => {
          if (cancelled || requestRevision !== revision.current) return;
          // The view is not up yet on a cold start; the recipe apply waits the same way.
          if (!cancelled && isCameraViewNotReady(cause) && attempts < APPLY_ATTEMPTS) {
            retry = setTimeout(run, APPLY_RETRY_MS);
            return;
          }
          if (__DEV__) console.warn("Camera settings failed to apply", cause);
          setApplying(false);
          setApplyError(copy.applyError);
        });
    };
    run();
    return () => {
      cancelled = true;
      revision.current++;
      applySoon.cancel();
      if (retry) clearTimeout(retry);
    };
  }, [restored, live, generation, adopt, applySoon]);

  useEffect(() => {
    if (!restored || applying || applyError) {
      saveSoon.cancel();
      return;
    }
    saveSoon.run(() => {
      void saveCaptureSettings(settings).catch(() => {});
    });
  }, [settings, restored, applying, applyError, saveSoon]);

  /** One control moved: clamped here so the strip changes with the thumb, then applied. */
  const change = (next: CaptureSettings) => {
    if (caps === null || !live) return;
    const requestRevision = ++revision.current;
    setApplying(true);
    setApplyError("");
    const wanted = clampSettings(next, caps);
    setSettings(wanted);
    setManualExposure(
      caps.manualSensor && (wanted.iso !== "auto" || wanted.shutterNs !== "auto"),
    );
    // Each apply restarts the repeating request, so native gets the latest value at most once
    // every APPLY_THROTTLE_MS and the last one always lands.
    applySoon.run(() => {
      applyCaptureSettings(wanted)
        .then((effective) => {
          if (requestRevision === revision.current) adopt(effective);
        })
        .catch((cause) => {
          if (requestRevision !== revision.current) return;
          setApplying(false);
          setApplyError(copy.applyError);
          if (__DEV__) console.warn("Camera settings failed to apply", cause);
        });
    });
  };

  const auto = () => {
    if (!live) return;
    const requestRevision = ++revision.current;
    setApplying(true);
    setApplyError("");
    applySoon.cancel();
    setSettings(DEFAULT_CAPTURE_SETTINGS);
    setManualExposure(false);
    applyCaptureSettings(DEFAULT_CAPTURE_SETTINGS)
      .then((effective) => {
        if (requestRevision === revision.current) adopt(effective);
      })
      .catch((cause) => {
        if (requestRevision !== revision.current) return;
        setApplying(false);
        setApplyError(copy.applyError);
        if (__DEV__) console.warn("Camera settings failed to apply", cause);
      });
  };

  const toggleHistogram = () => {
    const next = !histogram;
    setHistogram(next);
    saveHistogramShown(next).catch(() => {});
  };

  /**
   * Native sends up to ten readings a second. With the histogram hidden, a reading that changes
   * nothing on the strip is dropped, so a still scene re-renders nothing.
   */
  const onMeter = useCallback((reading: MeterReading) => {
    setMeter((now) =>
      histogramRef.current || readoutChanged(now, reading) ? reading : now,
    );
  }, []);

  return {
    applying,
    applyError,
    caps,
    settings,
    manualExposure,
    meter,
    histogram,
    onMeter,
    change,
    auto,
    toggleHistogram,
  };
}
