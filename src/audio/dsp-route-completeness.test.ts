import { describe, expect, it } from "vitest";
import { OdysseyDSP } from "./dsp-core";
import type { SynthParams } from "../synth/params";

const SAMPLE_RATE = 44_100;

const render = (
  dsp: OdysseyDSP,
  frames: number,
  externalInput?: Float32Array,
): [Float32Array, Float32Array] => {
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  dsp.process(left, right, externalInput);
  return [left, right];
};

const rms = (samples: Float32Array): number => Math.sqrt(
  samples.reduce((sum, sample) => sum + sample * sample, 0) / Math.max(1, samples.length),
);

const meanAbsoluteDifference = (left: Float32Array, right: Float32Array): number => {
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference += Math.abs(left[index] - right[index]);
  }
  return difference / Math.max(1, left.length);
};

const openExternalPatch = (overrides: Partial<SynthParams> = {}): Partial<SynthParams> => ({
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
  ...overrides,
});

const sine = (frames: number, frequency: number): Float32Array => Float32Array.from(
  { length: frames },
  (_, frame) => Math.sin(frame * Math.PI * 2 * frequency / SAMPLE_RATE) * 0.25,
);

describe("remaining normalized signal-route contracts", () => {
  it("uses Auto as a held key, yields to physical notes, and resumes its selected note", () => {
    const dsp = new OdysseyDSP(SAMPLE_RATE);
    dsp.setParams({ autoRun: 1, autoNote: 41, portamento: 0 });
    render(dsp, 1);
    expect(dsp.getMeter()).toMatchObject({ gate: true, lowNote: 41, highNote: 41 });

    dsp.noteOn(55);
    render(dsp, 1);
    expect(dsp.getMeter()).toMatchObject({ gate: true, lowNote: 55, highNote: 55 });

    dsp.setParams({ autoNote: 43 });
    render(dsp, 1);
    expect(dsp.getMeter()).toMatchObject({ gate: true, lowNote: 55, highNote: 55 });

    dsp.noteOff(55);
    render(dsp, 1);
    expect(dsp.getMeter()).toMatchObject({ gate: true, lowNote: 43, highNote: 43 });

    dsp.setParams({ autoRun: 0 });
    render(dsp, 1);
    expect(dsp.getMeter().gate).toBe(false);
  });

  it("applies each oscillator fine control independently at the declared cent scale", () => {
    const frequencies = (vco1Fine: number, vco2Fine: number): [number, number] => {
      const dsp = new OdysseyDSP(SAMPLE_RATE);
      dsp.setParams({ portamento: 0, vco1Fine, vco2Fine });
      dsp.noteOn(48);
      render(dsp, 1);
      const meter = dsp.getMeter();
      return [meter.vco1Frequency, meter.vco2Frequency];
    };

    const neutral = frequencies(0, 0);
    const split = frequencies(100, -100);
    const semitone = Math.pow(2, 1 / 12);
    expect(split[0] / neutral[0]).toBeCloseTo(semitone, 6);
    expect(split[1] / neutral[1]).toBeCloseTo(1 / semitone, 6);
  });

  it("applies modulation-wheel vibrato equally to both oscillators through the LFO", () => {
    const frequencies = (vibratoSemitones: number): { frequencies: [number, number]; lfo: number } => {
      const dsp = new OdysseyDSP(SAMPLE_RATE);
      dsp.setParams({ portamento: 0, lfoRate: 0.2 });
      dsp.setPerformance({ vibratoSemitones });
      dsp.noteOn(48);
      render(dsp, 1);
      const meter = dsp.getMeter();
      return {
        frequencies: [meter.vco1Frequency, meter.vco2Frequency],
        lfo: dsp.getDiagnostics().lfoTriangle,
      };
    };

    const neutral = frequencies(0);
    const vibrato = frequencies(1);
    const expectedRatio = Math.pow(2, vibrato.lfo / 12);
    expect(vibrato.frequencies[0] / neutral.frequencies[0]).toBeCloseTo(expectedRatio, 6);
    expect(vibrato.frequencies[1] / neutral.frequencies[1]).toBeCloseTo(expectedRatio, 6);
    expect(expectedRatio).toBeLessThan(1);
  });

  it("switches VCO 2 FM 1 between LFO and the shared mixer/pedal control node", () => {
    const frequencyForSource = (vco2Fm1Source: number): number => {
      const dsp = new OdysseyDSP(SAMPLE_RATE);
      dsp.setParams({
        portamento: 0,
        lfoRate: 0.2,
        vco2Coarse: 100,
        vco2Fm1Source,
        vco2Fm1Amount: 0.5,
        pedalConnected: 1,
        pedalPosition: 1,
      });
      dsp.noteOn(36);
      render(dsp, 1);
      return dsp.getMeter().vco2Frequency;
    };

    expect(frequencyForSource(1)).toBeGreaterThan(frequencyForSource(0) * 2.3);
  });

  it.each([
    ["S/H input 1", "shInput1Source", "shInput1Level", "shInput2Level"],
    ["S/H input 2", "shInput2Source", "shInput2Level", "shInput1Level"],
  ] as const)("makes both source positions of %s reach the raw S/H mixer", (
    _label,
    sourceKey,
    activeLevel,
    mutedLevel,
  ) => {
    const trace = (source: number): Float32Array => {
      const dsp = new OdysseyDSP(SAMPLE_RATE);
      dsp.setParams({
        portamento: 0,
        vco1Coarse: 311.13,
        vco2Coarse: 466.16,
        [sourceKey]: source,
        [activeLevel]: 1,
        [mutedLevel]: 0,
      });
      dsp.noteOn(36);
      render(dsp, 256);
      return Float32Array.from({ length: 512 }, () => {
        render(dsp, 1);
        return dsp.getDiagnostics().rawSampleHold;
      });
    };

    expect(meanAbsoluteDifference(trace(0), trace(1))).toBeGreaterThan(0.05);
  });

  it("makes both VCO 1 waveform switch positions audible through mixer channel 2", () => {
    const signalForSource = (mixer2Source: number): Float32Array => {
      const dsp = new OdysseyDSP(SAMPLE_RATE);
      dsp.setParams({
        mixer1Level: 0,
        mixer2Source,
        mixer2Level: 1,
        mixer3Level: 0,
        delayEnabled: 0,
        filterType: 1,
        filterCutoff: 16_000,
        filterResonance: 0,
        filterMod1Amount: 0,
        filterMod2Amount: 0,
        filterMod3Amount: 0,
        hpfCutoff: 16,
        vcaInitialGain: 1,
        vcaEnvelopeAmount: 0,
        masterVolume: 1,
      });
      dsp.noteOn(48);
      return render(dsp, 4_096)[0];
    };

    expect(meanAbsoluteDifference(signalForSource(0), signalForSource(1))).toBeGreaterThan(0.05);
  });

  it("makes external level and master volume independently control live-input output", () => {
    const level = (externalLevel: number, masterVolume: number): number => {
      const dsp = new OdysseyDSP(SAMPLE_RATE);
      dsp.setParams(openExternalPatch({ externalLevel, masterVolume }));
      const [output] = render(dsp, 16_384, sine(16_384, 440));
      return rms(output.slice(8_192));
    };

    const full = level(1, 1);
    expect(full).toBeGreaterThan(0.02);
    expect(level(0, 1)).toBeLessThan(full * 0.0001);
    expect(level(1, 0.2)).toBeLessThan(full * 0.3);
  });

  it("places the user high-pass after the live-input mixer and low-pass", () => {
    const levelAtHighPass = (hpfCutoff: number): number => {
      const dsp = new OdysseyDSP(SAMPLE_RATE);
      dsp.setParams(openExternalPatch({ hpfCutoff }));
      const [output] = render(dsp, 16_384, sine(16_384, 100));
      return rms(output.slice(8_192));
    };

    const open = levelAtHighPass(16);
    const filtered = levelAtHighPass(1_000);
    expect(open).toBeGreaterThan(0.02);
    expect(filtered).toBeLessThan(open * 0.15);
  });
});
