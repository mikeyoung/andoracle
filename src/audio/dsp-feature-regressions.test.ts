import { describe, expect, it } from "vitest";
import { OdysseyDSP } from "./dsp-core";
import type { SynthParams } from "../synth/params";

const SAMPLE_RATE = 44_100;

const processExternal = (
  dsp: OdysseyDSP,
  input: Float32Array,
): [Float32Array, Float32Array] => {
  const left = new Float32Array(input.length);
  const right = new Float32Array(input.length);
  dsp.process(left, right, input);
  return [left, right];
};

const render = (dsp: OdysseyDSP, frames: number): [Float32Array, Float32Array] => (
  processExternal(dsp, new Float32Array(frames))
);

const impulse = (frames: number, amplitude = 0.8): Float32Array => {
  const input = new Float32Array(frames);
  input[0] = amplitude;
  return input;
};

const maximumAbsolute = (buffer: Float32Array): number => {
  let maximum = 0;
  for (const sample of buffer) maximum = Math.max(maximum, Math.abs(sample));
  return maximum;
};

const peakIndex = (buffer: Float32Array): number => {
  let maximum = -1;
  let result = -1;
  for (let index = 0; index < buffer.length; index += 1) {
    const magnitude = Math.abs(buffer[index]);
    if (magnitude > maximum) {
      maximum = magnitude;
      result = index;
    }
  }
  return result;
};

const windowEnergy = (buffer: Float32Array, start: number, end: number): number => {
  let energy = 0;
  for (let index = start; index < Math.min(end, buffer.length); index += 1) {
    energy += buffer[index] * buffer[index];
  }
  return energy;
};

const assertFiniteAndBounded = (buffer: Float32Array): void => {
  for (const sample of buffer) {
    expect(Number.isFinite(sample)).toBe(true);
    expect(Math.abs(sample)).toBeLessThanOrEqual(1);
  }
};

