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
import { OutputMeter, outputPeakPercent } from "./OutputMeter";
import {
  DirectEntryInterruptionRegistry,
  shouldConsumeLongPressClick,
  shouldEmitRangeChange,
} from "./ParameterControls";
import { ExternalInputControl } from "./ExternalInputControl";
import { HelpDialog } from "./HelpDialog";
import { MidiInputControl } from "./MidiInputControl";
import { PatchLibraryDialog } from "./PatchLibraryDialog";
import {
  clearPpcOwnership,
  isPadActivationKey,
  PpcPads,
  ppcPointerDepth,
  shouldToggleAssistivePad,
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
    }));

    expect(markup.match(/class="piano-key /g)).toHaveLength(37);
    expect(markup.match(/aria-keyshortcuts="Enter Space"/g)).toHaveLength(37);
    expect(markup.match(/aria-pressed="false"/g)).toHaveLength(37);
    expect(markup).toContain('role="group" aria-label="On-screen keyboard"');
    expect(markup.match(/data-keyboard-row="true"/g)).toHaveLength(1);
    expect(markup).toContain('aria-label="C2 through C5"');
    expect(markup).not.toContain("Scrollable on-screen keyboard");
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
  it("exposes a clamped, finite percentage through the meter role", () => {
    const markup = renderToStaticMarkup(createElement(OutputMeter, { peak: 0.426 }));

    expect(markup).toContain('role="meter"');
    expect(markup).toContain('aria-label="Output peak"');
    expect(markup).toContain('aria-valuemin="0"');
    expect(markup).toContain('aria-valuemax="100"');
    expect(markup).toContain('aria-valuenow="43"');
    expect(markup).toContain('aria-valuetext="43 percent"');
  });

  it("normalizes invalid and out-of-range peaks", () => {
    expect(outputPeakPercent(Number.NaN)).toBe(0);
    expect(outputPeakPercent(Number.POSITIVE_INFINITY)).toBe(0);
    expect(outputPeakPercent(-0.1)).toBe(0);
    expect(outputPeakPercent(1.1)).toBe(100);
  });
});

describe("range control change filtering", () => {
  it("does not emit an unchanged value but preserves real edits", () => {
    expect(shouldEmitRangeChange(0.5, 0.5)).toBe(false);
    expect(shouldEmitRangeChange(0.5, 0.51)).toBe(true);
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

describe("direct-entry long-press click suppression", () => {
  it("consumes only the pointer click belonging to the gesture", () => {
    expect(shouldConsumeLongPressClick(true, 1)).toBe(true);
    expect(shouldConsumeLongPressClick(true, 2)).toBe(true);
    expect(shouldConsumeLongPressClick(true, 0)).toBe(false);
    expect(shouldConsumeLongPressClick(false, 1)).toBe(false);
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
      busy: true,
      error: null,
      inputs: [],
      onToggle: vi.fn(),
      onRefresh: vi.fn(),
    }));

    expect(markup).toContain("Cancel MIDI");
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Refresh<\/button>/);
    expect(markup).toMatch(/<button[^>]*>Cancel MIDI<\/button>/);
  });
});

describe("user patch library dialogs", () => {
  it("renders a labeled name field and explains trim and uniqueness rules", () => {
    const markup = renderToStaticMarkup(createElement(PatchLibraryDialog, {
      mode: "save",
      patchNames: ["Bass"],
      origin: null,
      onSave: vi.fn(),
      onLoad: vi.fn(),
      onClose: vi.fn(),
    }));

    expect(markup).toContain("Save patch");
    expect(markup).toContain('id="patch-library-name"');
    expect(markup).toContain("Leading and trailing whitespace is removed");
    expect(markup).toContain("regardless of capitalization");
  });

  it("renders saved names as explicit radio choices without loading on selection", () => {
    const onLoad = vi.fn();
    const markup = renderToStaticMarkup(createElement(PatchLibraryDialog, {
      mode: "load",
      patchNames: ["Bass", "Wide Pad"],
      origin: null,
      onSave: vi.fn(),
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
      onLoad: vi.fn(),
      onClose: vi.fn(),
    }));

    expect(markup).toContain("No user patches have been saved");
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Load selected<\/button>/);
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
