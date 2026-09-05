import { OdysseyDSP, type PerformanceState } from "./dsp-core";
import type { SynthParams } from "../synth/params";

declare const sampleRate: number;
declare function registerProcessor(name: string, constructor: typeof AudioWorkletProcessor): void;

declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: AudioWorkletNodeOptions);
  abstract process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean;
}

type WorkletMessage =
  | { type: "params"; params: Partial<SynthParams> }
  | { type: "note-on"; note: number }
  | { type: "note-off"; note: number }
  | { type: "keyboard-trigger" }
  | { type: "all-notes-off" }
  | { type: "all-sound-off" }
  | { type: "resume-sound" }
  | { type: "request-meter" }
  | { type: "performance"; performance: Partial<PerformanceState> };

class AndoracleProcessor extends AudioWorkletProcessor {
  private readonly dsp = new OdysseyDSP(sampleRate);
  private externalInputBuffer = new Float32Array(0);
  private blocksUntilMeter = 1;
  private meterRequested = false;

  constructor() {
    super();
    this.port.onmessage = (event: MessageEvent<WorkletMessage>) => {
      const message = event.data;
      switch (message.type) {
        case "params":
          this.dsp.setParams(message.params);
          break;
        case "note-on":
          if (Number.isFinite(message.note)) this.dsp.noteOn(message.note);
          break;
        case "note-off":
          if (Number.isFinite(message.note)) this.dsp.noteOff(message.note);
          break;
        case "keyboard-trigger":
          this.dsp.keyboardTrigger();
          break;
        case "all-notes-off":
          this.dsp.allNotesOff();
          break;
        case "all-sound-off":
          this.dsp.allSoundOff();
          break;
        case "resume-sound":
          this.dsp.resumeSound();
          break;
        case "request-meter":
          this.meterRequested = true;
          break;
        case "performance":
          this.dsp.setPerformance(message.performance);
          break;
      }
    };
  }

  private foldExternalInput(
    channels: Float32Array[] | undefined,
    frameCount: number,
  ): Float32Array | undefined {
    if (!channels?.length) return undefined;
    if (channels.length === 1) return channels[0];
    if (this.externalInputBuffer.length !== frameCount) {
      this.externalInputBuffer = new Float32Array(frameCount);
    }

    const gain = 1 / channels.length;
    for (let frame = 0; frame < frameCount; frame += 1) {
      let sample = 0;
      for (let channel = 0; channel < channels.length; channel += 1) {
        sample += channels[channel]?.[frame] ?? 0;
      }
      this.externalInputBuffer[frame] = sample * gain;
    }
    return this.externalInputBuffer;
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const output = outputs[0];
    if (!output?.[0]) return true;
    const left = output[0];
    const right = output[1] ?? output[0];
    this.dsp.process(left, right, this.foldExternalInput(inputs[0], left.length));
    this.blocksUntilMeter -= 1;
    if (this.blocksUntilMeter <= 0) {
      if (this.meterRequested) {
        this.port.postMessage({ type: "meter", meter: this.dsp.getMeter() });
        this.meterRequested = false;
      }
      this.blocksUntilMeter = 12;
    }
    return true;
  }
}

registerProcessor("andoracle-synth", AndoracleProcessor);