const transparentExternalPatch = (
  overrides: Partial<SynthParams> = {},
): Partial<SynthParams> => ({
  mixer1Level: 0,
  mixer2Level: 0,
  mixer3Level: 0,
  externalLevel: 1,
  outputFeedback: 0,
  delayEnabled: 1,
  delayTime: 20,
  delayFeedback: 0,
  delayMix: 1,
  delayTone: 18_000,
  delaySpread: 0,
  delayPingPong: 0,
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

describe("stereo delay feature regressions", () => {
  it("keeps both wet channels sample-aligned when stereo spread is zero", () => {
    const dsp = new OdysseyDSP(SAMPLE_RATE);
    dsp.setParams(transparentExternalPatch());

    const [left, right] = processExternal(dsp, impulse(3_000));
    expect(maximumAbsolute(left)).toBeGreaterThan(0.01);
    expect(Array.from(left)).toEqual(Array.from(right));
  });

  it("moves the right wet echo later when stereo spread is positive", () => {
    const dsp = new OdysseyDSP(SAMPLE_RATE);
    dsp.setParams(transparentExternalPatch({ delaySpread: 1 }));

    const [left, right] = processExternal(dsp, impulse(3_000));
    const separation = peakIndex(right) - peakIndex(left);
    expect(maximumAbsolute(left)).toBeGreaterThan(0.01);
    expect(maximumAbsolute(right)).toBeGreaterThan(0.01);
    expect(separation).toBeGreaterThan(150);
    expect(separation).toBeLessThan(250);
  });

  it("alternates successive feedback echoes between channels in ping-pong mode", () => {
    const dsp = new OdysseyDSP(SAMPLE_RATE);
    dsp.setParams(transparentExternalPatch({
      delayTime: 15,
      delayFeedback: 0.78,
      delayPingPong: 1,
    }));

    const [left, right] = processExternal(dsp, impulse(3_000));
    const firstLeft = windowEnergy(left, 600, 790);
    const firstRight = windowEnergy(right, 600, 790);
    const secondLeft = windowEnergy(left, 1_260, 1_450);
    const secondRight = windowEnergy(right, 1_260, 1_450);
    const thirdLeft = windowEnergy(left, 1_920, 2_120);
    const thirdRight = windowEnergy(right, 1_920, 2_120);

    expect(firstLeft).toBeGreaterThan(firstRight * 100);
    expect(secondRight).toBeGreaterThan(secondLeft * 20);
    expect(thirdLeft).toBeGreaterThan(thirdRight * 10);
  });

  it("is an immediate dry bypass and does not capture new input while disabled", () => {
    const dsp = new OdysseyDSP(SAMPLE_RATE);
    dsp.setParams(transparentExternalPatch({
      delayEnabled: 0,
      delayTime: 10,
      delayFeedback: 0.92,
    }));

    const [dryLeft, dryRight] = processExternal(dsp, impulse(128));
    expect(maximumAbsolute(dryLeft)).toBeGreaterThan(0.01);
    expect(Array.from(dryLeft)).toEqual(Array.from(dryRight));

    // Let the downstream VCF/VCA and output FIR finish responding to the dry
    // impulse before asking whether the delay itself retained a copy.
    render(dsp, 1_000);
    dsp.setParams({ delayEnabled: 1 });
    const [silentLeft, silentRight] = render(dsp, 2_000);
    // The independent 16 Hz HPF retains a small dry-path settling tail, but a
    // captured delay repeat would be orders of magnitude larger.
    expect(maximumAbsolute(silentLeft)).toBeLessThan(0.0001);
    expect(maximumAbsolute(silentRight)).toBeLessThan(0.0001);
  });

  it("drains a stored feedback tail while bypassed instead of freezing it", () => {
    const dsp = new OdysseyDSP(SAMPLE_RATE);
    dsp.setParams(transparentExternalPatch({
      delayTime: 5,
      delayFeedback: 0.8,
      delayPingPong: 1,
    }));
    processExternal(dsp, impulse(500));

    dsp.setParams({ delayEnabled: 0 });
    const [bypassedLeft, bypassedRight] = render(dsp, 22_050);
    // The first few output samples can contain the output FIR's already-fed
    // history; the bypass must be silent once that fixed downstream latency
    // has drained.
    expect(windowEnergy(bypassedLeft, bypassedLeft.length - 1_000, bypassedLeft.length))
      .toBeLessThan(windowEnergy(bypassedLeft, 0, 1_000) * 0.01);
    expect(windowEnergy(bypassedRight, bypassedRight.length - 1_000, bypassedRight.length))
      .toBeLessThan(windowEnergy(bypassedRight, 0, 1_000) * 0.01);

    dsp.setParams({ delayEnabled: 1 });
    const [drainedLeft, drainedRight] = render(dsp, 2_000);
    expect(maximumAbsolute(drainedLeft)).toBeLessThan(0.00001);
    expect(maximumAbsolute(drainedRight)).toBeLessThan(0.00001);
  });

  it("stays finite and bounded through repeated minimum/maximum delay-time jumps", () => {
    const dsp = new OdysseyDSP(SAMPLE_RATE);
    dsp.setParams(transparentExternalPatch({
      delayFeedback: 0.92,
      delaySpread: 1,
      delayPingPong: 1,
    }));

    for (let block = 0; block < 96; block += 1) {
      dsp.setParams({
        delayTime: block % 2 === 0 ? 1 : 1_000,
        delayPingPong: block % 3 === 0 ? 1 : 0,
      });
      const input = Float32Array.from(
        { length: 128 },
        (_, index) => Math.sin((block * 128 + index) * Math.PI * 2 * 733 / SAMPLE_RATE) * 0.4,
      );
      const [left, right] = processExternal(dsp, input);
      assertFiniteAndBounded(left);
      assertFiniteAndBounded(right);
    }
  });
});

describe("under-tested parameter routes", () => {
  it("applies master tune equally to both keyboard-tracked oscillators", () => {
    const frequencyAtTune = (masterTune: number): [number, number] => {
      const dsp = new OdysseyDSP(SAMPLE_RATE);
      dsp.setParams({ portamento: 0, masterTune });
      dsp.noteOn(60);
      render(dsp, 1);
      const meter = dsp.getMeter();
      return [meter.vco1Frequency, meter.vco2Frequency];
    };

    const neutral = frequencyAtTune(0);
    const sharp = frequencyAtTune(100);
    const semitone = Math.pow(2, 1 / 12);
    expect(sharp[0] / neutral[0]).toBeCloseTo(semitone, 6);
    expect(sharp[1] / neutral[1]).toBeCloseTo(semitone, 6);
  });

  it("selects genuinely different VCO 1 LFO FM sources", () => {
    const frequencyForSource = (vco1Fm1Source: number): number => {
      const dsp = new OdysseyDSP(SAMPLE_RATE);
      dsp.setParams({
        portamento: 0,
        vco1Coarse: 100,
        vco1Fm1Source,
        vco1Fm1Amount: 1,
      });
      dsp.noteOn(36);
      render(dsp, 1);
      return dsp.getMeter().vco1Frequency;
    };

    expect(frequencyForSource(1)).toBeGreaterThan(frequencyForSource(0) * 3.9);
  });

  it.each([
    ["VCO 1", "vco1Fm2Source", "vco1Fm2Amount", "vco1Frequency"],
    ["VCO 2", "vco2Fm2Source", "vco2Fm2Amount", "vco2Frequency"],
  ] as const)("routes held S/H or ADSR independently to %s FM 2", (
    _label,
    sourceKey,
    amountKey,
    meterKey,
  ) => {
    const frequencyForSource = (source: number): number => {
      const dsp = new OdysseyDSP(SAMPLE_RATE);
      dsp.setParams({
        portamento: 0,
        vco1Coarse: 100,
        vco2Coarse: 100,
        shInput1Level: 0,
        shInput2Level: 0,
        adsrAttack: 0.005,
        adsrDecay: 8,
        adsrSustain: 1,
        [sourceKey]: source,
        [amountKey]: 0.1,
      });
      dsp.noteOn(36);
      render(dsp, 4_000);
      return dsp.getMeter()[meterKey];
    };

    expect(frequencyForSource(1)).toBeGreaterThan(frequencyForSource(0) * 1.7);
  });

  it("switches VCO 2 PWM between bipolar LFO motion and the ADSR contour", () => {
    const pulseWidthForSource = (vco2PwmSource: number): number => {
      const dsp = new OdysseyDSP(SAMPLE_RATE);
      dsp.setParams({
        vco2PulseWidth: 0.5,
        vco2PwmSource,
        vco2PwmAmount: 1,
        adsrAttack: 0.005,
        adsrDecay: 8,
        adsrSustain: 1,
      });
      dsp.noteOn(48);
      render(dsp, 1_000);
      return dsp.getDiagnostics().pulseWidth2;
    };

    expect(pulseWidthForSource(0)).toBeGreaterThan(0.5);
    expect(pulseWidthForSource(1)).toBeCloseTo(0.05, 2);
  });

  it("switches VCF modulation 2 between held S/H and LFO triangle", () => {
    const cutoffForSource = (filterMod2Source: number): number => {
      const dsp = new OdysseyDSP(SAMPLE_RATE);
      dsp.setParams({
        lfoRate: 0.2,
        shInput1Level: 0,
        shInput2Level: 0,
        filterCutoff: 1_000,
        filterMod1Amount: 0,
        filterMod2Source,
        filterMod2Amount: 1,
        filterMod3Amount: 0,
      });
      render(dsp, 3_000);
      return dsp.getDiagnostics().effectiveFilterCutoff;
    };

    const sampleHold = cutoffForSource(0);
    const lfo = cutoffForSource(1);
    expect(sampleHold).toBeCloseTo(1_000, 0);
    expect(lfo).toBeLessThan(sampleHold * 0.35);
  });

  it("switches VCF modulation 3 between a fast ADSR and slow AR contour", () => {
    const cutoffForSource = (filterMod3Source: number): number => {
      const dsp = new OdysseyDSP(SAMPLE_RATE);
      dsp.setParams({
        filterCutoff: 500,
        filterMod1Amount: 0,
        filterMod2Amount: 0,
        filterMod3Source,
        filterMod3Amount: 0.25,
        arAttack: 5,
        adsrAttack: 0.005,
        adsrDecay: 8,
        adsrSustain: 1,
      });
      dsp.noteOn(48);
      render(dsp, 4_000);
      return dsp.getDiagnostics().effectiveFilterCutoff;
    };

    expect(cutoffForSource(0)).toBeGreaterThan(cutoffForSource(1) * 2.5);
  });

  it("makes the selected AR or ADSR release time control the audible VCA tail", () => {
    const tailEnergy = (
      vcaEnvelopeSource: number,
      releaseKey: "arRelease" | "adsrRelease",
      release: number,
    ): number => {
      const dsp = new OdysseyDSP(SAMPLE_RATE);
      dsp.setParams({
        mixer1Level: 0,
        mixer2Level: 1,
        mixer3Level: 0,
        filterCutoff: 16_000,
        filterResonance: 0,
        filterMod1Amount: 0,
        filterMod2Amount: 0,
        filterMod3Amount: 0,
        hpfCutoff: 16,
        vcaInitialGain: 0,
        vcaEnvelopeSource,
        vcaEnvelopeAmount: 1,
        arAttack: 0.005,
        adsrAttack: 0.005,
        adsrDecay: 8,
        adsrSustain: 1,
        [releaseKey]: release,
      });
      dsp.noteOn(48);
      render(dsp, 3_000);
      dsp.noteOff(48);
      const [tail] = render(dsp, 8_000);
      return windowEnergy(tail, 4_000, 8_000);
    };

    const fastAr = tailEnergy(0, "arRelease", 0.01);
    const slowAr = tailEnergy(0, "arRelease", 2);
    const fastAdsr = tailEnergy(1, "adsrRelease", 0.015);
    const slowAdsr = tailEnergy(1, "adsrRelease", 2);
    expect(slowAr).toBeGreaterThan(fastAr * 100);
    expect(slowAdsr).toBeGreaterThan(fastAdsr * 100);
  });

  it("changes the audible noise spectrum when the white/pink selector moves", () => {
    const noiseForColor = (noiseColor: number): Float32Array => {
      const dsp = new OdysseyDSP(SAMPLE_RATE);
      dsp.setParams({
        mixer1Source: 0,
        mixer1Level: 1,
        mixer2Level: 0,
        mixer3Level: 0,
        noiseColor,
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
      return render(dsp, 4_096)[0];
    };

    const white = noiseForColor(0);
    const pink = noiseForColor(1);
    let meanDifference = 0;
    for (let index = 0; index < white.length; index += 1) {
      meanDifference += Math.abs(white[index] - pink[index]);
    }
    expect(meanDifference / white.length).toBeGreaterThan(0.01);
  });

  it("changes oscillator 2's audible waveform when its mixer source switches", () => {
    const signalForSource = (mixer3Source: number): Float32Array => {
      const dsp = new OdysseyDSP(SAMPLE_RATE);
      dsp.setParams({
        mixer1Level: 0,
        mixer2Level: 0,
        mixer3Source,
        mixer3Level: 1,
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

    const saw = signalForSource(0);
    const pulse = signalForSource(1);
    let meanDifference = 0;
    for (let index = 0; index < saw.length; index += 1) {
      meanDifference += Math.abs(saw[index] - pulse[index]);
    }
    expect(meanDifference / saw.length).toBeGreaterThan(0.05);
  });
});
