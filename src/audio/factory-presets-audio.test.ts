import { describe, expect, it } from "vitest";
import { FACTORY_PRESETS } from "../synth/presets";
import { DEFAULT_PARAMS, type SynthParams } from "../synth/params";
import { OdysseyDSP } from "./dsp-core";

const SAMPLE_RATE = 44_100;
const BLOCK_SIZE = 128;

interface RenderSummary {
  readonly peak: number;
  readonly rms: number;
}

const renderSummary = (dsp: OdysseyDSP, frames: number): RenderSummary => {
  let peak = 0;
  let sumSquares = 0;
  let rendered = 0;
  while (rendered < frames) {
    const blockFrames = Math.min(BLOCK_SIZE, frames - rendered);
    const left = new Float32Array(blockFrames);
    const right = new Float32Array(blockFrames);
    dsp.process(left, right);
    for (let index = 0; index < blockFrames; index += 1) {
      if (
        !Number.isFinite(left[index])
        || !Number.isFinite(right[index])
        || Math.abs(left[index]) > 1
        || Math.abs(right[index]) > 1
      ) {
        throw new Error(`invalid audio sample at frame ${rendered + index}`);
      }
      peak = Math.max(peak, Math.abs(left[index]), Math.abs(right[index]));
      sumSquares += (left[index] * left[index] + right[index] * right[index]) * 0.5;
    }
    rendered += blockFrames;
  }
  return { peak, rms: Math.sqrt(sumSquares / Math.max(1, frames)) };
};

const renderStereo = (dsp: OdysseyDSP, frames: number): readonly [Float32Array, Float32Array] => {
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  dsp.process(left, right);
  return [left, right];
};

const meanStereoDifference = (
  leftA: Float32Array,
  rightA: Float32Array,
  leftB: Float32Array,
  rightB: Float32Array,
  start = 0,
): number => {
  let difference = 0;
  for (let index = start; index < leftA.length; index += 1) {
    difference += Math.abs(leftA[index] - leftB[index]);
    difference += Math.abs(rightA[index] - rightB[index]);
  }
  return difference / Math.max(1, (leftA.length - start) * 2);
};

const rmsBetween = (buffer: Float32Array, start: number, end: number): number => {
  let sumSquares = 0;
  for (let index = start; index < end; index += 1) sumSquares += buffer[index] * buffer[index];
  return Math.sqrt(sumSquares / Math.max(1, end - start));
};

const renderFactoryVariant = (
  name: string,
  changes: Partial<SynthParams>,
  frames: number,
  note = 48,
): readonly [Float32Array, Float32Array, OdysseyDSP] => {
  const preset = FACTORY_PRESETS.find((candidate) => candidate.name === name);
  if (!preset) throw new Error(`missing factory preset: ${name}`);
  const dsp = new OdysseyDSP(SAMPLE_RATE);
  dsp.setParams({ ...preset.params, ...changes });
  if (dsp.params.autoRun < 0.5) dsp.noteOn(note);
  const [left, right] = renderStereo(dsp, frames);
  return [left, right, dsp];
};

