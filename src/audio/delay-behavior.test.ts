import { describe, expect, it } from "vitest";
import { DEFAULT_PARAMS, type SynthParams } from "../synth/params";
import { OdysseyDSP } from "./dsp-core";

const SAMPLE_RATE = 44_100;
const INTERNAL_SAMPLE_RATE = SAMPLE_RATE * 2;

interface DelayProbe {
  reset(): void;
  process(inputLeft: number, inputRight?: number, captureInput?: boolean): void;
  readonly outputLeft: number;
  readonly outputRight: number;
}

const delayOf = (dsp: OdysseyDSP): DelayProbe => (dsp as unknown as { delay: DelayProbe }).delay;

const configureDelay = (
  dsp: OdysseyDSP,
  changes: Partial<SynthParams> = {},
): DelayProbe => {
  dsp.setParams({
    ...DEFAULT_PARAMS,
    delayEnabled: 1,
    delayTime: 10,
    delayFeedback: 0,
    delayMix: 1,
    delayTone: 18_000,
    delaySpread: 0,
    delayPingPong: 0,
    ...changes,
  });
  const delay = delayOf(dsp);
  delay.reset();
  return delay;
};

const renderDirectImpulse = (
  changes: Partial<SynthParams>,
  frames: number,
  inputLeft = 1,
  inputRight = 0,
): readonly [Float64Array, Float64Array] => {
  const dsp = new OdysseyDSP(SAMPLE_RATE);
  const delay = configureDelay(dsp, changes);
  const left = new Float64Array(frames);
  const right = new Float64Array(frames);
  for (let frame = 0; frame < frames; frame += 1) {
    delay.process(frame === 0 ? inputLeft : 0, frame === 0 ? inputRight : 0);
    left[frame] = delay.outputLeft;
    right[frame] = delay.outputRight;
  }
  return [left, right];
};

const peakBetween = (buffer: Float64Array, start: number, end: number): number => {
  let peak = 0;
  for (let index = start; index < Math.min(end, buffer.length); index += 1) {
    peak = Math.max(peak, Math.abs(buffer[index]));
  }
  return peak;
};

const firstAudibleFrame = (buffer: Float64Array, threshold = 1e-12): number => {
  for (let index = 0; index < buffer.length; index += 1) {
    if (Math.abs(buffer[index]) > threshold) return index;
  }
  return -1;
};

const renderDsp = (
  dsp: OdysseyDSP,
  frames: number,
  externalInput?: Float32Array,
): readonly [Float32Array, Float32Array] => {
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  dsp.process(left, right, externalInput);
  return [left, right];
};

const assertFiniteAndBounded = (...buffers: readonly Float32Array[]): void => {
  for (const buffer of buffers) {
    for (const sample of buffer) {
      expect(Number.isFinite(sample)).toBe(true);
      expect(Math.abs(sample)).toBeLessThanOrEqual(1);
    }
  }
};

