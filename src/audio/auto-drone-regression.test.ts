import { describe, expect, it } from "vitest";
import { getFactoryPreset } from "../synth/presets";
import { OdysseyDSP } from "./dsp-core";

const SAMPLE_RATE = 44_100;
const BLOCK_SIZE = 128;
const SECONDS = 30;

describe("Auto Drone sustained output", () => {
  it("continues producing audible output well beyond the first second", () => {
    const preset = getFactoryPreset("Auto Drone");
    expect(preset).toBeDefined();

    const dsp = new OdysseyDSP(SAMPLE_RATE);
    dsp.setParams(preset!.params);

    const sumSquares = Array.from({ length: SECONDS }, () => 0);
    const samples = Array.from({ length: SECONDS }, () => 0);
    let rendered = 0;
    let invalidFrame = -1;
    const totalFrames = SAMPLE_RATE * SECONDS;

    while (rendered < totalFrames) {
      const frames = Math.min(BLOCK_SIZE, totalFrames - rendered);
      const left = new Float32Array(frames);
      const right = new Float32Array(frames);
      dsp.process(left, right);

      for (let index = 0; index < frames; index += 1) {
        const second = Math.min(SECONDS - 1, Math.floor((rendered + index) / SAMPLE_RATE));
        const mono = (left[index] + right[index]) * 0.5;
        if (!Number.isFinite(mono) && invalidFrame < 0) invalidFrame = rendered + index;
        sumSquares[second] += mono * mono;
        samples[second] += 1;
      }
      rendered += frames;
    }

    const rms = sumSquares.map((sum, index) => Math.sqrt(sum / samples[index]));
    expect(invalidFrame).toBe(-1);
    expect(dsp.getMeter()).toMatchObject({ gate: true, lowNote: 43, highNote: 43 });
    expect(
      rms.every((secondRms) => secondRms > 0.001),
      `per-second RMS: ${JSON.stringify(rms)}`,
    ).toBe(true);
    expect(rms.at(-1)!).toBeGreaterThan(rms[0] * 0.1);
  });

  it("Panic clears the voice and delay until a deliberate new articulation", () => {
    const preset = getFactoryPreset("Auto Drone");
    expect(preset).toBeDefined();

    const dsp = new OdysseyDSP(SAMPLE_RATE);
    dsp.setParams(preset!.params);
    const beforePanic = new Float32Array(BLOCK_SIZE);
    dsp.process(beforePanic, new Float32Array(BLOCK_SIZE));
    expect(beforePanic.some((sample) => Math.abs(sample) > 0.0001)).toBe(true);

    // This is the App's Panic ordering: AUTO is disabled before the hard
    // clear. Initial Gain remains nonzero in the patch, so an accidental
    // resume-sound command would immediately expose the free-running VCOs.
    dsp.setParams({ autoRun: 0 });
    dsp.allSoundOff();
    expect(dsp.getDiagnostics().delayTailRetired).toBe(true);
    const afterPanic = new Float32Array(SAMPLE_RATE * 2);
    const afterPanicRight = new Float32Array(afterPanic.length);
    dsp.process(afterPanic, afterPanicRight);
    expect(afterPanic.every((sample) => sample === 0)).toBe(true);
    expect(afterPanicRight.every((sample) => sample === 0)).toBe(true);
    expect(dsp.getDiagnostics().delayTailRetired).toBe(true);

    dsp.noteOn(60);
    const afterNewNote = new Float32Array(4_096);
    dsp.process(afterNewNote, new Float32Array(afterNewNote.length));
    expect(afterNewNote.some((sample) => Math.abs(sample) > 0.0001)).toBe(true);
  });

  it("can deliberately restore its hands-free gate after Panic", () => {
    const preset = getFactoryPreset("Auto Drone");
    expect(preset).toBeDefined();

    const dsp = new OdysseyDSP(SAMPLE_RATE);
    dsp.setParams(preset!.params);
    renderSilently(dsp, SAMPLE_RATE);
    dsp.setParams({ autoRun: 0 });
    dsp.allSoundOff();
    dsp.setParams({ autoRun: 1 });

    const resumed = new Float32Array(SAMPLE_RATE);
    dsp.process(resumed, new Float32Array(resumed.length));
    expect(resumed.some((sample) => Math.abs(sample) > 0.0001)).toBe(true);
    expect(dsp.getMeter()).toMatchObject({ gate: true, lowNote: 43, highNote: 43 });
  });
});

const renderSilently = (dsp: OdysseyDSP, frames: number): void => {
  let remaining = frames;
  while (remaining > 0) {
    const block = Math.min(BLOCK_SIZE, remaining);
    dsp.process(new Float32Array(block), new Float32Array(block));
    remaining -= block;
  }
};