describe("factory-preset audio contracts", () => {
  const intendedSignatures: Readonly<Record<string, Partial<SynthParams>>> = {
    "Init Andoracle": {
      autoRun: 0,
      mixer2Source: 0,
      mixer3Source: 0,
      delayEnabled: 0,
      driveEnabled: 0,
    },
    "Rubber Bass": {
      autoRun: 0,
      filterType: 2,
      driveEnabled: 1,
      driveAmount: 2.8,
      adsrSustain: 0.2,
    },
    "Sync Brass": {
      autoRun: 0,
      vco2Sync: 1,
      filterType: 3,
      mixer3Source: 0,
    },
    "Random Voltage": {
      autoRun: 0,
      shInput2Source: 0,
      filterMod2Source: 0,
      delayEnabled: 1,
      delayTime: 235,
    },
    "Metallic XOR": {
      autoRun: 0,
      mixer1Source: 1,
      mixer2Level: 0,
      mixer3Level: 0,
      filterType: 1,
      delayEnabled: 1,
    },
    "Auto Drone": {
      autoRun: 1,
      autoNote: 43,
      vco1PwmAmount: 0.58,
      vco2PwmAmount: 0.42,
      mixer2Source: 1,
      mixer3Source: 1,
      vcaInitialGain: 0.18,
      vcaEnvelopeSource: 0,
      delayEnabled: 1,
      delayTime: 560,
    },
  };

  it.each(FACTORY_PRESETS)("keeps the intended $name feature signature", (preset) => {
    expect(preset.params).toMatchObject(intendedSignatures[preset.name]);
  });

  it.each(FACTORY_PRESETS)("renders a sustained, finite $name voice", (preset) => {
    const dsp = new OdysseyDSP(SAMPLE_RATE);
    dsp.setParams(preset.params);
    if (preset.params.autoRun < 0.5) dsp.noteOn(48);

    const first = renderSummary(dsp, SAMPLE_RATE);
    const sustained = renderSummary(dsp, SAMPLE_RATE * 2);

    expect(first.peak, preset.name).toBeGreaterThan(0.001);
    expect(sustained.rms, preset.name).toBeGreaterThan(0.0001);
    expect(dsp.getMeter().gate, preset.name).toBe(true);
    if (preset.params.autoRun > 0.5) {
      expect(dsp.getMeter()).toMatchObject({
        lowNote: Math.round(preset.params.autoNote),
        highNote: Math.round(preset.params.autoNote),
      });
    }
  });

  it.each(FACTORY_PRESETS.filter((preset) => preset.params.autoRun < 0.5))(
    "releases the keyboard-gated $name voice without a stuck note or repeat",
    (preset) => {
      const dsp = new OdysseyDSP(SAMPLE_RATE);
      dsp.setParams(preset.params);
      dsp.noteOn(48);
      expect(renderSummary(dsp, SAMPLE_RATE / 2).peak, preset.name).toBeGreaterThan(0.001);
      dsp.noteOff(48);
      renderSummary(dsp, SAMPLE_RATE * 4);
      const settled = renderSummary(dsp, SAMPLE_RATE / 2);

      expect(dsp.getHeldNotes(), preset.name).toEqual([]);
      expect(dsp.getMeter().gate, preset.name).toBe(false);
      expect(settled.rms, preset.name).toBeLessThan(0.00001);
    },
  );

  it("changes between every factory preset without stale or non-finite audio state", () => {
    const dsp = new OdysseyDSP(SAMPLE_RATE);
    for (const preset of [...FACTORY_PRESETS, ...FACTORY_PRESETS].reverse()) {
      dsp.allNotesOff();
      dsp.setParams(preset.params);
      if (preset.params.autoRun < 0.5) dsp.noteOn(52);
      const rendered = renderSummary(dsp, SAMPLE_RATE / 2);
      expect(rendered.peak, preset.name).toBeGreaterThan(0.0001);
    }
  });

  it("makes Auto Drone's programmed pulse-width modulation audible", () => {
    const preset = FACTORY_PRESETS.find((candidate) => candidate.name === "Auto Drone");
    expect(preset).toBeDefined();

    const modulated = new OdysseyDSP(SAMPLE_RATE);
    modulated.setParams(preset!.params);
    const staticPulse = new OdysseyDSP(SAMPLE_RATE);
    staticPulse.setParams({
      ...preset!.params,
      vco1PwmAmount: 0,
      vco2PwmAmount: 0,
    });

    const [modulatedLeft, modulatedRight] = renderStereo(modulated, SAMPLE_RATE * 2);
    const [staticLeft, staticRight] = renderStereo(staticPulse, SAMPLE_RATE * 2);
    expect(meanStereoDifference(
      modulatedLeft,
      modulatedRight,
      staticLeft,
      staticRight,
      SAMPLE_RATE / 2,
    )).toBeGreaterThan(0.001);
  });

  it("renders Init Andoracle as a tuned two-saw keyboard starting point", () => {
    const [sawLeft, sawRight, dsp] = renderFactoryVariant("Init Andoracle", {}, SAMPLE_RATE);
    const [pulseLeft, pulseRight] = renderFactoryVariant(
      "Init Andoracle",
      { mixer2Source: 1, mixer3Source: 1 },
      SAMPLE_RATE,
    );

    expect(dsp.getMeter().vco1Frequency).toBeCloseTo(130.82, 0);
    expect(dsp.getMeter().vco2Frequency).toBeCloseTo(130.82, 0);
    expect(meanStereoDifference(sawLeft, sawRight, pulseLeft, pulseRight, SAMPLE_RATE / 4))
      .toBeGreaterThan(0.01);
  });

  it("gives Rubber Bass an audible punch-to-sustain contour and Type II drive character", () => {
    const [bassLeft, bassRight, dsp] = renderFactoryVariant("Rubber Bass", {}, SAMPLE_RATE * 2);
    const [cleanLeft, cleanRight] = renderFactoryVariant(
      "Rubber Bass",
      { driveEnabled: 0 },
      SAMPLE_RATE * 2,
    );

    const attackRms = rmsBetween(bassLeft, Math.round(SAMPLE_RATE * 0.04), Math.round(SAMPLE_RATE * 0.22));
    const sustainRms = rmsBetween(bassLeft, Math.round(SAMPLE_RATE * 1.4), Math.round(SAMPLE_RATE * 1.9));
    expect(dsp.getMeter().vco1Frequency).toBeCloseTo(65.4, 0);
    expect(dsp.getMeter().vco2Frequency).toBeLessThan(dsp.getMeter().vco1Frequency);
    expect(attackRms).toBeGreaterThan(sustainRms * 1.2);
    expect(meanStereoDifference(bassLeft, bassRight, cleanLeft, cleanRight, SAMPLE_RATE / 20))
      .toBeGreaterThan(0.001);
  });

  it("makes Sync Brass hard-sync and its envelope-driven oscillator sweep audible", () => {
    const [syncLeft, syncRight] = renderFactoryVariant("Sync Brass", {}, SAMPLE_RATE * 2);
    const [freeLeft, freeRight] = renderFactoryVariant(
      "Sync Brass",
      { vco2Sync: 0 },
      SAMPLE_RATE * 2,
    );
    const [staticLeft, staticRight] = renderFactoryVariant(
      "Sync Brass",
      { vco2Fm2Amount: 0 },
      SAMPLE_RATE * 2,
    );

    expect(meanStereoDifference(syncLeft, syncRight, freeLeft, freeRight, SAMPLE_RATE / 20))
      .toBeGreaterThan(0.005);
    expect(meanStereoDifference(syncLeft, syncRight, staticLeft, staticRight, SAMPLE_RATE / 20))
      .toBeGreaterThan(0.001);
  });

  it("makes Random Voltage's clocked noise S/H and delay materially animate the patch", () => {
    const [animatedLeft, animatedRight, animated] = renderFactoryVariant(
      "Random Voltage",
      {},
      SAMPLE_RATE * 2,
    );
    const [staticLeft, staticRight] = renderFactoryVariant(
      "Random Voltage",
      {
        vco1Fm2Amount: 0,
        vco2Fm2Amount: 0,
        filterMod2Amount: 0,
        delayEnabled: 0,
      },
      SAMPLE_RATE * 2,
    );

    expect(Math.abs(animated.getDiagnostics().heldSample)).toBeGreaterThan(0.001);
    expect(meanStereoDifference(animatedLeft, animatedRight, staticLeft, staticRight, SAMPLE_RATE / 4))
      .toBeGreaterThan(0.005);
  });

  it("keeps Metallic XOR audibly dependent on its exclusive pulse-comparator ring source", () => {
    const [ringLeft, ringRight] = renderFactoryVariant("Metallic XOR", {}, SAMPLE_RATE * 2);
    const [noiseLeft, noiseRight] = renderFactoryVariant(
      "Metallic XOR",
      { mixer1Source: 0 },
      SAMPLE_RATE * 2,
    );

    expect(meanStereoDifference(ringLeft, ringRight, noiseLeft, noiseRight, SAMPLE_RATE / 4))
      .toBeGreaterThan(0.01);
  });

  it("makes Auto Drone's evolving stereo delay audible while its gate remains hands-free", () => {
    const [delayedLeft, delayedRight, dsp] = renderFactoryVariant("Auto Drone", {}, SAMPLE_RATE * 4);
    const [dryLeft, dryRight] = renderFactoryVariant(
      "Auto Drone",
      { delayEnabled: 0 },
      SAMPLE_RATE * 4,
    );

    const meter = dsp.getMeter();
    expect(meter).toMatchObject({ gate: true, lowNote: 43, highNote: 43 });
    expect(meter.leftRms).toBeCloseTo(rmsBetween(delayedLeft, 0, delayedLeft.length), 10);
    expect(meter.rightRms).toBeCloseTo(rmsBetween(delayedRight, 0, delayedRight.length), 10);
    expect(meanStereoDifference(delayedLeft, delayedRight, dryLeft, dryRight, SAMPLE_RATE))
      .toBeGreaterThan(0.005);
    expect(meanStereoDifference(delayedLeft, delayedRight, delayedRight, delayedLeft, SAMPLE_RATE))
      .toBeGreaterThan(0.001);
  });
});