describe("stereo delay control behavior", () => {
  it("places Time extremes and every factory Time at the requested left and full-spread right taps", () => {
    let failure: string | null = null;
    const dsp = new OdysseyDSP(SAMPLE_RATE);
    const delay = delayOf(dsp);
    for (const delayTime of [1, 2, 3, 10, 235, 320, 410, 560, 999, 1_000]) {
      if (failure !== null) break;
      dsp.setParams({
        delayEnabled: 1,
        delayTime,
        delayFeedback: 0,
        delayMix: 1,
        delayTone: delayTime % 2 === 0 ? 500 : 18_000,
        delaySpread: 1,
        delayPingPong: 0,
      });
      delay.reset();
      const expectedLeft = Math.floor(delayTime * 0.001 * INTERNAL_SAMPLE_RATE);
      const expectedRight = Math.floor(delayTime * 0.001 * INTERNAL_SAMPLE_RATE * 1.22);
      const frames = expectedRight + 3;
      let firstLeft = -1;
      let firstRight = -1;
      for (let frame = 0; frame < frames; frame += 1) {
        delay.process(frame === 0 ? 0.75 : 0, frame === 0 ? -0.25 : 0);
        if (firstLeft < 0 && Math.abs(delay.outputLeft) > 1e-12) firstLeft = frame;
        if (firstRight < 0 && Math.abs(delay.outputRight) > 1e-12) firstRight = frame;
      }
      if (firstLeft !== expectedLeft || firstRight !== expectedRight) {
        failure = `${delayTime} ms: left ${firstLeft}/${expectedLeft}, right ${firstRight}/${expectedRight}`;
      }
    }
    expect(failure).toBeNull();
  }, 30_000);

  it("bypasses exactly when disabled and preserves an exact dry path at zero Mix", () => {
    const bypassed = new OdysseyDSP(SAMPLE_RATE);
    const bypassedDelay = configureDelay(bypassed, { delayEnabled: 0, delayMix: 1 });
    const zeroMix = new OdysseyDSP(SAMPLE_RATE);
    const zeroMixDelay = configureDelay(zeroMix, { delayEnabled: 1, delayMix: 0 });
    const samples = [0.75, -0.3, 0, 0.1, 0, 0];

    for (const sample of samples) {
      bypassedDelay.process(sample, -sample);
      zeroMixDelay.process(sample, -sample);
      expect(bypassedDelay.outputLeft).toBe(sample);
      expect(bypassedDelay.outputRight).toBeCloseTo(-sample, 15);
      expect(zeroMixDelay.outputLeft).toBe(sample);
      expect(zeroMixDelay.outputRight).toBeCloseTo(-sample, 15);
    }
  });

  it("makes Feedback create later repeats without altering the first tap", () => {
    const delaySamples = Math.round(10 * 0.001 * INTERNAL_SAMPLE_RATE);
    const [withoutFeedback] = renderDirectImpulse(
      { delayFeedback: 0 },
      delaySamples * 3 + 8,
    );
    const [withFeedback] = renderDirectImpulse(
      { delayFeedback: 0.92 },
      delaySamples * 3 + 8,
    );

    expect(peakBetween(withFeedback, delaySamples - 1, delaySamples + 2)).toBeCloseTo(
      peakBetween(withoutFeedback, delaySamples - 1, delaySamples + 2),
      10,
    );
    expect(peakBetween(withoutFeedback, delaySamples * 2 - 2, delaySamples * 2 + 3)).toBeLessThan(1e-12);
    expect(peakBetween(withFeedback, delaySamples * 2 - 2, delaySamples * 2 + 3)).toBeGreaterThan(0.1);
  });

  it("uses Spread to move only the right tap later", () => {
    const base = Math.round(20 * 0.001 * INTERNAL_SAMPLE_RATE);
    const [left, right] = renderDirectImpulse(
      { delayTime: 20, delaySpread: 1 },
      Math.ceil(base * 1.22) + 4,
      0.5,
      0.5,
    );
    expect(firstAudibleFrame(left)).toBe(Math.floor(base));
    expect(firstAudibleFrame(right)).toBe(Math.floor(base * 1.22));
    expect(firstAudibleFrame(right)).toBeGreaterThan(firstAudibleFrame(left));
  });

  it("cross-feeds successive repeats only in Ping-pong mode", () => {
    const tap = Math.round(10 * 0.001 * INTERNAL_SAMPLE_RATE);
    const [normalLeft, normalRight] = renderDirectImpulse(
      { delayFeedback: 0.8, delayPingPong: 0 },
      tap * 3 + 8,
    );
    const [pingLeft, pingRight] = renderDirectImpulse(
      { delayFeedback: 0.8, delayPingPong: 1 },
      tap * 3 + 8,
    );

    expect(peakBetween(normalLeft, tap - 1, tap + 2)).toBeGreaterThan(0.1);
    expect(peakBetween(normalRight, 0, normalRight.length)).toBeLessThan(1e-12);
    expect(peakBetween(pingLeft, tap - 1, tap + 2)).toBeGreaterThan(0.1);
    expect(peakBetween(pingRight, tap * 2 - 2, tap * 2 + 3)).toBeGreaterThan(0.05);
  });

  it("keeps maximum Feedback bounded through a 30-second stress render", () => {
    const dsp = new OdysseyDSP(SAMPLE_RATE);
    const delay = configureDelay(dsp, {
      delayTime: 1,
      delayFeedback: 0.92,
      delayMix: 1,
      delayTone: 18_000,
      delaySpread: 1,
      delayPingPong: 1,
    });
    let peak = 0;
    let invalidFrame = -1;
    for (let frame = 0; frame < INTERNAL_SAMPLE_RATE * 30; frame += 1) {
      delay.process(frame === 0 ? 1 : 0, 0);
      if (
        !Number.isFinite(delay.outputLeft)
        || !Number.isFinite(delay.outputRight)
        || Math.abs(delay.outputLeft) > 2
        || Math.abs(delay.outputRight) > 2
      ) {
        invalidFrame = frame;
        break;
      }
      peak = Math.max(peak, Math.abs(delay.outputLeft), Math.abs(delay.outputRight));
    }
    expect(invalidFrame).toBe(-1);
    expect(peak).toBeGreaterThan(0.1);
  }, 30_000);
});

