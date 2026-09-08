import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  blocksComputerKeyboardNotes,
  COMPUTER_KEYBOARD_TEXT_ENTRY_SELECTOR,
  reservesComputerKeyboardChord,
} from "../src/computer-keyboard";
import {
  MidiInputControl,
  midiInputDisplayName,
  midiInputListLabel,
  type MidiInputOperation,
} from "../src/components/MidiInputControl";

const renderMidi = (overrides: Partial<Parameters<typeof MidiInputControl>[0]> = {}): string => (
  renderToStaticMarkup(createElement(MidiInputControl, {
    supported: true,
    unsupportedReason: null,
    enabled: false,
    operation: null,
    error: null,
    inputs: [],
    onToggle: vi.fn(),
    onRefresh: vi.fn(),
    ...overrides,
  }))
);

describe("MIDI connection UI", () => {
  it("associates unsupported security guidance with the unavailable action", () => {
    const markup = renderMidi({
      supported: false,
      unsupportedReason: "MIDI requires HTTPS or a localhost address.",
    });

    expect(markup).toContain('aria-busy="false"');
    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain('aria-atomic="true"');
    expect(markup).toContain("MIDI requires HTTPS or a localhost address. Touch and computer keys still work.");
    expect(markup).toMatch(/<button[^>]*aria-describedby="([^"]+)"[^>]*disabled=""[^>]*>Connect MIDI<\/button>/);
    expect(markup).toMatch(/<small id="([^"]+)"[^>]*role="status"/);
  });

  it("identifies connected inputs with manufacturer names without redundant duplication", () => {
    const inputs = [
      { id: "one", name: "Launchkey 49", manufacturer: "Novation" },
      { id: "two", name: "Roland A-49", manufacturer: "Roland" },
    ] as const;

    expect(midiInputDisplayName(inputs[0])).toBe("Launchkey 49 (Novation)");
    expect(midiInputDisplayName(inputs[1])).toBe("Roland A-49");
    expect(midiInputListLabel(inputs)).toBe("Launchkey 49 (Novation), Roland A-49");
    expect(renderMidi({ enabled: true, inputs })).toContain(
      "2 MIDI inputs: Launchkey 49 (Novation), Roland A-49",
    );
  });

  it("keeps working input names visible alongside a partial port failure", () => {
    const markup = renderMidi({
      enabled: true,
      error: "MIDI input error: Broken Keys did not open",
      inputs: [{ id: "working", name: "Working Keys", manufacturer: "Acme" }],
    });

    expect(markup).toContain('role="alert"');
    expect(markup).toContain('aria-live="assertive"');
    expect(markup).toContain(
      "MIDI input error: Broken Keys did not open — active 1 MIDI input: Working Keys (Acme).",
    );
  });

  it.each([
    ["connecting", false, "Waiting for MIDI permission and opening detected inputs.", "Cancel MIDI", false],
    ["refreshing", true, "Refreshing detected MIDI inputs.", "Cancel MIDI", false],
    ["disconnecting", true, "Disconnecting MIDI inputs.", "Disconnecting…", true],
    ["cancelling", true, "Cancelling the MIDI operation and disconnecting inputs.", "Cancelling…", true],
  ] as const)(
    "renders an honest, accessible %s state",
    (operation: Exclude<MidiInputOperation, null>, enabled, status, label, toggleDisabled) => {
      const markup = renderMidi({ operation, enabled });

      expect(markup).toContain('aria-busy="true"');
      expect(markup).toContain(status);
      const toggle = markup.match(new RegExp(`<button[^>]*>${label.replace("…", "…")}<\\/button>`))?.[0] ?? "";
      expect(toggle).not.toBe("");
      expect(toggle.includes('aria-disabled="true"')).toBe(toggleDisabled);
      expect(toggle).not.toMatch(/\sdisabled=""/);
      if (enabled) {
        const refresh = markup.match(/<button[^>]*>Refresh<\/button>/)?.[0] ?? "";
        expect(refresh).toContain('aria-disabled="true"');
        expect(refresh).not.toMatch(/\sdisabled=""/);
      }
    },
  );

  it("gives conditional sibling buttons stable identities so toggling does not steal focus", () => {
    const source = readFileSync(resolve("src/components/MidiInputControl.tsx"), "utf8");

    expect(source).toContain('key="refresh"');
    expect(source).toContain('key="toggle"');
  });
});