describe("delay boundary integration", () => {
  it("keeps every integer delay time finite through both full-spread first taps", () => {
    const dsp = new OdysseyDSP(SAMPLE_RATE);
    const delay = (dsp as unknown as {
      delay: {
        reset(): void;
        process(left: number, right?: number, captureInput?: boolean): void;
        outputLeft: number;
        outputRight: number;
      };
    }).delay;
    let failure: { delayTime: number; sample: number } | null = null;

    for (let delayTime = 1; delayTime <= 1_000 && failure === null; delayTime += 1) {
      dsp.setParams({
        delayEnabled: 1,
        delayTime,
        delayFeedback: 0.92,
        delayMix: 1,
        delayTone: delayTime % 2 === 0 ? 350 : 18_000,
        delaySpread: 1,
        delayPingPong: 1,
      });
      delay.reset();
      const finalTap = Math.ceil(delayTime * 0.001 * SAMPLE_RATE * 2 * 1.22) + 4;
      for (let sample = 0; sample < finalTap; sample += 1) {
        delay.process(sample === 0 ? 0.75 : 0, sample === 0 ? -0.25 : 0);
        if (!Number.isFinite(delay.outputLeft) || !Number.isFinite(delay.outputRight)) {
          failure = { delayTime, sample };
          break;
        }
      }
    }

    expect(failure).toBeNull();
  }, 30_000);

  const delayCases: ReadonlyArray<Pick<
    SynthParams,
    "delayTime" | "delayFeedback" | "delayMix" | "delayTone" | "delaySpread" | "delayPingPong"
  >> = [
    { delayTime: 1, delayFeedback: 0, delayMix: 0, delayTone: 350, delaySpread: 0, delayPingPong: 0 },
    { delayTime: 20, delayFeedback: 0.92, delayMix: 1, delayTone: 18_000, delaySpread: 1, delayPingPong: 1 },
    { delayTime: 235, delayFeedback: 0.46, delayMix: 0.22, delayTone: 6_200, delaySpread: 0.35, delayPingPong: 0 },
    { delayTime: 410, delayFeedback: 0.54, delayMix: 0.31, delayTone: 4_400, delaySpread: 0.72, delayPingPong: 1 },
    { delayTime: 560, delayFeedback: 0.54, delayMix: 0.38, delayTone: 4_400, delaySpread: 0.72, delayPingPong: 1 },
    { delayTime: 999, delayFeedback: 0.92, delayMix: 1, delayTone: 350, delaySpread: 1, delayPingPong: 0 },
    { delayTime: 1_000, delayFeedback: 0.92, delayMix: 1, delayTone: 18_000, delaySpread: 1, delayPingPong: 1 },
  ];

  it.each(delayCases)(
    "keeps the complete path finite across the first $delayTime ms tap",
    (delayParams) => {
      const dsp = new OdysseyDSP(SAMPLE_RATE);
      dsp.setParams({
        ...DEFAULT_PARAMS,
        autoRun: 1,
        delayEnabled: 1,
        ...delayParams,
      });
      const latestTapMs = delayParams.delayTime * (1 + delayParams.delaySpread * 0.22);
      const rendered = renderSummary(
        dsp,
        Math.ceil((latestTapMs + 250) * SAMPLE_RATE / 1_000),
      );
      expect(rendered.peak).toBeGreaterThan(0.001);
      expect(dsp.getMeter().gate).toBe(true);
    },
  );
});
