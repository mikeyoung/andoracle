import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  clearKeyboardOwnership,
  createKeyboardRowGeometry,
  focusKeyboardNote,
  isSyntheticActivationClick,
  isVisualActivationKey,
  Keyboard,
  shouldToggleAssistiveKey,
  visualKeySource,
} from "./Keyboard";
import {
  EMPTY_ODYSSEY_METER,
  OutputMeter,
  integrateOutputVuMeterPhysics,
  odysseyMetersMatch,
  outputVuMeterDrive,
  outputVuMeterMotionIsSettled,
} from "./OutputMeter";
import {
  DIRECT_ENTRY_LONG_PRESS_DELAY_MS,
  DirectEntryLongPressTracker,
  DirectEntryInterruptionRegistry,
  DeferredRangePointerFocusRelease,
  keyboardAdjustedRangeValue,
  LongPressClickSuppression,
  RangeControl,
  ReversibleRangeKeyboardStepper,
  shouldStartDirectEntryLongPress,
  shouldReleaseChoicePointerFocus,
  shouldConsumeLongPressClick,
  shouldEmitRangeChange,
} from "./ParameterControls";
import {
  deleteConfirmationTimeoutMessage,
  DeleteConfirmationDialog,
  raceDeleteConfirmationWithAbort,
} from "./DeleteConfirmationDialog";
import { ExternalInputControl } from "./ExternalInputControl";
import { HelpDialog } from "./HelpDialog";
import { MidiInputControl } from "./MidiInputControl";
import parameterControlsSource from "./ParameterControls.tsx?raw";
import { PatchLibraryDialog } from "./PatchLibraryDialog";
import patchLibraryDialogSource from "./PatchLibraryDialog.tsx?raw";
import {
  PARAM_KEYS,
  PARAM_SPECS,
  formatParamValue,
  normalizedToParam,
  paramToNormalized,
} from "../synth/params";
import {
  clearPpcOwnership,
  isPadActivationKey,
  PpcPads,
  ppcPointerDepth,
  shouldToggleAssistivePad,
  updatePpcPointerDepth,
  type PadActivation,
  type PadKind,
} from "./PpcPads";