describe("computer keyboard coexistence", () => {
  const baseEvent = {
    altKey: false,
    ctrlKey: false,
    defaultPrevented: false,
    isComposing: false,
    metaKey: false,
  };

  it.each(["altKey", "ctrlKey", "metaKey", "defaultPrevented", "isComposing"] as const)(
    "leaves %s chords to the browser, assistive technology, or text composer",
    (property) => {
      expect(reservesComputerKeyboardChord({ ...baseEvent, [property]: true })).toBe(true);
    },
  );

  it("continues playing unmodified note keys while a MIDI button has focus", () => {
    let receivedSelector = "";
    const midiButton = {
      closest: (selector: string) => {
        receivedSelector = selector;
        return null;
      },
    } as unknown as EventTarget;

    expect(reservesComputerKeyboardChord(baseEvent)).toBe(false);
    expect(blocksComputerKeyboardNotes(midiButton)).toBe(false);
    expect(receivedSelector).toBe(COMPUTER_KEYBOARD_TEXT_ENTRY_SELECTOR);
  });

  it("blocks note shortcuts in native, ARIA, and every valid contenteditable text surface", () => {
    const blockedTarget = {
      closest: (selector: string) => selector === COMPUTER_KEYBOARD_TEXT_ENTRY_SELECTOR ? {} : null,
    } as unknown as EventTarget;

    expect(COMPUTER_KEYBOARD_TEXT_ENTRY_SELECTOR).toContain("[role='textbox']");
    expect(COMPUTER_KEYBOARD_TEXT_ENTRY_SELECTOR).toContain("[contenteditable]:not([contenteditable='false'])");
    expect(blocksComputerKeyboardNotes(blockedTarget)).toBe(true);
  });
});

describe("App MIDI error continuity", () => {
  it("does not overwrite a port-open error with a generic connect or refresh success", () => {
    const source = readFileSync(resolve("src/App.tsx"), "utf8");
    const connectStart = source.indexOf("const toggleMidi = useCallback");
    const refreshStart = source.indexOf("const refreshMidi = useCallback", connectStart);
    const connect = source.slice(connectStart, refreshStart);
    const refresh = source.slice(refreshStart, source.indexOf("const install =", refreshStart));

    expect(connect).toContain("if (midiErrorRef.current === null)");
    expect(refresh).toContain("if (midiErrorRef.current === null)");
    expect(connect).toMatch(/catch \(error\)[\s\S]*?updateMidiError\(message\);[\s\S]*?setNotice\(message\);/);
  });

  it("clears a recovered error even when the healthy input list is empty", () => {
    const source = readFileSync(resolve("src/App.tsx"), "utf8");
    const inputsChangedStart = source.indexOf("inputsChanged: (inputs) => {");
    const errorStart = source.indexOf("error: (message) => {", inputsChangedStart);
    const inputsChanged = source.slice(inputsChangedStart, errorStart);

    expect(inputsChanged).toContain("setMidiInputs(inputs)");
    expect(inputsChanged).toContain("updateMidiError(null)");
    expect(inputsChanged).not.toContain("inputs.length > 0");
    expect(inputsChanged).toContain("current === previousError ? recoveryNotice : current");
  });
});

describe("MIDI reset and audio-power integration", () => {
  const source = readFileSync(resolve("src/App.tsx"), "utf8");

  it("makes Panic forget MIDI ownership and center both hardware wheels", () => {
    const releaseStart = source.indexOf("const releasePhysicalNotes = useCallback");
    const releaseEnd = source.indexOf("const releaseUiNotes = useCallback", releaseStart);
    const release = source.slice(releaseStart, releaseEnd);
    const panicStart = source.indexOf("const panic =");
    const panicEnd = source.indexOf("const clearClipboardToast", panicStart);
    const panic = source.slice(panicStart, panicEnd);

    expect(release).toContain("midiSessionRef.current?.forgetHeldNotes()");
    expect(release).toContain("midiBendNormalized: 0");
    expect(release).toContain("midiModNormalized: 0");
    expect(release).toContain("engine.allNotesOff()");
    expect(release).toContain("engine.setPerformance({ bendSemitones: 0, vibratoSemitones: 0 })");
    expect(panic).toContain("setInputResetEpoch((epoch) => epoch + 1)");
    expect(panic).toContain("releasePhysicalNotes()");
  });

  it("keeps MIDI connected across power changes and replays held notes after power-on", () => {
    const powerStart = source.indexOf("const togglePower = async");
    const powerEnd = source.indexOf("const playSequence = useCallback", powerStart);
    const power = source.slice(powerStart, powerEnd);

    expect(power).toContain("for (const note of new Set(noteSources.current.values())) engine.noteOn(note)");
    expect(power).toContain("syncPerformance()");
    expect(power).not.toContain("midiSessionRef.current?.disconnect");
    expect(power).not.toContain("forgetHeldNotes");
  });
});
