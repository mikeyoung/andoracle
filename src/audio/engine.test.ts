import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PARAMS } from "../synth/params";
import {
  AUDIO_CONTEXT_CLOSE_TIMEOUT_MS,
  AUDIO_CONTEXT_TRANSITION_TIMEOUT_MS,
  OdysseyAudioEngine,
} from "./engine";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

class FakeAudioParam {
  value = 0;
  readonly cancelScheduledValues = vi.fn();
  readonly setValueAtTime = vi.fn((value: number) => {
    this.value = value;
  });
  readonly linearRampToValueAtTime = vi.fn((value: number) => {
    this.value = value;
  });
}

class FakeAudioNode extends EventTarget {
  readonly disconnect = vi.fn();
  readonly connect = vi.fn((destination: unknown) => destination);
}

class FakeGainNode extends FakeAudioNode {
  readonly gain = new FakeAudioParam();
}

class FakeMessagePort {
  onmessage: ((event: MessageEvent) => void) | null = null;
  readonly postMessage = vi.fn();
  readonly close = vi.fn();
}

class FakeWorkletNode extends FakeAudioNode {
  readonly port = new FakeMessagePort();
}

class FakeMediaSourceNode extends FakeAudioNode {}

class FakeTrack extends EventTarget {
  readyState: MediaStreamTrackState = "live";
  readonly stop = vi.fn(() => {
    this.readyState = "ended";
  });

  end(): void {
    this.readyState = "ended";
    this.dispatchEvent(new Event("ended"));
  }
}

class FakeStream extends EventTarget {
  active = true;
  readonly track = new FakeTrack();

  getTracks(): MediaStreamTrack[] {
    return [this.track as unknown as MediaStreamTrack];
  }

  getAudioTracks(): MediaStreamTrack[] {
    return this.getTracks();
  }

  becomeInactive(): void {
    this.active = false;
    this.dispatchEvent(new Event("inactive"));
  }
}

interface ContextSetup {
  sampleRate?: number;
  addModule?: () => Promise<void>;
  resume?: (context: FakeAudioContext) => Promise<void>;
  suspend?: (context: FakeAudioContext) => Promise<void>;
  close?: (context: FakeAudioContext) => Promise<void>;
  mediaSourceError?: Error;
  mediaConnectError?: Error;
  graphConnectError?: Error;
}

class FakeAudioContext {
  readonly setup: ContextSetup;
  readonly sampleRate: number;
  state: AudioContextState = "suspended";
  currentTime = 1;
  onstatechange: ((event: Event) => void) | null = null;
  readonly destination = new FakeAudioNode();
  readonly gainNode = new FakeGainNode();
  readonly mediaSources: FakeMediaSourceNode[] = [];
  readonly audioWorklet: { addModule: ReturnType<typeof vi.fn> };
  readonly resume = vi.fn(async () => {
    if (this.setup.resume) return this.setup.resume(this);
    if (this.state === "closed") throw new Error("Context is closed");
    this.state = "running";
    this.onstatechange?.(new Event("statechange"));
  });
  readonly suspend = vi.fn(async () => {
    if (this.setup.suspend) return this.setup.suspend(this);
    if (this.state === "closed") throw new Error("Context is closed");
    this.state = "suspended";
    this.onstatechange?.(new Event("statechange"));
  });
  readonly close = vi.fn(async () => {
    if (this.setup.close) return this.setup.close(this);
    this.state = "closed";
    this.onstatechange?.(new Event("statechange"));
  });
  readonly createGain = vi.fn(() => {
    if (this.setup.graphConnectError) {
      this.gainNode.connect.mockImplementationOnce(() => {
        throw this.setup.graphConnectError;
      });
    }
    return this.gainNode as unknown as GainNode;
  });
  readonly createMediaStreamSource = vi.fn((_stream: MediaStream) => {
    if (this.setup.mediaSourceError) throw this.setup.mediaSourceError;
    const source = new FakeMediaSourceNode();
    if (this.setup.mediaConnectError) {
      source.connect.mockImplementationOnce(() => {
        throw this.setup.mediaConnectError;
      });
    }
    this.mediaSources.push(source);
    return source as unknown as MediaStreamAudioSourceNode;
  });

  constructor(setup: ContextSetup) {
    this.setup = setup;
    this.sampleRate = setup.sampleRate ?? 44100;
    this.audioWorklet = {
      addModule: vi.fn(setup.addModule ?? (async () => undefined)),
    };
  }

  transition(state: AudioContextState): ((event: Event) => void) | null {
    this.state = state;
    const callback = this.onstatechange;
    callback?.(new Event("statechange"));
    return callback;
  }
}