describe("on-screen keyboard interaction contracts", () => {
  it("uses independent ownership tokens for Space, Enter, and assistive activation", () => {
    const sources = [
      visualKeySource(60, " "),
      visualKeySource(60, "Enter"),
      visualKeySource(60, "assistive"),
    ];

    expect(new Set(sources).size).toBe(3);
    expect(sources).toEqual([
      "visual-key:60:Space",
      "visual-key:60:Enter",
      "visual-key:60:assistive",
    ]);
  });

  it("recognizes only the intended activation keys and synthetic clicks", () => {
    expect(isVisualActivationKey(" ")).toBe(true);
    expect(isVisualActivationKey("Enter")).toBe(true);
    expect(isVisualActivationKey("Escape")).toBe(false);
    expect(isSyntheticActivationClick(0)).toBe(true);
    expect(isSyntheticActivationClick(1)).toBe(false);
    expect(shouldToggleAssistiveKey(0, false)).toBe(true);
    expect(shouldToggleAssistiveKey(0, true)).toBe(false);
    expect(shouldToggleAssistiveKey(1, false)).toBe(false);
  });

  it("renders all 37 keys as pressed-state buttons with keyboard shortcuts", () => {
    const markup = renderToStaticMarkup(createElement(Keyboard, {
      activeNotes: new Set<number>(),
      allocatedLow: null,
      allocatedHigh: null,
      resetEpoch: 0,
      onNoteOn: vi.fn(),
      onNoteOff: vi.fn(),
      position: "bottom",
      onPositionChange: vi.fn(),
    }));

    expect(markup.match(/class="piano-key /g)).toHaveLength(37);
    expect(markup.match(/aria-keyshortcuts="Enter Space"/g)).toHaveLength(37);
    expect(markup.match(/aria-pressed="false"/g)).toHaveLength(37);
    expect(markup).toContain('role="group" aria-label="On-screen keyboard"');
    expect(markup.match(/data-keyboard-row="[123]"/g)).toHaveLength(3);
    expect(markup).toContain('aria-label="C2 through B2"');
    expect(markup).toContain('aria-label="C3 through B3"');
    expect(markup).toContain('aria-label="C4 through C5"');
    expect(markup).not.toContain("Scrollable on-screen keyboard");
  });

  it("partitions compact keys into octaves that can form centered two- or three-row layouts", () => {
    const mobileRows = [
      createKeyboardRowGeometry(36, 47),
      createKeyboardRowGeometry(48, 59),
      createKeyboardRowGeometry(60, 72),
    ];

    expect(mobileRows.map((row) => [row.startNote, row.endNote, row.whiteCount])).toEqual([
      [36, 47, 7],
      [48, 59, 7],
      [60, 72, 8],
    ]);
    expect(mobileRows.flatMap((row) => row.keys).map((key) => key.note)).toEqual(
      Array.from({ length: 37 }, (_, index) => 36 + index),
    );

    const markup = renderToStaticMarkup(createElement(Keyboard, {
      activeNotes: new Set<number>(),
      allocatedLow: null,
      allocatedHigh: null,
      resetEpoch: 0,
      onNoteOn: vi.fn(),
      onNoteOff: vi.fn(),
      position: "bottom",
      onPositionChange: vi.fn(),
    }));
    const secondOctaveStart = markup.match(/style="[^"]*--two-row-key-left:([^%;]+)%[^"]*" data-note="48"/);
    const lowerRowStart = markup.match(/style="[^"]*--two-row-key-left:([^%;]+)%[^"]*" data-note="60"/);
    const lowerRowEnd = markup.match(/style="[^"]*--two-row-key-left:([^%;]+)%;--two-row-key-width:([^%;]+)%[^"]*" data-note="72"/);
    const threeRowStarts = [36, 48, 60].map((note) => (
      markup.match(new RegExp(`style="[^"]*--three-row-key-left:([^%;]+)%[^"]*" data-note="${note}"`))
    ));

    expect(Number(secondOctaveStart?.[1])).toBeCloseTo(50, 6);
    expect(Number(lowerRowStart?.[1])).toBeCloseTo((3 / 14) * 100, 6);
    expect(Number(lowerRowEnd?.[1]) + Number(lowerRowEnd?.[2])).toBeCloseTo((11 / 14) * 100, 6);
    expect(threeRowStarts.map((match) => Number(match?.[1]))).toEqual([0, 0, 0]);
  });

  it("focuses a pointer-struck piano key without scrolling the page", () => {
    const lowFocus = vi.fn();
    const middleFocus = vi.fn();
    const highFocus = vi.fn();
    const keys = new Map([
      [36, { focus: lowFocus }],
      [60, { focus: middleFocus }],
      [72, { focus: highFocus }],
    ]);

    expect(focusKeyboardNote(60, keys)).toBe(60);
    expect(middleFocus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
    expect(focusKeyboardNote(12, keys)).toBe(36);
    expect(focusKeyboardNote(96, keys)).toBe(72);
    expect(lowFocus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
    expect(highFocus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
  });

  it("lays out the complete keyboard as one proportional C2–C5 surface", () => {
    const keyboard = createKeyboardRowGeometry(36, 72);

    expect(keyboard.keys).toHaveLength(37);
    expect(keyboard.whiteCount).toBe(22);
    for (const key of keyboard.keys) {
      const width = key.white ? 1 : 0.625;
      expect(key.left).toBeGreaterThanOrEqual(0);
      expect(key.left + width).toBeLessThanOrEqual(keyboard.whiteCount);
      expect((key.left / keyboard.whiteCount) * 100).toBeGreaterThanOrEqual(0);
      expect(((key.left + width) / keyboard.whiteCount) * 100).toBeLessThanOrEqual(100);
    }
  });

  it("clears every pointer, assistive, and pending-click owner on a reset", () => {
    const pointerNotes = new Map([[7, 60], [8, 64]]);
    const visualKeySources = new Map([
      [visualKeySource(67, "assistive"), 67],
      [visualKeySource(69, "Enter"), 69],
    ]);
    const clickSuppressions = new Set([visualKeySource(69, "Enter")]);
    const suppressionTimers = new Map([[visualKeySource(69, "Enter"), 101]]);
    const onNoteOff = vi.fn();
    const clearTimer = vi.fn();

    clearKeyboardOwnership(
      pointerNotes,
      visualKeySources,
      clickSuppressions,
      suppressionTimers,
      onNoteOff,
      clearTimer,
    );

    expect(onNoteOff.mock.calls.map(([source]) => source)).toEqual([
      "pointer:7",
      "pointer:8",
      "visual-key:67:assistive",
      "visual-key:69:Enter",
    ]);
    expect(clearTimer).toHaveBeenCalledExactlyOnceWith(101);
    expect(pointerNotes.size).toBe(0);
    expect(visualKeySources.size).toBe(0);
    expect(clickSuppressions.size).toBe(0);
    expect(suppressionTimers.size).toBe(0);
  });
});

describe("PPC interaction contracts", () => {
  it("keeps Space and Enter as independently recognized activations", () => {
    expect(isPadActivationKey(" ")).toBe(true);
    expect(isPadActivationKey("Enter")).toBe(true);
    expect(isPadActivationKey("Space")).toBe(false);
    expect(shouldToggleAssistivePad(0, false)).toBe(true);
    expect(shouldToggleAssistivePad(0, true)).toBe(false);
    expect(shouldToggleAssistivePad(1, false)).toBe(false);
  });

  it("maps vertical touch position to depth and clamps outside the pad", () => {
    expect(ppcPointerDepth(100, 100, 200, 0.5, "touch")).toBe(1);
    expect(ppcPointerDepth(200, 100, 200, 0.5, "touch")).toBe(0.5);
    expect(ppcPointerDepth(300, 100, 200, 0.5, "touch")).toBe(0);
    expect(ppcPointerDepth(50, 100, 200, 0.5, "touch")).toBe(1);
    expect(ppcPointerDepth(350, 100, 200, 0.5, "touch")).toBe(0);
  });

  it("uses actual pen pressure while preserving position control for touch", () => {
    expect(ppcPointerDepth(280, 100, 200, 0.8, "pen")).toBe(0.8);
    expect(ppcPointerDepth(280, 100, 200, 0.8, "touch")).toBeCloseTo(0.1);
  });

  it("reuses pointer-down geometry and suppresses unchanged move work", () => {
    const pointer = {
      kind: "up" as const,
      depth: 0.5,
      top: 100,
      height: 200,
    };

    expect(updatePpcPointerDepth(pointer, 200, 0, "touch")).toBe(false);
    expect(pointer.depth).toBe(0.5);
    expect(updatePpcPointerDepth(pointer, 150, 0, "touch")).toBe(true);
    expect(pointer.depth).toBe(0.75);
    expect(updatePpcPointerDepth(pointer, 275, 0.4, "pen")).toBe(true);
    expect(pointer.depth).toBe(0.4);
  });

  it("renders three pressed-state pads with keyboard shortcut metadata", () => {
    const markup = renderToStaticMarkup(createElement(PpcPads, {
      bendRange: 2,
      vibratoRange: 0.5,
      resetEpoch: 0,
      onPerformance: vi.fn(),
    }));

    expect(markup.match(/class="ppc-pad /g)).toHaveLength(3);
    expect(markup.match(/aria-keyshortcuts="Enter Space"/g)).toHaveLength(3);
    expect(markup.match(/aria-pressed="false"/g)).toHaveLength(3);
    expect(markup).toContain('role="group" aria-label="Proportional pitch controls"');
    expect(markup.indexOf('aria-label="Bend down pressure pad"')).toBeLessThan(
      markup.indexOf('aria-label="Vibrato pressure pad"'),
    );
    expect(markup.indexOf('aria-label="Vibrato pressure pad"')).toBeLessThan(
      markup.indexOf('aria-label="Bend up pressure pad"'),
    );
  });

  it("clears every pointer, keyboard, assistive, and pending-click pad owner", () => {
    const pointerValues = new Map([[11, { kind: "up" as const, depth: 0.75 }]]);
    const keyboardActivations: Record<PadKind, Set<PadActivation>> = {
      down: new Set([" "]),
      vibrato: new Set(["assistive"]),
      up: new Set(),
    };
    const clickSuppressions: Record<PadKind, Set<Exclude<PadActivation, "assistive">>> = {
      down: new Set([" "]),
      vibrato: new Set(),
      up: new Set(["Enter"]),
    };
    const suppressionTimers = new Map([["down: ", 201], ["up:Enter", 202]]);
    const clearTimer = vi.fn();

    expect(clearPpcOwnership(
      pointerValues,
      keyboardActivations,
      clickSuppressions,
      suppressionTimers,
      clearTimer,
    )).toBe(true);
    expect(clearTimer.mock.calls.map(([timer]) => timer)).toEqual([201, 202]);
    expect(pointerValues.size).toBe(0);
    expect(Object.values(keyboardActivations).every((activations) => activations.size === 0)).toBe(true);
    expect(Object.values(clickSuppressions).every((suppressions) => suppressions.size === 0)).toBe(true);
    expect(suppressionTimers.size).toBe(0);

    expect(clearPpcOwnership(
      pointerValues,
      keyboardActivations,
      clickSuppressions,
      suppressionTimers,
      clearTimer,
    )).toBe(false);
  });
});

describe("output meter accessibility", () => {
  it("exposes both physical VU channels through one concise meter role", () => {
    const leftRms = 0.01;
    const rightRms = 0.02;
    const leftPercent = Math.round(outputVuMeterDrive(leftRms) * 100);
    const rightPercent = Math.round(outputVuMeterDrive(rightRms) * 100);
    const markup = renderToStaticMarkup(createElement(OutputMeter, {
      leftRms,
      rightRms,
      running: true,
    }));

    expect(markup).toContain('role="group" aria-label="Stereo output level"');
    expect(markup.match(/role="meter"/g)).toHaveLength(2);
    expect(markup).toContain('aria-label="Left output level"');
    expect(markup).toContain('aria-label="Right output level"');
    expect(markup.match(/aria-valuemin="0"/g)).toHaveLength(2);
    expect(markup.match(/aria-valuemax="100"/g)).toHaveLength(2);
    expect(markup).toContain(`aria-valuenow="${leftPercent}" aria-valuetext="${leftPercent} percent"`);
    expect(markup).toContain(`aria-valuenow="${rightPercent}" aria-valuetext="${rightPercent} percent"`);
    expect(markup).toContain('class="output-meter is-powered"');
    expect(markup).toContain('class="output-vu-meter__face output-vu-meter__face--off"');
    expect(markup).toContain('class="output-vu-meter__face output-vu-meter__face--on"');
    expect(markup).toContain('class="output-vu-meter__needles" width="698" height="260"');
  });

  it("normalizes invalid, silent, and over-range RMS levels", () => {
    expect(outputVuMeterDrive(Number.NaN)).toBe(0);
    expect(outputVuMeterDrive(Number.POSITIVE_INFINITY)).toBe(0);
    expect(outputVuMeterDrive(-0.1)).toBe(0);
    expect(outputVuMeterDrive(0)).toBe(0);
    expect(outputVuMeterDrive(1)).toBe(1);
  });

  it("retains Chaotic Sound Effects' calibrated dB scale and frame-clamped response", () => {
    expect(outputVuMeterDrive(0.004777286046641967)).toBeCloseTo(0, 8);
    expect(outputVuMeterDrive(0.016950450455051074)).toBeCloseTo(0.5, 8);
    expect(outputVuMeterDrive(0.06014246794170308)).toBeCloseTo(1, 8);

    const positions = new Float64Array(2);
    const velocities = new Float64Array(2);
    const drives = new Float64Array([1, 0]);
    integrateOutputVuMeterPhysics(positions, velocities, drives, 1 / 60);
    expect(positions[0]).toBeCloseTo(0.07515432098765432, 10);
    expect(velocities[0]).toBeCloseTo(5.685185185185185, 10);

    const clampedPositions = new Float64Array(2);
    const clampedVelocities = new Float64Array(2);
    integrateOutputVuMeterPhysics(clampedPositions, clampedVelocities, drives, 5);
    expect(clampedPositions[0]).toBeCloseTo(0.34920719811897644, 9);
    expect(clampedVelocities[0]).toBeCloseTo(8.768353140100453, 8);
  });

  it("uses bounded moving-coil physics and settles at both target levels", () => {
    const positions = new Float64Array(2);
    const velocities = new Float64Array(2);
    const drives = new Float64Array([1, 0.4]);

    expect(outputVuMeterMotionIsSettled(positions, velocities, drives)).toBe(false);
    for (let step = 0; step < 300; step += 1) {
      integrateOutputVuMeterPhysics(positions, velocities, drives, 1 / 120);
    }
    expect(positions[0]).toBeCloseTo(1, 3);
    expect(positions[1]).toBeCloseTo(0.4, 3);
    expect(outputVuMeterMotionIsSettled(positions, velocities, drives)).toBe(true);

    drives.fill(0);
    for (let step = 0; step < 300; step += 1) {
      integrateOutputVuMeterPhysics(positions, velocities, drives, 1 / 120);
    }
    expect([...positions].every((position) => position >= 0 && position <= 1)).toBe(true);
    expect(outputVuMeterMotionIsSettled(positions, velocities, drives)).toBe(true);
  });

  it("suppresses identical telemetry frames without hiding a changed field", () => {
    expect(odysseyMetersMatch(EMPTY_ODYSSEY_METER, { ...EMPTY_ODYSSEY_METER })).toBe(true);
    expect(odysseyMetersMatch(EMPTY_ODYSSEY_METER, {
      ...EMPTY_ODYSSEY_METER,
      leftRms: 0.25,
    })).toBe(false);
  });
});

describe("range control change filtering", () => {
  class FakeRangeWindowTarget {
    readonly added = new Map<string, number>();
    readonly removed = new Map<string, number>();
    private readonly listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();

    addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
      const listeners = this.listeners.get(type) ?? new Set<EventListenerOrEventListenerObject>();
      listeners.add(listener);
      this.listeners.set(type, listeners);
      this.added.set(type, (this.added.get(type) ?? 0) + 1);
    }

    removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
      this.listeners.get(type)?.delete(listener);
      this.removed.set(type, (this.removed.get(type) ?? 0) + 1);
    }

    dispatch(type: string, pointerId?: number): void {
      const event = new Event(type);
      if (pointerId !== undefined) Object.defineProperty(event, "pointerId", { value: pointerId });
      for (const listener of [...(this.listeners.get(type) ?? [])]) {
        if (typeof listener === "function") listener(event);
        else listener.handleEvent(event);
      }
    }

    listenerCount(type: string): number {
      return this.listeners.get(type)?.size ?? 0;
    }
  }

  it("renders native vertical inputs as accessible 270-degree rotary dials", () => {
    const renderDial = (value: number) => renderToStaticMarkup(createElement(RangeControl, {
      param: "masterVolume",
      value,
      accent: "#808080",
      onChange: vi.fn(),
      onDirectEdit: vi.fn(),
    }));
    const minimum = renderDial(0);
    const middle = renderDial(0.5);
    const maximum = renderDial(1);

    expect(minimum).toContain('class="dial-shell" style="--dial-angle:-135deg"');
    expect(middle).toContain('class="dial-shell" style="--dial-angle:0deg"');
    expect(maximum).toContain('class="dial-shell" style="--dial-angle:135deg"');
    expect(middle).toContain('type="range"');
    expect(middle).toContain('aria-label="Master volume"');
    expect(middle).toContain('aria-orientation="vertical"');
    expect(middle).toContain('aria-valuetext="50%"');
    expect(middle).toContain('class="dial-scale" aria-hidden="true"');
    expect(middle).toContain('class="dial-face" aria-hidden="true"');
  });

  it("keeps every range parameter finite and bounded across both dial endpoints", () => {
    const rangeParams = PARAM_KEYS.filter((param) => PARAM_SPECS[param].control === "range");

    for (const param of rangeParams) {
      const renderDial = (value: number) => renderToStaticMarkup(createElement(RangeControl, {
        param,
        value,
        accent: "#808080",
        onChange: vi.fn(),
        onDirectEdit: vi.fn(),
      }));
      const minimum = renderDial(PARAM_SPECS[param].min);
      const maximum = renderDial(PARAM_SPECS[param].max);

      expect(minimum, `${param} minimum`).toContain('style="--dial-angle:-135deg"');
      expect(maximum, `${param} maximum`).toContain('style="--dial-angle:135deg"');
      expect(`${minimum}${maximum}`, `${param} output`).not.toMatch(/NaN|Infinity/);
    }
  });

  it("releases focus after Chromium's pointer default and owns the pending timer", () => {
    const blur = vi.fn();
    const callbacks = new Map<number, () => void>();
    const setTimer = vi.fn((callback: () => void) => {
      callbacks.set(31, callback);
      return 31;
    });
    const clearTimer = vi.fn((timerId: number) => callbacks.delete(timerId));
    const release = new DeferredRangePointerFocusRelease(setTimer, clearTimer);

    release.schedule({ blur });
    expect(blur).not.toHaveBeenCalled();
    expect(setTimer).toHaveBeenCalledExactlyOnceWith(expect.any(Function), 0);
    callbacks.get(31)?.();
    expect(blur).toHaveBeenCalledTimes(1);

    release.schedule({ blur });
    release.dispose();
    expect(clearTimer).toHaveBeenCalledExactlyOnceWith(31);
    expect(callbacks.size).toBe(0);
  });

  it("coalesces multiple terminal pointer events into one focus release", () => {
    let nextTimer = 40;
    const callbacks = new Map<number, () => void>();
    const setTimer = vi.fn((callback: () => void) => {
      const timer = nextTimer++;
      callbacks.set(timer, callback);
      return timer;
    });
    const clearTimer = vi.fn((timerId: number) => callbacks.delete(timerId));
    const blur = vi.fn();
    const release = new DeferredRangePointerFocusRelease(setTimer, clearTimer);

    release.schedule({ blur });
    release.schedule({ blur });
    expect(clearTimer).toHaveBeenCalledExactlyOnceWith(40);
    callbacks.get(41)?.();
    expect(blur).toHaveBeenCalledTimes(1);
  });

  it("releases dial focus after its pointer ends outside the input", () => {
    const windowTarget = new FakeRangeWindowTarget();
    const callbacks = new Map<number, () => void>();
    const blur = vi.fn();
    const release = new DeferredRangePointerFocusRelease(
      (callback) => {
        callbacks.set(71, callback);
        return 71;
      },
      (timerId) => callbacks.delete(timerId),
      windowTarget,
    );

    release.beginPointerGesture({ blur }, 14);
    expect(windowTarget.listenerCount("pointerup")).toBe(1);
    expect(windowTarget.listenerCount("pointercancel")).toBe(1);
    expect(windowTarget.listenerCount("blur")).toBe(1);
    expect(windowTarget.listenerCount("pagehide")).toBe(1);

    windowTarget.dispatch("pointerup", 99);
    expect(callbacks.size).toBe(0);
    expect(windowTarget.listenerCount("pointerup")).toBe(1);

    windowTarget.dispatch("pointerup", 14);
    expect(callbacks.size).toBe(1);
    for (const type of ["pointerup", "pointercancel", "blur", "pagehide"]) {
      expect(windowTarget.listenerCount(type), type).toBe(0);
      expect(windowTarget.removed.get(type), type).toBe(1);
    }
    expect(blur).not.toHaveBeenCalled();
    callbacks.get(71)?.();
    expect(blur).toHaveBeenCalledTimes(1);
  });

  it("cleans temporary dial listeners on interruption and disposal", () => {
    const windowTarget = new FakeRangeWindowTarget();
    const interruptedBlur = vi.fn();
    const disposedBlur = vi.fn();
    const release = new DeferredRangePointerFocusRelease(
      vi.fn(() => 81),
      vi.fn(),
      windowTarget,
    );

    release.beginPointerGesture({ blur: interruptedBlur }, 21);
    windowTarget.dispatch("pagehide");
    expect(interruptedBlur).toHaveBeenCalledTimes(1);
    expect(windowTarget.listenerCount("pointerup")).toBe(0);

    release.beginPointerGesture({ blur: disposedBlur }, 22);
    release.dispose();
    windowTarget.dispatch("pointercancel", 22);
    expect(disposedBlur).not.toHaveBeenCalled();
    for (const type of ["pointerup", "pointercancel", "blur", "pagehide"]) {
      expect(windowTarget.listenerCount(type), type).toBe(0);
      expect(windowTarget.added.get(type), type).toBe(2);
      expect(windowTarget.removed.get(type), type).toBe(2);
    }
  });

  it("does not emit an unchanged value but preserves real edits", () => {
    expect(shouldEmitRangeChange(0.5, 0.5)).toBe(false);
    expect(shouldEmitRangeChange(0.5, 0.51)).toBe(true);
  });

  it("releases choice focus only for pointer-generated clicks", () => {
    expect(shouldReleaseChoicePointerFocus(1)).toBe(true);
    expect(shouldReleaseChoicePointerFocus(2)).toBe(true);
    expect(shouldReleaseChoicePointerFocus(0)).toBe(false);
    expect(shouldReleaseChoicePointerFocus(-1)).toBe(false);
  });

  it("keeps one-step movement when it already produces complete rotary feedback", () => {
    expect(keyboardAdjustedRangeValue("masterTune", 0, "ArrowRight")).toBe(1);
    expect(keyboardAdjustedRangeValue("masterTune", 0, "ArrowUp")).toBe(1);
    expect(keyboardAdjustedRangeValue("masterTune", 0, "ArrowLeft")).toBe(-1);
    expect(keyboardAdjustedRangeValue("autoNote", 48, "ArrowRight")).toBe(49);
    expect(keyboardAdjustedRangeValue("ppcBendRange", 8, "ArrowDown")).toBe(7);
  });

  it("advances fine controls to the next visible and screen-reader-distinct stop", () => {
    const raw = 65.41;
    const nextAudio = keyboardAdjustedRangeValue("vco1Coarse", raw, "ArrowUp");
    const nextLowFrequency = keyboardAdjustedRangeValue("vco1Coarse", raw, "ArrowUp", 0.01);

    expect(nextAudio).toBeDefined();
    expect(nextLowFrequency).toBeDefined();
    expect(Math.round(paramToNormalized("vco1Coarse", nextAudio!) * 1000))
      .toBeGreaterThan(Math.round(paramToNormalized("vco1Coarse", raw) * 1000));
    expect(formatParamValue("vco1Coarse", nextAudio!)).not.toBe(formatParamValue("vco1Coarse", raw));
    expect(Math.round(paramToNormalized("vco1Coarse", nextLowFrequency!) * 1000))
      .toBeGreaterThan(Math.round(paramToNormalized("vco1Coarse", raw) * 1000));
    expect(formatParamValue("vco1Coarse", nextLowFrequency! * 0.01))
      .not.toBe(formatParamValue("vco1Coarse", raw * 0.01));
  });

  it("exactly reverses the last perceptible Arrow-key transition", () => {
    const stepper = new ReversibleRangeKeyboardStepper();
    const pedalStart = PARAM_SPECS.pedalPosition.default;
    const pedalUp = stepper.adjust("pedalPosition", pedalStart, "ArrowUp")!;

    expect(formatParamValue("pedalPosition", pedalUp))
      .not.toBe(formatParamValue("pedalPosition", pedalStart));
    expect(stepper.adjust("pedalPosition", pedalUp, "ArrowDown")).toBe(pedalStart);

    const coarseStart = PARAM_SPECS.vco1Coarse.default;
    const coarseUp = stepper.adjust("vco1Coarse", coarseStart, "ArrowUp", 0.01)!;
    expect(Math.round(paramToNormalized("vco1Coarse", coarseUp) * 1000))
      .toBeGreaterThan(Math.round(paramToNormalized("vco1Coarse", coarseStart) * 1000));
    expect(formatParamValue("vco1Coarse", coarseUp * 0.01))
      .not.toBe(formatParamValue("vco1Coarse", coarseStart * 0.01));
    expect(stepper.adjust("vco1Coarse", coarseUp, "ArrowDown", 0.01)).toBe(coarseStart);
  });

  it("invalidates reversible Arrow history when the dial loses focus", () => {
    const stepper = new ReversibleRangeKeyboardStepper();
    const start = PARAM_SPECS.pedalPosition.default;
    const up = stepper.adjust("pedalPosition", start, "ArrowUp")!;

    stepper.reset();
    const laterDown = stepper.adjust("pedalPosition", up, "ArrowDown")!;
    expect(laterDown).not.toBe(start);
    expect(laterDown).toBeLessThan(up);

    expect(parameterControlsSource).toMatch(
      /aria-describedby=\{`param-\$\{param\}-range`}\s+onBlur=\{\(\) => keyboardStepper\.current\?\.reset\(\)}/,
    );
  });

  it("clamps Arrow keys, reaches endpoints, and keeps page motion normalized", () => {
    expect(keyboardAdjustedRangeValue("masterTune", 100, "ArrowRight")).toBe(100);
    expect(keyboardAdjustedRangeValue("masterTune", -100, "ArrowLeft")).toBe(-100);
    expect(keyboardAdjustedRangeValue("filterCutoff", 4_200, "Home")).toBe(16);
    expect(keyboardAdjustedRangeValue("filterCutoff", 4_200, "End")).toBe(16_000);
    expect(keyboardAdjustedRangeValue("filterCutoff", 4_200, "PageUp"))
      .toBeGreaterThan(4_200);
    expect(keyboardAdjustedRangeValue("filterCutoff", 4_200, "PageDown"))
      .toBeLessThan(4_200);
    expect(keyboardAdjustedRangeValue("masterTune", 0, "Escape")).toBeUndefined();
  });

  it("provides exact Arrow and endpoint behavior for every range parameter", () => {
    const rangeParams = PARAM_KEYS.filter((param) => PARAM_SPECS[param].control === "range");
    expect(rangeParams.length).toBeGreaterThan(0);

    for (const param of rangeParams) {
      const spec = PARAM_SPECS[param];
      const middle = normalizedToParam(param, 0.5);
      expect(
        keyboardAdjustedRangeValue(param, middle, "ArrowUp"),
        `${param} ArrowUp`,
      ).toBeGreaterThan(middle);
      expect(
        keyboardAdjustedRangeValue(param, middle, "ArrowDown"),
        `${param} ArrowDown`,
      ).toBeLessThan(middle);
      expect(keyboardAdjustedRangeValue(param, spec.min, "ArrowDown"), `${param} lower clamp`)
        .toBe(spec.min);
      expect(keyboardAdjustedRangeValue(param, spec.max, "ArrowUp"), `${param} upper clamp`)
        .toBe(spec.max);
      expect(keyboardAdjustedRangeValue(param, middle, "Home"), `${param} Home`)
        .toBe(spec.min);
      expect(keyboardAdjustedRangeValue(param, middle, "End"), `${param} End`)
        .toBe(spec.max);

      const up = keyboardAdjustedRangeValue(param, middle, "ArrowUp")!;
      const down = keyboardAdjustedRangeValue(param, middle, "ArrowDown")!;
      const middlePosition = Math.round(paramToNormalized(param, middle) * 1000);
      expect(Math.round(paramToNormalized(param, up) * 1000), `${param} visible ArrowUp`)
        .toBeGreaterThan(middlePosition);
      expect(Math.round(paramToNormalized(param, down) * 1000), `${param} visible ArrowDown`)
        .toBeLessThan(middlePosition);
      expect(formatParamValue(param, up), `${param} announced ArrowUp`)
        .not.toBe(formatParamValue(param, middle));
      expect(formatParamValue(param, down), `${param} announced ArrowDown`)
        .not.toBe(formatParamValue(param, middle));

      const upwardStepper = new ReversibleRangeKeyboardStepper();
      const perceptibleUp = upwardStepper.adjust(param, middle, "ArrowUp")!;
      expect(
        upwardStepper.adjust(param, perceptibleUp, "ArrowDown"),
        `${param} exact interior Arrow reversal`,
      ).toBe(middle);

      const fromMinimum = new ReversibleRangeKeyboardStepper();
      const minimumUp = fromMinimum.adjust(param, spec.min, "ArrowUp")!;
      expect(minimumUp, `${param} lower endpoint inward movement`).toBeGreaterThan(spec.min);
      expect(
        fromMinimum.adjust(param, minimumUp, "ArrowDown"),
        `${param} exact lower endpoint reversal`,
      ).toBe(spec.min);

      const fromMaximum = new ReversibleRangeKeyboardStepper();
      const maximumDown = fromMaximum.adjust(param, spec.max, "ArrowDown")!;
      expect(maximumDown, `${param} upper endpoint inward movement`).toBeLessThan(spec.max);
      expect(
        fromMaximum.adjust(param, maximumDown, "ArrowUp"),
        `${param} exact upper endpoint reversal`,
      ).toBe(spec.max);
    }
  });
});

describe("direct-entry interruption listener registry", () => {
  class FakeEventTarget {
    hidden = false;
    readonly added = new Map<string, number>();
    readonly removed = new Map<string, number>();
    private readonly listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();

    addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
      const listeners = this.listeners.get(type) ?? new Set<EventListenerOrEventListenerObject>();
      listeners.add(listener);
      this.listeners.set(type, listeners);
      this.added.set(type, (this.added.get(type) ?? 0) + 1);
    }

    removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
      this.listeners.get(type)?.delete(listener);
      this.removed.set(type, (this.removed.get(type) ?? 0) + 1);
    }

    dispatch(type: string): void {
      const event = new Event(type);
      for (const listener of this.listeners.get(type) ?? []) {
        if (typeof listener === "function") listener(event);
        else listener.handleEvent(event);
      }
    }
  }

  it("shares one listener pair and removes it after the final subscriber", () => {
    const windowTarget = new FakeEventTarget();
    const documentTarget = new FakeEventTarget();
    const registry = new DirectEntryInterruptionRegistry(windowTarget, documentTarget);
    const first = vi.fn();
    const second = vi.fn();
    const unsubscribeFirst = registry.subscribe(first);
    const unsubscribeSecond = registry.subscribe(second);

    expect(registry.subscriberCount).toBe(2);
    expect(windowTarget.added.get("blur")).toBe(1);
    expect(documentTarget.added.get("visibilitychange")).toBe(1);
    windowTarget.dispatch("blur");
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);

    documentTarget.hidden = false;
    documentTarget.dispatch("visibilitychange");
    expect(first).toHaveBeenCalledTimes(1);
    documentTarget.hidden = true;
    documentTarget.dispatch("visibilitychange");
    expect(first).toHaveBeenCalledTimes(2);
    expect(second).toHaveBeenCalledTimes(2);

    unsubscribeFirst();
    expect(windowTarget.removed.get("blur")).toBeUndefined();
    unsubscribeSecond();
    expect(registry.subscriberCount).toBe(0);
    expect(windowTarget.removed.get("blur")).toBe(1);
    expect(documentTarget.removed.get("visibilitychange")).toBe(1);
  });
});

describe("direct-entry long-press gesture tracking", () => {
  const pointer = (
    pointerType: string,
    overrides: Partial<{
      pointerId: number;
      button: number;
      isPrimary: boolean;
      clientX: number;
      clientY: number;
    }> = {},
  ) => ({
    pointerId: overrides.pointerId ?? 7,
    pointerType,
    button: overrides.button ?? 0,
    isPrimary: overrides.isPrimary ?? true,
    clientX: overrides.clientX ?? 100,
    clientY: overrides.clientY ?? 100,
  });

  it("opens exact entry after a primary mouse, touch, or pen hold", () => {
    for (const pointerType of ["mouse", "touch", "pen"]) {
      let callback: (() => void) | undefined;
      const activate = vi.fn();
      const setTimer = vi.fn((next: () => void) => {
        callback = next;
        return 91;
      });
      const clearTimer = vi.fn();
      const tracker = new DirectEntryLongPressTracker(setTimer, clearTimer);

      expect(tracker.begin(pointer(pointerType), activate), pointerType).toBe(true);
      expect(setTimer, pointerType).toHaveBeenCalledExactlyOnceWith(
        expect.any(Function),
        DIRECT_ENTRY_LONG_PRESS_DELAY_MS,
      );
      callback?.();
      expect(activate, pointerType).toHaveBeenCalledTimes(1);
      expect(tracker.end(7), pointerType).toBe(true);
      // A timer that has already fired is not cleared a second time.
      expect(clearTimer, pointerType).not.toHaveBeenCalled();
    }
  });

  it("leaves right click to context-menu handling and ignores secondary pointers", () => {
    const setTimer = vi.fn(() => 92);
    const tracker = new DirectEntryLongPressTracker(setTimer, vi.fn());

    expect(shouldStartDirectEntryLongPress(pointer("mouse"))).toBe(true);
    expect(shouldStartDirectEntryLongPress(pointer("mouse", { button: 2 }))).toBe(false);
    expect(shouldStartDirectEntryLongPress(pointer("touch", { isPrimary: false }))).toBe(false);
    expect(tracker.begin(pointer("mouse", { button: 2 }), vi.fn())).toBe(false);
    expect(tracker.begin(pointer("touch", { isPrimary: false }), vi.fn())).toBe(false);
    expect(setTimer).not.toHaveBeenCalled();
  });

  it("tolerates finger drift while cancelling deliberate dial movement", () => {
    const callbacks = new Map<number, () => void>();
    let nextTimer = 100;
    const clearTimer = vi.fn((timerId: number) => callbacks.delete(timerId));
    const tracker = new DirectEntryLongPressTracker(
      (callback) => {
        const timerId = nextTimer++;
        callbacks.set(timerId, callback);
        return timerId;
      },
      clearTimer,
    );
    const touchActivation = vi.fn();

    tracker.begin(pointer("touch"), touchActivation);
    expect(tracker.move(99, 500, 500)).toBe(false);
    expect(tracker.move(7, 117, 100)).toBe(true);
    callbacks.get(100)?.();
    expect(touchActivation).toHaveBeenCalledTimes(1);
    tracker.end(7);

    const cancelledTouchActivation = vi.fn();
    tracker.begin(pointer("touch"), cancelledTouchActivation);
    expect(tracker.move(7, 119, 100)).toBe(false);
    expect(clearTimer).toHaveBeenCalledWith(101);
    expect(callbacks.has(101)).toBe(false);
    expect(cancelledTouchActivation).not.toHaveBeenCalled();

    const mouseActivation = vi.fn();
    tracker.begin(pointer("mouse"), mouseActivation);
    expect(tracker.move(7, 109, 100)).toBe(false);
    expect(callbacks.has(102)).toBe(false);
    expect(mouseActivation).not.toHaveBeenCalled();
  });

  it("ignores unrelated terminal events and owns cancellation cleanup", () => {
    const callbacks = new Map<number, () => void>();
    const clearTimer = vi.fn((timerId: number) => callbacks.delete(timerId));
    const activate = vi.fn();
    const tracker = new DirectEntryLongPressTracker(
      (callback) => {
        callbacks.set(110, callback);
        return 110;
      },
      clearTimer,
    );

    tracker.begin(pointer("touch"), activate);
    expect(tracker.end(8)).toBe(false);
    expect(callbacks.has(110)).toBe(true);
    tracker.cancel();
    expect(clearTimer).toHaveBeenCalledExactlyOnceWith(110);
    expect(callbacks.size).toBe(0);
    expect(tracker.end(7)).toBe(false);
    expect(activate).not.toHaveBeenCalled();
  });

  it("wires the all-pointer tracker into parameter capture handlers", () => {
    expect(parameterControlsSource).toContain("if (!shouldStartDirectEntryLongPress(event)) return;");
    expect(parameterControlsSource).not.toContain('if (event.pointerType === "mouse")');
    expect(parameterControlsSource).toContain(
      "longPress.current?.move(event.pointerId, event.clientX, event.clientY);",
    );
    expect(parameterControlsSource).toContain(
      "if (!longPress.current?.end(event.pointerId)) return;",
    );
  });
});

describe("direct-entry long-press click suppression", () => {
  it("consumes only the pointer click belonging to the gesture", () => {
    expect(shouldConsumeLongPressClick(true, 1)).toBe(true);
    expect(shouldConsumeLongPressClick(true, 2)).toBe(true);
    expect(shouldConsumeLongPressClick(true, 0)).toBe(false);
    expect(shouldConsumeLongPressClick(false, 1)).toBe(false);
  });

  it("expires a cancelled gesture latch at the next task boundary", () => {
    const callbacks = new Map<number, () => void>();
    const setTimer = vi.fn((callback: () => void) => {
      callbacks.set(41, callback);
      return 41;
    });
    const clearTimer = vi.fn((timerId: number) => callbacks.delete(timerId));
    const suppression = new LongPressClickSuppression(setTimer, clearTimer);

    suppression.arm();
    suppression.expireAfterGesture();
    expect(setTimer).toHaveBeenCalledExactlyOnceWith(expect.any(Function), 0);

    callbacks.get(41)?.();
    expect(suppression.consumeClick(1)).toBe(false);
  });

  it("still consumes the current gesture click before expiry", () => {
    const callbacks = new Map<number, () => void>();
    const setTimer = vi.fn((callback: () => void) => {
      callbacks.set(42, callback);
      return 42;
    });
    const clearTimer = vi.fn((timerId: number) => callbacks.delete(timerId));
    const suppression = new LongPressClickSuppression(setTimer, clearTimer);

    suppression.arm();
    suppression.expireAfterGesture();

    expect(suppression.consumeClick(1)).toBe(true);
    expect(clearTimer).toHaveBeenCalledExactlyOnceWith(42);
    expect(callbacks.size).toBe(0);
    expect(suppression.consumeClick(1)).toBe(false);
  });

  it("never swallows an independent keyboard or assistive click", () => {
    const suppression = new LongPressClickSuppression(vi.fn(() => 43), vi.fn());

    suppression.arm();
    expect(suppression.consumeClick(0)).toBe(false);
    expect(suppression.consumeClick(1)).toBe(false);
  });

  it("clears its owned expiry timer on reset and disposal", () => {
    let nextTimer = 50;
    const setTimer = vi.fn(() => nextTimer++);
    const clearTimer = vi.fn();
    const suppression = new LongPressClickSuppression(setTimer, clearTimer);

    suppression.arm();
    suppression.expireAfterGesture();
    suppression.reset();
    suppression.arm();
    suppression.expireAfterGesture();
    suppression.dispose();

    expect(clearTimer.mock.calls.map(([timerId]) => timerId)).toEqual([50, 51]);
    expect(suppression.consumeClick(1)).toBe(false);
  });
});

describe("cancellable device connection controls", () => {
  it("keeps the external-input action enabled while a permission request is pending", () => {
    const markup = renderToStaticMarkup(createElement(ExternalInputControl, {
      enabled: false,
      busy: true,
      error: null,
      onToggle: vi.fn(),
    }));

    expect(markup).toContain("Cancel connection");
    expect(markup).not.toContain("disabled");
  });

  it("keeps MIDI cancellation available while disabling a concurrent refresh", () => {
    const markup = renderToStaticMarkup(createElement(MidiInputControl, {
      supported: true,
      unsupportedReason: null,
      enabled: true,
      operation: "refreshing",
      error: null,
      inputs: [],
      onToggle: vi.fn(),
      onRefresh: vi.fn(),
    }));

    expect(markup).toContain("Cancel MIDI");
    const buttons = markup.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) ?? [];
    const refresh = buttons.find((button) => button.includes(">Refresh</span>")) ?? "";
    const cancel = buttons.find((button) => button.includes(">Cancel MIDI</span>")) ?? "";
    expect(refresh).toContain('aria-disabled="true"');
    expect(refresh).not.toContain('disabled=""');
    expect(cancel).not.toBe("");
    expect(cancel).not.toContain('aria-disabled="true"');
  });
});

describe("user patch library dialogs", () => {
  it("renders a labeled name field and explains trim and confirmed replacement rules", () => {
    const markup = renderToStaticMarkup(createElement(PatchLibraryDialog, {
      mode: "save",
      patchNames: ["Bass"],
      origin: null,
      onSave: vi.fn(),
      onReplace: vi.fn(),
      onLoad: vi.fn(),
      onClose: vi.fn(),
    }));

    expect(markup).toContain("Save patch");
    expect(markup).toContain('id="patch-library-name"');
    expect(markup).toContain("Leading and trailing whitespace is removed");
    expect(markup).toContain("Matching names can be replaced after confirmation");
    expect(markup).toContain("regardless of capitalization");
  });

  it("renders saved names as explicit radio choices without loading on selection", () => {
    const onLoad = vi.fn();
    const markup = renderToStaticMarkup(createElement(PatchLibraryDialog, {
      mode: "load",
      patchNames: ["Bass", "Wide Pad"],
      origin: null,
      onSave: vi.fn(),
      onReplace: vi.fn(),
      onLoad,
      onClose: vi.fn(),
    }));

    expect(markup.match(/type="radio"/g)).toHaveLength(2);
    expect(markup).toContain("Bass");
    expect(markup).toContain("Wide Pad");
    expect(markup).toContain("Load selected");
    expect(onLoad).not.toHaveBeenCalled();
  });

  it("keeps the empty library understandable and disables loading", () => {
    const markup = renderToStaticMarkup(createElement(PatchLibraryDialog, {
      mode: "load",
      patchNames: [],
      origin: null,
      onSave: vi.fn(),
      onReplace: vi.fn(),
      onLoad: vi.fn(),
      onClose: vi.fn(),
    }));

    expect(markup).toContain("No user patches have been saved");
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Load selected<\/button>/);
  });

  it("uses a cancellable, two-stage replacement confirmation without weakening load mode", () => {
    const source = patchLibraryDialogSource;
    const replacementStart = source.indexOf("if (saveConflict)");
    const replacementEnd = source.indexOf("const backdropClose", replacementStart);
    const replacement = source.slice(replacementStart, replacementEnd);

    expect(source).toContain('readonly status: "duplicate"');
    expect(source).toContain("readonly existingPatch: UserPatch");
    expect(source).toContain("export type PatchSaveOutcome = string | null | PatchSaveConflict");
    expect(source).toContain("onReplace: (");
    expect(source).toContain("signal: AbortSignal");
    expect(source).toContain('"Replace saved patch?"');
    expect(source).toContain("replaceCancelRef.current?.focus()");
    expect(source).toContain("active.replacementController?.abort(");
    expect(source).toContain("if (busyRef.current) return;");
    expect(replacementStart).toBeGreaterThanOrEqual(0);
    expect(replacement).toContain("new AbortController()");
    expect(replacement).toContain("onReplace(expected, controller.signal)");
    expect(replacement).toContain("setSaveConflict(null)");
    expect(replacement).toContain("setNameFocusRequest");

    const confirmationActions = source.slice(
      source.indexOf("{saveConflict ? (", source.indexOf('className="modal-actions"')),
      source.indexOf(") : (", source.indexOf("{saveConflict ? (", source.indexOf('className="modal-actions"'))),
    );
    expect(confirmationActions).toMatch(/>\s*Cancel\s*<\/button>/);
    expect(confirmationActions).toMatch(/>\s*Replace\s*<\/button>/);
    expect(confirmationActions).not.toMatch(/ref=\{replaceCancelRef\}[\s\S]*?disabled=\{busy\}[\s\S]*?>\s*Cancel/);
  });
});

