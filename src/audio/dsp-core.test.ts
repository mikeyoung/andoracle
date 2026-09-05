import { describe, expect, it } from "vitest";
import { OdysseyDSP } from "./dsp-core";

const render = (dsp: OdysseyDSP, frames: number): [Float32Array, Float32Array] => {
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  dsp.process(left, right);
  return [left, right];
};

const assertFiniteAndBounded = (buffer: Float32Array): void => {
  for (const value of buffer) {
    expect(Number.isFinite(value)).toBe(true);
    expect(Math.abs(value)).toBeLessThanOrEqual(1);
  }
};

const rmsBetween = (buffer: Float32Array, start: number, end: number): number => {
  let sumSquares = 0;
  for (let index = start; index < end; index += 1) sumSquares += buffer[index] * buffer[index];
  return Math.sqrt(sumSquares / Math.max(1, end - start));
};

const meanAbsoluteDifference = (left: Float32Array, right: Float32Array): number => {
  let total = 0;
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) total += Math.abs(left[index] - right[index]);
  return total / Math.max(1, length);
};

const toneAmplitude = (buffer: Float32Array, frequency: number, sampleRate = 44100): number => {
  let sine = 0;
  let cosine = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    const phase = index * Math.PI * 2 * frequency / sampleRate;
    sine += buffer[index] * Math.sin(phase);
    cosine += buffer[index] * Math.cos(phase);
  }
  return 2 * Math.hypot(sine, cosine) / buffer.length;
};

const crossingFrequency = (buffer: Float32Array, sampleRate = 44100): number => {
  let mean = 0;
  for (const sample of buffer) mean += sample;
  mean /= Math.max(1, buffer.length);
  let crossings = 0;
  let firstCrossing = -1;
  let lastCrossing = -1;
  for (let index = 1; index < buffer.length; index += 1) {
    if (buffer[index - 1] <= mean && buffer[index] > mean) {
      if (firstCrossing < 0) firstCrossing = index;
      lastCrossing = index;
      crossings += 1;
    }
  }
  if (crossings < 2 || lastCrossing <= firstCrossing) return 0;
  return (crossings - 1) * sampleRate / (lastCrossing - firstCrossing);
};

