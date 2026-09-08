import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MIDI_INPUT_OPEN_TIMEOUT_MS,
  WebMidiSession,
  MIDI_INPUT_CLOSE_TIMEOUT_MS,
  combinePerformanceSources,
  decodeMidiMessage,
  type MidiInputSummary,
  type WebMidiHandlers,
} from "./web-midi";

class FakeMidiInput {
  readonly id: string;
  readonly name: string;
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

  constructor(id: string, name: string) {
    this.id = id;
    this.name = name;
  }

  emit(data: number[]): void {
    this.onmidimessage?.({ data: Uint8Array.from(data) } as MIDIMessageEvent);
  }
}

class FakeMidiAccess extends EventTarget {
  readonly inputs = new Map<string, MIDIInput>();
  readonly outputs = new Map<string, MIDIOutput>();
  readonly sysexEnabled = false;
  onstatechange: ((event: MIDIConnectionEvent) => void) | null = null;
}

const makeHandlers = () => {
  const handlers: WebMidiHandlers = {
    noteOn: vi.fn(),
    noteOff: vi.fn(),
    pitchBend: vi.fn(),
    modulation: vi.fn(),
    allSoundOff: vi.fn(),
    inputsChanged: vi.fn(),
    error: vi.fn(),
  };
  return handlers;
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Web MIDI decoding", () => {
  it("covers note boundaries and velocity semantics on every MIDI channel", () => {
    for (let channel = 0; channel < 16; channel += 1) {
      expect(decodeMidiMessage([0x90 | channel, 0, 1])).toEqual({
        type: "note-on", channel, note: 0, velocity: 1 / 127,
      });
      expect(decodeMidiMessage([0x90 | channel, 127, 127])).toEqual({
        type: "note-on", channel, note: 127, velocity: 1,
      });
      expect(decodeMidiMessage([0x90 | channel, 127, 0])).toEqual({
        type: "note-off", channel, note: 127,
      });
      expect(decodeMidiMessage([0x80 | channel, 0, 127])).toEqual({
        type: "note-off", channel, note: 0,
      });
    }
  });

  it("decodes note-on, note-off, velocity-zero note-off, and all channels", () => {
    expect(decodeMidiMessage([0x90, 60, 127])).toEqual({
      type: "note-on", channel: 0, note: 60, velocity: 1,
    });
    expect(decodeMidiMessage([0x9f, 72, 64])).toMatchObject({
      type: "note-on", channel: 15, note: 72,
    });
    expect(decodeMidiMessage([0x90, 60, 0])).toEqual({ type: "note-off", channel: 0, note: 60 });
    expect(decodeMidiMessage([0x8a, 48, 93])).toEqual({ type: "note-off", channel: 10, note: 48 });
  });

  it("normalizes all pitch-wheel endpoints exactly", () => {
    expect(decodeMidiMessage([0xe0, 0x00, 0x00])).toMatchObject({ normalized: -1 });
    expect(decodeMidiMessage([0xe0, 0x00, 0x40])).toMatchObject({ normalized: 0 });
    expect(decodeMidiMessage([0xe0, 0x7f, 0x7f])).toMatchObject({ normalized: 1 });
  });

  it("decodes every 14-bit pitch-wheel value monotonically within its full range", () => {
    let previous = Number.NEGATIVE_INFINITY;
    for (let raw = 0; raw < 16_384; raw += 1) {
      const decoded = decodeMidiMessage([0xef, raw & 0x7f, raw >> 7]);
      expect(decoded).toMatchObject({ type: "pitch-bend", channel: 15 });
      if (!decoded || decoded.type !== "pitch-bend") throw new Error("Pitch bend was not decoded.");
      expect(decoded.normalized).toBeGreaterThan(previous);
      expect(decoded.normalized).toBeGreaterThanOrEqual(-1);
      expect(decoded.normalized).toBeLessThanOrEqual(1);
      previous = decoded.normalized;
    }
  });

  it("decodes modulation and channel recovery controls", () => {
    expect(decodeMidiMessage([0xb3, 1, 127])).toEqual({
      type: "modulation", channel: 3, normalized: 1,
    });
    expect(decodeMidiMessage([0xb3, 120, 0])).toEqual({ type: "all-sound-off", channel: 3 });
    for (const controller of [123, 124, 125, 126, 127]) {
      expect(decodeMidiMessage([0xb3, controller, 0])).toEqual({ type: "all-notes-off", channel: 3 });
    }
    expect(decodeMidiMessage([0xb3, 121, 0])).toEqual({ type: "reset-controllers", channel: 3 });
  });

  it("normalizes every modulation value on every MIDI channel", () => {
    for (let channel = 0; channel < 16; channel += 1) {
      for (let value = 0; value < 128; value += 1) {
        expect(decodeMidiMessage([0xb0 | channel, 1, value])).toEqual({
          type: "modulation", channel, normalized: value / 127,
        });
      }
    }
  });

  it("enforces the defined values of MIDI channel-mode messages", () => {
    for (const controller of [120, 121, 123, 124, 125, 127]) {
      expect(decodeMidiMessage([0xb0, controller, 0])).not.toBeNull();
      for (let value = 1; value < 128; value += 1) {
        expect(decodeMidiMessage([0xb0, controller, value])).toBeNull();
      }
    }
    // CC126's value is the requested mono channel count, so its entire data
    // range is valid even though Andoracle only needs its all-notes-off side effect.
    for (let value = 0; value < 128; value += 1) {
      expect(decodeMidiMessage([0xbf, 126, value])).toEqual({
        type: "all-notes-off", channel: 15,
      });
    }
  });

  it("ignores malformed, system, clock, and unsupported messages", () => {
    expect(decodeMidiMessage(null)).toBeNull();
    expect(decodeMidiMessage(undefined)).toBeNull();
    expect(decodeMidiMessage([])).toBeNull();
    expect(decodeMidiMessage([0x90, 60])).toBeNull();
    expect(decodeMidiMessage([0x90, 60, 100, 0x80])).toBeNull();
    expect(decodeMidiMessage([0xe0, 0, 0x40, 0])).toBeNull();
    expect(decodeMidiMessage([0xb0, 1, 127, 0])).toBeNull();
    expect(decodeMidiMessage([0xf8])).toBeNull();
    expect(decodeMidiMessage([0xb0, 7, 100])).toBeNull();
    expect(decodeMidiMessage([0x40, 60, 100])).toBeNull();
    expect(decodeMidiMessage([0x90, -1, 100])).toBeNull();
    expect(decodeMidiMessage([0x90, 128, 100])).toBeNull();
    expect(decodeMidiMessage([0x90, 60.5, 100])).toBeNull();
    expect(decodeMidiMessage([0x90, 60, Number.NaN])).toBeNull();
    expect(decodeMidiMessage([0xe0, 0x80, 0x40])).toBeNull();
    expect(decodeMidiMessage([0xb0, 1, Number.POSITIVE_INFINITY])).toBeNull();
  });

  it("rejects every running, unsupported, and system status byte", () => {
    for (let status = 0; status < 256; status += 1) {
      const command = status & 0xf0;
      const supported = status < 0xf0 && [0x80, 0x90, 0xe0].includes(command);
      expect(decodeMidiMessage([status, 2, 64]) !== null).toBe(supported);
    }
  });

  it("rejects every high-bit data byte in each parsed data position", () => {
    for (let invalid = 0x80; invalid <= 0xff; invalid += 1) {
      expect(decodeMidiMessage([0x90, invalid, 64])).toBeNull();
      expect(decodeMidiMessage([0x90, 60, invalid])).toBeNull();
      expect(decodeMidiMessage([0xe0, invalid, 0x40])).toBeNull();
      expect(decodeMidiMessage([0xe0, 0, invalid])).toBeNull();
      expect(decodeMidiMessage([0xb0, invalid, 64])).toBeNull();
      expect(decodeMidiMessage([0xb0, 1, invalid])).toBeNull();
    }
  });

  it("combines MIDI wheels with PPC controls without one source erasing the other", () => {
    expect(combinePerformanceSources({
      ppcBendSemitones: -1,
      ppcVibratoSemitones: 0.4,
      midiBendNormalized: 0.5,
      midiModNormalized: 0.25,
    }, 6, 2)).toEqual({ bendSemitones: 2, vibratoSemitones: 0.5 });
  });

  it("requests least-privilege access only on connect and routes input messages", async () => {
    const input = new FakeMidiInput("keys-1", "Test Keys");
    const access = new FakeMidiAccess();
    access.inputs.set(input.id, input as unknown as MIDIInput);
    const requestMIDIAccess = vi.fn(async () => access as unknown as MIDIAccess);
    vi.stubGlobal("window", { isSecureContext: true });
    vi.stubGlobal("navigator", { requestMIDIAccess });
    const handlers = makeHandlers();
    const session = new WebMidiSession(handlers);

    expect(requestMIDIAccess).not.toHaveBeenCalled();
    await expect(session.connect()).resolves.toEqual([
      { id: "keys-1", name: "Test Keys", manufacturer: "Test" },
    ]);
    expect(requestMIDIAccess).toHaveBeenCalledWith({ sysex: false });

    input.emit([0x90, 60, 100]);
    input.emit([0xe0, 0x7f, 0x7f]);
    input.emit([0xb0, 1, 64]);
    input.emit([0x80, 60, 0]);
    expect(handlers.noteOn).toHaveBeenCalledWith(expect.stringContaining("midi:keys-1:0:60:"), 60);
    expect(handlers.noteOff).toHaveBeenCalledTimes(1);
    expect(handlers.pitchBend).toHaveBeenCalledWith(1);
    expect(handlers.modulation).toHaveBeenCalledWith(64 / 127);
    await session.disconnect();
  });

  it("routes the same pitch independently across all sixteen channels", async () => {
    const input = new FakeMidiInput("channel-keys", "Channel Keys");
    const access = new FakeMidiAccess();
    access.inputs.set(input.id, input as unknown as MIDIInput);
    vi.stubGlobal("window", { isSecureContext: true });
    vi.stubGlobal("navigator", {
      requestMIDIAccess: vi.fn(async () => access as unknown as MIDIAccess),
    });
    const handlers = makeHandlers();
    const session = new WebMidiSession(handlers);
    await session.connect();

    for (let channel = 0; channel < 16; channel += 1) {
      input.emit([0x90 | channel, 60, 100]);
    }
    const sources = vi.mocked(handlers.noteOn).mock.calls.map(([source]) => source);
    expect(new Set(sources)).toHaveLength(16);
    for (let channel = 15; channel >= 0; channel -= 1) {
      input.emit([0x80 | channel, 60, 64]);
      expect(handlers.noteOff).toHaveBeenLastCalledWith(sources[channel]);
    }
    expect(handlers.noteOff).toHaveBeenCalledTimes(16);
    await session.disconnect();
  });

  it("uses velocity-zero note-on as a FIFO release without creating an attack", async () => {
    const input = new FakeMidiInput("zero-velocity", "Zero Velocity Keys");
    const access = new FakeMidiAccess();
    access.inputs.set(input.id, input as unknown as MIDIInput);
    vi.stubGlobal("window", { isSecureContext: true });
    vi.stubGlobal("navigator", {
      requestMIDIAccess: vi.fn(async () => access as unknown as MIDIAccess),
    });
    const handlers = makeHandlers();
    const session = new WebMidiSession(handlers);
    await session.connect();

    input.emit([0x94, 72, 100]);
    input.emit([0x94, 72, 80]);
    const sources = vi.mocked(handlers.noteOn).mock.calls.map(([source]) => source);
    input.emit([0x94, 72, 0]);
    expect(handlers.noteOn).toHaveBeenCalledTimes(2);
    expect(handlers.noteOff).toHaveBeenLastCalledWith(sources[0]);
    input.emit([0x84, 72, 127]);
    expect(handlers.noteOff).toHaveBeenLastCalledWith(sources[1]);
    input.emit([0x84, 72, 0]);
    expect(handlers.noteOff).toHaveBeenCalledTimes(2);
    await session.disconnect();
  });

  it("keeps identical channel/note ownership independent across MIDI inputs", async () => {
    const first = new FakeMidiInput("same-note-first", "First Keys");
    const second = new FakeMidiInput("same-note-second", "Second Keys");
    const access = new FakeMidiAccess();
    access.inputs.set(first.id, first as unknown as MIDIInput);
    access.inputs.set(second.id, second as unknown as MIDIInput);
    vi.stubGlobal("window", { isSecureContext: true });
    vi.stubGlobal("navigator", {
      requestMIDIAccess: vi.fn(async () => access as unknown as MIDIAccess),
    });
    const handlers = makeHandlers();
    const session = new WebMidiSession(handlers);
    await session.connect();

    first.emit([0x90, 60, 100]);
    second.emit([0x90, 60, 100]);
    const [firstSource] = vi.mocked(handlers.noteOn).mock.calls[0];
    const [secondSource] = vi.mocked(handlers.noteOn).mock.calls[1];
    expect(firstSource).not.toBe(secondSource);
    second.emit([0x80, 60, 0]);
    expect(handlers.noteOff).toHaveBeenLastCalledWith(secondSource);
    first.emit([0x80, 60, 0]);
    expect(handlers.noteOff).toHaveBeenLastCalledWith(firstSource);
    await session.disconnect();
  });

  it("does not dispatch malformed or unsupported event payloads to handlers", async () => {
    const input = new FakeMidiInput("malformed", "Malformed Source");
    const access = new FakeMidiAccess();
    access.inputs.set(input.id, input as unknown as MIDIInput);
    vi.stubGlobal("window", { isSecureContext: true });
    vi.stubGlobal("navigator", {
      requestMIDIAccess: vi.fn(async () => access as unknown as MIDIAccess),
    });
    const handlers = makeHandlers();
    const session = new WebMidiSession(handlers);
    await session.connect();
    vi.mocked(handlers.inputsChanged).mockClear();

    for (const data of [
      [0x90, 60],
      [0x90, 60, 100, 0x80],
      [60, 100],
      [0xf8],
      [0xa0, 60, 100],
      [0xb0, 7, 100],
      [0xb0, 120, 1],
      [0xb0, 123, 127],
    ]) input.emit(data);

    expect(handlers.noteOn).not.toHaveBeenCalled();
    expect(handlers.noteOff).not.toHaveBeenCalled();
    expect(handlers.pitchBend).not.toHaveBeenCalled();
    expect(handlers.modulation).not.toHaveBeenCalled();
    expect(handlers.allSoundOff).not.toHaveBeenCalled();
    await session.disconnect();
  });

  it("tracks repeated notes independently and releases them on channel recovery", async () => {
    const input = new FakeMidiInput("keys-2", "Layered Keys");
    const access = new FakeMidiAccess();
    access.inputs.set(input.id, input as unknown as MIDIInput);
    vi.stubGlobal("window", { isSecureContext: true });
    vi.stubGlobal("navigator", {
      requestMIDIAccess: vi.fn(async () => access as unknown as MIDIAccess),
    });
    const handlers = makeHandlers();
    const session = new WebMidiSession(handlers);
    await session.connect();

    input.emit([0x92, 64, 100]);
    input.emit([0x92, 64, 100]);
    input.emit([0x82, 64, 0]);
    expect(handlers.noteOn).toHaveBeenCalledTimes(2);
    expect(handlers.noteOff).toHaveBeenCalledTimes(1);
    input.emit([0xb2, 123, 0]);
    expect(handlers.noteOff).toHaveBeenCalledTimes(2);
    await session.disconnect();
  });

  it("bounds repeated note-on ownership and releases every evicted source token", async () => {
    const input = new FakeMidiInput("flood-keys", "Flood Keys");
    const access = new FakeMidiAccess();
    access.inputs.set(input.id, input as unknown as MIDIInput);
    vi.stubGlobal("window", { isSecureContext: true });
    vi.stubGlobal("navigator", {
      requestMIDIAccess: vi.fn(async () => access as unknown as MIDIAccess),
    });
    const handlers = makeHandlers();
    const session = new WebMidiSession(handlers);
    await session.connect();

    for (let index = 0; index < 1_000; index += 1) input.emit([0x90, 60, 100]);
    expect(handlers.noteOn).toHaveBeenCalledTimes(1_000);
    expect(handlers.noteOff).toHaveBeenCalledTimes(984);
    input.emit([0xb0, 123, 0]);
    expect(handlers.noteOff).toHaveBeenCalledTimes(1_000);
    await session.disconnect();
  });

  it("bounds aggregate held-note ownership across channels", async () => {
    const input = new FakeMidiInput("global-flood", "Global Flood");
    const access = new FakeMidiAccess();
    access.inputs.set(input.id, input as unknown as MIDIInput);
    vi.stubGlobal("window", { isSecureContext: true });
    vi.stubGlobal("navigator", {
      requestMIDIAccess: vi.fn(async () => access as unknown as MIDIAccess),
    });
    const handlers = makeHandlers();
    const session = new WebMidiSession(handlers);
    await session.connect();

    for (let index = 0; index < 300; index += 1) {
      const channel = Math.floor(index / 128);
      input.emit([0x90 | channel, index % 128, 100]);
    }
    expect(handlers.noteOff).toHaveBeenCalledTimes(44);
    for (const channel of [0, 1, 2]) input.emit([0xb0 | channel, 123, 0]);
    expect(handlers.noteOff).toHaveBeenCalledTimes(300);
    await session.disconnect();
  });

  it("dispatches CC120 as hard silence after releasing only that input channel", async () => {
    const input = new FakeMidiInput("mode-keys", "Mode Keys");
    const access = new FakeMidiAccess();
    access.inputs.set(input.id, input as unknown as MIDIInput);
    vi.stubGlobal("window", { isSecureContext: true });
    vi.stubGlobal("navigator", {
      requestMIDIAccess: vi.fn(async () => access as unknown as MIDIAccess),
    });
    const handlers = makeHandlers();
    const session = new WebMidiSession(handlers);
    await session.connect();

    input.emit([0x91, 60, 100]);
    input.emit([0x92, 67, 100]);
    input.emit([0xb1, 120, 0]);
    expect(handlers.noteOff).toHaveBeenCalledTimes(1);
    expect(handlers.allSoundOff).toHaveBeenCalledWith("mode-keys", 1);
    input.emit([0xb2, 127, 0]);
    expect(handlers.noteOff).toHaveBeenCalledTimes(2);
    await session.disconnect();
  });

  it("releases channel ownership before dispatching the all-sound-off callback", async () => {
    const input = new FakeMidiInput("ordered-panic", "Ordered Panic Keys");
    const access = new FakeMidiAccess();
    access.inputs.set(input.id, input as unknown as MIDIInput);
    vi.stubGlobal("window", { isSecureContext: true });
    vi.stubGlobal("navigator", {
      requestMIDIAccess: vi.fn(async () => access as unknown as MIDIAccess),
    });
    const events: string[] = [];
    const handlers = makeHandlers();
    handlers.noteOff = vi.fn((source) => events.push(`off:${source}`));
    handlers.allSoundOff = vi.fn((inputId, channel) => {
      events.push(`sound-off:${inputId}:${channel}`);
    });
    const session = new WebMidiSession(handlers);
    await session.connect();

    input.emit([0x92, 48, 100]);
    input.emit([0x92, 55, 100]);
    input.emit([0x93, 67, 100]);
    const channelTwoSources = vi.mocked(handlers.noteOn).mock.calls
      .slice(0, 2)
      .map(([source]) => source);
    input.emit([0xb2, 120, 0]);

    expect(events).toEqual([
      `off:${channelTwoSources[0]}`,
      `off:${channelTwoSources[1]}`,
      "sound-off:ordered-panic:2",
    ]);
    input.emit([0xb3, 123, 0]);
    expect(handlers.noteOff).toHaveBeenCalledTimes(3);
    expect(handlers.allSoundOff).toHaveBeenCalledTimes(1);
    await session.disconnect();
  });

  it("applies every all-notes-off channel mode only to its addressed channel", async () => {
    const input = new FakeMidiInput("channel-modes", "Channel Mode Keys");
    const access = new FakeMidiAccess();
    access.inputs.set(input.id, input as unknown as MIDIInput);
    vi.stubGlobal("window", { isSecureContext: true });
    vi.stubGlobal("navigator", {
      requestMIDIAccess: vi.fn(async () => access as unknown as MIDIAccess),
    });
    const handlers = makeHandlers();
    const session = new WebMidiSession(handlers);
    await session.connect();

    const controllers = [123, 124, 125, 126, 127];
    controllers.forEach((_controller, channel) => input.emit([0x90 | channel, 60, 100]));
    const sources = vi.mocked(handlers.noteOn).mock.calls.map(([source]) => source);
    controllers.forEach((controller, channel) => {
      input.emit([0xb0 | channel, controller, controller === 126 ? 5 : 0]);
      expect(handlers.noteOff).toHaveBeenLastCalledWith(sources[channel]);
    });
    expect(handlers.noteOff).toHaveBeenCalledTimes(controllers.length);
    expect(handlers.allSoundOff).not.toHaveBeenCalled();
    await session.disconnect();
  });

  it("resets pitch and modulation without releasing notes", async () => {
    const input = new FakeMidiInput("reset-controls", "Reset Controller Keys");
    const access = new FakeMidiAccess();
    access.inputs.set(input.id, input as unknown as MIDIInput);
    vi.stubGlobal("window", { isSecureContext: true });
    vi.stubGlobal("navigator", {
      requestMIDIAccess: vi.fn(async () => access as unknown as MIDIAccess),
    });
    const handlers = makeHandlers();
    const session = new WebMidiSession(handlers);
    await session.connect();

    input.emit([0x96, 72, 100]);
    input.emit([0xe6, 0x7f, 0x7f]);
    input.emit([0xb6, 1, 127]);
    input.emit([0xb6, 121, 0]);
    expect(handlers.pitchBend).toHaveBeenLastCalledWith(0);
    expect(handlers.modulation).toHaveBeenLastCalledWith(0);
    expect(handlers.noteOff).not.toHaveBeenCalled();
    input.emit([0x86, 72, 0]);
    expect(handlers.noteOff).toHaveBeenCalledOnce();
    await session.disconnect();
  });

  it("forgets panic-cleared ownership so stale releases cannot affect later notes", async () => {
    const input = new FakeMidiInput("manual-panic", "Manual Panic Keys");
    const access = new FakeMidiAccess();
    access.inputs.set(input.id, input as unknown as MIDIInput);
    vi.stubGlobal("window", { isSecureContext: true });
    vi.stubGlobal("navigator", {
      requestMIDIAccess: vi.fn(async () => access as unknown as MIDIAccess),
    });
    const handlers = makeHandlers();
    const session = new WebMidiSession(handlers);
    await session.connect();

    input.emit([0x90, 60, 100]);
    session.forgetHeldNotes();
    input.emit([0x80, 60, 0]);
    input.emit([0xb0, 123, 0]);
    expect(handlers.noteOff).not.toHaveBeenCalled();

    input.emit([0x90, 60, 100]);
    const freshSource = vi.mocked(handlers.noteOn).mock.calls[1]?.[0];
    input.emit([0x80, 60, 0]);
    expect(handlers.noteOff).toHaveBeenCalledWith(freshSource);
    await session.disconnect();
  });

  it("releases held notes and centers wheels when a device is unplugged", async () => {
    const input = new FakeMidiInput("keys-3", "Hotplug Keys");
    const access = new FakeMidiAccess();
    access.inputs.set(input.id, input as unknown as MIDIInput);
    vi.stubGlobal("window", { isSecureContext: true });
    vi.stubGlobal("navigator", {
      requestMIDIAccess: vi.fn(async () => access as unknown as MIDIAccess),
    });
    const handlers = makeHandlers();
    const session = new WebMidiSession(handlers);
    await session.connect();
    input.emit([0x90, 55, 100]);
    input.emit([0xe0, 0x7f, 0x7f]);
    input.emit([0xb0, 1, 127]);

    input.state = "disconnected";
    access.dispatchEvent(new Event("statechange"));
    expect(handlers.noteOff).toHaveBeenCalledTimes(1);
    expect(handlers.pitchBend).toHaveBeenLastCalledWith(0);
    expect(handlers.modulation).toHaveBeenLastCalledWith(0);
    expect(input.close).toHaveBeenCalled();
    await session.disconnect();
  });

  it("releases an unplugged input immediately while another input open is stuck", async () => {
    const active = new FakeMidiInput("active-hotplug", "Active Hotplug Keys");
    const access = new FakeMidiAccess();
    access.inputs.set(active.id, active as unknown as MIDIInput);
    vi.stubGlobal("window", { isSecureContext: true });
    vi.stubGlobal("navigator", {
      requestMIDIAccess: vi.fn(async () => access as unknown as MIDIAccess),
    });
    const handlers = makeHandlers();
    const session = new WebMidiSession(handlers);
    await session.connect();

    active.emit([0x90, 55, 100]);
    active.emit([0xe0, 0x7f, 0x7f]);
    active.emit([0xb0, 1, 127]);
    const staleHandler = active.onmidimessage;
    vi.mocked(handlers.noteOn).mockClear();
    vi.mocked(handlers.noteOff).mockClear();
    vi.mocked(handlers.pitchBend).mockClear();
    vi.mocked(handlers.modulation).mockClear();

    const stuck = new FakeMidiInput("stuck-hotplug", "Stuck Hotplug Keys");
    stuck.open.mockImplementationOnce(() => new Promise<MIDIInput>(() => undefined));
    access.inputs.set(stuck.id, stuck as unknown as MIDIInput);
    const refreshing = session.refresh();
    await vi.waitFor(() => expect(stuck.open).toHaveBeenCalledTimes(1));

    active.state = "disconnected";
    access.inputs.delete(active.id);
    access.dispatchEvent(new Event("statechange"));

    expect(active.onmidimessage).toBeNull();
    expect(active.close).toHaveBeenCalledTimes(1);
    expect(handlers.noteOff).toHaveBeenCalledTimes(1);
    expect(handlers.pitchBend).toHaveBeenLastCalledWith(0);
    expect(handlers.modulation).toHaveBeenLastCalledWith(0);
    staleHandler?.({ data: Uint8Array.from([0x90, 60, 100]) } as MIDIMessageEvent);
    expect(handlers.noteOn).not.toHaveBeenCalled();

    const disconnecting = session.disconnect(true);
    await expect(refreshing).rejects.toMatchObject({ name: "AbortError" });
    await disconnecting;
  });

  it("ignores a saved message callback after its input is unplugged", async () => {
    const input = new FakeMidiInput("stale-unplug", "Stale Unplug");
    const access = new FakeMidiAccess();
    access.inputs.set(input.id, input as unknown as MIDIInput);
    vi.stubGlobal("window", { isSecureContext: true });
    vi.stubGlobal("navigator", {
      requestMIDIAccess: vi.fn(async () => access as unknown as MIDIAccess),
    });
    const handlers = makeHandlers();
    const session = new WebMidiSession(handlers);
    await session.connect();
    const staleHandler = input.onmidimessage;
    expect(staleHandler).not.toBeNull();

    input.state = "disconnected";
    access.inputs.delete(input.id);
    access.dispatchEvent(new Event("statechange"));
    await vi.waitFor(() => expect(input.close).toHaveBeenCalledTimes(1));
    vi.mocked(handlers.noteOn).mockClear();
    vi.mocked(handlers.pitchBend).mockClear();
    vi.mocked(handlers.modulation).mockClear();
    staleHandler?.({ data: Uint8Array.from([0x90, 60, 100]) } as MIDIMessageEvent);
    staleHandler?.({ data: Uint8Array.from([0xe0, 0x7f, 0x7f]) } as MIDIMessageEvent);
    staleHandler?.({ data: Uint8Array.from([0xb0, 1, 127]) } as MIDIMessageEvent);

    expect(handlers.noteOn).not.toHaveBeenCalled();
    expect(handlers.pitchBend).not.toHaveBeenCalled();
    expect(handlers.modulation).not.toHaveBeenCalled();
    await session.disconnect(true);
  });

  it("ignores a saved message callback after disconnect", async () => {
    const input = new FakeMidiInput("stale-disconnect", "Stale Disconnect");
    const access = new FakeMidiAccess();
    access.inputs.set(input.id, input as unknown as MIDIInput);
    vi.stubGlobal("window", { isSecureContext: true });
    vi.stubGlobal("navigator", {
      requestMIDIAccess: vi.fn(async () => access as unknown as MIDIAccess),
    });
    const handlers = makeHandlers();
    const session = new WebMidiSession(handlers);
    await session.connect();
    const staleHandler = input.onmidimessage;
    expect(staleHandler).not.toBeNull();
    await session.disconnect(true);
    vi.mocked(handlers.noteOn).mockClear();
    vi.mocked(handlers.pitchBend).mockClear();

    staleHandler?.({ data: Uint8Array.from([0x90, 60, 100]) } as MIDIMessageEvent);
    staleHandler?.({ data: Uint8Array.from([0xe0, 0x7f, 0x7f]) } as MIDIMessageEvent);
    expect(handlers.noteOn).not.toHaveBeenCalled();
    expect(handlers.pitchBend).not.toHaveBeenCalled();
  });

  it("ignores a saved callback from a replaced input wrapper", async () => {
    const original = new FakeMidiInput("replaced-wrapper", "Original Wrapper");
    const replacement = new FakeMidiInput("replaced-wrapper", "Replacement Wrapper");
    const access = new FakeMidiAccess();
    access.inputs.set(original.id, original as unknown as MIDIInput);
    vi.stubGlobal("window", { isSecureContext: true });
    vi.stubGlobal("navigator", {
      requestMIDIAccess: vi.fn(async () => access as unknown as MIDIAccess),
    });
    const handlers = makeHandlers();
    const session = new WebMidiSession(handlers);
    await session.connect();
    const staleHandler = original.onmidimessage;
    expect(staleHandler).not.toBeNull();

    original.state = "disconnected";
    access.inputs.set(replacement.id, replacement as unknown as MIDIInput);
    access.dispatchEvent(new Event("statechange"));
    await vi.waitFor(() => expect(replacement.onmidimessage).not.toBeNull());
    vi.mocked(handlers.noteOn).mockClear();
    vi.mocked(handlers.pitchBend).mockClear();
    staleHandler?.({ data: Uint8Array.from([0x90, 60, 100]) } as MIDIMessageEvent);
    staleHandler?.({ data: Uint8Array.from([0xe0, 0x7f, 0x7f]) } as MIDIMessageEvent);
    replacement.emit([0x90, 61, 100]);

    expect(handlers.noteOn).toHaveBeenCalledTimes(1);
    expect(handlers.noteOn).toHaveBeenCalledWith(
      expect.stringContaining("midi:replaced-wrapper:0:61:"),
      61,
    );
    expect(handlers.pitchBend).not.toHaveBeenCalled();
    await session.disconnect(true);
  });

  it("ignores a saved callback after the same wrapper is closed and reopened", async () => {
    const input = new FakeMidiInput("reopened-wrapper", "Reopened Wrapper");
    const access = new FakeMidiAccess();
    access.inputs.set(input.id, input as unknown as MIDIInput);
    vi.stubGlobal("window", { isSecureContext: true });
    vi.stubGlobal("navigator", {
      requestMIDIAccess: vi.fn(async () => access as unknown as MIDIAccess),
    });
    const handlers = makeHandlers();
    const session = new WebMidiSession(handlers);
    await session.connect();
    const staleHandler = input.onmidimessage;
    expect(staleHandler).not.toBeNull();

    input.connection = "closed";
    access.dispatchEvent(new Event("statechange"));
    await vi.waitFor(() => expect(input.open).toHaveBeenCalledTimes(2));
    expect(input.onmidimessage).not.toBe(staleHandler);
    vi.mocked(handlers.noteOn).mockClear();
    staleHandler?.({ data: Uint8Array.from([0x90, 60, 100]) } as MIDIMessageEvent);
    input.emit([0x90, 61, 100]);

    expect(handlers.noteOn).toHaveBeenCalledTimes(1);
    expect(handlers.noteOn).toHaveBeenCalledWith(
      expect.stringContaining("midi:reopened-wrapper:0:61:"),
      61,
    );
    await session.disconnect(true);
  });

  it("publishes topology once when open statechange and repeated refreshes change nothing", async () => {
    const input = new FakeMidiInput("stable-topology", "Stable Topology");
    const access = new FakeMidiAccess();
    access.inputs.set(input.id, input as unknown as MIDIInput);
    input.open.mockImplementation(async () => {
      input.connection = "open";
      access.dispatchEvent(new Event("statechange"));
      return input as unknown as MIDIInput;
    });
    vi.stubGlobal("window", { isSecureContext: true });
    vi.stubGlobal("navigator", {
      requestMIDIAccess: vi.fn(async () => access as unknown as MIDIAccess),
    });
    const handlers = makeHandlers();
    const session = new WebMidiSession(handlers);

    await session.connect();
    const messageHandler = input.onmidimessage;
    expect(messageHandler).not.toBeNull();
    expect(handlers.inputsChanged).toHaveBeenCalledTimes(1);
    for (let refresh = 0; refresh < 10; refresh += 1) await session.refresh();
    expect(input.open).toHaveBeenCalledTimes(1);
    expect(input.onmidimessage).toBe(messageHandler);
    expect(handlers.inputsChanged).toHaveBeenCalledTimes(1);
    await session.disconnect();
    expect(handlers.inputsChanged).toHaveBeenCalledTimes(2);
    expect(handlers.inputsChanged).toHaveBeenLastCalledWith([]);
  });

  it("publishes partial input success before reporting the failed port", async () => {
    const working = new FakeMidiInput("partial-working", "Working Keys");
    const failed = new FakeMidiInput("partial-failed", "Failed Keys");
    failed.open.mockRejectedValueOnce(new Error("Failed Keys is busy"));
    const access = new FakeMidiAccess();
    access.inputs.set(working.id, working as unknown as MIDIInput);
    access.inputs.set(failed.id, failed as unknown as MIDIInput);
    vi.stubGlobal("window", { isSecureContext: true });
    vi.stubGlobal("navigator", {
      requestMIDIAccess: vi.fn(async () => access as unknown as MIDIAccess),
    });
    const events: string[] = [];
    const handlers = makeHandlers();
    handlers.inputsChanged = vi.fn((inputs: readonly MidiInputSummary[]) => {
      events.push(`inputs:${inputs.map(({ id }) => id).join(",")}`);
    });
    handlers.error = vi.fn((message) => {
      events.push(`error:${message}`);
    });
    const session = new WebMidiSession(handlers);

    await expect(session.connect()).resolves.toEqual([
      { id: "partial-working", name: "Working Keys", manufacturer: "Test" },
    ]);
    expect(events).toEqual([
      "inputs:partial-working",
      "error:Failed Keys is busy",
    ]);

    events.length = 0;
    vi.mocked(handlers.inputsChanged).mockClear();
    vi.mocked(handlers.error).mockClear();
    failed.state = "disconnected";
    access.inputs.delete(failed.id);
    access.dispatchEvent(new Event("statechange"));
    await vi.waitFor(() => expect(handlers.inputsChanged).toHaveBeenCalledWith([
      { id: "partial-working", name: "Working Keys", manufacturer: "Test" },
    ]));
    expect(events).toEqual(["inputs:partial-working"]);
    expect(handlers.error).not.toHaveBeenCalled();
    await session.refresh();
    expect(handlers.inputsChanged).toHaveBeenCalledTimes(1);
    await session.disconnect();
  });

  it("publishes healthy empty recovery after the only failed port disappears", async () => {
    const failed = new FakeMidiInput("only-failed", "Only Failed Keys");
    failed.open.mockRejectedValueOnce(new Error("Only Failed Keys is busy"));
    const access = new FakeMidiAccess();
    access.inputs.set(failed.id, failed as unknown as MIDIInput);
    vi.stubGlobal("window", { isSecureContext: true });
    vi.stubGlobal("navigator", {
      requestMIDIAccess: vi.fn(async () => access as unknown as MIDIAccess),
    });
    const handlers = makeHandlers();
    const session = new WebMidiSession(handlers);
    await expect(session.connect()).resolves.toEqual([]);
    expect(handlers.inputsChanged).toHaveBeenLastCalledWith([]);
    expect(handlers.error).toHaveBeenCalledWith("Only Failed Keys is busy");
    vi.mocked(handlers.inputsChanged).mockClear();
    vi.mocked(handlers.error).mockClear();

    failed.state = "disconnected";
    access.inputs.delete(failed.id);
    access.dispatchEvent(new Event("statechange"));
    await vi.waitFor(() => expect(handlers.inputsChanged).toHaveBeenCalledWith([]));
    expect(handlers.inputsChanged).toHaveBeenCalledTimes(1);
    expect(handlers.error).not.toHaveBeenCalled();
    await session.disconnect();
  });

  it("bounds teardown when a MIDI driver never settles close()", async () => {
    vi.useFakeTimers();
    const input = new FakeMidiInput("stuck-close", "Stuck Close");
    const access = new FakeMidiAccess();
    access.inputs.set(input.id, input as unknown as MIDIInput);
    vi.stubGlobal("window", { isSecureContext: true });
    vi.stubGlobal("navigator", {
      requestMIDIAccess: vi.fn(async () => access as unknown as MIDIAccess),
    });
    const session = new WebMidiSession(makeHandlers());
    await session.connect();
    input.close.mockImplementationOnce(() => new Promise<never>(() => undefined));

    const disconnecting = session.disconnect();
    await vi.advanceTimersByTimeAsync(MIDI_INPUT_CLOSE_TIMEOUT_MS);
    await expect(disconnecting).resolves.toBeUndefined();
    expect(input.onmidimessage).toBeNull();
  });

  it("keeps a late raw close single-owned across session replacement", async () => {
    vi.useFakeTimers();
    const input = new FakeMidiInput("late-close", "Late Close Keys");
    const access = new FakeMidiAccess();
    access.inputs.set(input.id, input as unknown as MIDIInput);
    vi.stubGlobal("window", { isSecureContext: true });
    vi.stubGlobal("navigator", {
      requestMIDIAccess: vi.fn(async () => access as unknown as MIDIAccess),
    });
    const firstSession = new WebMidiSession(makeHandlers());
    await firstSession.connect();
    let resolveClose: ((input: MIDIInput) => void) | undefined;
    input.close.mockImplementationOnce(() => new Promise<MIDIInput>((resolve) => {
      resolveClose = resolve;
    }));

    const disconnecting = firstSession.disconnect(true);
    await vi.advanceTimersByTimeAsync(MIDI_INPUT_CLOSE_TIMEOUT_MS);
    await expect(disconnecting).resolves.toBeUndefined();
    expect(input.close).toHaveBeenCalledTimes(1);

    const replacementSession = new WebMidiSession(makeHandlers());
    await expect(replacementSession.connect()).resolves.toEqual([]);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await expect(replacementSession.refresh()).resolves.toEqual([]);
    }
    expect(input.open).toHaveBeenCalledTimes(1);
    expect(input.close).toHaveBeenCalledTimes(1);

    input.connection = "closed";
    resolveClose?.(input as unknown as MIDIInput);
    await vi.advanceTimersByTimeAsync(0);
    await expect(replacementSession.refresh()).resolves.toEqual([
      { id: "late-close", name: "Late Close Keys", manufacturer: "Test" },
    ]);
    expect(input.open).toHaveBeenCalledTimes(2);
    await replacementSession.disconnect();
    await firstSession.dispose();
  });

  it("single-flights concurrent disconnects until the owned port actually closes", async () => {
    const input = new FakeMidiInput("shared-disconnect", "Shared Disconnect");
    const access = new FakeMidiAccess();
    access.inputs.set(input.id, input as unknown as MIDIInput);
    vi.stubGlobal("window", { isSecureContext: true });
    vi.stubGlobal("navigator", {
      requestMIDIAccess: vi.fn(async () => access as unknown as MIDIAccess),
    });
    const session = new WebMidiSession(makeHandlers());
    await session.connect();
    let resolveClose: ((input: MIDIInput) => void) | undefined;
    input.close.mockImplementationOnce(() => new Promise<MIDIInput>((resolve) => {
      resolveClose = resolve;
    }));

    const first = session.disconnect(true);
    const second = session.disconnect(true);
    expect(second).toBe(first);
    expect(input.close).toHaveBeenCalledTimes(1);
    let settled = false;
    void second.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    input.connection = "closed";
    resolveClose?.(input as unknown as MIDIInput);
    await expect(first).resolves.toBeUndefined();
    expect(settled).toBe(true);
  });

  it("single-flights repeated dispose calls and waits for an active disconnect", async () => {
    const input = new FakeMidiInput("dispose-during-close", "Dispose During Close");
    const access = new FakeMidiAccess();
    access.inputs.set(input.id, input as unknown as MIDIInput);
    vi.stubGlobal("window", { isSecureContext: true });
    vi.stubGlobal("navigator", {
      requestMIDIAccess: vi.fn(async () => access as unknown as MIDIAccess),
    });
    const session = new WebMidiSession(makeHandlers());
    await session.connect();
    let resolveClose: ((input: MIDIInput) => void) | undefined;
    input.close.mockImplementationOnce(() => new Promise<MIDIInput>((resolve) => {
      resolveClose = resolve;
    }));

    const disconnecting = session.disconnect(true);
    const disposing = session.dispose();
    const repeatedDispose = session.dispose();
    expect(disposing).toBe(disconnecting);
    expect(repeatedDispose).toBe(disposing);
    expect(input.close).toHaveBeenCalledTimes(1);
    let settled = false;
    void disposing.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    input.connection = "closed";
    resolveClose?.(input as unknown as MIDIInput);
    await expect(disposing).resolves.toBeUndefined();
    await expect(session.connect()).rejects.toThrow("no longer available");
  });

  it("waits for a close already owned by an in-flight topology sync", async () => {
    const input = new FakeMidiInput("sync-close", "Sync Close");
    const access = new FakeMidiAccess();
    access.inputs.set(input.id, input as unknown as MIDIInput);
    vi.stubGlobal("window", { isSecureContext: true });
    vi.stubGlobal("navigator", {
      requestMIDIAccess: vi.fn(async () => access as unknown as MIDIAccess),
    });
    const session = new WebMidiSession(makeHandlers());
    await session.connect();
    let resolveClose: ((input: MIDIInput) => void) | undefined;
    input.close.mockImplementationOnce(() => new Promise<MIDIInput>((resolve) => {
      resolveClose = resolve;
    }));

    input.connection = "closed";
    access.dispatchEvent(new Event("statechange"));
    await vi.waitFor(() => expect(input.close).toHaveBeenCalledTimes(1));
    const disconnecting = session.disconnect(true);
    let settled = false;
    void disconnecting.then(() => {
      settled = true;
    });
    for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
    expect(settled).toBe(false);

    resolveClose?.(input as unknown as MIDIInput);
    await expect(disconnecting).resolves.toBeUndefined();
    expect(input.open).toHaveBeenCalledTimes(1);
  });

  it("rejects connect and refresh while port teardown is still active", async () => {
    const firstInput = new FakeMidiInput("teardown-race", "Teardown Race");
    const firstAccess = new FakeMidiAccess();
    firstAccess.inputs.set(firstInput.id, firstInput as unknown as MIDIInput);
    const replacementInput = new FakeMidiInput("teardown-race", "Teardown Race");
    const replacementAccess = new FakeMidiAccess();
    replacementAccess.inputs.set(replacementInput.id, replacementInput as unknown as MIDIInput);
    const requestMIDIAccess = vi.fn()
      .mockResolvedValueOnce(firstAccess as unknown as MIDIAccess)
      .mockResolvedValueOnce(replacementAccess as unknown as MIDIAccess);
    vi.stubGlobal("window", { isSecureContext: true });
    vi.stubGlobal("navigator", { requestMIDIAccess });
    const session = new WebMidiSession(makeHandlers());
    await session.connect();
    let resolveClose: ((input: MIDIInput) => void) | undefined;
    firstInput.close.mockImplementationOnce(() => new Promise<MIDIInput>((resolve) => {
      resolveClose = resolve;
    }));

    const disconnecting = session.disconnect(true);
    await expect(session.connect()).rejects.toMatchObject({ name: "AbortError" });
    await expect(session.refresh()).rejects.toMatchObject({ name: "AbortError" });
    expect(requestMIDIAccess).toHaveBeenCalledTimes(1);
    expect(replacementInput.open).not.toHaveBeenCalled();

    firstInput.connection = "closed";
    resolveClose?.(firstInput as unknown as MIDIInput);
    await disconnecting;
    await expect(session.connect()).resolves.toEqual([
      { id: "teardown-race", name: "Teardown Race", manufacturer: "Test" },
    ]);
    expect(requestMIDIAccess).toHaveBeenCalledTimes(2);
    expect(replacementInput.open).toHaveBeenCalledTimes(1);
    await session.disconnect();
  });

  it("cancels a pending permission request during silent teardown", async () => {
    const access = new FakeMidiAccess();
    const input = new FakeMidiInput("late-keys", "Late Keys");
    access.inputs.set(input.id, input as unknown as MIDIInput);
    let resolveAccess: ((access: MIDIAccess) => void) | undefined;
    const pendingAccess = new Promise<MIDIAccess>((resolve) => {
      resolveAccess = resolve;
    });
    vi.stubGlobal("window", { isSecureContext: true });
    vi.stubGlobal("navigator", { requestMIDIAccess: vi.fn(() => pendingAccess) });
    const handlers = makeHandlers();
    const session = new WebMidiSession(handlers);

    const connecting = session.connect();
    expect(session.connect()).toBe(connecting);
    await session.disconnect(true);
    await expect(connecting).rejects.toMatchObject({ name: "AbortError" });
    resolveAccess?.(access as unknown as MIDIAccess);
    await Promise.resolve();
    await Promise.resolve();
    expect(input.close).not.toHaveBeenCalled();
    expect(handlers.inputsChanged).not.toHaveBeenCalled();
  });

  it("does not issue another permission request until a cancelled raw request settles", async () => {
    let resolveFirstAccess: ((access: MIDIAccess) => void) | undefined;
    const firstPermission = new Promise<MIDIAccess>((resolve) => {
      resolveFirstAccess = resolve;
    });
    const abandonedInput = new FakeMidiInput("abandoned", "Abandoned Keys");
    const abandonedAccess = new FakeMidiAccess();
    abandonedAccess.inputs.set(abandonedInput.id, abandonedInput as unknown as MIDIInput);
    const retryInput = new FakeMidiInput("retry", "Retry Keys");
    const retryAccess = new FakeMidiAccess();
    retryAccess.inputs.set(retryInput.id, retryInput as unknown as MIDIInput);
    const requestMIDIAccess = vi.fn()
      .mockReturnValueOnce(firstPermission)
      .mockResolvedValueOnce(retryAccess as unknown as MIDIAccess);
    vi.stubGlobal("window", { isSecureContext: true });
    vi.stubGlobal("navigator", { requestMIDIAccess });
    const session = new WebMidiSession(makeHandlers());

    const connecting = session.connect();
    await session.disconnect(true);
    await expect(connecting).rejects.toMatchObject({ name: "AbortError" });
    const replacementSession = new WebMidiSession(makeHandlers());
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await expect(replacementSession.connect()).rejects.toThrow("still pending in the browser");
    }
    expect(requestMIDIAccess).toHaveBeenCalledTimes(1);

    resolveFirstAccess?.(abandonedAccess as unknown as MIDIAccess);
    await Promise.resolve();
    await Promise.resolve();
    expect(abandonedInput.close).not.toHaveBeenCalled();
    await expect(replacementSession.connect()).resolves.toEqual([
      { id: "retry", name: "Retry Keys", manufacturer: "Test" },
    ]);
    expect(requestMIDIAccess).toHaveBeenCalledTimes(2);
    await replacementSession.disconnect();
    await session.dispose();
  });

  it("does not let a cancelled late access grant close another session's live input", async () => {
    const input = new FakeMidiInput("shared-live", "Shared Live Keys");
    const access = new FakeMidiAccess();
    access.inputs.set(input.id, input as unknown as MIDIInput);
    let resolveLateAccess: ((access: MIDIAccess) => void) | undefined;
    const lateAccess = new Promise<MIDIAccess>((resolve) => {
      resolveLateAccess = resolve;
    });
    const requestMIDIAccess = vi.fn()
      .mockResolvedValueOnce(access as unknown as MIDIAccess)
      .mockReturnValueOnce(lateAccess);
    vi.stubGlobal("window", { isSecureContext: true });
    vi.stubGlobal("navigator", { requestMIDIAccess });
    const liveHandlers = makeHandlers();
    const liveSession = new WebMidiSession(liveHandlers);
    const cancelledSession = new WebMidiSession(makeHandlers());
    await liveSession.connect();
    const liveMessageHandler = input.onmidimessage;

    const connecting = cancelledSession.connect();
    await cancelledSession.disconnect(true);
    await expect(connecting).rejects.toMatchObject({ name: "AbortError" });
    resolveLateAccess?.(access as unknown as MIDIAccess);
    await Promise.resolve();
    await Promise.resolve();

    expect(input.close).not.toHaveBeenCalled();
    expect(input.connection).toBe("open");
    expect(input.onmidimessage).toBe(liveMessageHandler);
    input.emit([0x90, 60, 100]);
    expect(liveHandlers.noteOn).toHaveBeenCalledTimes(1);
    await cancelledSession.dispose();
    await liveSession.disconnect();
  });

  it("does not let a concurrent session steal or close another session's live port", async () => {
    const input = new FakeMidiInput("shared-port", "Shared Port");
    const access = new FakeMidiAccess();
    access.inputs.set(input.id, input as unknown as MIDIInput);
    vi.stubGlobal("window", { isSecureContext: true });
    vi.stubGlobal("navigator", {
      requestMIDIAccess: vi.fn(async () => access as unknown as MIDIAccess),
    });
    const liveHandlers = makeHandlers();
    const contenderHandlers = makeHandlers();
    const liveSession = new WebMidiSession(liveHandlers);
    const contenderSession = new WebMidiSession(contenderHandlers);

    await expect(liveSession.connect()).resolves.toHaveLength(1);
    const liveMessageHandler = input.onmidimessage;
    await expect(contenderSession.connect()).resolves.toEqual([]);
    expect(input.open).toHaveBeenCalledTimes(1);
    expect(input.onmidimessage).toBe(liveMessageHandler);

    await contenderSession.disconnect(true);
    expect(input.close).not.toHaveBeenCalled();
    expect(input.onmidimessage).toBe(liveMessageHandler);
    input.emit([0x90, 60, 100]);
    expect(liveHandlers.noteOn).toHaveBeenCalledTimes(1);
    expect(contenderHandlers.noteOn).not.toHaveBeenCalled();
    await liveSession.disconnect();
  });

  it("single-owns one logical port across distinct MIDIAccess wrapper objects", async () => {
    const firstInput = new FakeMidiInput("logical-port", "Logical Port");
    const secondInput = new FakeMidiInput("logical-port", "Logical Port");
    const firstAccess = new FakeMidiAccess();
    const secondAccess = new FakeMidiAccess();
    const requestMIDIAccess = vi.fn()
      .mockResolvedValueOnce(firstAccess as unknown as MIDIAccess)
      .mockResolvedValueOnce(secondAccess as unknown as MIDIAccess);
    vi.stubGlobal("window", { isSecureContext: true });
    vi.stubGlobal("navigator", { requestMIDIAccess });
    const firstHandlers = makeHandlers();
    const secondHandlers = makeHandlers();
    const firstSession = new WebMidiSession(firstHandlers);
    const secondSession = new WebMidiSession(secondHandlers);
    await firstSession.connect();
    await secondSession.connect();
    firstAccess.inputs.set(firstInput.id, firstInput as unknown as MIDIInput);
    secondAccess.inputs.set(secondInput.id, secondInput as unknown as MIDIInput);

    const [firstInputs, secondInputs] = await Promise.all([
      firstSession.refresh(),
      secondSession.refresh(),
    ]);
    expect(firstInputs).toEqual([
      { id: "logical-port", name: "Logical Port", manufacturer: "Test" },
    ]);
    expect(secondInputs).toEqual([]);
    expect(firstInput.open).toHaveBeenCalledTimes(1);
    expect(secondInput.open).not.toHaveBeenCalled();
    firstInput.emit([0x90, 60, 100]);
    secondInput.emit([0x90, 61, 100]);
    expect(firstHandlers.noteOn).toHaveBeenCalledTimes(1);
    expect(secondHandlers.noteOn).not.toHaveBeenCalled();

    await firstSession.disconnect(true);
    await expect(secondSession.refresh()).resolves.toEqual([
      { id: "logical-port", name: "Logical Port", manufacturer: "Test" },
    ]);
    expect(secondInput.open).toHaveBeenCalledTimes(1);
    secondInput.emit([0x90, 61, 100]);
    expect(secondHandlers.noteOn).toHaveBeenCalledTimes(1);
    await secondSession.disconnect();
  });

  it("quarantines a pending logical-port open across distinct wrapper objects", async () => {
    const firstInput = new FakeMidiInput("logical-opening", "Logical Opening");
    const secondInput = new FakeMidiInput("logical-opening", "Logical Opening");
    let resolveOpen: ((input: MIDIInput) => void) | undefined;
    firstInput.open.mockImplementationOnce(() => new Promise<MIDIInput>((resolve) => {
      resolveOpen = resolve;
    }));
    const firstAccess = new FakeMidiAccess();
    const secondAccess = new FakeMidiAccess();
    const requestMIDIAccess = vi.fn()
      .mockResolvedValueOnce(firstAccess as unknown as MIDIAccess)
      .mockResolvedValueOnce(secondAccess as unknown as MIDIAccess);
    vi.stubGlobal("window", { isSecureContext: true });
    vi.stubGlobal("navigator", { requestMIDIAccess });
    const firstSession = new WebMidiSession(makeHandlers());
    const secondSession = new WebMidiSession(makeHandlers());
    await firstSession.connect();
    await secondSession.connect();
    firstAccess.inputs.set(firstInput.id, firstInput as unknown as MIDIInput);
    secondAccess.inputs.set(secondInput.id, secondInput as unknown as MIDIInput);

    const firstRefresh = firstSession.refresh();
    const firstOutcome = firstRefresh.then(
      () => null,
      (error: unknown) => error,
    );
    await vi.waitFor(() => expect(firstInput.open).toHaveBeenCalledTimes(1));
    await expect(secondSession.refresh()).resolves.toEqual([]);
    expect(secondInput.open).not.toHaveBeenCalled();
    await firstSession.disconnect(true);
    await expect(firstOutcome).resolves.toMatchObject({ name: "AbortError" });
    await expect(secondSession.refresh()).resolves.toEqual([]);
    expect(secondInput.open).not.toHaveBeenCalled();

    firstInput.connection = "open";
    resolveOpen?.(firstInput as unknown as MIDIInput);
    await vi.waitFor(() => expect(firstInput.close).toHaveBeenCalledTimes(2));
    await expect(secondSession.refresh()).resolves.toEqual([
      { id: "logical-opening", name: "Logical Opening", manufacturer: "Test" },
    ]);
    expect(secondInput.open).toHaveBeenCalledTimes(1);
    await secondSession.disconnect();
  });

  it("quarantines a pending logical-port close across distinct wrapper objects", async () => {
    vi.useFakeTimers();
    const firstInput = new FakeMidiInput("logical-closing", "Logical Closing");
    const secondInput = new FakeMidiInput("logical-closing", "Logical Closing");
    const firstAccess = new FakeMidiAccess();
    const secondAccess = new FakeMidiAccess();
    const requestMIDIAccess = vi.fn()
      .mockResolvedValueOnce(firstAccess as unknown as MIDIAccess)
      .mockResolvedValueOnce(secondAccess as unknown as MIDIAccess);
    vi.stubGlobal("window", { isSecureContext: true });
    vi.stubGlobal("navigator", { requestMIDIAccess });
    const firstSession = new WebMidiSession(makeHandlers());
    const secondSession = new WebMidiSession(makeHandlers());
    await firstSession.connect();
    await secondSession.connect();
    firstAccess.inputs.set(firstInput.id, firstInput as unknown as MIDIInput);
    secondAccess.inputs.set(secondInput.id, secondInput as unknown as MIDIInput);
    await firstSession.refresh();
    await expect(secondSession.refresh()).resolves.toEqual([]);
    let resolveClose: ((input: MIDIInput) => void) | undefined;
    firstInput.close.mockImplementationOnce(() => new Promise<MIDIInput>((resolve) => {
      resolveClose = resolve;
    }));

    const disconnecting = firstSession.disconnect(true);
    await vi.advanceTimersByTimeAsync(MIDI_INPUT_CLOSE_TIMEOUT_MS);
    await disconnecting;
    await expect(secondSession.refresh()).resolves.toEqual([]);
    expect(secondInput.open).not.toHaveBeenCalled();

    firstInput.connection = "closed";
    resolveClose?.(firstInput as unknown as MIDIInput);
    await vi.advanceTimersByTimeAsync(0);
    await expect(secondSession.refresh()).resolves.toEqual([
      { id: "logical-closing", name: "Logical Closing", manufacturer: "Test" },
    ]);
    expect(secondInput.open).toHaveBeenCalledTimes(1);
    await secondSession.disconnect();
  });

  it("retries a port whose pending open crossed a disconnect/reconnect", async () => {
    const input = new FakeMidiInput("replug-keys", "Replug Keys");
    let resolveFirstOpen: ((input: MIDIInput) => void) | undefined;
    input.open.mockImplementationOnce(() => new Promise<MIDIInput>((resolve) => {
      resolveFirstOpen = resolve;
    }));
    const access = new FakeMidiAccess();
    access.inputs.set(input.id, input as unknown as MIDIInput);
    vi.stubGlobal("window", { isSecureContext: true });
    vi.stubGlobal("navigator", {
      requestMIDIAccess: vi.fn(async () => access as unknown as MIDIAccess),
    });
    const handlers = makeHandlers();
    const session = new WebMidiSession(handlers);

    const connecting = session.connect();
    await vi.waitFor(() => expect(input.open).toHaveBeenCalledTimes(1));
    expect(session.connect()).toBe(connecting);
    input.state = "disconnected";
    access.dispatchEvent(new Event("statechange"));
    input.state = "connected";
    access.dispatchEvent(new Event("statechange"));
    input.connection = "open";
    resolveFirstOpen?.(input as unknown as MIDIInput);

    await expect(connecting).resolves.toEqual([
      { id: "replug-keys", name: "Replug Keys", manufacturer: "Test" },
    ]);
    expect(input.open).toHaveBeenCalledTimes(2);
    await session.disconnect();
  });

  it("waits for an invalidated raw open to settle before retrying that port", async () => {
    const input = new FakeMidiInput("cancelled-open", "Cancelled Open");
    let resolveFirstOpen: ((input: MIDIInput) => void) | undefined;
    input.open.mockImplementationOnce(() => new Promise<MIDIInput>((resolve) => {
      resolveFirstOpen = resolve;
    }));
    const access = new FakeMidiAccess();
    access.inputs.set(input.id, input as unknown as MIDIInput);
    vi.stubGlobal("window", { isSecureContext: true });
    vi.stubGlobal("navigator", {
      requestMIDIAccess: vi.fn(async () => access as unknown as MIDIAccess),
    });
    const handlers = makeHandlers();
    const session = new WebMidiSession(handlers);

    const connecting = session.connect();
    await vi.waitFor(() => expect(input.open).toHaveBeenCalledTimes(1));
    input.state = "disconnected";
    access.dispatchEvent(new Event("statechange"));
    input.state = "connected";
    access.dispatchEvent(new Event("statechange"));

    await expect(connecting).resolves.toEqual([]);
    expect(input.open).toHaveBeenCalledTimes(1);
    resolveFirstOpen?.(input as unknown as MIDIInput);
    await vi.waitFor(() => expect(input.close).toHaveBeenCalled());
    await expect(session.refresh()).resolves.toEqual([
      { id: "cancelled-open", name: "Cancelled Open", manufacturer: "Test" },
    ]);
    expect(input.open).toHaveBeenCalledTimes(2);
    await session.disconnect();
  });

  it("does not stack retries onto one timed-out raw port open", async () => {
    vi.useFakeTimers();
    let resolveFirstOpen: ((input: MIDIInput) => void) | undefined;
    const firstOpen = new Promise<MIDIInput>((resolve) => {
      resolveFirstOpen = resolve;
    });
    const input = new FakeMidiInput("bounded-open", "Bounded Open");
    input.open.mockImplementationOnce(() => firstOpen);
    const access = new FakeMidiAccess();
    access.inputs.set(input.id, input as unknown as MIDIInput);
    vi.stubGlobal("window", { isSecureContext: true });
    vi.stubGlobal("navigator", {
      requestMIDIAccess: vi.fn(async () => access as unknown as MIDIAccess),
    });
    const session = new WebMidiSession(makeHandlers());

    const connecting = session.connect();
    await vi.advanceTimersByTimeAsync(MIDI_INPUT_OPEN_TIMEOUT_MS);
    await expect(connecting).resolves.toEqual([]);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await expect(session.refresh()).resolves.toEqual([]);
    }
    expect(input.open).toHaveBeenCalledTimes(1);

    resolveFirstOpen?.(input as unknown as MIDIInput);
    await vi.advanceTimersByTimeAsync(0);
    await expect(session.refresh()).resolves.toEqual([
      { id: "bounded-open", name: "Bounded Open", manufacturer: "Test" },
    ]);
    expect(input.open).toHaveBeenCalledTimes(2);
    await session.disconnect();
  });

  it("times out a stuck port, permits later discovery, and closes a late completion", async () => {
    vi.useFakeTimers();
    const stuck = new FakeMidiInput("timed-out", "Timed Out Keys");
    let resolveOpen: ((input: MIDIInput) => void) | undefined;
    stuck.open.mockImplementationOnce(() => new Promise<MIDIInput>((resolve) => {
      resolveOpen = resolve;
    }));
    const access = new FakeMidiAccess();
    access.inputs.set(stuck.id, stuck as unknown as MIDIInput);
    vi.stubGlobal("window", { isSecureContext: true });
    vi.stubGlobal("navigator", {
      requestMIDIAccess: vi.fn(async () => access as unknown as MIDIAccess),
    });
    const handlers = makeHandlers();
    const session = new WebMidiSession(handlers);

    const connecting = session.connect();
    await vi.advanceTimersByTimeAsync(MIDI_INPUT_OPEN_TIMEOUT_MS);
    await expect(connecting).resolves.toEqual([]);
    expect(handlers.error).toHaveBeenCalledWith("Timed Out Keys did not open within 8 seconds.");

    stuck.state = "disconnected";
    access.inputs.delete(stuck.id);
    const working = new FakeMidiInput("working", "Working Keys");
    access.inputs.set(working.id, working as unknown as MIDIInput);
    await expect(session.refresh()).resolves.toEqual([
      { id: "working", name: "Working Keys", manufacturer: "Test" },
    ]);

    const closeCalls = stuck.close.mock.calls.length;
    resolveOpen?.(stuck as unknown as MIDIInput);
    await Promise.resolve();
    await Promise.resolve();
    expect(stuck.close.mock.calls.length).toBeGreaterThan(closeCalls);
    await session.disconnect();
  });

  it("coalesces callers onto one pending refresh promise", async () => {
    const access = new FakeMidiAccess();
    vi.stubGlobal("window", { isSecureContext: true });
    vi.stubGlobal("navigator", {
      requestMIDIAccess: vi.fn(async () => access as unknown as MIDIAccess),
    });
    const handlers = makeHandlers();
    const session = new WebMidiSession(handlers);
    await session.connect();
    const stuck = new FakeMidiInput("shared-refresh", "Shared Refresh");
    stuck.open.mockImplementationOnce(() => new Promise<MIDIInput>(() => undefined));
    access.inputs.set(stuck.id, stuck as unknown as MIDIInput);

    const first = session.refresh();
    const second = session.refresh();
    expect(second).toBe(first);
    await vi.waitFor(() => expect(stuck.open).toHaveBeenCalledTimes(1));
    const disconnecting = session.disconnect(true);
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    await disconnecting;
  });

  it("cancels and coalesces reconnects that reuse an existing MIDI access grant", async () => {
    const access = new FakeMidiAccess();
    vi.stubGlobal("window", { isSecureContext: true });
    vi.stubGlobal("navigator", {
      requestMIDIAccess: vi.fn(async () => access as unknown as MIDIAccess),
    });
    const session = new WebMidiSession(makeHandlers());
    await session.connect();
    const input = new FakeMidiInput("stuck-reconnect", "Stuck Reconnect");
    input.open.mockImplementationOnce(() => new Promise<MIDIInput>(() => undefined));
    access.inputs.set(input.id, input as unknown as MIDIInput);

    const first = session.connect();
    const second = session.connect();
    expect(second).toBe(first);
    await vi.waitFor(() => expect(input.open).toHaveBeenCalledTimes(1));
    const disconnecting = session.disconnect(true);
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    await disconnecting;
  });

  it("promptly cancels connect when a MIDI input open never settles", async () => {
    const input = new FakeMidiInput("stuck-keys", "Stuck Keys");
    input.open.mockImplementationOnce(() => new Promise<MIDIInput>(() => undefined));
    const access = new FakeMidiAccess();
    access.inputs.set(input.id, input as unknown as MIDIInput);
    vi.stubGlobal("window", { isSecureContext: true });
    vi.stubGlobal("navigator", {
      requestMIDIAccess: vi.fn(async () => access as unknown as MIDIAccess),
    });
    const handlers = makeHandlers();
    const session = new WebMidiSession(handlers);

    const connecting = session.connect();
    await vi.waitFor(() => expect(input.open).toHaveBeenCalled());
    await session.disconnect(true);
    await expect(connecting).rejects.toMatchObject({ name: "AbortError" });
    expect(input.close).toHaveBeenCalled();
  });

  it("promptly cancels a refresh whose newly discovered port never opens", async () => {
    const access = new FakeMidiAccess();
    vi.stubGlobal("window", { isSecureContext: true });
    vi.stubGlobal("navigator", {
      requestMIDIAccess: vi.fn(async () => access as unknown as MIDIAccess),
    });
    const handlers = makeHandlers();
    const session = new WebMidiSession(handlers);
    await session.connect();
    const input = new FakeMidiInput("stuck-refresh", "Stuck Refresh");
    input.open.mockImplementationOnce(() => new Promise<MIDIInput>(() => undefined));
    access.inputs.set(input.id, input as unknown as MIDIInput);

    const refreshing = session.refresh();
    await vi.waitFor(() => expect(input.open).toHaveBeenCalled());
    await session.disconnect(true);
    await expect(refreshing).rejects.toMatchObject({ name: "AbortError" });
    expect(input.close).toHaveBeenCalled();
  });

  it("reopens a connected port that reports a closed connection", async () => {
    const input = new FakeMidiInput("closed-keys", "Closed Keys");
    const access = new FakeMidiAccess();
    access.inputs.set(input.id, input as unknown as MIDIInput);
    vi.stubGlobal("window", { isSecureContext: true });
    vi.stubGlobal("navigator", {
      requestMIDIAccess: vi.fn(async () => access as unknown as MIDIAccess),
    });
    const handlers = makeHandlers();
    const session = new WebMidiSession(handlers);
    await session.connect();

    input.connection = "closed";
    access.dispatchEvent(new Event("statechange"));
    await vi.waitFor(() => expect(input.open).toHaveBeenCalledTimes(2));
    input.emit([0x90, 64, 100]);
    expect(handlers.noteOn).toHaveBeenCalledTimes(1);
    await session.disconnect();
  });

  it("pairs port, message, and topology ownership across ten full device cycles", async () => {
    const input = new FakeMidiInput("cycled-keys", "Cycled Keys");
    const access = new FakeMidiAccess();
    access.inputs.set(input.id, input as unknown as MIDIInput);
    const addListener = vi.spyOn(access, "addEventListener");
    const removeListener = vi.spyOn(access, "removeEventListener");
    const requestMIDIAccess = vi.fn(async () => access as unknown as MIDIAccess);
    vi.stubGlobal("window", { isSecureContext: true });
    vi.stubGlobal("navigator", { requestMIDIAccess });
    const handlers = makeHandlers();
    const session = new WebMidiSession(handlers);

    for (let cycle = 0; cycle < 10; cycle += 1) {
      await expect(session.connect()).resolves.toHaveLength(1);
      expect(input.onmidimessage).not.toBeNull();
      input.emit([0x90, 60, 100]);
      await session.disconnect();
      expect(input.onmidimessage).toBeNull();
      input.emit([0x90, 60, 100]);
    }

    expect(requestMIDIAccess).toHaveBeenCalledTimes(10);
    expect(input.open).toHaveBeenCalledTimes(10);
    expect(input.close).toHaveBeenCalledTimes(10);
    expect(addListener.mock.calls.filter(([type]) => type === "statechange")).toHaveLength(10);
    expect(removeListener.mock.calls.filter(([type]) => type === "statechange")).toHaveLength(10);
    expect(handlers.noteOn).toHaveBeenCalledTimes(10);
    await session.dispose();
  });

  it("does not advertise a port that fails to open and can retry it", async () => {
    const input = new FakeMidiInput("busy-keys", "Busy Keys");
    input.open.mockRejectedValueOnce(new Error("Port is in use"));
    const access = new FakeMidiAccess();
    access.inputs.set(input.id, input as unknown as MIDIInput);
    vi.stubGlobal("window", { isSecureContext: true });
    vi.stubGlobal("navigator", {
      requestMIDIAccess: vi.fn(async () => access as unknown as MIDIAccess),
    });
    const handlers = makeHandlers();
    const session = new WebMidiSession(handlers);

    await expect(session.connect()).resolves.toEqual([]);
    expect(handlers.error).toHaveBeenCalledWith("Port is in use");
    await expect(session.refresh()).resolves.toEqual([
      { id: "busy-keys", name: "Busy Keys", manufacturer: "Test" },
    ]);
    await session.disconnect();
  });

  it("closes a port whose open promise resolves without entering the open state", async () => {
    const input = new FakeMidiInput("stalled-keys", "Stalled Keys");
    input.open.mockImplementationOnce(async () => input as unknown as MIDIInput);
    const access = new FakeMidiAccess();
    access.inputs.set(input.id, input as unknown as MIDIInput);
    vi.stubGlobal("window", { isSecureContext: true });
    vi.stubGlobal("navigator", {
      requestMIDIAccess: vi.fn(async () => access as unknown as MIDIAccess),
    });
    const handlers = makeHandlers();
    const session = new WebMidiSession(handlers);

    await expect(session.connect()).resolves.toEqual([]);
    expect(handlers.error).toHaveBeenCalledWith("Stalled Keys did not enter the open state.");
    expect(input.close).toHaveBeenCalledTimes(1);
    expect(input.onmidimessage).toBeNull();

    await expect(session.refresh()).resolves.toEqual([
      { id: "stalled-keys", name: "Stalled Keys", manufacturer: "Test" },
    ]);
    expect(input.open).toHaveBeenCalledTimes(2);
    await session.disconnect();
  });

  it("falls back to a remaining device's latest wheel values after unplug", async () => {
    const first = new FakeMidiInput("first", "First Keys");
    const second = new FakeMidiInput("second", "Second Keys");
    const access = new FakeMidiAccess();
    access.inputs.set(first.id, first as unknown as MIDIInput);
    access.inputs.set(second.id, second as unknown as MIDIInput);
    vi.stubGlobal("window", { isSecureContext: true });
    vi.stubGlobal("navigator", {
      requestMIDIAccess: vi.fn(async () => access as unknown as MIDIAccess),
    });
    const handlers = makeHandlers();
    const session = new WebMidiSession(handlers);
    await session.connect();

    first.emit([0xe0, 0x00, 0x00]);
    first.emit([0xb0, 1, 32]);
    second.emit([0xe0, 0x7f, 0x7f]);
    second.emit([0xb0, 1, 96]);
    second.state = "disconnected";
    access.dispatchEvent(new Event("statechange"));
    await Promise.resolve();

    expect(handlers.pitchBend).toHaveBeenLastCalledWith(-1);
    expect(handlers.modulation).toHaveBeenLastCalledWith(32 / 127);
    await session.disconnect();
  });

  it("refreshes controller-lane recency even when a wheel repeats its value", async () => {
    const first = new FakeMidiInput("first-repeat", "First Repeat Keys");
    const second = new FakeMidiInput("second-repeat", "Second Repeat Keys");
    const access = new FakeMidiAccess();
    access.inputs.set(first.id, first as unknown as MIDIInput);
    access.inputs.set(second.id, second as unknown as MIDIInput);
    vi.stubGlobal("window", { isSecureContext: true });
    vi.stubGlobal("navigator", {
      requestMIDIAccess: vi.fn(async () => access as unknown as MIDIAccess),
    });
    const handlers = makeHandlers();
    const session = new WebMidiSession(handlers);
    await session.connect();

    first.emit([0xe0, 0x00, 0x20]);
    second.emit([0xe0, 0x00, 0x60]);
    // Repeating the first lane's unchanged value still makes it the active
    // fallback when the other input is removed.
    first.emit([0xe0, 0x00, 0x20]);
    second.state = "disconnected";
    access.dispatchEvent(new Event("statechange"));
    await Promise.resolve();

    expect(handlers.pitchBend).toHaveBeenLastCalledWith(-0.5);
    await session.disconnect();
  });
});
