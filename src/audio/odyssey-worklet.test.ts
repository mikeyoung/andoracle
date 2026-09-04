import { afterEach, describe, expect, it, vi } from "vitest";

interface FakePort {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage: ReturnType<typeof vi.fn>;
}

interface RegisteredProcessor {
  port: FakePort;
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean;
}

interface InspectableDsp {
  readonly params: Record<string, number>;
  readonly performance: { bendSemitones: number; vibratoSemitones: number };
  getHeldNotes(): number[];
  getDiagnostics(): { pendingArticulations: number };
}

describe("AndoracleProcessor", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("emits at most one meter per request on the bounded cadence", async () => {
    let Processor: (new () => RegisteredProcessor) | undefined;
    let processorName: string | undefined;
    class FakeAudioWorkletProcessor {
      readonly port: FakePort = {
        onmessage: null,
        postMessage: vi.fn(),
      };
    }

    vi.stubGlobal("sampleRate", 44100);
    vi.stubGlobal("AudioWorkletProcessor", FakeAudioWorkletProcessor);
    vi.stubGlobal(
      "registerProcessor",
      (name: string, constructor: new () => RegisteredProcessor) => {
        processorName = name;
        Processor = constructor;
      },
    );
    await import("./odyssey-worklet");
    expect(processorName).toBe("andoracle-synth");
    expect(Processor).toBeDefined();

    const processor = new (Processor as new () => RegisteredProcessor)();
    const processBlock = (): void => {
      processor.process(
        [],
        [[new Float32Array(128), new Float32Array(128)]],
        {},
      );
    };
    const requestMeter = (): void => {
      processor.port.onmessage?.({ data: { type: "request-meter" } } as MessageEvent);
    };

    for (let block = 0; block < 13; block += 1) processBlock();
    expect(processor.port.postMessage).not.toHaveBeenCalled();

    requestMeter();
    requestMeter();
    for (let block = 0; block < 11; block += 1) processBlock();
    expect(processor.port.postMessage).not.toHaveBeenCalled();
    processBlock();
    expect(processor.port.postMessage).toHaveBeenCalledTimes(1);
    expect(processor.port.postMessage).toHaveBeenLastCalledWith({
      type: "meter",
      meter: expect.objectContaining({ sampleRate: 44100 }),
    });

    for (let block = 0; block < 24; block += 1) processBlock();
    expect(processor.port.postMessage).toHaveBeenCalledTimes(1);
    requestMeter();
    for (let block = 0; block < 12; block += 1) processBlock();
    expect(processor.port.postMessage).toHaveBeenCalledTimes(2);
  });

  it("routes every engine command and external input through the worklet bridge", async () => {
    let Processor: (new () => RegisteredProcessor) | undefined;
    class FakeAudioWorkletProcessor {
      readonly port: FakePort = {
        onmessage: null,
        postMessage: vi.fn(),
      };
    }

    vi.stubGlobal("sampleRate", 44100);
    vi.stubGlobal("AudioWorkletProcessor", FakeAudioWorkletProcessor);
    vi.stubGlobal(
      "registerProcessor",
      (_name: string, constructor: new () => RegisteredProcessor) => {
        Processor = constructor;
      },
    );
    await import("./odyssey-worklet");
    const processor = new (Processor as new () => RegisteredProcessor)();
    const dsp = (processor as unknown as { dsp: InspectableDsp }).dsp;
    const send = (data: Record<string, unknown>): void => {
      processor.port.onmessage?.({ data } as MessageEvent);
    };

    send({
      type: "params",
      params: {
        mixer1Level: 0,
        mixer2Level: 0,
        mixer3Level: 0,
        externalLevel: 1,
        outputFeedback: 0,
        delayEnabled: 0,
        filterType: 1,
        filterCutoff: 16_000,
        filterResonance: 0,
        filterMod1Amount: 0,
        filterMod2Amount: 0,
        filterMod3Amount: 0,
        hpfCutoff: 16,
        driveEnabled: 0,
        vcaInitialGain: 1,
        vcaEnvelopeAmount: 0,
        masterVolume: 1,
      },
    });
    expect(dsp.params.masterVolume).toBe(1);

    send({ type: "note-on", note: 60 });
    expect(dsp.getHeldNotes()).toEqual([60]);
    const articulationsAfterNote = dsp.getDiagnostics().pendingArticulations;
    send({ type: "keyboard-trigger" });
    expect(dsp.getDiagnostics().pendingArticulations).toBeGreaterThan(articulationsAfterNote);

    send({ type: "performance", performance: { bendSemitones: 7, vibratoSemitones: 1.25 } });
    expect(dsp.performance).toEqual({ bendSemitones: 7, vibratoSemitones: 1.25 });
    send({ type: "note-off", note: 60 });
    expect(dsp.getHeldNotes()).toEqual([]);

    send({ type: "note-on", note: 62 });
    send({ type: "all-notes-off" });
    expect(dsp.getHeldNotes()).toEqual([]);

    const silentLeft = new Float32Array(128);
    const silentRight = new Float32Array(128);
    const input = Float32Array.from(
      { length: 128 },
      (_, frame) => Math.sin(frame * Math.PI * 2 * 440 / 44_100) * 0.25,
    );
    send({ type: "all-sound-off" });
    processor.process([[input]], [[silentLeft, silentRight]], {});
    expect([...silentLeft, ...silentRight].every((sample) => sample === 0)).toBe(true);

    send({ type: "resume-sound" });
    let externalEnergy = 0;
    for (let block = 0; block < 32; block += 1) {
      const left = new Float32Array(128);
      const right = new Float32Array(128);
      processor.process([[input]], [[left, right]], {});
      externalEnergy += left.reduce((sum, sample) => sum + Math.abs(sample), 0);
    }
    expect(externalEnergy).toBeGreaterThan(1);

    send({ type: "request-meter" });
    for (let block = 0; block < 12; block += 1) {
      processor.process([], [[new Float32Array(128), new Float32Array(128)]], {});
    }
    expect(processor.port.postMessage).toHaveBeenCalledTimes(1);
    expect(processor.port.postMessage).toHaveBeenCalledWith({
      type: "meter",
      meter: expect.objectContaining({ sampleRate: 44_100 }),
    });
  });
});
