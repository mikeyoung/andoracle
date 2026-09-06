import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MIDI_INPUT_OPEN_TIMEOUT_MS,
  WebMidiSession,
  MIDI_INPUT_CLOSE_TIMEOUT_MS,
  combinePerformanceSources,
  decodeMidiMessage,
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

  it("ignores malformed, system, clock, and unsupported messages", () => {
    expect(decodeMidiMessage([])).toBeNull();
    expect(decodeMidiMessage([0x90, 60])).toBeNull();
    expect(decodeMidiMessage([0xf8])).toBeNull();
    expect(decodeMidiMessage([0xb0, 7, 100])).toBeNull();
    expect(decodeMidiMessage([0x40, 60, 100])).toBeNull();
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
});