describe("delay routing, trails, and lifecycle", () => {
  const externalDelayDsp = (delayTrails: number): OdysseyDSP => {
    const dsp = new OdysseyDSP(SAMPLE_RATE);
    dsp.setParams({
      mixer1Level: 0,
      mixer2Level: 0,
      mixer3Level: 0,
      externalLevel: 1,
      filterType: 1,
      filterCutoff: 16_000,
      filterResonance: 0,
      filterMod1Amount: 0,
      filterMod2Amount: 0,
      filterMod3Amount: 0,
      hpfCutoff: 16,
      vcaInitialGain: 1,
      vcaEnvelopeAmount: 0,
      driveEnabled: 0,
      delayEnabled: 1,
      delayTime: 20,
      delayFeedback: 0.75,
      delayMix: 1,
      delayTone: 18_000,
      delaySpread: 0,
      delayPingPong: 0,
      delayTrails,
      masterVolume: 1,
    });
    return dsp;
  };

  it.each([0, 1])("Panic hard-clears synth and delay for Trails %i", (delayTrails) => {
    const dsp = externalDelayDsp(delayTrails);
    const impulse = new Float32Array(4_096);
    impulse[0] = 0.8;
    const [before] = renderDsp(dsp, impulse.length, impulse);
    expect(before.some((sample) => Math.abs(sample) > 1e-4)).toBe(true);

    dsp.allSoundOff();
    expect(dsp.getDiagnostics().delayTailRetired).toBe(true);
    const silence = new Float32Array(SAMPLE_RATE * 3);
    const [afterLeft, afterRight] = renderDsp(dsp, silence.length, silence);
    expect(afterLeft.every((sample) => sample === 0)).toBe(true);
    expect(afterRight.every((sample) => sample === 0)).toBe(true);
    expect(dsp.getDiagnostics().delayTailRetired).toBe(true);
  });

  it("lets a Trails-on repeat continue after the keyboard gate and VCA close", () => {
    const dsp = new OdysseyDSP(SAMPLE_RATE);
    dsp.setParams({
      ...DEFAULT_PARAMS,
      delayEnabled: 1,
      delayTime: 40,
      delayFeedback: 0.82,
      delayMix: 1,
      delayTone: 18_000,
      delaySpread: 0,
      delayPingPong: 0,
      delayTrails: 1,
      arAttack: 0.005,
      arRelease: 0.01,
      vcaEnvelopeSource: 0,
      vcaEnvelopeAmount: 1,
      vcaInitialGain: 0,
    });
    dsp.noteOn(48);
    renderDsp(dsp, Math.round(SAMPLE_RATE * 0.15));
    dsp.noteOff(48);
    const [tail] = renderDsp(dsp, Math.round(SAMPLE_RATE * 0.3));
    expect(peakBetween(Float64Array.from(tail), SAMPLE_RATE * 0.03, tail.length)).toBeGreaterThan(0.001);
    expect(dsp.getMeter().gate).toBe(false);
  });

  it("keeps a Trails-off short note audible through the current VCA release", () => {
    const dsp = new OdysseyDSP(SAMPLE_RATE);
    dsp.setParams({
      ...DEFAULT_PARAMS,
      mixer1Level: 0,
      mixer2Level: 1,
      mixer3Level: 0,
      delayEnabled: 1,
      delayTime: 40,
      delayFeedback: 0.65,
      delayMix: 1,
      delayTone: 18_000,
      delaySpread: 0,
      delayPingPong: 0,
      delayTrails: 0,
      adsrAttack: 0.005,
      adsrDecay: 0.2,
      adsrSustain: 1,
      adsrRelease: 0.45,
      vcaEnvelopeSource: 1,
      vcaEnvelopeAmount: 1,
      vcaInitialGain: 0,
    });

    // The articulation is deliberately shorter than Delay Time. Key-up must
    // not erase the samples that should arrive during the envelope release.
    dsp.noteOn(48);
    renderDsp(dsp, Math.round(SAMPLE_RATE * 0.02));
    dsp.noteOff(48);
    const [release] = renderDsp(dsp, Math.round(SAMPLE_RATE * 0.12));

    expect(peakBetween(
      Float64Array.from(release),
      Math.round(SAMPLE_RATE * 0.018),
      Math.round(SAMPLE_RATE * 0.055),
    )).toBeGreaterThan(0.001);
    expect(dsp.getMeter().gate).toBe(false);
  });

  it("keyboard-cuts Trails-off repeats through the current final filter and VCA", () => {
    const dsp = new OdysseyDSP(SAMPLE_RATE);
    dsp.setParams({
      ...DEFAULT_PARAMS,
      delayEnabled: 1,
      delayTime: 40,
      delayFeedback: 0.82,
      delayMix: 1,
      delayTone: 18_000,
      delaySpread: 0,
      delayPingPong: 0,
      delayTrails: 0,
      arAttack: 0.005,
      arRelease: 0.01,
      vcaEnvelopeSource: 0,
      vcaEnvelopeAmount: 1,
      vcaInitialGain: 0,
    });
    dsp.noteOn(48);
    renderDsp(dsp, Math.round(SAMPLE_RATE * 0.15));
    dsp.noteOff(48);
    const [tail] = renderDsp(dsp, Math.round(SAMPLE_RATE * 0.3));
    expect(peakBetween(Float64Array.from(tail), SAMPLE_RATE * 0.06, tail.length)).toBeLessThan(1e-6);
    expect(dsp.getMeter().gate).toBe(false);
  });

  it("resets incompatible buffered history whenever Trails routing changes", () => {
    for (const initialRoute of [0, 1]) {
      const dsp = externalDelayDsp(initialRoute);
      const impulse = new Float32Array(512);
      impulse[0] = 0.8;
      renderDsp(dsp, impulse.length, impulse);
      expect(dsp.getDiagnostics().delayTailRetired).toBe(false);
      dsp.setParams({ delayTrails: 1 - initialRoute });
      expect(dsp.getDiagnostics().delayTailRetired).toBe(true);
      const [left, right] = renderDsp(dsp, 8_192, new Float32Array(8_192));
      expect(Math.max(...left.map(Math.abs))).toBeLessThan(0.001);
      expect(Math.max(...right.map(Math.abs))).toBeLessThan(0.001);
    }
  });

  it("drains and retires a bypassed tail, then never revives stale audio", () => {
    const dsp = externalDelayDsp(1);
    const impulse = new Float32Array(4_096);
    impulse[0] = 0.8;
    renderDsp(dsp, impulse.length, impulse);
    expect(dsp.getDiagnostics().delayTailRetired).toBe(false);

    dsp.setParams({ delayEnabled: 0 });
    for (let second = 0; second < 12 && !dsp.getDiagnostics().delayTailRetired; second += 1) {
      const [left, right] = renderDsp(dsp, SAMPLE_RATE, new Float32Array(SAMPLE_RATE));
      assertFiniteAndBounded(left, right);
      expect(Math.max(...left.map(Math.abs))).toBeLessThan(0.001);
      expect(Math.max(...right.map(Math.abs))).toBeLessThan(0.001);
    }
    expect(dsp.getDiagnostics().delayTailRetired).toBe(true);

    dsp.setParams({ delayEnabled: 1 });
    const [left, right] = renderDsp(dsp, SAMPLE_RATE * 2, new Float32Array(SAMPLE_RATE * 2));
    expect(Math.max(...left.map(Math.abs))).toBeLessThan(0.001);
    expect(Math.max(...right.map(Math.abs))).toBeLessThan(0.001);
  });

  it("survives rapid changes across every delay control without NaN or runaway state", () => {
    const dsp = new OdysseyDSP(SAMPLE_RATE);
    dsp.setParams({
      autoRun: 1,
      vcaInitialGain: 1,
      vcaEnvelopeAmount: 0,
      masterVolume: 1,
    });
    for (let block = 0; block < 2_000; block += 1) {
      dsp.setParams({
        delayEnabled: block % 7 === 0 ? 0 : 1,
        delayTime: block % 2 === 0 ? 1 : 1_000,
        delayFeedback: block % 3 === 0 ? 0 : 0.92,
        delayMix: block % 5 === 0 ? 0 : 1,
        delayTone: block % 2 === 0 ? 500 : 18_000,
        delaySpread: block % 3 === 0 ? 0 : 1,
        delayPingPong: block % 2,
        delayTrails: Math.floor(block / 11) % 2,
      });
      const [left, right] = renderDsp(dsp, 128);
      assertFiniteAndBounded(left, right);
    }
  }, 30_000);
});