let contextSetups: ContextSetup[];
let contexts: FakeAudioContext[];
let workletNodes: FakeWorkletNode[];

const installAudioFakes = (...setups: ContextSetup[]): void => {
  contextSetups = [...setups];
  contexts = [];
  workletNodes = [];
  class AudioContextConstructor {
    constructor() {
      const context = new FakeAudioContext(contextSetups.shift() ?? {});
      contexts.push(context);
      return context;
    }
  }
  class WorkletNodeConstructor {
    constructor() {
      const node = new FakeWorkletNode();
      workletNodes.push(node);
      return node;
    }
  }
  vi.stubGlobal("window", { AudioContext: AudioContextConstructor });
  vi.stubGlobal("AudioWorkletNode", WorkletNodeConstructor);
  vi.stubGlobal("navigator", {});
};

beforeEach(() => installAudioFakes({}));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("OdysseyAudioEngine lifecycle", () => {
  it("closes every partial resource after worklet initialization fails and can retry", async () => {
    installAudioFakes(
      { addModule: async () => { throw new Error("bad worklet"); } },
      {},
    );
    const engine = new OdysseyAudioEngine();

    await expect(engine.powerOn(DEFAULT_PARAMS)).rejects.toThrow("bad worklet");
    expect(contexts[0].close).toHaveBeenCalledTimes(1);
    expect(workletNodes).toHaveLength(0);
    await expect(engine.powerOn(DEFAULT_PARAMS)).resolves.toBeUndefined();
    expect(contexts).toHaveLength(2);
    expect(workletNodes).toHaveLength(1);
    await engine.dispose();
  });

  it("rolls back the worklet node, gain, and context after graph connection fails", async () => {
    installAudioFakes({ graphConnectError: new Error("destination rejected") });
    const engine = new OdysseyAudioEngine();

    await expect(engine.powerOn(DEFAULT_PARAMS)).rejects.toThrow("destination rejected");
    expect(workletNodes[0].port.onmessage).toBeNull();
    expect(workletNodes[0].port.close).toHaveBeenCalled();
    expect(workletNodes[0].disconnect).toHaveBeenCalled();
    expect(contexts[0].gainNode.disconnect).toHaveBeenCalled();
    expect(contexts[0].close).toHaveBeenCalled();
  });

  it("invalidates and closes an initialization that is pending during dispose", async () => {
    const moduleLoad = deferred<void>();
    installAudioFakes({ addModule: () => moduleLoad.promise });
    const engine = new OdysseyAudioEngine();
    const starting = engine.powerOn(DEFAULT_PARAMS);

    await vi.waitFor(() => expect(contexts).toHaveLength(1));
    await engine.dispose();
    await expect(starting).rejects.toMatchObject({ name: "AbortError" });
    expect(contexts[0].close).toHaveBeenCalledTimes(1);
    moduleLoad.resolve();
    await Promise.resolve();
    expect(workletNodes).toHaveLength(0);
    await expect(engine.powerOn(DEFAULT_PARAMS)).rejects.toThrow("no longer available");
  });

  it("recovers with a fresh graph after the active context closes and ignores its stale callback", async () => {
    installAudioFakes({}, {});
    const engine = new OdysseyAudioEngine();
    const states: AudioContextState[] = [];
    engine.onStatus((status) => {
      if (status.state !== "uninitialized") states.push(status.state);
    });
    await engine.powerOn(DEFAULT_PARAMS);
    const staleCallback = contexts[0].transition("closed");

    await engine.powerOn(DEFAULT_PARAMS);
    expect(contexts).toHaveLength(2);
    expect(workletNodes).toHaveLength(2);
    contexts[0].state = "suspended";
    staleCallback?.(new Event("statechange"));
    expect(states.at(-1)).toBe("running");
    await engine.dispose();
  });

  it("quarantines a failed worklet processor and builds a fresh graph on restart", async () => {
    installAudioFakes({}, {});
    const engine = new OdysseyAudioEngine();
    const statuses: string[] = [];
    engine.onStatus((status) => {
      if (status.error) statuses.push(status.error);
    });
    await engine.powerOn(DEFAULT_PARAMS);
    const failedNode = workletNodes[0];

    failedNode.dispatchEvent(new Event("processorerror"));
    expect(failedNode.port.onmessage).toBeNull();
    expect(failedNode.port.close).toHaveBeenCalledTimes(1);
    expect(failedNode.disconnect).toHaveBeenCalled();
    expect(contexts[0].gainNode.disconnect).toHaveBeenCalled();
    expect(contexts[0].close).toHaveBeenCalledTimes(1);
    expect(statuses.at(-1)).toContain("processor stopped unexpectedly");

    failedNode.port.postMessage.mockClear();
    engine.setParams({ vco1Fine: 0.1 });
    engine.noteOn(60);
    expect(failedNode.port.postMessage).not.toHaveBeenCalled();

    await engine.powerOn(DEFAULT_PARAMS);
    expect(contexts).toHaveLength(2);
    expect(workletNodes).toHaveLength(2);
    await engine.dispose();
  });

  it("resumes an interrupted context without constructing a replacement", async () => {
    const engine = new OdysseyAudioEngine();
    await engine.powerOn(DEFAULT_PARAMS);
    contexts[0].transition("interrupted");

    await engine.powerOn(DEFAULT_PARAMS);
    expect(contexts).toHaveLength(1);
    expect(contexts[0].resume).toHaveBeenCalledTimes(2);
    expect(contexts[0].state).toBe("running");
    await engine.dispose();
  });

  it("promptly rejects a superseded power-on while sharing its pending initialization", async () => {
    const moduleLoad = deferred<void>();
    installAudioFakes({ addModule: () => moduleLoad.promise });
    const engine = new OdysseyAudioEngine();
    const first = engine.powerOn(DEFAULT_PARAMS);
    const second = engine.powerOn(DEFAULT_PARAMS);

    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    moduleLoad.resolve();
    await expect(second).resolves.toBeUndefined();
    expect(contexts).toHaveLength(1);
    await engine.dispose();
  });

  it("powers off promptly by invalidating a never-settling initialization", async () => {
    const moduleLoad = deferred<void>();
    installAudioFakes(
      { addModule: () => moduleLoad.promise },
      {},
    );
    const engine = new OdysseyAudioEngine();
    const starting = engine.powerOn(DEFAULT_PARAMS);
    await vi.waitFor(() => expect(contexts).toHaveLength(1));

    await expect(engine.powerOff()).resolves.toBeUndefined();
    await expect(starting).rejects.toMatchObject({ name: "AbortError" });
    expect(contexts[0].close).toHaveBeenCalled();
    moduleLoad.resolve();
    await Promise.resolve();
    expect(workletNodes).toHaveLength(0);

    await engine.powerOn(DEFAULT_PARAMS);
    expect(contexts).toHaveLength(2);
    await engine.dispose();
  });

  it("quarantines a cancelled raw worklet load across repeated startup retries", async () => {
    const moduleLoad = deferred<void>();
    installAudioFakes(
      { addModule: () => moduleLoad.promise },
      {},
    );
    const engine = new OdysseyAudioEngine();
    const starting = engine.powerOn(DEFAULT_PARAMS);
    await vi.waitFor(() => expect(contexts).toHaveLength(1));

    await expect(engine.powerOff()).resolves.toBeUndefined();
    await expect(starting).rejects.toMatchObject({ name: "AbortError" });
    for (let retry = 0; retry < 10; retry += 1) {
      await expect(engine.powerOn(DEFAULT_PARAMS)).rejects.toThrow(
        "A previous audio processor load is still finishing. Try again shortly.",
      );
    }

    expect(contexts).toHaveLength(1);
    expect(contexts[0].audioWorklet.addModule).toHaveBeenCalledTimes(1);
    moduleLoad.resolve();
    await moduleLoad.promise;
    await Promise.resolve();

    await expect(engine.powerOn(DEFAULT_PARAMS)).resolves.toBeUndefined();
    expect(contexts).toHaveLength(2);
    expect(contexts[1].audioWorklet.addModule).toHaveBeenCalledTimes(1);
    await engine.dispose();
  });

  it("quarantines a cancelled raw resume across repeated power retries", async () => {
    const resuming = deferred<void>();
    installAudioFakes(
      {
        resume: async (context) => {
          await resuming.promise;
          context.state = "running";
          context.onstatechange?.(new Event("statechange"));
        },
      },
      {},
    );
    const engine = new OdysseyAudioEngine();
    const starting = engine.powerOn(DEFAULT_PARAMS);
    await vi.waitFor(() => expect(contexts[0]?.resume).toHaveBeenCalledTimes(1));

    await expect(engine.powerOff()).resolves.toBeUndefined();
    await expect(starting).rejects.toMatchObject({ name: "AbortError" });
    for (let retry = 0; retry < 10; retry += 1) {
      await expect(engine.powerOn(DEFAULT_PARAMS)).rejects.toThrow(
        "A previous audio context transition is still finishing. Try again shortly.",
      );
    }

    expect(contexts).toHaveLength(1);
    expect(contexts[0].resume).toHaveBeenCalledTimes(1);
    resuming.resolve();
    await resuming.promise;
    await Promise.resolve();
    await Promise.resolve();

    await expect(engine.powerOn(DEFAULT_PARAMS)).resolves.toBeUndefined();
    expect(contexts).toHaveLength(2);
    expect(contexts[1].resume).toHaveBeenCalledTimes(1);
    await engine.dispose();
  });

  it("quarantines a cancelled raw suspend across repeated power retries", async () => {
    vi.useFakeTimers();
    const suspending = deferred<void>();
    installAudioFakes(
      {
        suspend: async (context) => {
          await suspending.promise;
          context.state = "suspended";
          context.onstatechange?.(new Event("statechange"));
        },
      },
      {},
    );
    const engine = new OdysseyAudioEngine();
    await engine.powerOn(DEFAULT_PARAMS);

    const stopping = engine.powerOff();
    await vi.advanceTimersByTimeAsync(40);
    expect(contexts[0].suspend).toHaveBeenCalledTimes(1);
    const interruptedStart = engine.powerOn(DEFAULT_PARAMS);
    await expect(stopping).rejects.toMatchObject({ name: "AbortError" });
    await expect(interruptedStart).rejects.toThrow(
      "A previous audio context transition is still finishing. Try again shortly.",
    );
    for (let retry = 0; retry < 10; retry += 1) {
      await expect(engine.powerOn(DEFAULT_PARAMS)).rejects.toThrow(
        "A previous audio context transition is still finishing. Try again shortly.",
      );
    }

    expect(contexts).toHaveLength(1);
    expect(contexts[0].suspend).toHaveBeenCalledTimes(1);
    suspending.resolve();
    await suspending.promise;
    await vi.advanceTimersByTimeAsync(0);

    await expect(engine.powerOn(DEFAULT_PARAMS)).resolves.toBeUndefined();
    expect(contexts).toHaveLength(2);
    await engine.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects a non-44.1 kHz context, closes it, and permits a 44.1 kHz retry", async () => {
    installAudioFakes({ sampleRate: 48000 }, { sampleRate: 44100 });
    const engine = new OdysseyAudioEngine();

    await expect(engine.powerOn(DEFAULT_PARAMS)).rejects.toThrow(
      "A 44,100 Hz audio context is required; this device opened at 48,000 Hz.",
    );
    expect(contexts[0].audioWorklet.addModule).not.toHaveBeenCalled();
    expect(contexts[0].close).toHaveBeenCalledTimes(1);

    await expect(engine.powerOn(DEFAULT_PARAMS)).resolves.toBeUndefined();
    expect(contexts).toHaveLength(2);
    expect(contexts[1].sampleRate).toBe(44100);
    expect(contexts[1].state).toBe("running");
    await engine.dispose();
  });

  it("quarantines a timed-out resume until its late transition and close settle", async () => {
    vi.useFakeTimers();
    const resuming = deferred<void>();
    const closing = deferred<void>();
    installAudioFakes({
      resume: async (context) => {
        await resuming.promise;
        context.state = "running";
        context.onstatechange?.(new Event("statechange"));
      },
      close: async (context) => {
        await closing.promise;
        context.state = "closed";
        context.onstatechange?.(new Event("statechange"));
      },
    }, {});
    const engine = new OdysseyAudioEngine();
    const starting = engine.powerOn(DEFAULT_PARAMS);
    const startOutcome = starting.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(contexts[0].resume).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(AUDIO_CONTEXT_TRANSITION_TIMEOUT_MS);
    await expect(startOutcome).resolves.toMatchObject({ name: "TimeoutError" });
    expect(workletNodes[0].port.onmessage).toBeNull();
    expect(workletNodes[0].disconnect).toHaveBeenCalled();
    expect(contexts[0].gainNode.disconnect).toHaveBeenCalled();
    expect(contexts[0].close).toHaveBeenCalledTimes(1);
    await expect(engine.powerOn(DEFAULT_PARAMS)).rejects.toThrow("still shutting down");
    expect(contexts).toHaveLength(1);

    resuming.resolve();
    closing.resolve();
    await vi.advanceTimersByTimeAsync(0);
    await expect(engine.powerOn(DEFAULT_PARAMS)).resolves.toBeUndefined();
    expect(contexts).toHaveLength(2);
    await engine.dispose();
  });

  it("closes a resume that completes after power-off cancelled it", async () => {
    const resuming = deferred<void>();
    installAudioFakes({
      resume: async (context) => {
        await resuming.promise;
        context.state = "running";
        context.onstatechange?.(new Event("statechange"));
      },
    }, {});
    const engine = new OdysseyAudioEngine();
    const starting = engine.powerOn(DEFAULT_PARAMS);
    await vi.waitFor(() => expect(contexts[0].resume).toHaveBeenCalledTimes(1));

    await expect(engine.powerOff()).resolves.toBeUndefined();
    await expect(starting).rejects.toMatchObject({ name: "AbortError" });
    expect(contexts[0].close).toHaveBeenCalledTimes(1);

    resuming.resolve();
    await vi.waitFor(() => expect(contexts[0].close).toHaveBeenCalledTimes(2));
    expect(contexts[0].state).toBe("closed");
    await expect(engine.powerOn(DEFAULT_PARAMS)).resolves.toBeUndefined();
    expect(contexts).toHaveLength(2);
    await engine.dispose();
  });

  it("retains raw close ownership even when close reports the closed state early", async () => {
    const resuming = deferred<void>();
    const closing = deferred<void>();
    installAudioFakes({
      resume: async (context) => {
        await resuming.promise;
        context.state = "running";
        context.onstatechange?.(new Event("statechange"));
      },
      close: async (context) => {
        context.state = "closed";
        await closing.promise;
        context.state = "closed";
      },
    }, {});
    const engine = new OdysseyAudioEngine();
    const starting = engine.powerOn(DEFAULT_PARAMS);
    await vi.waitFor(() => expect(contexts[0].resume).toHaveBeenCalledTimes(1));

    await engine.powerOff();
    await expect(starting).rejects.toMatchObject({ name: "AbortError" });
    expect(contexts[0].close).toHaveBeenCalledTimes(1);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await expect(engine.powerOn(DEFAULT_PARAMS)).rejects.toThrow("still shutting down");
    }

    resuming.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(contexts[0].state).toBe("running");
    expect(contexts[0].close).toHaveBeenCalledTimes(1);
    closing.resolve();
    await vi.waitFor(() => expect(contexts[0].state).toBe("closed"));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(contexts[0].close).toHaveBeenCalledTimes(1);
    await expect(engine.powerOn(DEFAULT_PARAMS)).resolves.toBeUndefined();
    expect(contexts).toHaveLength(2);
    await engine.dispose();
  });

  it("quarantines a timed-out suspend until its late transition and close settle", async () => {
    vi.useFakeTimers();
    const suspending = deferred<void>();
    const closing = deferred<void>();
    installAudioFakes({
      suspend: async (context) => {
        await suspending.promise;
        context.state = "suspended";
        context.onstatechange?.(new Event("statechange"));
      },
      close: async (context) => {
        await closing.promise;
        context.state = "closed";
        context.onstatechange?.(new Event("statechange"));
      },
    }, {});
    const engine = new OdysseyAudioEngine();
    await engine.powerOn(DEFAULT_PARAMS);

    const stopping = engine.powerOff();
    const stopOutcome = stopping.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(40);
    expect(contexts[0].suspend).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(AUDIO_CONTEXT_TRANSITION_TIMEOUT_MS);
    await expect(stopOutcome).resolves.toMatchObject({ name: "TimeoutError" });
    expect(contexts[0].close).toHaveBeenCalledTimes(1);
    await expect(engine.powerOn(DEFAULT_PARAMS)).rejects.toThrow("still shutting down");
    expect(contexts).toHaveLength(1);

    suspending.resolve();
    closing.resolve();
    await vi.advanceTimersByTimeAsync(0);
    await expect(engine.powerOn(DEFAULT_PARAMS)).resolves.toBeUndefined();
    expect(contexts).toHaveLength(2);
    await engine.dispose();
  });

  it("bounds dispose when close never settles", async () => {
    vi.useFakeTimers();
    installAudioFakes({ close: () => new Promise<never>(() => undefined) });
    const engine = new OdysseyAudioEngine();
    await engine.powerOn(DEFAULT_PARAMS);

    const disposing = engine.dispose();
    expect(contexts[0].close).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(AUDIO_CONTEXT_CLOSE_TIMEOUT_MS);
    await expect(disposing).resolves.toBeUndefined();
    expect(workletNodes[0].port.onmessage).toBeNull();
    expect(workletNodes[0].port.close).toHaveBeenCalledTimes(1);
    expect(workletNodes[0].disconnect).toHaveBeenCalled();
    expect(contexts[0].gainNode.disconnect).toHaveBeenCalled();
  });

  it("cancels a never-settling media prompt promptly and stops a late stream", async () => {
    const permission = deferred<MediaStream>();
    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia: vi.fn(() => permission.promise) },
    });
    const engine = new OdysseyAudioEngine();
    await engine.powerOn(DEFAULT_PARAMS);

    const enabling = engine.enableExternalInput();
    engine.disableExternalInput();
    await expect(enabling).rejects.toMatchObject({ name: "AbortError" });

    const lateStream = new FakeStream();
    permission.resolve(lateStream as unknown as MediaStream);
    await vi.waitFor(() => expect(lateStream.track.stop).toHaveBeenCalled());
    expect(contexts[0].createMediaStreamSource).not.toHaveBeenCalled();
    await engine.dispose();
  });

  it("coalesces repeated retries behind one cancelled media permission request", async () => {
    const firstPermission = deferred<MediaStream>();
    const secondStream = new FakeStream();
    const getUserMedia = vi.fn()
      .mockReturnValueOnce(firstPermission.promise)
      .mockResolvedValueOnce(secondStream as unknown as MediaStream);
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    const engine = new OdysseyAudioEngine();
    await engine.powerOn(DEFAULT_PARAMS);

    const first = engine.enableExternalInput();
    engine.disableExternalInput();
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await expect(engine.enableExternalInput()).rejects.toThrow("still pending in the browser");
    }
    expect(getUserMedia).toHaveBeenCalledTimes(1);

    const lateStream = new FakeStream();
    firstPermission.resolve(lateStream as unknown as MediaStream);
    await vi.waitFor(() => expect(lateStream.track.stop).toHaveBeenCalled());
    await expect(engine.enableExternalInput()).resolves.toBeUndefined();
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    await engine.dispose();
  });

  it("keeps a cancelled media prompt bounded across engine remounts", async () => {
    const firstPermission = deferred<MediaStream>();
    const retryStream = new FakeStream();
    const getUserMedia = vi.fn()
      .mockReturnValueOnce(firstPermission.promise)
      .mockResolvedValueOnce(retryStream as unknown as MediaStream);
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    const firstEngine = new OdysseyAudioEngine();
    await firstEngine.powerOn(DEFAULT_PARAMS);
    const enabling = firstEngine.enableExternalInput();
    await firstEngine.dispose();
    await expect(enabling).rejects.toMatchObject({ name: "AbortError" });

    const replacementEngine = new OdysseyAudioEngine();
    await replacementEngine.powerOn(DEFAULT_PARAMS);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await expect(replacementEngine.enableExternalInput()).rejects.toThrow(
        "still pending in the browser",
      );
    }
    expect(getUserMedia).toHaveBeenCalledTimes(1);

    const lateStream = new FakeStream();
    firstPermission.resolve(lateStream as unknown as MediaStream);
    await vi.waitFor(() => expect(lateStream.track.stop).toHaveBeenCalled());
    await expect(replacementEngine.enableExternalInput()).resolves.toBeUndefined();
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    await replacementEngine.dispose();
  });

  it("cancels a pending media prompt on dispose before its late stream is available", async () => {
    const permission = deferred<MediaStream>();
    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia: vi.fn(() => permission.promise) },
    });
    const engine = new OdysseyAudioEngine();
    await engine.powerOn(DEFAULT_PARAMS);
    const enabling = engine.enableExternalInput();

    await engine.dispose();
    await expect(enabling).rejects.toMatchObject({ name: "AbortError" });
    const lateStream = new FakeStream();
    permission.resolve(lateStream as unknown as MediaStream);
    await vi.waitFor(() => expect(lateStream.track.stop).toHaveBeenCalled());
  });

  it("handles a stream ending synchronously during its connected notification", async () => {
    const first = new FakeStream();
    const second = new FakeStream();
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: vi.fn()
          .mockResolvedValueOnce(first as unknown as MediaStream)
          .mockResolvedValueOnce(second as unknown as MediaStream),
      },
    });
    const engine = new OdysseyAudioEngine();
    engine.onExternalInputState((connected) => {
      if (connected) first.track.end();
    });
    await engine.powerOn(DEFAULT_PARAMS);

    await expect(engine.enableExternalInput()).rejects.toMatchObject({ name: "AbortError" });
    expect(first.track.stop).toHaveBeenCalled();
    await expect(engine.enableExternalInput()).resolves.toBeUndefined();
    await engine.dispose();
  });

  it.each(["source", "connect"] as const)(
    "stops the acquired stream when media %s construction fails",
    async (failure) => {
      installAudioFakes(failure === "source"
        ? { mediaSourceError: new Error("source failed") }
        : { mediaConnectError: new Error("connect failed") });
      const stream = new FakeStream();
      vi.stubGlobal("navigator", {
        mediaDevices: { getUserMedia: vi.fn(async () => stream as unknown as MediaStream) },
      });
      const engine = new OdysseyAudioEngine();
      await engine.powerOn(DEFAULT_PARAMS);

      await expect(engine.enableExternalInput()).rejects.toThrow(`${failure} failed`);
      expect(stream.track.stop).toHaveBeenCalled();
      if (failure === "connect") {
        expect(contexts[0].mediaSources[0].disconnect).toHaveBeenCalled();
      }
      await engine.dispose();
    },
  );

  it("rolls back partially installed live-input listeners when a track rejects setup", async () => {
    const stream = new FakeStream();
    const removeStreamListener = vi.spyOn(stream, "removeEventListener");
    vi.spyOn(stream.track, "addEventListener").mockImplementationOnce(() => {
      throw new Error("track listener failed");
    });
    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia: vi.fn(async () => stream as unknown as MediaStream) },
    });
    const engine = new OdysseyAudioEngine();
    await engine.powerOn(DEFAULT_PARAMS);

    await expect(engine.enableExternalInput()).rejects.toThrow("track listener failed");
    expect(removeStreamListener).toHaveBeenCalledWith("inactive", expect.any(Function));
    expect(contexts[0].mediaSources[0].disconnect).toHaveBeenCalledTimes(1);
    expect(stream.track.stop).toHaveBeenCalledTimes(1);
    await engine.dispose();
  });

  it.each(["ended", "inactive"] as const)(
    "clears a %s live-input stream and permits reacquisition",
    async (eventType) => {
      const first = new FakeStream();
      const second = new FakeStream();
      const getUserMedia = vi.fn()
        .mockResolvedValueOnce(first as unknown as MediaStream)
        .mockResolvedValueOnce(second as unknown as MediaStream);
      vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
      const engine = new OdysseyAudioEngine();
      const inputStates: boolean[] = [];
      engine.onExternalInputState((connected) => inputStates.push(connected));
      await engine.powerOn(DEFAULT_PARAMS);
      await engine.enableExternalInput();

      if (eventType === "ended") first.track.end();
      else first.becomeInactive();
      expect(inputStates).toEqual([false, true, false]);
      expect(contexts[0].mediaSources[0].disconnect).toHaveBeenCalled();
      expect(first.track.stop).toHaveBeenCalled();

      await engine.enableExternalInput();
      expect(getUserMedia).toHaveBeenCalledTimes(2);
      expect(inputStates.at(-1)).toBe(true);
      await engine.dispose();
    },
  );

  it("rejects live input while suspended and replaces a retained dead stream", async () => {
    const first = new FakeStream();
    const second = new FakeStream();
    const getUserMedia = vi.fn()
      .mockResolvedValueOnce(first as unknown as MediaStream)
      .mockResolvedValueOnce(second as unknown as MediaStream);
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    const engine = new OdysseyAudioEngine();
    await engine.powerOn(DEFAULT_PARAMS);
    contexts[0].transition("suspended");
    await expect(engine.enableExternalInput()).rejects.toThrow("Power on");
    contexts[0].transition("running");
    await engine.enableExternalInput();

    first.active = false;
    first.track.readyState = "ended";
    await engine.enableExternalInput();
    expect(first.track.stop).toHaveBeenCalled();
    expect(contexts[0].mediaSources[0].disconnect).toHaveBeenCalled();
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    await engine.dispose();
  });

  it("tears down live input when a closed context is detected before its callback", async () => {
    installAudioFakes({}, {});
    const stream = new FakeStream();
    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia: vi.fn(async () => stream as unknown as MediaStream) },
    });
    const engine = new OdysseyAudioEngine();
    await engine.powerOn(DEFAULT_PARAMS);
    await engine.enableExternalInput();

    contexts[0].state = "closed";
    await engine.powerOn(DEFAULT_PARAMS);
    expect(contexts).toHaveLength(2);
    expect(stream.track.stop).toHaveBeenCalled();
    expect(contexts[0].mediaSources[0].disconnect).toHaveBeenCalled();
    await engine.dispose();
  });

  it("bounds meter traffic to one outstanding request and stops requesting without a listener", async () => {
    const engine = new OdysseyAudioEngine();
    const listener = vi.fn();
    const unsubscribe = engine.onMeter(listener);
    await engine.powerOn(DEFAULT_PARAMS);
    const port = workletNodes[0].port;
    const meterRequests = (): number => port.postMessage.mock.calls
      .filter(([message]) => message.type === "request-meter").length;
    expect(meterRequests()).toBe(1);

    contexts[0].transition("running");
    contexts[0].transition("running");
    expect(meterRequests()).toBe(1);
    contexts[0].state = "suspended";
    port.onmessage?.({ data: { type: "meter", meter: { peak: 0.8 } } } as MessageEvent);
    expect(listener).not.toHaveBeenCalled();
    contexts[0].transition("running");
    expect(meterRequests()).toBe(2);
    port.onmessage?.({ data: { type: "meter", meter: {} } } as MessageEvent);
    expect(meterRequests()).toBe(3);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    port.onmessage?.({ data: { type: "meter", meter: {} } } as MessageEvent);
    expect(meterRequests()).toBe(3);
    await engine.dispose();
  });

  it("does not queue controls while suspended and resynchronizes state on power-on", async () => {
    vi.useFakeTimers();
    const engine = new OdysseyAudioEngine();
    await engine.powerOn(DEFAULT_PARAMS);
    const port = workletNodes[0].port;
    port.postMessage.mockClear();
    const poweringOff = engine.powerOff();
    await vi.advanceTimersByTimeAsync(40);
    await poweringOff;
    port.postMessage.mockClear();

    engine.setParams({ vco1Fine: 0.25 });
    engine.setPerformance({ bendSemitones: 3 });
    engine.noteOn(60);
    engine.noteOff(60);
    engine.keyboardTrigger();
    engine.allNotesOff();
    engine.allSoundOff();
    expect(port.postMessage).not.toHaveBeenCalled();

    await engine.powerOn({ ...DEFAULT_PARAMS, vco1Fine: 0.25 });
    expect(port.postMessage).toHaveBeenCalledWith({ type: "all-notes-off" });
    expect(port.postMessage).toHaveBeenCalledWith({
      type: "params",
      params: expect.objectContaining({ vco1Fine: 0.25 }),
    });
    expect(port.postMessage).toHaveBeenCalledWith({
      type: "performance",
      performance: { bendSemitones: 3, vibratoSemitones: 0 },
    });
    await engine.dispose();
  });

  it("clears superseded power-down ramp timers across repeated power cycles", async () => {
    vi.useFakeTimers();
    const engine = new OdysseyAudioEngine();
    await engine.powerOn(DEFAULT_PARAMS);

    for (let cycle = 0; cycle < 10; cycle += 1) {
      const stopping = engine.powerOff();
      const stopped = stopping.catch((error: unknown) => error);
      const starting = engine.powerOn(DEFAULT_PARAMS);
      await expect(stopped).resolves.toMatchObject({ name: "AbortError" });
      await expect(starting).resolves.toBeUndefined();
      expect(vi.getTimerCount()).toBe(0);
    }

    await engine.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("releases every live-input graph across ten complete power and device cycles", async () => {
    vi.useFakeTimers();
    const streams: FakeStream[] = [];
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: vi.fn(async () => {
          const stream = new FakeStream();
          streams.push(stream);
          return stream as unknown as MediaStream;
        }),
      },
    });
    const engine = new OdysseyAudioEngine();

    for (let cycle = 0; cycle < 10; cycle += 1) {
      await engine.powerOn(DEFAULT_PARAMS);
      await engine.enableExternalInput();
      engine.disableExternalInput();
      const stopping = engine.powerOff();
      await vi.advanceTimersByTimeAsync(40);
      await stopping;
      expect(vi.getTimerCount()).toBe(0);
    }

    expect(contexts).toHaveLength(1);
    expect(workletNodes).toHaveLength(1);
    expect(streams).toHaveLength(10);
    for (const [index, stream] of streams.entries()) {
      expect(stream.track.stop, `stream ${index} track`).toHaveBeenCalledTimes(1);
      expect(contexts[0].mediaSources[index].disconnect, `stream ${index} source`)
        .toHaveBeenCalledTimes(1);
    }
    await engine.dispose();
    expect(contexts[0].close).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("fully disposes the graph, external stream, port, and AudioContext", async () => {
    const stream = new FakeStream();
    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia: vi.fn(async () => stream as unknown as MediaStream) },
    });
    const engine = new OdysseyAudioEngine();
    await engine.powerOn(DEFAULT_PARAMS);
    await engine.enableExternalInput();
    expect(workletNodes[0].port.postMessage).toHaveBeenCalledWith({ type: "resume-sound" });
    engine.allSoundOff();
    expect(workletNodes[0].port.postMessage).toHaveBeenLastCalledWith({ type: "all-sound-off" });

    await engine.dispose();
    expect(stream.track.stop).toHaveBeenCalled();
    expect(contexts[0].mediaSources[0].disconnect).toHaveBeenCalled();
    expect(workletNodes[0].port.onmessage).toBeNull();
    expect(workletNodes[0].port.close).toHaveBeenCalled();
    expect(workletNodes[0].disconnect).toHaveBeenCalled();
    expect(contexts[0].gainNode.disconnect).toHaveBeenCalled();
    expect(contexts[0].close).toHaveBeenCalledTimes(1);
  });
});
