import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mock } from "node:test";

/**
 * The capture hook's wiring, with no device. `check-runtime-behavior.mjs` covers the pure dial in
 * `src/capture/mode.ts`; this renders the real `useCaptureControls` and drives it only through its
 * return value, checking what the camera was told and what reached storage.
 *
 * Two modules are replaced where the app stops being JavaScript:
 *   modules/seeker-camera     a fake camera that answers as `resolve` in CaptureControls.kt does
 *   AsyncStorage              a Map
 * apply.ts, store.ts, captureChrome.ts and timing.ts are the real ones. `mock.module` needs
 * --experimental-test-module-mocks, so the checks run in a worker started with it; it matches on
 * the resolved file URL (a bare Windows path is silently ignored) and works because tsx loads the
 * app's .ts as CommonJS.
 *
 * react-dom renders into a stub container: the probe returns null, so react-dom only needs
 * something to hang its listeners on, and `act` needs the development React.
 *
 * `--hook <file>` checks another copy of the hook instead, e.g. a mutant, to prove a check has teeth.
 */

const hookArg = process.argv.indexOf("--hook");
const hookUrl = hookArg > 0
  ? pathToFileURL(resolvePath(process.argv[hookArg + 1])).href
  : new URL("../src/screens/useCaptureControls.ts", import.meta.url).href;

