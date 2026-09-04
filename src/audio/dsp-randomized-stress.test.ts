import { describe, expect, it } from "vitest";
import {
  DEFAULT_PARAMS,
  PARAM_KEYS,
  PARAM_SPECS,
  normalizedToParam,
  type SynthParams,
} from "../synth/params";
import { OdysseyDSP } from "./dsp-core";

const SAMPLE_RATE = 44_100;
const BLOCK_SIZE = 256;

const assertFiniteStereo = (
  left: Float32Array,
  right: Float32Array,
  context: string,
): void => {
  for (let index = 0; index < left.length; index += 1) {
    const leftSample = left[index];
    const rightSample = right[index];
    if (
      !Number.isFinite(leftSample)
      || !Number.isFinite(rightSample)
      || Math.abs(leftSample) > 1
      || Math.abs(rightSample) > 1
    ) {
      throw new Error(`${context}: invalid stereo sample at frame ${index}: ${leftSample}, ${rightSample}`);
    }
  }
};

const renderBlock = (dsp: OdysseyDSP, phase: number, context: string): void => {
  const left = new Float32Array(BLOCK_SIZE);
  const right = new Float32Array(BLOCK_SIZE);
  const external = Float32Array.from(
    { length: BLOCK_SIZE },
    (_, index) => Math.sin((phase + index) * Math.PI * 2 * 997 / SAMPLE_RATE) * 0.7,
  );
  dsp.process(left, right, external);
  assertFiniteStereo(left, right, context);
};

const seededRandom = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
};

describe("deterministic DSP stress matrix", () => {
  it("renders every declared parameter at both boundaries without instability", () => {
    for (const key of PARAM_KEYS) {
      const spec = PARAM_SPECS[key];
      for (const value of [spec.min, spec.max]) {
        const dsp = new OdysseyDSP(SAMPLE_RATE);
        dsp.setParams({
          ...DEFAULT_PARAMS,
          masterVolume: 1,
          autoRun: 1,
          [key]: value,
        });
        renderBlock(dsp, 0, `${key}=${value}`);
        renderBlock(dsp, BLOCK_SIZE, `${key}=${value} retained state`);
      }
    }
  });

  it("survives rapid complete-patch, note, performance, and input changes", () => {
    const random = seededRandom(0xa0d55e7);
    const dsp = new OdysseyDSP(SAMPLE_RATE);

    for (let iteration = 0; iteration < 96; iteration += 1) {
      const patch = Object.fromEntries(
        PARAM_KEYS.map((key) => [key, normalizedToParam(key, random())]),
      ) as SynthParams;
      patch.masterVolume = 1;
      dsp.setParams(patch);
      dsp.setPerformance({
        bendSemitones: random() * 48 - 24,
        vibratoSemitones: random() * 12,
      });

      const low = 24 + Math.floor(random() * 72);
      const high = Math.min(127, low + 1 + Math.floor(random() * 24));
      dsp.noteOn(low);
      if (iteration % 2 === 0) dsp.noteOn(high);
      renderBlock(dsp, iteration * BLOCK_SIZE, `random patch ${iteration}`);
      if (iteration % 3 === 0) dsp.keyboardTrigger();
      if (iteration % 2 === 0) dsp.noteOff(high);
      dsp.noteOff(low);
    }

    const meter = dsp.getMeter();
    expect(meter.sampleRate).toBe(SAMPLE_RATE);
    expect(Number.isFinite(meter.peak)).toBe(true);
    expect(Number.isFinite(meter.rms)).toBe(true);
  });
});
