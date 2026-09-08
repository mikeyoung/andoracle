import { afterEach, describe, expect, it, vi } from "vitest";
import { NoteOwnershipIndex } from "../note-ownership";
import { NoteSequenceRecorder, type MonotonicClock, type SequenceTimerApi } from "../sequencer/transport";
import { recoverAfterMidiAllSoundOff, type MidiAllSoundOffTarget } from "./audio-integration";
import { WebMidiSession, type WebMidiHandlers } from "./web-midi";

class FakeMidiInput {
  readonly id = "integration-keys";
  readonly name = "Integration Keys";
  readonly manufacturer = "Test";
  readonly type = "input" as const;
  readonly version = "1";
  state: MIDIPortDeviceState = "connected";
  connection: MIDIPortConnectionState = "closed";
  onmidimessage: ((event: MIDIMessageEvent) => void) | null = null;
  readonly open = vi.fn(async () => {
    this.connection = "open";
    return this as unknown as MIDIInput;
  });
  readonly close = vi.fn(async () => {
    this.connection = "closed";
    return this as unknown as MIDIInput;
  });

  emit(data: readonly number[]): void {
    this.onmidimessage?.({ data: Uint8Array.from(data) } as MIDIMessageEvent);
  }
}

class FakeMidiAccess extends EventTarget {
  readonly inputs = new Map<string, MIDIInput>();
  readonly outputs = new Map<string, MIDIOutput>();
  readonly sysexEnabled = false;
  onstatechange: ((event: MIDIConnectionEvent) => void) | null = null;
}

class ManualClock implements MonotonicClock {
  value = 0;
  now(): number {
    return this.value;
  }
}

const inertTimers: SequenceTimerApi = {
  setTimeout: () => 1,
  clearTimeout: () => undefined,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Web MIDI through App-style audio and recorder routing", () => {
  it("captures exact MIDI key-down/up timing, excludes wheels and pedals, and restores surviving channels after CC120", async () => {
    const input = new FakeMidiInput();
    const access = new FakeMidiAccess();
    access.inputs.set(input.id, input as unknown as MIDIInput);
    vi.stubGlobal("window", { isSecureContext: true });
    vi.stubGlobal("navigator", {
      requestMIDIAccess: vi.fn(async () => access as unknown as MIDIAccess),
    });

    const clock = new ManualClock();
    const recorder = new NoteSequenceRecorder(() => undefined, clock, inertTimers);
    const sources = new Map<string, number>();
    const owners = new NoteOwnershipIndex();
    const audioCalls: string[] = [];
    const audio: MidiAllSoundOffTarget & { noteOff(note: number): void; keyboardTrigger(): void } = {
      allSoundOff: () => audioCalls.push("all-sound-off"),
      resumeSound: () => audioCalls.push("resume-sound"),
      noteOn: (note) => audioCalls.push(`note-on:${note}`),
      noteOff: (note) => audioCalls.push(`note-off:${note}`),
      keyboardTrigger: () => audioCalls.push("keyboard-trigger"),
    };
    const pitchBends: number[] = [];
    const modulations: number[] = [];

    const handlers: WebMidiHandlers = {
      noteOn: (source, note) => {
        recorder.noteOn(source, note);
        sources.set(source, note);
        if (owners.add(note)) audio.noteOn(note);
        else audio.keyboardTrigger();
      },
      noteOff: (source) => {
        const note = sources.get(source);
        if (note === undefined) return;
        recorder.noteOff(source);
        sources.delete(source);
        if (owners.remove(note)) audio.noteOff(note);
      },
      pitchBend: (value) => pitchBends.push(value),
      modulation: (value) => modulations.push(value),
      allSoundOff: () => recoverAfterMidiAllSoundOff(audio, sources.values(), false),
      inputsChanged: () => undefined,
      error: (message) => { throw new Error(message); },
    };
    const session = new WebMidiSession(handlers);
    await session.connect();
    recorder.start();

    input.emit([0x90, 60, 100]);
    clock.value = 25;
    input.emit([0x91, 67, 127]);
    clock.value = 90;
    input.emit([0xe0, 0x7f, 0x7f]);
    input.emit([0xb1, 1, 64]);
    input.emit([0xb1, 64, 127]);
    clock.value = 100;
    input.emit([0xb0, 120, 0]);
    clock.value = 160;
    input.emit([0x81, 67, 0]);

    expect(recorder.finish()).toEqual({
      events: [
        { deltaMs: 0, note: 60, on: true },
        { deltaMs: 25, note: 67, on: true },
        { deltaMs: 75, note: 60, on: false },
        { deltaMs: 60, note: 67, on: false },
      ],
      durationMs: 160,
      noteCount: 2,
    });
    expect(pitchBends).toEqual([1]);
    expect(modulations).toEqual([64 / 127]);
    expect(audioCalls).toEqual([
      "note-on:60",
      "note-on:67",
      "note-off:60",
      "all-sound-off",
      "note-on:67",
      "note-off:67",
    ]);

    await session.disconnect();
    recorder.dispose();
  });
});