if (!process.argv.includes("--worker")) {
  const result = spawnSync(process.execPath,
    ["--experimental-test-module-mocks", "--disable-warning=ExperimentalWarning", "--import", "tsx",
      fileURLToPath(import.meta.url), "--worker", ...process.argv.slice(2)],
    { encoding: "utf8", timeout: 60_000, env: { ...process.env, NODE_ENV: "test" } });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  process.stdout.write(result.stdout);
} else {
  const require = createRequire(import.meta.url);
  const hop = () => new Promise((done) => setImmediate(done));

  // ---- The camera. Answers on a later turn of the loop, or when the check says so (`hold`).
  const CAPS = { manualSensor: true, manualPostProcessing: true, iso: { min: 50, max: 6400 },
    shutterNs: { min: 100_000, max: 30_000_000_000 }, ev: { min: -6, max: 6, step: 1 / 3 },
    aeLock: true, awbLock: true, awbModes: ["auto", "daylight", "shade"], afModes: ["continuous-picture", "off"],
    focus: { minDiopters: 0, maxDiopters: 10, calibration: "uncalibrated" }, kelvin: { min: 2000, max: 10000 } };
  const NO_VIEW = "no active camera view";
  const within = (value, { min, max }) => Math.min(max, Math.max(min, value));
  const native = {};
  /** `resolve` in CaptureControls.kt: one manual value holds both, and AE's controls read back off. */
  const resolveLikeNative = (asked, lastAe) => {
    const manual = asked.iso !== "auto" || asked.shutterNs !== "auto";
    const kelvin = typeof asked.whiteBalance === "object";
    if (!kelvin && !CAPS.awbModes.includes(asked.whiteBalance))
      throw new Error(`white balance mode "${asked.whiteBalance}" is not on this camera`);
    return {
      iso: manual ? within(asked.iso === "auto" ? lastAe?.iso ?? 400 : asked.iso, CAPS.iso) : "auto",
      shutterNs: manual
        ? within(asked.shutterNs === "auto" ? lastAe?.shutterNs ?? 16_666_667 : asked.shutterNs, CAPS.shutterNs)
        : "auto",
      ev: manual ? 0 : within(asked.ev, CAPS.ev),
      aeLock: asked.aeLock && !manual,
      whiteBalance: kelvin ? { kelvin: within(asked.whiteBalance.kelvin, CAPS.kelvin) } : asked.whiteBalance,
      awbLock: asked.awbLock && !kelvin,
      focus: asked.focus === "auto" ? "auto" : within(asked.focus, { min: 0, max: CAPS.focus.maxDiopters }),
      manualExposure: manual,
    };
  };
  const SeekerCamera = {
    async captureCapabilities() {
      await hop();
      if (native.capabilityRefusals-- > 0) throw new Error("no react context");
      return CAPS;
    },
    setCaptureSettings(json) {
      const asked = JSON.parse(json);
      native.requests.push(asked);
      const refusal = native.refusals.shift();
      return new Promise((fulfil, reject) => {
        // Resolved as the request arrives, against what AE metered last; delivered later.
        let deliver;
        try {
          const effective = resolveLikeNative(asked, native.lastAe);
          deliver = () => fulfil(effective);
        } catch (cause) {
          deliver = () => reject(cause);
        }
        const settle = (how) => {
          native.waiting = native.waiting.filter((one) => one !== request);
          how();
        };
        const request = {
          asked,
          answer: () => settle(refusal === undefined ? deliver : () => reject(new Error(refusal))),
          refuse: (message) => settle(() => reject(new Error(message))),
        };
        if (native.hold) native.waiting.push(request);
        else setImmediate(request.answer);
      });
    },
  };

  // ---- The phone's storage.
  const SETTINGS_KEY = "capture.v1", CHROME_KEY = "capture.chrome.v1";
  const storage = {};
  const AsyncStorage = {
    async getItem(key) {
      storage.reads++;
      if (storage.gate) await storage.gate;
      return storage.items.get(key) ?? null;
    },
    async setItem(key, value) {
      storage.writes.push(key);
      storage.items.set(key, value);
    },
  };
  const stored = (key) => JSON.parse(storage.items.get(key) ?? "null");
  const seed = (settings, chrome) => {
    if (settings) storage.items.set(SETTINGS_KEY, JSON.stringify({ v: 1, settings }));
    if (chrome) storage.items.set(CHROME_KEY, JSON.stringify({ v: 1, ...chrome }));
  };

  mock.module(new URL("../modules/seeker-camera/index.ts", import.meta.url).href,
    { namedExports: { SeekerCamera, UNAVAILABLE: "unavailable" } });
  mock.module(pathToFileURL(require.resolve("@react-native-async-storage/async-storage")).href,
    { defaultExport: AsyncStorage });

  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.__DEV__ = false;
  globalThis.window = { event: undefined, HTMLIFrameElement: class {} };
  const { act, createElement } = require("react");
  const { createRoot } = require("react-dom/client");
  const { useCaptureControls } = await import(hookUrl);
  const { DEFAULT_CAPTURE_SETTINGS: AUTOMATIC } = await import("../src/capture/model.ts");
  const { captureControls: copy } = await import("../src/ui/copy.ts");

  // React says an update escaped `act` on console.error: that is a broken check, not a warning.
  const complaints = [];
  console.error = (...args) => complaints.push(args.join(" "));

  const fresh = () => {
    Object.assign(native, { requests: [], waiting: [], refusals: [], hold: false, lastAe: null, capabilityRefusals: 0 });
    Object.assign(storage, { items: new Map(), reads: 0, writes: [], gate: null });
    mock.timers.reset();
    mock.timers.enable({ apis: ["setTimeout"] });
  };
  const holdReads = () => {
    let release;
    storage.gate = new Promise((done) => { release = done; });
    return () => { storage.gate = null; release(); };
  };

  /**
   * React renders when an `act` ends, and what that render's effects start (a read, a request)
   * answers on a later turn: a few rounds let a cold start run from the store to the camera's answer.
   */
  const flush = async () => {
    for (let round = 0; round < 5; round++) await act(async () => { await hop(); await hop(); });
  };
  const mount = async (props = { live: true, generation: 0 }) => {
    let view;
    const Probe = (given) => { view = useCaptureControls(given); return null; };
    const root = createRoot({ nodeType: 1, nodeName: "DIV", tagName: "DIV", ownerDocument: null,
      addEventListener() {}, removeEventListener() {} });
    const render = async (next) => { await act(async () => root.render(createElement(Probe, next))); await flush(); };
    /** `action` gets the newest render's value, as a press on the screen would. No time passes. */
    const run = async (action) => {
      let out;
      await act(async () => { out = action(view); });
      await flush();
      return out;
    };
    const tick = (ms) => run(() => mock.timers.tick(ms));
    await render(props);
    return {
      get view() { return view; },
      run,
      tick,
      render,
      /** One press at a hand's pace: the throttle has closed again before the next one. */
      press: async (action) => { const out = await run(action); await tick(100); return out; },
      meter: (reading) => { if (!reading.manualExposure) native.lastAe = reading; return run((now) => now.onMeter(reading)); },
      answer: (request, refusal) => run(() => (refusal ? request.refuse(refusal) : request.answer())),
      unmount: async () => { await act(async () => root.unmount()); await flush(); },
    };
  };
  const reading = (patch) => ({ iso: 137, shutterNs: 13_698_630, ev: 0, focusDistance: null, awbMode: "auto",
    aeState: "converged", afState: "inactive", manualExposure: false, histogram: [], sampled: 0,
    clippedBlack: 0, clippedWhite: 0, ...patch });
  const exposure = (settings) => [settings.iso, settings.shutterNs, settings.ev];

  {
    // A failed restore. This block and the next run first: apply.ts caches the capabilities once
    // it has them, so only these mounts can be refused them.
    fresh();
    native.capabilityRefusals = Infinity;
    seed(null, { readout: true, display: "grid" });
    const left = storage.items.get(CHROME_KEY);
    const cam = await mount();
    // The real AsyncStorage loads in node and fails soft, so a mock that missed would go unnoticed.
    assert.ok(storage.reads > 0, "the stores must be reading the fake storage");
    assert.equal(cam.view.caps, null);
    assert.equal(await cam.press((now) => now.chooseMode("program")), false, "no dial without a camera to turn it on");
    await cam.press((now) => now.cycleDisplay());
    await cam.tick(1_000);
    assert.deepEqual(storage.writes, [], "a failed restore must not replace the stored chrome");
    assert.equal(storage.items.get(CHROME_KEY), left);
    await cam.unmount();
  }

  {
    // The restore refused by a camera that answers a moment later. The apply then succeeds, on the
    // defaults, and saving those would replace what the photographer had: settings, and what the
    // dial set aside. Nothing is written over a store that was not read.
    fresh();
    native.capabilityRefusals = 1;
    storage.items.set(SETTINGS_KEY, JSON.stringify({ v: 1,
      settings: { ...AUTOMATIC, iso: 800, shutterNs: 8_000_000, whiteBalance: "daylight" },
      parked: { ...AUTOMATIC, whiteBalance: "shade", focus: 1.5 }, aside: 3 }));
    seed(null, { readout: true, display: "grid" });
    const left = [storage.items.get(SETTINGS_KEY), storage.items.get(CHROME_KEY)];
    const cam = await mount();
    assert.deepEqual([cam.view.caps, native.requests.length, cam.view.applying, cam.view.applyError], [null, 1, false, ""],
      "this camera did come up, on its defaults: the case in which a save would go through");
    await cam.tick(5_000);
    await cam.press((now) => now.auto());
    await cam.press((now) => now.cycleDisplay());
    await cam.tick(5_000);
    assert.deepEqual(storage.writes, [], "after a restore that failed, nothing is written");
    assert.deepEqual([storage.items.get(SETTINGS_KEY), storage.items.get(CHROME_KEY)], left, "and what was stored is there to the byte");
    await cam.unmount();
  }

  {
    // Before the store has answered: nothing is shown, told to the camera, or written.
    fresh();
    seed({ ...AUTOMATIC, ev: 3, whiteBalance: "daylight" }, { readout: true, display: "grid" });
    const release = holdReads();
    const cam = await mount();
    await cam.press((now) => now.cycleDisplay());
    assert.equal(cam.view.display, "plain");
    assert.equal(await cam.press((now) => now.chooseMode("program")), false);
    await cam.tick(1_000);
    assert.deepEqual(storage.writes, [], "nothing is written before the store was read");
    assert.deepEqual(native.requests, [], "the camera waits for what was stored, not for the defaults");
    release();
    await cam.tick(0);
    // Cold start: the stored settings and chrome come up, and the camera is told them.
    assert.equal(cam.view.mode, "program");
    assert.equal(cam.view.display, "grid");
    assert.equal(cam.view.canHoldExposure, true);
    assert.deepEqual(cam.view.settings, { ...AUTOMATIC, ev: 3, whiteBalance: "daylight" });
    assert.deepEqual(native.requests, [{ ...AUTOMATIC, ev: 3, whiteBalance: "daylight" }]);
    assert.equal(cam.view.applying, false);
    await cam.unmount();
  }

  for (const held of [{ iso: 320, shutterNs: 8_000_000 }, { focus: 1.5 }]) {
    // A stored held value the stored chrome would hide: the readout comes up, and stays up.
    fresh();
    seed({ ...AUTOMATIC, ...held }, { readout: false, display: "histogram" });
    const cam = await mount();
    assert.equal(cam.view.mode, "iso" in held ? "manual" : "program", "a held value is never hidden behind AUTO");
    assert.equal(cam.view.display, "histogram");
    assert.deepEqual([stored(CHROME_KEY).readout, stored(CHROME_KEY).display], [true, "histogram"],
      "the store is told the readout is up, and nothing else in it changes");
    await cam.press((now) => now.change({ ...now.settings, iso: "auto", shutterNs: "auto", focus: "auto" }));
    assert.equal(cam.view.mode, "program", "releasing a restored held value leaves the dial on P, not AUTO");
    await cam.unmount();
  }

  {
    // P at +1, M, P: still +1. M holds what the camera metered last, and brightness waits.
    fresh();
    const cam = await mount();
    assert.equal(cam.view.mode, "auto");
    assert.equal(await cam.press((now) => now.chooseMode("auto")), false, "the dial is already there");
    assert.equal(await cam.press((now) => now.chooseMode("manual")), false, "M has nothing to hold before a reading");
    assert.equal(cam.view.mode, "auto");
    const drawn = reading(), last = reading({ iso: 200, shutterNs: 10_000_000 });
    await cam.meter(drawn);
    await cam.meter(last);
    assert.equal(cam.view.meter, drawn, "AUTO shows brightness alone: a reading that leaves it alone is not drawn");
    const told = native.requests.length;
    assert.equal(await cam.press((now) => now.chooseMode("program")), true);
    assert.equal(cam.view.mode, "program");
    assert.equal(native.requests.length, told, "AUTO to P with nothing set aside leaves the camera's request running");
    assert.equal(stored(CHROME_KEY).readout, true);
    await cam.press((now) => now.change({ ...now.settings, ev: 3 }));
    assert.equal(cam.view.settings.ev, 3);
    assert.equal(await cam.press((now) => now.chooseMode("manual")), true);
    assert.equal(cam.view.mode, "manual");
    assert.deepEqual(exposure(cam.view.settings), [200, 10_000_000, 0], "M holds the newest reading, drawn or not");
    assert.deepEqual(exposure(native.requests.at(-1)), [200, 10_000_000, 0]);
    assert.equal(await cam.press((now) => now.chooseMode("manual")), false);
    assert.equal(await cam.press((now) => now.chooseMode("program")), true);
    assert.equal(cam.view.mode, "program");
    assert.deepEqual(exposure(cam.view.settings), ["auto", "auto", 3], "P after M must not drop the photograph a stop");
    assert.equal(native.requests.at(-1).ev, 3, "and the camera is told so, not only the strip");

    // A ruler moved in P turns the dial to M by itself, at once; the companion value is native's.
    await cam.tick(1_000);
    assert.deepEqual(exposure(stored(SETTINGS_KEY).settings), ["auto", "auto", 3]);
    native.lastAe = { iso: 250, shutterNs: 5_000_000 };
    native.hold = true;
    await cam.run((now) => now.change({ ...now.settings, iso: 800 }));
    assert.equal(cam.view.mode, "manual", "the strip changes with the thumb, before the camera answers");
    assert.equal(cam.view.applying, true);
    await cam.tick(1_000);
    assert.equal(stored(SETTINGS_KEY).settings.iso, "auto", "a request is never stored, only an answer");
    await cam.answer(native.waiting[0]);
    native.hold = false;
    assert.equal(cam.view.applying, false);
    assert.deepEqual(exposure(cam.view.settings), [800, 5_000_000, 0], "what native says it applied is what is in force");
    await cam.tick(1_000);
    assert.deepEqual(exposure(stored(SETTINGS_KEY).settings), [800, 5_000_000, 0], "and what is stored");
    await cam.press((now) => now.change({ ...now.settings, iso: "auto", shutterNs: "auto" }));
    assert.equal(cam.view.mode, "program");
    assert.equal(cam.view.settings.ev, 3);
    await cam.unmount();
  }

  {
    // M with colour held, AUTO, M: what AUTO set aside comes back with the dial, reading or none.
    fresh();
    seed({ ...AUTOMATIC, iso: 800, shutterNs: 8_000_000, whiteBalance: "daylight" }, { readout: true, display: "plain" });
    const cam = await mount();
    assert.equal(cam.view.mode, "manual");
    const left = cam.view.settings;
    assert.equal(await cam.press((now) => now.chooseMode("auto")), true);
    assert.equal(cam.view.mode, "auto");
    assert.deepEqual(cam.view.settings, AUTOMATIC, "AUTO keeps brightness and nothing else");
    assert.deepEqual(native.requests.at(-1), AUTOMATIC, "and releases it in the camera too");
    assert.equal(stored(CHROME_KEY).readout, false);
    assert.equal(cam.view.meter, null);
    assert.equal(await cam.press((now) => now.chooseMode("manual")), true, "M needs no reading to bring back a held pair");
    assert.equal(cam.view.mode, "manual");
    assert.deepEqual(cam.view.settings, left);
    assert.deepEqual(native.requests.at(-1), left);
    // AUTO, then P: the colour comes back, the exposure does not, under the brightness AUTO was left on.
    await cam.press((now) => now.chooseMode("auto"));
    await cam.press((now) => now.change({ ...now.settings, ev: 6 }));
    assert.equal(cam.view.mode, "auto", "brightness is AUTO's own control");
    assert.equal(await cam.press((now) => now.chooseMode("program")), true);
    assert.equal(cam.view.mode, "program");
    assert.deepEqual([...exposure(cam.view.settings), cam.view.settings.whiteBalance], ["auto", "auto", 6, "daylight"]);
    assert.deepEqual(native.requests.at(-1), cam.view.settings);
    await cam.unmount();
  }

  {
    // What the dial set aside outlives the app, as a dial's position does.
    fresh();
    const first = await mount();
    await first.meter(reading());
    await first.press((now) => now.chooseMode("program"));
    assert.equal(first.view.remembered, null, "only AUTO has something set aside to show");
    await first.press((now) => now.change({ ...now.settings, ev: 3, whiteBalance: "daylight" }));
    await first.press((now) => now.chooseMode("manual"));
    await first.tick(1_000);
    await first.unmount();

    const inManual = await mount();
    assert.equal(inManual.view.mode, "manual");
    assert.equal(await inManual.press((now) => now.chooseMode("program")), true);
    assert.equal(inManual.view.settings.ev, 3, "the brightness M set aside comes back after a restart too");
    await inManual.meter(reading({ iso: 320, shutterNs: 8_000_000 }));
    await inManual.press((now) => now.chooseMode("manual"));
    await inManual.press((now) => now.chooseMode("auto"));
    assert.deepEqual([inManual.view.mode, inManual.view.remembered, inManual.view.settings.ev], ["auto", "manual", 3]);
    await inManual.tick(1_000);
    await inManual.unmount();

    const onAuto = await mount();
    assert.deepEqual([onAuto.view.mode, onAuto.view.remembered, onAuto.view.meter], ["auto", "manual", null]);
    // AUTO has no cell to show a brightness, so one left on it does not outlive the app.
    assert.equal(onAuto.view.settings.ev, 0, "a brightness left on AUTO is not brought back");
    assert.equal(native.requests.at(-1).ev, 0, "and the camera is opened without it");
    assert.equal(await onAuto.press((now) => now.chooseMode("manual")), true, "what AUTO set aside is still there to come back");
    assert.deepEqual([...exposure(onAuto.view.settings), onAuto.view.settings.whiteBalance], [320, 8_000_000, 0, "daylight"]);
    assert.equal(onAuto.view.remembered, null);
    await onAuto.press((now) => now.chooseMode("program"));
    assert.equal(onAuto.view.settings.ev, 0, "and P comes back under the brightness AUTO has now: none");
    await onAuto.unmount();
  }

  {
    // `auto()`: everything, the brightness M set aside included, and nothing queued follows it.
    fresh();
    const cam = await mount();
    await cam.meter(reading());
    await cam.press((now) => now.chooseMode("program"));
    await cam.press((now) => now.change({ ...now.settings, ev: 3, whiteBalance: "daylight" }));
    await cam.press((now) => now.chooseMode("manual"));
    await cam.run((now) => now.change({ ...now.settings, iso: 400 }));
    await cam.run((now) => now.change({ ...now.settings, iso: 800 }));
    assert.equal(native.requests.at(-1).iso, 400, "a drag reaches the camera at most once per throttle");
    await cam.press((now) => now.auto());
    assert.deepEqual(cam.view.settings, AUTOMATIC, "one action, and the camera is choosing everything again");
    assert.deepEqual(native.requests.at(-1), AUTOMATIC, "a value still waiting in the throttle must not follow it");
    assert.equal(cam.view.applying, false);
    // It is asked for by holding the dial's AUTO, so that is where the dial is left, with nothing
    // set aside for P or M to bring back, now or after a restart.
    assert.equal(cam.view.mode, "auto", "a full reset leaves the dial on AUTO");
    assert.equal(cam.view.remembered, null, "and sets nothing aside");
    await cam.press((now) => now.chooseMode("manual"));
    await cam.press((now) => now.chooseMode("program"));
    assert.equal(cam.view.settings.ev, 0, "the brightness M had set aside went with the rest");
    await cam.unmount();
  }

  {
    // Answers out of order. Each request carries a revision, and only the newest may be adopted.
    fresh();
    native.hold = true;
    const cam = await mount();
    await cam.run((now) => now.change({ ...now.settings, whiteBalance: "daylight" }));
    const [coldStart, moved] = native.waiting;
    assert.deepEqual([coldStart.asked.whiteBalance, moved.asked.whiteBalance], ["auto", "daylight"]);
    await cam.answer(moved);
    assert.equal(cam.view.applying, false);
    await cam.answer(coldStart);
    assert.equal(cam.view.settings.whiteBalance, "daylight", "the cold start's late answer must not undo a control moved since");

    await cam.tick(100);
    await cam.run((now) => now.change({ ...now.settings, iso: 400 }));
    await cam.tick(100);
    await cam.run((now) => now.change({ ...now.settings, iso: 800 }));
    let [older, newer] = native.waiting;
    await cam.answer(newer);
    await cam.answer(older);
    assert.equal(cam.view.settings.iso, 800, "an answer to an older request must never overwrite a newer one");
    assert.equal(cam.view.applying, false);

    await cam.tick(100);
    await cam.run((now) => now.change({ ...now.settings, iso: 1600 }));
    await cam.tick(100);
    await cam.run((now) => now.change({ ...now.settings, iso: 3200 }));
    [older, newer] = native.waiting;
    await cam.answer(older, "camera closed");
    assert.deepEqual([cam.view.applyError, cam.view.applying], ["", true], "nor may an older refusal speak for it");
    await cam.answer(newer);
    assert.deepEqual([cam.view.settings.iso, cam.view.applyError, cam.view.applying], [3200, "", false]);
    // The newest request refused is the one refusal that shows, and it is never stored.
    await cam.tick(1_000);
    await cam.run((now) => now.change({ ...now.settings, iso: 100 }));
    await cam.answer(native.waiting[0], "camera closed");
    assert.deepEqual([cam.view.applyError, cam.view.applying], [copy.applyError, false]);
    await cam.tick(1_000);
    assert.equal(stored(SETTINGS_KEY).settings.iso, 3200);
    await cam.unmount();
  }

  {
    // The view is not up on a cold start: the apply is tried again, then given up with one line.
    fresh();
    seed({ ...AUTOMATIC, whiteBalance: "shade" }, null);
    native.refusals = [NO_VIEW, NO_VIEW];
    const cam = await mount();
    assert.deepEqual([native.requests.length, cam.view.applying, cam.view.applyError], [1, true, ""]);
    await cam.tick(150);
    await cam.tick(150);
    assert.deepEqual([native.requests.length, cam.view.applying, cam.view.applyError], [3, false, ""]);
    assert.equal(native.requests.at(-1).whiteBalance, "shade");
    await cam.unmount();

    fresh();
    native.refusals = Array(40).fill(NO_VIEW);
    const stuck = await mount();
    for (let wait = 0; wait < 20; wait++) await stuck.tick(150);
    const asked = native.requests.length;
    assert.ok(asked > 1 && asked < 20, "a camera that never comes up is not asked for ever");
    assert.deepEqual([stuck.view.applyError, stuck.view.applying], [copy.applyError, false]);
    await stuck.unmount();

    fresh();
    native.refusals = ["camera closed"];
    const refused = await mount();
    await refused.tick(1_000);
    assert.equal(native.requests.length, 1, "only a missing view is worth asking again");
    assert.equal(refused.view.applyError, copy.applyError);
    await refused.unmount();
  }

  {
    // A control moved while the cold start waits for the view takes the revision, and the waiting
    // with it.
    fresh();
    seed({ ...AUTOMATIC, whiteBalance: "shade" }, { readout: true, display: "plain" });
    native.refusals = [NO_VIEW, NO_VIEW, NO_VIEW];
    const cam = await mount();
    assert.deepEqual([native.requests.length, cam.view.applying, cam.view.applyError], [1, true, ""], "the cold start is waiting for the view");
    await cam.run((now) => now.change({ ...now.settings, whiteBalance: "daylight" }));
    assert.deepEqual([native.requests.length, cam.view.applying, cam.view.applyError], [2, true, ""], "a view not up yet is no error for a moved control either");
    await cam.tick(150);
    assert.deepEqual([native.requests.length, cam.view.applying, cam.view.applyError], [3, true, ""], "it waits as the cold start did");
    await cam.tick(150);
    assert.deepEqual([native.requests.length, cam.view.applying, cam.view.applyError], [4, false, ""], "and lands once the view is up");
    assert.deepEqual(native.requests.map((asked) => asked.whiteBalance), ["shade", "daylight", "daylight", "daylight"],
      "the cold start's own wait ended when the control took the revision");
    assert.equal(cam.view.settings.whiteBalance, "daylight", "what is in force is what was moved to");
    await cam.tick(5_000);
    assert.equal(native.requests.length, 4);
    assert.equal(stored(SETTINGS_KEY).settings.whiteBalance, "daylight");
    await cam.unmount();

    // auto() during the wait, the same.
    fresh();
    seed({ ...AUTOMATIC, whiteBalance: "shade", ev: 3 }, { readout: true, display: "plain" });
    native.refusals = [NO_VIEW, NO_VIEW];
    const reset = await mount();
    await reset.run((now) => now.auto());
    assert.deepEqual([native.requests.length, reset.view.applying, reset.view.applyError], [2, true, ""], "nor is it an error for auto()");
    await reset.tick(150);
    assert.deepEqual([native.requests.length, reset.view.applying, reset.view.applyError], [3, false, ""], "which lands once the view is up");
    assert.deepEqual(native.requests.at(-1), AUTOMATIC);
    assert.deepEqual(reset.view.settings, AUTOMATIC);
    await reset.tick(5_000);
    assert.equal(native.requests.length, 3);
    await reset.unmount();

    // ...and a moved control whose view never comes up is given up on with the one line, too.
    fresh();
    const stuck = await mount();
    native.refusals = Array(40).fill(NO_VIEW);
    await stuck.run((now) => now.change({ ...now.settings, whiteBalance: "daylight" }));
    for (let wait = 0; wait < 20; wait++) await stuck.tick(150);
    const asked = native.requests.length - 1;
    assert.ok(asked > 1 && asked < 20, "a moved control does not ask for ever either");
    assert.deepEqual([stuck.view.applyError, stuck.view.applying], [copy.applyError, false]);
    await stuck.tick(5_000);
    assert.equal(native.requests.length - 1, asked);
    assert.equal(stored(SETTINGS_KEY)?.settings.whiteBalance ?? "auto", "auto", "a refused request is never stored");
    await stuck.unmount();
  }

  {
    // A reading belongs to the camera that metered it: a restart, or no camera, starts without one.
    fresh();
    const cam = await mount();
    await cam.press((now) => now.chooseMode("program"));
    await cam.meter(reading());
    assert.notEqual(cam.view.meter, null);
    await cam.render({ live: true, generation: 1 });
    assert.equal(cam.view.meter, null, "a restarted camera must not show the last scene's numbers");
    assert.equal(await cam.press((now) => now.chooseMode("manual")), false, "nor may M hold them");
    await cam.meter(reading({ iso: 320, shutterNs: 8_000_000 }));
    assert.equal(await cam.press((now) => now.chooseMode("manual")), true);
    assert.deepEqual(exposure(cam.view.settings), [320, 8_000_000, 0]);

    const told = native.requests.length;
    await cam.meter(reading({ iso: 320, shutterNs: 8_000_000, manualExposure: true }));
    await cam.render({ live: false, generation: 1 });
    assert.equal(cam.view.meter, null);
    await cam.press((now) => now.change({ ...now.settings, iso: 1600 }));
    await cam.press((now) => now.auto());
    assert.equal(await cam.press((now) => now.chooseMode("program")), false);
    assert.deepEqual([cam.view.settings.iso, native.requests.length], [320, told], "no camera, no control");
    await cam.render({ live: true, generation: 1 });
    assert.equal(native.requests.length, told + 1);
    assert.deepEqual(exposure(native.requests.at(-1)), [320, 8_000_000, 0], "a fresh view starts on its defaults, so it is told what is held");
    assert.equal(await cam.press((now) => now.chooseMode("program")), true);
    assert.equal(await cam.press((now) => now.chooseMode("manual")), false, "M waits for the new view's first reading");
    // In the dark the meter reads past what the sensor holds by hand: the shutter takes the difference.
    await cam.meter(reading({ iso: CAPS.iso.max * 2, shutterNs: 50_000_000 }));
    assert.equal(await cam.press((now) => now.chooseMode("manual")), true);
    assert.deepEqual(exposure(cam.view.settings), [CAPS.iso.max, 100_000_000, 0], "M holds the metered exposure, not a darker one");
    assert.deepEqual(exposure(native.requests.at(-1)), [CAPS.iso.max, 100_000_000, 0]);
    await cam.unmount();
  }

  {
    // DISP: plain, grid, histogram. The histogram belongs to the readout, so AUTO skips it.
    fresh();
    seed(null, { readout: false, display: "histogram" });
    const cam = await mount();
    const presses = async () => {
      const seen = [];
      for (let press = 0; press < 3; press++) { await cam.press((now) => now.cycleDisplay()); seen.push(cam.view.display); }
      return seen;
    };
    assert.deepEqual([cam.view.mode, cam.view.display], ["auto", "plain"], "AUTO never draws the histogram");
    assert.deepEqual(await presses(), ["grid", "plain", "grid"]);
    assert.equal(stored(CHROME_KEY).display, "grid");
    await cam.press((now) => now.chooseMode("program"));
    assert.deepEqual(await presses(), ["histogram", "plain", "grid"]);
    await cam.press((now) => now.cycleDisplay());
    await cam.unmount();
    const again = await mount();
    assert.deepEqual([again.view.mode, again.view.display], ["program", "histogram"], "the chrome comes back as it was left");
    await again.unmount();
  }

  mock.timers.reset();
  assert.deepEqual(complaints, [], "every update must land inside act()");
  console.log("capture hook checks ok — restore and its guards (nothing written after a failed one), mode dial through the hook, brightness carried across M, AUTO's parked settings, both across a restart (a brightness left on AUTO is not), auto(), revision guard, view-not-ready retry for the cold start, a moved control and auto(), meter reset on restart, DISP");
}
