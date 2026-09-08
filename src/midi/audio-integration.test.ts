import { describe, expect, it, vi } from "vitest";
import appSource from "../App.tsx?raw";
import {
  recoverAfterMidiAllSoundOff,
  type MidiAllSoundOffTarget,
} from "./audio-integration";

const makeTarget = (): { target: MidiAllSoundOffTarget; calls: string[] } => {
  const calls: string[] = [];
  return {
    calls,
    target: {
      allSoundOff: vi.fn(() => calls.push("all-sound-off")),
      noteOn: vi.fn((note) => calls.push(`note-on:${note}`)),
      resumeSound: vi.fn(() => calls.push("resume-sound")),
    },
  };
};

describe("App MIDI CC120 audio recovery", () => {
  it("hard-clears first and restores each remaining channel/interface pitch once", () => {
    const { target, calls } = makeTarget();

    recoverAfterMidiAllSoundOff(target, [60, 67, 60, 72, 67], false);

    expect(calls).toEqual([
      "all-sound-off",
      "note-on:60",
      "note-on:67",
      "note-on:72",
    ]);
  });

  it("leaves a source-free voice hard-muted after clearing delay and envelopes", () => {
    const { target, calls } = makeTarget();

    recoverAfterMidiAllSoundOff(target, [], false);

    expect(calls).toEqual(["all-sound-off"]);
  });

  it("resumes AUTO or external input only after surviving note owners are rebuilt", () => {
    const { target, calls } = makeTarget();

    recoverAfterMidiAllSoundOff(target, [64, 64], true);

    expect(calls).toEqual([
      "all-sound-off",
      "note-on:64",
      "resume-sound",
    ]);
  });

  it("keeps the App callback wired without bypassing AUTO or external input", () => {
    const start = appSource.indexOf("const midiAllSoundOff = useCallback");
    const end = appSource.indexOf("if (!midiSessionRef.current)", start);
    const callback = appSource.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(callback).toContain("recoverAfterMidiAllSoundOff(");
    expect(callback).toContain("noteSources.current.values()");
    expect(callback).toContain("paramsRef.current.autoRun > 0.5 || externalInputEnabledRef.current");
    expect(callback).not.toMatch(/(?:autoRun|externalInputEnabledRef)[^;]*\) return;/);
  });
});

describe("App MIDI performance and recording contracts", () => {
  it("routes hardware note down/up through recording but keeps wheels out of the take", () => {
    const noteStart = appSource.indexOf("const noteOn = useCallback");
    const releaseStart = appSource.indexOf("const releasePhysicalNotes", noteStart);
    const noteCallbacks = appSource.slice(noteStart, releaseStart);
    const wheelStart = appSource.indexOf("const midiPitchBend = useCallback");
    const cc120Start = appSource.indexOf("const midiAllSoundOff", wheelStart);
    const wheelCallbacks = appSource.slice(wheelStart, cc120Start);
    const handlerStart = appSource.indexOf("session.setHandlers({");
    const handlerEnd = appSource.indexOf("});", handlerStart);
    const handlers = appSource.slice(handlerStart, handlerEnd);

    expect(noteCallbacks).toContain("sequenceRecorderRef.current?.noteOn(source, note)");
    expect(noteCallbacks).toContain("sequenceRecorderRef.current?.noteOff(source)");
    expect(noteCallbacks).toContain("!source.startsWith(SEQUENCE_SOURCE_PREFIX)");
    expect(wheelCallbacks).not.toContain("sequenceRecorderRef");
    expect(handlers).toMatch(/noteOn,\s*noteOff,\s*pitchBend: midiPitchBend,\s*modulation: midiModulation,/);
  });

  it("recomputes held wheel values for range changes, patch loads, and power replay", () => {
    const changeStart = appSource.indexOf("const changeParam = useCallback");
    const editorStart = appSource.indexOf("const openDirectEditor", changeStart);
    const changeParam = appSource.slice(changeStart, editorStart);
    expect(changeParam).toContain('key === "ppcBendRange" || key === "ppcVibratoRange"');
    expect(changeParam).toContain("syncPerformance(next)");

    for (const marker of [
      "Shared patch loaded from the URL.",
      "const applyPatch = useCallback",
      "const loadNamedPatch = useCallback",
    ]) {
      const index = appSource.indexOf(marker);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(appSource.slice(Math.max(0, index - 700), index + 900)).toContain("syncPerformance(next)");
    }

    const powerStart = appSource.indexOf("const togglePower = async");
    const playStart = appSource.indexOf("const playSequence", powerStart);
    const power = appSource.slice(powerStart, playStart);
    expect(power).toMatch(/await engine\.powerOn\(paramsRef\.current\);[\s\S]*?noteSources\.current\.values\(\)[\s\S]*?syncPerformance\(\)/);
  });

  it("panic invalidates MIDI ownership and neutralizes both wheels", () => {
    const start = appSource.indexOf("const releasePhysicalNotes = useCallback");
    const end = appSource.indexOf("const releaseUiNotes", start);
    const release = appSource.slice(start, end);

    expect(release).toContain("noteSources.current.clear()");
    expect(release).toContain("noteOwnerCounts.current.clear()");
    expect(release).toContain("midiSessionRef.current?.forgetHeldNotes()");
    expect(release).toContain("midiBendNormalized: 0");
    expect(release).toContain("midiModNormalized: 0");
    expect(release).toContain("engine.allNotesOff()");
    expect(release).toContain("engine.setPerformance({ bendSemitones: 0, vibratoSemitones: 0 })");
  });
});
