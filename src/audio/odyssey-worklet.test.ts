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
});