describe("local-library deletion confirmation", () => {
  it.each([
    ["patch", "Acid <Lead>", "Delete patch?", "Delete patch"],
    ["recording", "First & Last", "Delete recording?", "Delete recording"],
  ] as const)("renders an accessible, non-implicit %s deletion", (kind, name, title, action) => {
    const onConfirm = vi.fn();
    const markup = renderToStaticMarkup(createElement(DeleteConfirmationDialog, {
      kind,
      name,
      origin: null,
      onConfirm,
      onClose: vi.fn(),
    }));

    expect(markup).toContain('aria-labelledby="delete-confirmation-title"');
    expect(markup).toContain('aria-describedby="delete-confirmation-description delete-confirmation-error"');
    expect(markup).toContain(title);
    expect(markup).toContain(action);
    expect(markup).toContain("This cannot be undone");
    expect(markup).not.toContain(name);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("settles promptly when cancellation revokes a pending confirmation", async () => {
    let settleOperation!: (value: string) => void;
    const operation = new Promise<string>((resolve) => {
      settleOperation = resolve;
    });
    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, "removeEventListener");
    const result = raceDeleteConfirmationWithAbort(operation, controller.signal);

    controller.abort(new DOMException("Closed by the user.", "AbortError"));
    await expect(result).rejects.toMatchObject({
      name: "AbortError",
      message: "Closed by the user.",
    });
    expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));

    // A consumer that ignores its signal may still settle later, but it cannot
    // revive the already-cancelled dialog continuation.
    settleOperation("late result");
    await Promise.resolve();
  });

  it("removes its abort listener after normal settlement", async () => {
    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, "removeEventListener");

    await expect(raceDeleteConfirmationWithAbort("deleted", controller.signal))
      .resolves.toBe("deleted");
    expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("rejects an already-aborted confirmation and provides a useful timeout message", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(raceDeleteConfirmationWithAbort(null, controller.signal))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(deleteConfirmationTimeoutMessage("patch")).toBe(
      "Deleting this patch timed out and may already have completed. Review the library before retrying.",
    );
  });
});

describe("help dialog", () => {
  it("concisely covers every supported playing interface without documenting synth settings", () => {
    const markup = renderToStaticMarkup(createElement(HelpDialog, {
      origin: null,
      onClose: vi.fn(),
    }));

    for (const label of [
      "Screen keys",
      "Computer keys",
      "Keyboard focus",
      "MIDI keyboard",
      "Live audio",
      "Hands-free",
      "Note sequencer",
    ]) expect(markup).toContain(label);
    expect(markup).toContain("A S D F G H J K L ;");
    expect(markup).toContain("W E T Y U O P");
    expect(markup).toContain("Click or Tab to a piano key");
    expect(markup).toContain("Close help");
    expect(markup).not.toMatch(/cutoff|resonance|delay time|envelope/i);
  });
});