describe("OdysseyDSP", () => {
  it("renders a 44.1 kHz stereo second without non-finite samples", () => {
    const dsp = new OdysseyDSP(44100);
    dsp.setParams({ autoRun: 1 });
    const [left, right] = render(dsp, 44100);
    expect(left).toHaveLength(44100);
    expect(right).toHaveLength(44100);
    expect(dsp.getMeter().sampleRate).toBe(44100);
    assertFiniteAndBounded(left);
    assertFiniteAndBounded(right);
    expect(dsp.getMeter().rms).toBeGreaterThan(0.001);
  });

  it("allocates one note to both oscillators and several notes to the extremes", () => {
    const dsp = new OdysseyDSP(44100);
    dsp.noteOn(60);
    render(dsp, 16);
    expect(dsp.getMeter()).toMatchObject({ gate: true, lowNote: 60, highNote: 60 });
    dsp.noteOn(67);
    dsp.noteOn(64);
    render(dsp, 16);
    expect(dsp.getMeter()).toMatchObject({ lowNote: 60, highNote: 67 });
    dsp.noteOff(67);
    render(dsp, 16);
    expect(dsp.getMeter()).toMatchObject({ lowNote: 60, highNote: 64 });
    dsp.noteOff(60);
    render(dsp, 16);
    expect(dsp.getMeter()).toMatchObject({ lowNote: 64, highNote: 64 });
    dsp.noteOff(64);
    render(dsp, 16);
    expect(dsp.getMeter().gate).toBe(false);
  });

  it("rejects non-finite note messages without poisoning later articulation", () => {
    const dsp = new OdysseyDSP(44100);

    for (const note of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      dsp.noteOn(note);
      dsp.noteOff(note);
    }

    expect(dsp.getHeldNotes()).toEqual([]);
    const [silentLeft, silentRight] = render(dsp, 16);
    assertFiniteAndBounded(silentLeft);
    assertFiniteAndBounded(silentRight);
    expect(dsp.getMeter().gate).toBe(false);
    expect(Number.isFinite(dsp.getMeter().vco1Frequency)).toBe(true);
    expect(Number.isFinite(dsp.getMeter().vco2Frequency)).toBe(true);

    dsp.noteOn(60);
    const [left, right] = render(dsp, 4096);
    assertFiniteAndBounded(left);
    assertFiniteAndBounded(right);
    expect(dsp.getHeldNotes()).toEqual([60]);
    expect(dsp.getMeter()).toMatchObject({ gate: true, lowNote: 60, highNote: 60 });
    expect(left.some((sample) => Math.abs(sample) > 1e-4)).toBe(true);
  });

  it("tunes A4 accurately from the default coarse calibration", () => {
    const dsp = new OdysseyDSP(44100);
    dsp.setParams({ portamento: 0 });
    dsp.noteOn(69);
    render(dsp, 128);
    expect(dsp.getMeter().vco1Frequency).toBeCloseTo(440, 0);
    expect(dsp.getMeter().vco2Frequency).toBeCloseTo(440, 0);
  });

  it("AUTO supplies a gate and audible output with no physical note", () => {
    const dsp = new OdysseyDSP(44100);
    dsp.setParams({ autoRun: 1, autoNote: 43 });
    const [left] = render(dsp, 4096);
    expect(dsp.getMeter()).toMatchObject({ gate: true, lowNote: 43, highNote: 43 });
    expect(left.some((value) => Math.abs(value) > 1e-4)).toBe(true);
    dsp.setParams({ autoRun: 0 });
    render(dsp, 16);
    expect(dsp.getMeter().gate).toBe(false);
  });

  it("keeps maximum-feedback delay and filter resonance bounded", () => {
    const dsp = new OdysseyDSP(44100);
    dsp.setParams({
      autoRun: 1,
      filterResonance: 1,
      filterType: 2,
      driveEnabled: 1,
      driveAmount: 10,
      delayEnabled: 1,
      delayFeedback: 0.92,
      delayMix: 1,
      delayTime: 1,
    });
    const [left, right] = render(dsp, 44100);
    assertFiniteAndBounded(left);
    assertFiniteAndBounded(right);
  });

  it("hard-mutes every audible state until a new articulation", () => {
    const dsp = new OdysseyDSP(44100);
    dsp.setParams({
      autoRun: 1,
      vcaInitialGain: 1,
      vcaEnvelopeAmount: 0,
      filterResonance: 1,
      delayEnabled: 1,
      delayFeedback: 0.92,
      delayMix: 0.7,
      driveEnabled: 1,
      driveAmount: 10,
    });
    const [sounding] = render(dsp, 4096);
    expect(sounding.some((sample) => Math.abs(sample) > 1e-4)).toBe(true);

    dsp.allSoundOff();
    const [mutedLeft, mutedRight] = render(dsp, 4096);
    expect(mutedLeft.every((sample) => sample === 0)).toBe(true);
    expect(mutedRight.every((sample) => sample === 0)).toBe(true);
    expect(dsp.getHeldNotes()).toEqual([]);
    expect(dsp.getMeter()).toMatchObject({ gate: false, peak: 0, rms: 0 });

    dsp.noteOn(60);
    const [restarted] = render(dsp, 4096);
    expect(restarted.some((sample) => Math.abs(sample) > 1e-4)).toBe(true);
  });

  it("lets a newly attached external source resume after MIDI all-sound-off", () => {
    const dsp = new OdysseyDSP(44100);
    dsp.setParams({
      mixer1Level: 0,
      mixer2Level: 0,
      mixer3Level: 0,
      externalLevel: 1,
      filterType: 1,
      filterCutoff: 16000,
      filterResonance: 0,
      filterMod1Amount: 0,
      filterMod2Amount: 0,
      filterMod3Amount: 0,
      hpfCutoff: 16,
      vcaInitialGain: 1,
      vcaEnvelopeAmount: 0,
      masterVolume: 1,
    });
    const input = new Float32Array(4096).fill(0.25);

    dsp.allSoundOff();
    const mutedLeft = new Float32Array(input.length);
    dsp.process(mutedLeft, new Float32Array(input.length), input);
    expect(mutedLeft.every((sample) => sample === 0)).toBe(true);

    dsp.resumeSound();
    const resumedLeft = new Float32Array(input.length);
    dsp.process(resumedLeft, new Float32Array(input.length), input);
    expect(resumedLeft.some((sample) => Math.abs(sample) > 1e-4)).toBe(true);
  });

  it("keeps a zero-mix delay exactly on the dry path", () => {
    const dry = new OdysseyDSP(44100);
    const bypassed = new OdysseyDSP(44100);
    dry.setParams({ autoRun: 1, delayEnabled: 0 });
    bypassed.setParams({ autoRun: 1, delayEnabled: 1, delayMix: 0 });
    const [dryLeft] = render(dry, 2048);
    const [bypassedLeft] = render(bypassed, 2048);
    expect(bypassedLeft).toEqual(dryLeft);
  });

  it("routes buffered repeats through the current final VCF setting", () => {
    const makeDsp = (): OdysseyDSP => {
      const dsp = new OdysseyDSP(44100);
      dsp.setParams({
        mixer1Level: 0,
        mixer2Level: 0,
        mixer3Level: 0,
        externalLevel: 1,
        filterType: 1,
        filterCutoff: 16000,
        filterResonance: 0,
        filterMod1Amount: 0,
        filterMod2Amount: 0,
        filterMod3Amount: 0,
        hpfCutoff: 16,
        vcaInitialGain: 1,
        vcaEnvelopeAmount: 0,
        driveEnabled: 0,
        delayEnabled: 1,
        delayTime: 100,
        delayFeedback: 0,
        delayMix: 1,
        delayTone: 18000,
        delaySpread: 0,
        delayPingPong: 0,
        masterVolume: 1,
      });
      return dsp;
    };

    const renderRepeat = (cutoffAfterBuffering: number): Float32Array => {
      const dsp = makeDsp();
      const inputFrames = 2048;
      const input = Float32Array.from(
        { length: inputFrames },
        (_, index) => Math.sin(index * Math.PI * 2 * 1000 / 44100) * 0.35,
      );
      const inputLeft = new Float32Array(inputFrames);
      const inputRight = new Float32Array(inputFrames);
      dsp.process(inputLeft, inputRight, input);
      dsp.setParams({ filterCutoff: cutoffAfterBuffering });
      return render(dsp, 5000)[0];
    };

    const openRepeat = renderRepeat(16000);
    const closedRepeat = renderRepeat(16);
    const openRms = rmsBetween(openRepeat, 2500, 4200);
    const closedRms = rmsBetween(closedRepeat, 2500, 4200);
    expect(openRms).toBeGreaterThan(0.01);
    expect(closedRms).toBeLessThan(openRms * 0.1);
  });

  it("places the final VCA after the delay buffer", () => {
    const dsp = new OdysseyDSP(44100);
    dsp.setParams({
      autoRun: 1,
      vcaInitialGain: 1,
      vcaEnvelopeAmount: 0,
      delayEnabled: 1,
      delayTime: 10,
      delayFeedback: 0.8,
      delayMix: 1,
    });
    render(dsp, 4096);
    dsp.setParams({ vcaInitialGain: 0 });
    const [closedLeft, closedRight] = render(dsp, 2048);
    expect(Math.max(...closedLeft.slice(96).map(Math.abs))).toBeLessThan(1e-9);
    expect(Math.max(...closedRight.slice(96).map(Math.abs))).toBeLessThan(1e-9);
  });

  it("keeps keyboard-clocked S/H fixed between key triggers", () => {
    const dsp = new OdysseyDSP(44100);
    dsp.setParams({ autoRun: 0, shClockSource: 1, shLag: 0 });
    dsp.noteOn(48);
    render(dsp, 512);
    const captured = dsp.getMeter().sampleHold;
    render(dsp, 4096);
    expect(dsp.getMeter().sampleHold).toBe(captured);
  });

  it("produces distinct but stable outputs for all three filter characters", () => {
    const outputs = [1, 2, 3].map((filterType) => {
      const dsp = new OdysseyDSP(44100);
      dsp.setParams({ autoRun: 1, filterType, filterCutoff: 1200, filterResonance: 0.66 });
      const [left] = render(dsp, 4096);
      assertFiniteAndBounded(left);
      return left;
    });
    expect(outputs[0]).not.toEqual(outputs[1]);
    expect(outputs[1]).not.toEqual(outputs[2]);
    expect(outputs[0]).not.toEqual(outputs[2]);
  });

  it("calibrates all three filter characters to the requested corner and passband gain", () => {
    const response = (filterType: number, frequency: number): number => {
      const dsp = new OdysseyDSP(44100);
      dsp.setParams({
        mixer1Level: 0,
        mixer2Level: 0,
        mixer3Level: 0,
        externalLevel: 1,
        filterType,
        filterCutoff: 1000,
        filterResonance: 0,
        filterMod1Amount: 0,
        filterMod2Amount: 0,
        filterMod3Amount: 0,
        hpfCutoff: 16,
        vcaInitialGain: 1,
        vcaEnvelopeAmount: 0,
        delayEnabled: 0,
        driveEnabled: 0,
        masterVolume: 0.2,
      });
      const frames = 16384;
      const input = Float32Array.from(
        { length: frames },
        (_, index) => Math.sin(index * Math.PI * 2 * frequency / 44100) * 0.001,
      );
      const left = new Float32Array(frames);
      const right = new Float32Array(frames);
      dsp.process(left, right, input);
      return rmsBetween(left, frames / 2, frames);
    };

    const passband = [1, 2, 3].map((filterType) => response(filterType, 100));
    const cornerRatios = [1, 2, 3].map(
      (filterType, index) => response(filterType, 1000) / passband[index],
    );
    expect(Math.max(...passband) / Math.min(...passband)).toBeLessThan(1.02);
    for (const ratio of cornerRatios) {
      expect(ratio).toBeGreaterThan(0.68);
      expect(ratio).toBeLessThan(0.75);
    }
  });

  it.each([2, 3])("keeps the Type %i resonant peak centered on the requested cutoff", (filterType) => {
    const response = (frequency: number): number => {
      const dsp = new OdysseyDSP(44100);
      dsp.setParams({
        mixer1Level: 0,
        mixer2Level: 0,
        mixer3Level: 0,
        externalLevel: 1,
        filterType,
        filterCutoff: 1000,
        filterResonance: 0.7,
        filterMod1Amount: 0,
        filterMod2Amount: 0,
        filterMod3Amount: 0,
        hpfCutoff: 16,
        vcaInitialGain: 1,
        vcaEnvelopeAmount: 0,
        delayEnabled: 0,
        driveEnabled: 0,
        masterVolume: 0.2,
      });
      const frames = 16384;
      const input = Float32Array.from(
        { length: frames },
        (_, index) => Math.sin(index * Math.PI * 2 * frequency / 44100) * 0.001,
      );
      const left = new Float32Array(frames);
      const right = new Float32Array(frames);
      dsp.process(left, right, input);
      return toneAmplitude(left.slice(frames / 2), frequency);
    };

    const center = response(1000);
    expect(center).toBeGreaterThan(response(800));
    expect(center).toBeGreaterThan(response(1200));
  });

  it("offers original and repaired Type III 4075 cutoff scaling", () => {
    const effectiveCutoff = (filter4075Mode: number): number => {
      const dsp = new OdysseyDSP(44100);
      dsp.setParams({
        filterType: 3,
        filter4075Mode,
        filterCutoff: 16000,
        filterMod1Amount: 0,
        filterMod2Amount: 0,
        filterMod3Amount: 0,
      });
      render(dsp, 4096);
      return dsp.getDiagnostics().effectiveFilterCutoff;
    };
    expect(effectiveCutoff(0)).toBeCloseTo(12000, 0);
    expect(effectiveCutoff(1)).toBeCloseTo(16000, 0);
  });

  it("keeps Type I self-oscillation sinusoidal and tuned to its cutoff", () => {
    const dsp = new OdysseyDSP(44100);
    dsp.setParams({
      mixer1Level: 0,
      mixer2Level: 0,
      mixer3Level: 0,
      externalLevel: 0,
      filterType: 1,
      filterCutoff: 1000,
      filterResonance: 1,
      filterMod1Amount: 0,
      filterMod2Amount: 0,
      filterMod3Amount: 0,
      hpfCutoff: 16,
      vcaInitialGain: 1,
      vcaEnvelopeAmount: 0,
      delayEnabled: 0,
      driveEnabled: 0,
      masterVolume: 0.2,
    });
    render(dsp, 44100);
    const [tail] = render(dsp, 16384);
    let mean = 0;
    for (const sample of tail) mean += sample;
    mean /= tail.length;
    let peak = 0;
    let sumSquares = 0;
    let crossings = 0;
    let firstCrossing = -1;
    let lastCrossing = -1;
    for (let index = 0; index < tail.length; index += 1) {
      const centered = tail[index] - mean;
      peak = Math.max(peak, Math.abs(centered));
      sumSquares += centered * centered;
      if (index > 0 && tail[index - 1] <= mean && tail[index] > mean) {
        if (firstCrossing < 0) firstCrossing = index;
        lastCrossing = index;
        crossings += 1;
      }
    }
    const rms = Math.sqrt(sumSquares / tail.length);
    const crest = peak / rms;
    const frequency = (crossings - 1) * 44100 / (lastCrossing - firstCrossing);
    expect(crest).toBeGreaterThan(1.34);
    expect(crest).toBeLessThan(1.42);
    expect(frequency).toBeGreaterThan(985);
    expect(frequency).toBeLessThan(1015);
  });

  it.each([1, 2, 3])("keeps Type %i self-oscillation bounded and audible", (filterType) => {
    const dsp = new OdysseyDSP(44100);
    dsp.setParams({
      mixer1Level: 0,
      mixer2Level: 0,
      mixer3Level: 0,
      externalLevel: 0,
      filterType,
      filterCutoff: 1000,
      filterResonance: 1,
      hpfCutoff: 16,
      vcaInitialGain: 1,
      vcaEnvelopeAmount: 0,
      masterVolume: 1,
    });
    render(dsp, 44100);
    const [tail] = render(dsp, 4096);
    assertFiniteAndBounded(tail);
    expect(dsp.getMeter().rms).toBeGreaterThan(0.001);
  });

  it.each([2, 3])("keeps Type %i self-oscillation tuned across the cutoff range", (filterType) => {
    for (const cutoff of [1000, 5000, 10000, 16000]) {
      const dsp = new OdysseyDSP(44100);
      dsp.setParams({
        mixer1Level: 0,
        mixer2Level: 0,
        mixer3Level: 0,
        externalLevel: 0,
        filterType,
        filter4075Mode: 1,
        filterCutoff: cutoff,
        filterResonance: 1,
        filterMod1Amount: 0,
        filterMod2Amount: 0,
        filterMod3Amount: 0,
        hpfCutoff: 16,
        vcaInitialGain: 1,
        vcaEnvelopeAmount: 0,
        delayEnabled: 0,
        driveEnabled: 0,
        masterVolume: 0.2,
      });
      render(dsp, 44100);
      const [tail] = render(dsp, 16384);
      const measured = crossingFrequency(tail);
      expect(measured / cutoff).toBeGreaterThan(0.98);
      expect(measured / cutoff).toBeLessThan(1.02);
    }
  });

  it("sustains low-end Type III self-oscillation instead of decaying", () => {
    const dsp = new OdysseyDSP(44100);
    dsp.setParams({
      mixer1Level: 0,
      mixer2Level: 0,
      mixer3Level: 0,
      externalLevel: 0,
      filterType: 3,
      filter4075Mode: 1,
      filterCutoff: 30,
      filterResonance: 1,
      filterMod1Amount: 0,
      filterMod2Amount: 0,
      filterMod3Amount: 0,
      hpfCutoff: 16,
      vcaInitialGain: 1,
      vcaEnvelopeAmount: 0,
      delayEnabled: 0,
      driveEnabled: 0,
      masterVolume: 0.2,
    });
    render(dsp, 44100 * 12);
    const [tail] = render(dsp, 44100);
    expect(rmsBetween(tail, 0, tail.length)).toBeGreaterThan(0.003);
    expect(crossingFrequency(tail)).toBeGreaterThan(29.4);
    expect(crossingFrequency(tail)).toBeLessThan(30.6);
  });

  it("keeps maximum Drive harmonics from folding into the audible band", () => {
    const dsp = new OdysseyDSP(44100);
    dsp.setParams({
      mixer1Level: 0,
      mixer2Level: 0,
      mixer3Level: 0,
      externalLevel: 0,
      filterType: 1,
      filterCutoff: 10000,
      filterResonance: 1,
      filterMod1Amount: 0,
      filterMod2Amount: 0,
      filterMod3Amount: 0,
      hpfCutoff: 16,
      vcaInitialGain: 1,
      vcaEnvelopeAmount: 0,
      delayEnabled: 0,
      driveEnabled: 1,
      driveAmount: 10,
      masterVolume: 0.2,
    });
    render(dsp, 44100);
    const [signal] = render(dsp, 44100);
    const fundamental = toneAmplitude(signal, 10000);
    const foldedSeventh = toneAmplitude(signal, 18200);
    const foldedNinth = toneAmplitude(signal, 1800);
    expect(20 * Math.log10(foldedSeventh / fundamental)).toBeLessThan(-58);
    expect(20 * Math.log10(foldedNinth / fundamental)).toBeLessThan(-58);
  });

  it("routes external audio through the shared filters and VCA", () => {
    const dsp = new OdysseyDSP(44100);
    dsp.setParams({
      mixer1Level: 0,
      mixer2Level: 0,
      mixer3Level: 0,
      externalLevel: 1,
      filterType: 1,
      filterCutoff: 12000,
      filterResonance: 0,
      hpfCutoff: 16,
      vcaInitialGain: 1,
      vcaEnvelopeAmount: 0,
    });
    const frames = 4096;
    const input = Float32Array.from({ length: frames }, (_, index) => Math.sin(index * Math.PI * 2 * 440 / 44100) * 0.25);
    const left = new Float32Array(frames);
    const right = new Float32Array(frames);
    dsp.process(left, right, input);
    assertFiniteAndBounded(left);
    expect(dsp.getMeter().rms).toBeGreaterThan(0.01);
  });

  it("queues every new key closure even when several arrive before an audio block", () => {
    const dsp = new OdysseyDSP(44100);
    dsp.noteOn(48);
    dsp.noteOn(60);
    dsp.noteOn(55);
    render(dsp, 500);
    expect(dsp.getDiagnostics().triggerCount).toBe(3);
    expect(dsp.getMeter()).toMatchObject({ lowNote: 48, highNote: 60, gate: true });
  });

  it("restarts ADSR but leaves the gate-driven AR continuous on legato closures", () => {
    const dsp = new OdysseyDSP(44100);
    dsp.setParams({
      lfoRate: 0.2,
      arAttack: 1,
      adsrAttack: 0.005,
      adsrDecay: 0.01,
      adsrSustain: 0.2,
      arSource: 0,
      adsrSource: 0,
    });
    dsp.noteOn(48);
    render(dsp, 2000);
    expect(dsp.getDiagnostics().adsrStage).toBe("sustain");
    const arBeforeLegato = dsp.getMeter().ar;

    dsp.noteOn(60);
    render(dsp, 1);
    expect(dsp.getDiagnostics().triggerCount).toBe(1);
    render(dsp, 450);
    expect(dsp.getDiagnostics().triggerCount).toBe(2);
    expect(dsp.getDiagnostics().adsrStage).toBe("attack");
    expect(dsp.getMeter().ar).toBeGreaterThan(arBeforeLegato);
    expect(dsp.getDiagnostics().lfoPhase).toBeLessThan(0.001);

    render(dsp, 2000);
    dsp.noteOn(55);
    render(dsp, 450);
    expect(dsp.getDiagnostics().triggerCount).toBe(3);
    expect(dsp.getMeter()).toMatchObject({ lowNote: 48, highNote: 60 });
    dsp.noteOff(55);
    render(dsp, 1);
    expect(dsp.getDiagnostics().triggerCount).toBe(3);
  });

  it("offers both historical transpose/portamento responses", () => {
    const make = (portamentoMode: number): OdysseyDSP => {
      const dsp = new OdysseyDSP(44100);
      dsp.setParams({ portamento: 0, portamentoMode, vco1Coarse: 100, masterTune: 0 });
      dsp.noteOn(36);
      render(dsp, 8);
      dsp.setParams({ portamento: 1, transpose: 24 });
      render(dsp, 1);
      return dsp;
    };

    const immediate = make(0);
    const glided = make(1);
    expect(immediate.getMeter().vco1Frequency).toBeCloseTo(400, 0);
    expect(glided.getMeter().vco1Frequency).toBeGreaterThan(100);
    expect(glided.getMeter().vco1Frequency).toBeLessThan(101);
  });

  it("tracks the late common keyboard CV from low C and includes transpose and bend", () => {
    const dsp = new OdysseyDSP(44100);
    dsp.setParams({
      portamento: 0,
      portamentoMode: 0,
      filterCutoff: 1000,
      filterMod1Source: 0,
      filterMod1Amount: 1,
      filterMod2Amount: 0,
      filterMod3Amount: 0,
    });
    dsp.noteOn(36);
    render(dsp, 4096);
    const lowC = dsp.getDiagnostics().effectiveFilterCutoff;
    dsp.noteOn(48);
    dsp.noteOff(36);
    render(dsp, 32);
    const octave = dsp.getDiagnostics().effectiveFilterCutoff;
    dsp.setPerformance({ bendSemitones: 12 });
    render(dsp, 32);
    const bent = dsp.getDiagnostics().effectiveFilterCutoff;
    dsp.setPerformance({ bendSemitones: 0 });
    dsp.setParams({ transpose: 24 });
    render(dsp, 32);
    const transposed = dsp.getDiagnostics().effectiveFilterCutoff;

    expect(lowC).toBeCloseTo(1000, 0);
    expect(octave / lowC).toBeCloseTo(2, 2);
    expect(bent / octave).toBeCloseTo(2, 2);
    expect(transposed / octave).toBeCloseTo(4, 2);
  });

  it("preserves the audio-rate raw S/H mixer route into VCF control", () => {
    const dsp = new OdysseyDSP(44100);
    dsp.setParams({
      autoRun: 1,
      vco1Coarse: 1000,
      shInput1Source: 0,
      shInput1Level: 1,
      shInput2Level: 0,
      filterCutoff: 1000,
      filterMod1Source: 1,
      filterMod1Amount: 1,
      filterMod2Amount: 0,
      filterMod3Amount: 0,
    });
    render(dsp, 1024);
    const cutoffs: number[] = [];
    for (let frame = 0; frame < 256; frame += 1) {
      render(dsp, 1);
      cutoffs.push(dsp.getDiagnostics().effectiveFilterCutoff);
    }
    expect(Math.max(...cutoffs) / Math.min(...cutoffs)).toBeGreaterThan(50);
  });

  it("keeps the XOR ring source independent of the audible VCO waveform switches", () => {
    const make = (mixer2Source: number, pulseWidth: number): Float32Array => {
      const dsp = new OdysseyDSP(44100);
      dsp.setParams({
        autoRun: 1,
        mixer1Source: 1,
        mixer1Level: 0.8,
        mixer2Source,
        mixer2Level: 0,
        mixer3Level: 0,
        vco1PulseWidth: pulseWidth,
        filterCutoff: 16000,
        filterResonance: 0,
        filterMod1Amount: 0,
        filterMod2Amount: 0,
        filterMod3Amount: 0,
        hpfCutoff: 16,
        vcaInitialGain: 1,
        vcaEnvelopeAmount: 0,
      });
      return render(dsp, 4096)[0];
    };

    const sawSelected = make(0, 0.5);
    const pulseSelected = make(1, 0.5);
    const narrowedPulse = make(0, 0.2);
    expect(pulseSelected).toEqual(sawSelected);
    expect(meanAbsoluteDifference(narrowedPulse, sawSelected)).toBeGreaterThan(0.01);
  });

  it("derives ring XOR from raw comparator states before band-limiting", () => {
    const dsp = new OdysseyDSP(44100);
    dsp.setParams({
      mixer1Source: 1,
      mixer1Level: 1,
      mixer2Level: 0,
      mixer3Level: 0,
      vco1Coarse: 100,
      vco2Coarse: 100,
      vco1Fine: 0,
      vco2Fine: 0,
      vco1PulseWidth: 0.5,
      vco2PulseWidth: 0.5,
      vco1PwmAmount: 0,
      vco2PwmAmount: 0,
      filterCutoff: 16000,
      filterResonance: 0,
      filterMod1Amount: 0,
      filterMod2Amount: 0,
      filterMod3Amount: 0,
      hpfCutoff: 16,
      vcaInitialGain: 1,
      vcaEnvelopeAmount: 0,
      delayEnabled: 0,
      masterVolume: 0.2,
    });
    dsp.noteOn(48);
    render(dsp, 44100);
    const [tail] = render(dsp, 4096);
    expect(rmsBetween(tail, 0, tail.length)).toBeLessThan(1e-7);
  });

  it("keeps high-frequency hard-sync aliases below the audible harmonic series", () => {
    const dsp = new OdysseyDSP(44100);
    dsp.setParams({
      mixer1Level: 0,
      mixer2Level: 0,
      mixer3Level: 0.03,
      mixer3Source: 0,
      vco1Coarse: 625,
      vco1Fine: 0,
      vco2Coarse: 1437.5,
      vco2Fine: 0,
      vco2Sync: 1,
      vco1Fm1Amount: 0,
      vco1Fm2Amount: 0,
      vco2Fm1Amount: 0,
      vco2Fm2Amount: 0,
      vco1PwmAmount: 0,
      vco2PwmAmount: 0,
      filterType: 1,
      filterCutoff: 16000,
      filterResonance: 0,
      filterMod1Amount: 0,
      filterMod2Amount: 0,
      filterMod3Amount: 0,
      hpfCutoff: 16,
      vcaInitialGain: 1,
      vcaEnvelopeAmount: 0,
      delayEnabled: 0,
      driveEnabled: 0,
      masterVolume: 0.2,
      portamento: 0,
    });
    dsp.noteOn(72);
    render(dsp, 8192);
    const [signal] = render(dsp, 44100);
    const wantedFrequencies = [5000, 10000, 15000, 20000];
    const aliasFrequencies: number[] = [];
    for (let harmonic = 5; harmonic <= 17; harmonic += 1) {
      let folded = harmonic * 5000 % 44100;
      if (folded > 22050) folded = 44100 - folded;
      if (
        folded > 0
        && !wantedFrequencies.includes(folded)
        && !aliasFrequencies.includes(folded)
      ) aliasFrequencies.push(folded);
    }
    const wantedPower = wantedFrequencies.reduce(
      (sum, frequency) => sum + toneAmplitude(signal, frequency) ** 2,
      0,
    );
    const aliasPower = aliasFrequencies.reduce(
      (sum, frequency) => sum + toneAmplitude(signal, frequency) ** 2,
      0,
    );
    const aliasDbc = 10 * Math.log10(aliasPower / wantedPower);
    expect(aliasDbc).toBeLessThan(-75);
  });

  it("uses a fixed pink source for S/H regardless of the audible noise switch", () => {
    const capture = (noiseColor: number): number => {
      const dsp = new OdysseyDSP(44100);
      dsp.setParams({
        noiseColor,
        shInput1Level: 0,
        shInput2Source: 0,
        shInput2Level: 1,
        shClockSource: 1,
        shLag: 0,
      });
      dsp.noteOn(48);
      render(dsp, 1);
      return dsp.getDiagnostics().heldSample;
    };
    expect(capture(0)).toBe(capture(1));
  });

  it("holds first and applies S/H lag only after capture", () => {
    const dsp = new OdysseyDSP(44100);
    dsp.setParams({
      shInput1Source: 0,
      shInput1Level: 1,
      shInput2Level: 0,
      shClockSource: 1,
      shLag: 1,
      portamento: 0,
    });
    dsp.noteOn(48);
    render(dsp, 512);
    const captured = dsp.getDiagnostics();
    render(dsp, 256);
    const later = dsp.getDiagnostics();
    expect(later.heldSample).toBe(captured.heldSample);
    expect(later.rawSampleHold).not.toBe(captured.rawSampleHold);
    expect(Math.abs(later.laggedSample - captured.heldSample))
      .toBeLessThan(Math.abs(captured.laggedSample - captured.heldSample));
  });

  it("matches the documented LFO and ADSR PWM excursion ranges", () => {
    const lfo = new OdysseyDSP(44100);
    lfo.setParams({ vco1PulseWidth: 0.5, vco1PwmSource: 0, vco1PwmAmount: 1 });
    lfo.noteOn(48);
    render(lfo, 1);
    expect(lfo.getDiagnostics().pulseWidth1).toBeCloseTo(0.65, 2);

    const adsr = new OdysseyDSP(44100);
    adsr.setParams({
      vco1PulseWidth: 0.5,
      vco1PwmSource: 1,
      vco1PwmAmount: 1,
      adsrAttack: 0.005,
      adsrDecay: 8,
      adsrSustain: 1,
    });
    adsr.noteOn(48);
    render(adsr, 1000);
    expect(adsr.getDiagnostics().pulseWidth1).toBeCloseTo(0.05, 2);
  });

  it("maps VCO 1 keyboard-off mode across the documented 0.2–20 Hz range", () => {
    const dsp = new OdysseyDSP(44100);
    dsp.setParams({ vco1Mode: 0, vco1Coarse: 20, vco1Fine: 0 });
    dsp.noteOn(36);
    render(dsp, 1);
    expect(dsp.getMeter().vco1Frequency).toBeCloseTo(0.2, 5);
    dsp.setParams({ vco1Coarse: 2000 });
    dsp.noteOn(72);
    render(dsp, 1);
    expect(dsp.getMeter().vco1Frequency).toBeCloseTo(20, 5);
  });

  it("preserves articulation chronology across note-on, gate-off, and note-on events", () => {
    const dsp = new OdysseyDSP(44100);
    dsp.noteOn(48);
    dsp.noteOff(48);
    dsp.noteOn(60);

    render(dsp, 1);
    expect(dsp.getDiagnostics().triggerCount).toBe(0);
    expect(dsp.getMeter().gate).toBe(false);
    render(dsp, 1);
    expect(dsp.getDiagnostics().triggerCount).toBe(0);
    expect(dsp.getMeter()).toMatchObject({ gate: true, lowNote: 60, highNote: 60 });
    render(dsp, 450);
    expect(dsp.getDiagnostics().triggerCount).toBe(2);
  });

  it("applies the revision-specific keyboard trigger delay", () => {
    const laterKeyboard = new OdysseyDSP(44100);
    laterKeyboard.setParams({ portamentoMode: 0 });
    laterKeyboard.noteOn(48);
    render(laterKeyboard, 441);
    expect(laterKeyboard.getMeter().gate).toBe(true);
    expect(laterKeyboard.getDiagnostics()).toMatchObject({ triggerCount: 0, adsrStage: "idle" });
    render(laterKeyboard, 1);
    expect(laterKeyboard.getDiagnostics()).toMatchObject({ triggerCount: 1, adsrStage: "attack" });

    const earlyKeyboard = new OdysseyDSP(44100);
    earlyKeyboard.setParams({ portamentoMode: 1 });
    earlyKeyboard.noteOn(48);
    render(earlyKeyboard, 661);
    expect(earlyKeyboard.getDiagnostics()).toMatchObject({ triggerCount: 0, adsrStage: "idle" });
    render(earlyKeyboard, 1);
    expect(earlyKeyboard.getDiagnostics()).toMatchObject({ triggerCount: 1, adsrStage: "attack" });
  });

  it("cancels delayed keyboard triggers on panic", () => {
    const dsp = new OdysseyDSP(44100);
    dsp.noteOn(48);
    render(dsp, 100);
    dsp.allNotesOff();
    render(dsp, 1000);
    expect(dsp.getDiagnostics().triggerCount).toBe(0);
    expect(dsp.getMeter().gate).toBe(false);
  });

  it("bounds a suspended trigger flood and drains it without invalid output", () => {
    const dsp = new OdysseyDSP(44100);
    dsp.noteOn(48);
    for (let index = 0; index < 10_000; index += 1) dsp.keyboardTrigger();

    expect(dsp.getDiagnostics()).toMatchObject({
      pendingArticulations: 512,
      pendingKeyboardTriggers: 0,
    });

    const [left, right] = render(dsp, 4096);
    assertFiniteAndBounded(left);
    assertFiniteAndBounded(right);
    expect(dsp.getDiagnostics()).toMatchObject({
      pendingArticulations: 0,
      pendingKeyboardTriggers: 0,
      triggerCount: 512,
    });
    expect(dsp.getHeldNotes()).toEqual([48]);
  });

  it("preserves bounded articulation order after the circular queue wraps", () => {
    const dsp = new OdysseyDSP(44100);
    dsp.noteOn(48);
    for (let index = 0; index < 400; index += 1) dsp.keyboardTrigger();

    render(dsp, 150);
    expect(dsp.getDiagnostics().pendingArticulations).toBe(101);
    for (let index = 0; index < 600; index += 1) dsp.keyboardTrigger();
    expect(dsp.getDiagnostics().pendingArticulations).toBe(512);

    const [left, right] = render(dsp, 4096);
    assertFiniteAndBounded(left);
    assertFiniteAndBounded(right);
    expect(dsp.getDiagnostics()).toMatchObject({
      pendingArticulations: 0,
      pendingKeyboardTriggers: 0,
      triggerCount: 812,
    });
    expect(dsp.getHeldNotes()).toEqual([48]);
  });

  it("starts LFO-repeat ADSR immediately without falsely clocking LFO-selected S/H", () => {
    const dsp = new OdysseyDSP(44100);
    dsp.setParams({
      lfoRate: 0.2,
      adsrSource: 1,
      repeatMode: 0,
      shClockSource: 0,
      shInput1Level: 1,
      shInput2Level: 0,
    });
    dsp.noteOn(48);
    render(dsp, 1);
    expect(dsp.getDiagnostics().adsrStage).toBe("attack");
    expect(dsp.getDiagnostics().heldSample).toBe(0);
  });

  it("does not let a raw legato trigger bypass the selected LFO repeat gate", () => {
    const dsp = new OdysseyDSP(44100);
    dsp.setParams({
      lfoRate: 0.2,
      adsrSource: 1,
      repeatMode: 0,
      adsrAttack: 0.005,
      adsrDecay: 0.01,
      adsrSustain: 0.2,
    });
    dsp.noteOn(48);
    render(dsp, 2000);
    expect(dsp.getDiagnostics().adsrStage).toBe("sustain");
    dsp.noteOn(60);
    render(dsp, 500);
    expect(dsp.getDiagnostics().adsrStage).toBe("sustain");
  });

  it("triggers on a newly selected AUTO repeat gate that is already high", () => {
    const dsp = new OdysseyDSP(44100);
    dsp.setParams({ repeatMode: 1, adsrSource: 0, lfoRate: 0.2 });
    render(dsp, 1);
    expect(dsp.getDiagnostics().adsrStage).toBe("idle");
    dsp.setParams({ adsrSource: 1 });
    render(dsp, 1);
    expect(dsp.getDiagnostics().adsrStage).toBe("attack");
  });

  it("clocks LFO-selected S/H only when keyboard reset creates a real rising edge", () => {
    const dsp = new OdysseyDSP(44100);
    dsp.setParams({
      lfoRate: 20,
      shClockSource: 0,
      shInput1Source: 0,
      shInput1Level: 1,
      shInput2Level: 0,
    });
    render(dsp, 1400);
    expect(dsp.getDiagnostics().lfoSquare).toBe(-1);
    expect(dsp.getDiagnostics().heldSample).toBe(0);
    dsp.noteOn(48);
    render(dsp, 500);
    expect(Math.abs(dsp.getDiagnostics().heldSample)).toBeGreaterThan(0.01);
  });

  it("collapses the high-note interval on bulk all-notes-off while retaining common pitch", () => {
    const dsp = new OdysseyDSP(44100);
    dsp.noteOn(60);
    dsp.noteOn(67);
    render(dsp, 1);
    expect(dsp.getMeter()).toMatchObject({ lowNote: 60, highNote: 67 });
    dsp.allNotesOff();
    render(dsp, 1);
    expect(dsp.getMeter()).toMatchObject({ gate: false, lowNote: 60, highNote: 60 });
  });

  it("supports the portamento footswitch bypass", () => {
    const dsp = new OdysseyDSP(44100);
    dsp.setParams({ portamento: 0, vco1Coarse: 100 });
    dsp.noteOn(36);
    render(dsp, 8);
    dsp.setParams({ portamento: 5, portamentoFootswitch: 1 });
    dsp.noteOn(48);
    dsp.noteOff(36);
    render(dsp, 2);
    expect(dsp.getMeter().vco1Frequency).toBeCloseTo(200, 0);
  });

  it("freezes the common pitch memory when the final gate is released", () => {
    const dsp = new OdysseyDSP(44100);
    dsp.setParams({ portamento: 0 });
    dsp.noteOn(36);
    render(dsp, 8);
    dsp.setParams({ portamento: 1 });
    dsp.noteOn(60);
    dsp.noteOff(36);
    render(dsp, 4410);
    dsp.noteOff(60);
    render(dsp, 1);
    const pitchAtRelease = dsp.getDiagnostics().currentLowNote;
    render(dsp, 44100);
    expect(dsp.getDiagnostics().currentLowNote).toBeCloseTo(pitchAtRelease, 10);
  });

  it("caps the slowest portamento at the Korg 1.5-second-per-octave response", () => {
    const dsp = new OdysseyDSP(44100);
    dsp.setParams({ portamento: 0 });
    dsp.noteOn(48);
    render(dsp, 1);
    dsp.setParams({ portamento: 1.5 });
    dsp.noteOn(60);
    dsp.noteOff(48);
    render(dsp, Math.round(44100 * 1.5));
    expect(dsp.getDiagnostics().currentLowNote).toBeCloseTo(48 + 12 * (1 - Math.exp(-1)), 2);
  });

  it("lets a connected pedal replace the shared raw S/H modulation node", () => {
    const dsp = new OdysseyDSP(44100);
    dsp.setParams({
      portamento: 0,
      vco2Coarse: 100,
      vco2Fm1Source: 1,
      vco2Fm1Amount: 1,
      shInput1Level: 0,
      shInput2Level: 0,
      pedalConnected: 1,
      pedalPosition: 0.5,
      filterCutoff: 1000,
      filterMod1Source: 1,
      filterMod1Amount: 1,
      filterMod2Amount: 0,
      filterMod3Amount: 0,
    });
    dsp.noteOn(36);
    render(dsp, 4096);
    expect(dsp.getMeter().vco2Frequency).toBeCloseTo(200, 0);
    expect(dsp.getDiagnostics().effectiveFilterCutoff).toBeCloseTo(4000, 0);
  });

  it("applies delay tone to the first wet echo, not only the feedback path", () => {
    const echoRms = (delayTone: number): number => {
      const dsp = new OdysseyDSP(44100);
      dsp.setParams({
        mixer1Level: 0,
        mixer2Level: 0,
        mixer3Level: 0,
        externalLevel: 1,
        delayEnabled: 1,
        delayTime: 10,
        delayFeedback: 0,
        delayMix: 1,
        delayTone,
        delaySpread: 0,
        filterType: 1,
        filterCutoff: 16000,
        filterResonance: 0,
        filterMod1Amount: 0,
        filterMod2Amount: 0,
        filterMod3Amount: 0,
        hpfCutoff: 16,
        vcaInitialGain: 1,
        vcaEnvelopeAmount: 0,
        masterVolume: 1,
      });
      const frames = 1400;
      const input = Float32Array.from(
        { length: frames },
        (_, index) => index < 220 ? Math.sin(index * Math.PI * 2 * 8000 / 44100) * 0.2 : 0,
      );
      const left = new Float32Array(frames);
      const right = new Float32Array(frames);
      dsp.process(left, right, input);
      return rmsBetween(left, 470, 700);
    };
    expect(echoRms(18000)).toBeGreaterThan(echoRms(500) * 3);
  });

  it("makes output-return feedback include the downstream filter and VCA path", () => {
    const tailRms = (outputFeedback: number, vcaInitialGain: number, frequency = 700): number => {
      const dsp = new OdysseyDSP(44100);
      dsp.setParams({
        mixer1Level: 0,
        mixer2Level: 0,
        mixer3Level: 0,
        externalLevel: 1,
        outputFeedback,
        delayEnabled: 0,
        filterType: 2,
        filterCutoff: 1400,
        filterResonance: 0.7,
        filterMod1Amount: 0,
        filterMod2Amount: 0,
        filterMod3Amount: 0,
        hpfCutoff: 16,
        vcaInitialGain,
        vcaEnvelopeAmount: 0,
        masterVolume: 1,
      });
      const input = Float32Array.from(
        { length: 4096 },
        (_, index) => index < 256 ? Math.sin(index * Math.PI * 2 * frequency / 44100) * 0.2 : 0,
      );
      const left = new Float32Array(input.length);
      const right = new Float32Array(input.length);
      dsp.process(left, right, input);
      return rmsBetween(left, 1200, 4000);
    };
    const openLoop = tailRms(2, 1, 200);
    const noReturn = tailRms(0, 1, 200);
    const closedVca = tailRms(2, 0, 200);
    expect(openLoop).toBeGreaterThan(noReturn * 1.5);
    expect(closedVca).toBeLessThan(openLoop * 0.01);
  });

  it("gives the two-pole filter a shallower stopband than both four-pole models", () => {
    const response = (filterType: number, frequency: number): number => {
      const dsp = new OdysseyDSP(44100);
      dsp.setParams({
        mixer1Level: 0,
        mixer2Level: 0,
        mixer3Level: 0,
        externalLevel: 1,
        filterType,
        filterCutoff: 1000,
        filterResonance: 0,
        filterMod1Amount: 0,
        filterMod2Amount: 0,
        filterMod3Amount: 0,
        hpfCutoff: 16,
        vcaInitialGain: 1,
        vcaEnvelopeAmount: 0,
        masterVolume: 1,
      });
      const frames = 8192;
      const input = Float32Array.from(
        { length: frames },
        (_, index) => Math.sin(index * Math.PI * 2 * frequency / 44100) * 0.01,
      );
      const left = new Float32Array(frames);
      const right = new Float32Array(frames);
      dsp.process(left, right, input);
      return rmsBetween(left, 4096, frames);
    };
    const typeOneRatio = response(1, 8000) / response(1, 250);
    const typeTwoRatio = response(2, 8000) / response(2, 250);
    const typeThreeRatio = response(3, 8000) / response(3, 250);
    expect(typeOneRatio).toBeGreaterThan(typeTwoRatio * 2.5);
    expect(typeOneRatio).toBeGreaterThan(typeThreeRatio * 2.5);
  });

  it("switches repeatedly between all filter models without stale-state instability", () => {
    const dsp = new OdysseyDSP(44100);
    dsp.setParams({
      mixer1Level: 0,
      mixer2Level: 0,
      mixer3Level: 0,
      externalLevel: 1,
      filterCutoff: 4200,
      filterResonance: 1,
      filterMod1Amount: 0,
      filterMod2Amount: 0,
      filterMod3Amount: 0,
      hpfCutoff: 16,
      vcaInitialGain: 1,
      vcaEnvelopeAmount: 0,
      masterVolume: 1,
    });

    let peak = 0;
    for (let block = 0; block < 180; block += 1) {
      dsp.setParams({ filterType: block % 3 + 1 });
      const input = Float32Array.from(
        { length: 128 },
        (_, frame) => Math.sin((block * 128 + frame) * Math.PI * 2 * 733 / 44100) * 0.4,
      );
      const left = new Float32Array(input.length);
      const right = new Float32Array(input.length);
      dsp.process(left, right, input);
      for (let frame = 0; frame < left.length; frame += 1) {
        expect(Number.isFinite(left[frame])).toBe(true);
        expect(Number.isFinite(right[frame])).toBe(true);
        peak = Math.max(peak, Math.abs(left[frame]), Math.abs(right[frame]));
      }
    }

    expect(peak).toBeGreaterThan(0.01);
    expect(peak).toBeLessThanOrEqual(1);
  });
});
