import {
  DEFAULT_PARAMS,
  DELAY_TONE_MAXIMUM,
  DELAY_TONE_MINIMUM,
  normalizeParamValue,
  type ParamKey,
  type SynthParams,
} from "../synth/params";

const TAU = Math.PI * 2;
const EPSILON = 0.001;
const createWindowedSincCoefficients = (length: number, cutoff: number): Float64Array => {
  const midpoint = (length - 1) * 0.5;
  const coefficients = new Float64Array(length);
  let sum = 0;
  for (let index = 0; index < length; index += 1) {
    const offset = index - midpoint;
    const sinc = offset === 0
      ? 2 * cutoff
      : Math.sin(2 * Math.PI * cutoff * offset) / (Math.PI * offset);
    const window = 0.42
      - 0.5 * Math.cos(2 * Math.PI * index / (length - 1))
      + 0.08 * Math.cos(4 * Math.PI * index / (length - 1));
    coefficients[index] = sinc * window;
    sum += coefficients[index];
  }
  for (let index = 0; index < length; index += 1) coefficients[index] /= sum;
  return coefficients;
};

const OUTPUT_DECIMATOR_COEFFICIENTS = createWindowedSincCoefficients(127, 0.23);
const DRIVE_OVERSAMPLE = 4;
const DELAY_WET_MAKEUP = 1.3;
const DELAY_PING_PONG_POWER_MAKEUP = Math.SQRT2;
const DELAY_MAX_CLEAN_TAP_BLEND = 0.36;
const DELAY_PRESENTATION_SMOOTHING_SECONDS = 0.02;
// Web MIDI and pointer events can continue arriving while an AudioContext is
// suspended. Keep enough chronology for many complete 37-key gestures without
// allowing an inactive worklet to accumulate an unbounded backlog.
const MAX_ARTICULATION_EVENTS = 512;
// At the requested 44.1 kHz output rate the longest (15 ms) keyboard-trigger
// delay spans 1,323 internal samples. This cap also leaves headroom at 96 kHz.
const MAX_PENDING_KEYBOARD_TRIGGERS = 4096;
// Paired interpolation/decimation filters reject the alias bands that can fold
// through both this 4x stage and the existing 2x output decimator.
const DRIVE_RESAMPLER_COEFFICIENTS = createWindowedSincCoefficients(63, 0.1);
const OSCILLATOR_DECIMATOR_COEFFICIENTS = new Float64Array([
  0,
  0.000070252408,
  0.000280903672,
  -0.000730246677,
  -0.001718576724,
  0.0024324535,
  0.00599584341,
  -0.005549349313,
  -0.016212872282,
  0.009956688423,
  0.038146911327,
  -0.014768542906,
  -0.088516659564,
  0.018558516709,
  0.312036782472,
  0.480035791091,
  0.312036782472,
  0.018558516709,
  -0.088516659564,
  -0.014768542906,
  0.038146911327,
  0.009956688423,
  -0.016212872282,
  -0.005549349313,
  0.00599584341,
  0.0024324535,
  -0.001718576724,
  -0.000730246677,
  0.000280903672,
  0.000070252408,
  0,
]);

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, value));

const softClip = (value: number): number => Math.tanh(value);
const softSaturate = (value: number, drive: number): number => Math.tanh(value * drive) / drive;

const fourPoleCutoffScale = (cutoff: number, resonance: number, rate: number): number => {
  const normalizedCutoff = clamp(cutoff / rate, 0, 0.22);
  // Four identical poles need 2.3x tuning for a -3 dB aggregate corner at zero
  // feedback, but approach 1x at self-oscillation. The polynomial compensates
  // the explicit digital feedback delay as cutoff approaches Nyquist.
  const selfOscillationScale = 1
    + 1.79 * normalizedCutoff
    - 2.42 * normalizedCutoff * normalizedCutoff;
  const cornerBlend = Math.pow(1 - clamp(resonance, 0, 1), 1.7);
  return selfOscillationScale + (2.3 - selfOscillationScale) * cornerBlend;
};

const segmentCoefficient = (seconds: number, rate: number): number =>
  seconds <= 0 ? 0 : Math.exp(Math.log(EPSILON) / (seconds * rate));

const polyBlep = (phase: number, increment: number): number => {
  if (increment <= 0) return 0;
  if (phase < increment) {
    const position = phase / increment;
    return position + position - position * position - 1;
  }
  if (phase > 1 - increment) {
    const position = (phase - 1) / increment;
    return position * position + position + position + 1;
  }
  return 0;
};

const sawWaveform = (phase: number, increment: number): number => {
  const saw = 2 * phase - 1 - polyBlep(phase, increment);
  return clamp(saw, -1.25, 1.25);
};

const pulseWaveform = (phase: number, increment: number, pulseWidth: number): number => {
  const shifted = (phase - pulseWidth + 1) % 1;
  let pulse = phase < pulseWidth ? 1 : -1;
  pulse += polyBlep(phase, increment);
  pulse -= polyBlep(shifted, increment);
  return clamp(pulse, -1.25, 1.25);
};

type EnvelopeStage = "idle" | "attack" | "decay" | "sustain" | "release";

class AREnvelope {
  value = 0;
  private gate = false;
  private target = 0;

  reset(): void {
    this.value = 0;
    this.gate = false;
    this.target = 0;
  }

  setGate(gate: boolean): void {
    if (gate === this.gate) return;
    this.gate = gate;
    this.target = gate ? 1 : 0;
  }

  process(attack: number, release: number, rate: number): number {
    const time = this.target > this.value ? attack : release;
    const coefficient = segmentCoefficient(time, rate);
    this.value = this.target + coefficient * (this.value - this.target);
    if (Math.abs(this.value - this.target) < 1e-6) this.value = this.target;
    return this.value;
  }
}

class ADSREnvelope {
  value = 0;
  stage: EnvelopeStage = "idle";
  private gate = false;

  reset(): void {
    this.value = 0;
    this.stage = "idle";
    this.gate = false;
  }

  setGate(gate: boolean): void {
    if (gate === this.gate) return;
    this.gate = gate;
    if (!gate) this.stage = "release";
  }

  trigger(): void {
    if (this.gate) this.stage = "attack";
  }

  process(attack: number, decay: number, sustain: number, release: number, rate: number): number {
    switch (this.stage) {
      case "attack": {
        const coefficient = segmentCoefficient(attack, rate);
        this.value = 1 + coefficient * (this.value - 1);
        if (this.value >= 1 - EPSILON) {
          this.value = 1;
          this.stage = this.gate ? "decay" : "release";
        }
        break;
      }
      case "decay": {
        const coefficient = segmentCoefficient(decay, rate);
        this.value = sustain + coefficient * (this.value - sustain);
        if (!this.gate) this.stage = "release";
        else if (Math.abs(this.value - sustain) <= EPSILON) {
          this.value = sustain;
          this.stage = "sustain";
        }
        break;
      }
      case "sustain":
        this.value = sustain;
        if (!this.gate) this.stage = "release";
        break;
      case "release": {
        const coefficient = segmentCoefficient(release, rate);
        this.value *= coefficient;
        if (this.value <= 1e-6) {
          this.value = 0;
          this.stage = "idle";
        }
        break;
      }
      case "idle":
        this.value = 0;
        break;
    }
    return this.value;
  }
}

class TptStateVariableFilter {
  private ic1 = 0;
  private ic2 = 0;

  reset(): void {
    this.ic1 = 0;
    this.ic2 = 0;
  }

  process(input: number, cutoff: number, resonance: number, rate: number): number {
    const frequency = clamp(cutoff, 8, rate * 0.44);
    const g = Math.tan(Math.PI * frequency / rate);
    const q = Math.SQRT1_2 + Math.pow(resonance, 2.25) * (30 - Math.SQRT1_2);
    const regenerativeFeedback = Math.max(0, resonance - 0.9) * 0.8;
    const stateEnergy = this.ic1 * this.ic1 + this.ic2 * this.ic2;
    const amplitudeDamping = Math.min(0.18, stateEnergy * 0.22);
    const k = 1 / q - regenerativeFeedback + amplitudeDamping;
    const a1 = 1 / (1 + g * (g + k));
    const a2 = g * a1;
    const a3 = g * a2;
    const v3 = input - this.ic2;
    const v1 = a1 * this.ic1 + a2 * v3;
    const v2 = this.ic2 + a2 * this.ic1 + a3 * v3;
    this.ic1 = clamp(2 * v1 - this.ic1, -8, 8);
    this.ic2 = clamp(2 * v2 - this.ic2, -8, 8);
    return softSaturate(v2, 0.45);
  }
}

class TptOnePole {
  state = 0;

  reset(): void {
    this.state = 0;
  }

  process(input: number, cutoff: number, rate: number): number {
    const g = Math.tan(Math.PI * clamp(cutoff, 8, rate * 0.44) / rate);
    const coefficient = g / (1 + g);
    const delta = (input - this.state) * coefficient;
    const output = delta + this.state;
    this.state = clamp(output + delta, -8, 8);
    return output;
  }
}

class TransistorLadderFilter {
  private stages = [new TptOnePole(), new TptOnePole(), new TptOnePole(), new TptOnePole()];

  reset(): void {
    for (const stage of this.stages) stage.reset();
  }

  process(input: number, cutoff: number, resonance: number, rate: number): number {
    const last = this.stages[3].state;
    const feedback = 4.12 * Math.pow(resonance, 1.55);
    let value = softSaturate(input - last * feedback, 1.55);
    const adjustedCutoff = cutoff * fourPoleCutoffScale(cutoff, resonance, rate);
    for (const stage of this.stages) {
      value = stage.process(value, adjustedCutoff, rate);
      value = softSaturate(value, 1.22);
    }
    return softSaturate(value, 1.3);
  }
}

class NortonCascadeFilter {
  private stages = [new TptOnePole(), new TptOnePole(), new TptOnePole(), new TptOnePole()];

  reset(): void {
    for (const stage of this.stages) stage.reset();
  }

  process(input: number, cutoff: number, resonance: number, rate: number): number {
    const last = this.stages[3].state;
    const feedback = 4.12 * Math.pow(resonance, 1.48);
    const limitedFeedback = softSaturate(last, 1.8) * feedback;
    let value = softSaturate(input - limitedFeedback, 1.14);
    const adjustedCutoff = cutoff * fourPoleCutoffScale(cutoff, resonance, rate);
    for (let index = 0; index < this.stages.length; index += 1) {
      value = this.stages[index].process(value, adjustedCutoff, rate);
      if (index === 1 || index === 3) value = softSaturate(value, 1.08);
    }
    return softSaturate(value, 1.12);
  }
}

class OnePoleHighPass {
  private low = new TptOnePole();

  reset(): void {
    this.low.reset();
  }

  process(input: number, cutoff: number, rate: number): number {
    return input - this.low.process(input, cutoff, rate);
  }
}

class PinkNoise {
  private b0 = 0;
  private b1 = 0;
  private b2 = 0;
  private b3 = 0;
  private b4 = 0;
  private b5 = 0;
  private b6 = 0;

  private readonly a0: number;
  private readonly a1: number;
  private readonly a2: number;
  private readonly a3: number;
  private readonly a4: number;
  private readonly a5: number;
  private readonly c0: number;
  private readonly c1: number;
  private readonly c2: number;
  private readonly c3: number;
  private readonly c4: number;
  private readonly c5: number;

  constructor(rate: number) {
    const ratio = 44100 / rate;
    const rescale = (pole: number, gain: number): [number, number] => {
      const mappedPole = Math.sign(pole) * Math.pow(Math.abs(pole), ratio);
      const varianceScale = Math.sqrt((1 - mappedPole * mappedPole) / (1 - pole * pole));
      return [mappedPole, gain * varianceScale];
    };
    [this.a0, this.c0] = rescale(0.99886, 0.0555179);
    [this.a1, this.c1] = rescale(0.99332, 0.0750759);
    [this.a2, this.c2] = rescale(0.969, 0.153852);
    [this.a3, this.c3] = rescale(0.8665, 0.3104856);
    [this.a4, this.c4] = rescale(0.55, 0.5329522);
    [this.a5, this.c5] = rescale(-0.7616, -0.016898);
  }

  process(white: number): number {
    this.b0 = this.a0 * this.b0 + white * this.c0;
    this.b1 = this.a1 * this.b1 + white * this.c1;
    this.b2 = this.a2 * this.b2 + white * this.c2;
    this.b3 = this.a3 * this.b3 + white * this.c3;
    this.b4 = this.a4 * this.b4 + white * this.c4;
    this.b5 = this.a5 * this.b5 + white * this.c5;
    const pink = this.b0 + this.b1 + this.b2 + this.b3 + this.b4 + this.b5 + this.b6 + white * 0.5362;
    this.b6 = white * 0.115926;
    return clamp(pink * 0.105, -1.4, 1.4);
  }
}

class FirDecimator {
  private readonly history: Float64Array;
  private index = 0;

  constructor(private readonly coefficients: Float64Array) {
    this.history = new Float64Array(coefficients.length);
  }

  reset(value = 0): void {
    this.history.fill(value);
    this.index = 0;
  }

  push(sample: number): void {
    this.history[this.index] = sample;
    this.index = (this.index + 1) % this.history.length;
  }

  read(): number {
    let output = 0;
    for (let tap = 0; tap < this.coefficients.length; tap += 1) {
      const historyIndex = (this.index - 1 - tap + this.history.length) % this.history.length;
      output += this.history[historyIndex] * this.coefficients[tap];
    }
    return output;
  }
}

class FourTimesInterpolator {
  private readonly history: Float64Array;
  private index = 0;

  constructor(private readonly coefficients: Float64Array) {
    this.history = new Float64Array(Math.ceil(coefficients.length / DRIVE_OVERSAMPLE));
  }

  reset(value: number): void {
    this.history.fill(value);
    this.index = 0;
  }

  push(sample: number): void {
    this.history[this.index] = sample;
    this.index = (this.index + 1) % this.history.length;
  }

  read(phase: number): number {
    let output = 0;
    let delay = 0;
    for (let tap = phase; tap < this.coefficients.length; tap += DRIVE_OVERSAMPLE) {
      const historyIndex = (this.index - 1 - delay + this.history.length) % this.history.length;
      output += this.history[historyIndex] * this.coefficients[tap];
      delay += 1;
    }
    return output * DRIVE_OVERSAMPLE;
  }
}

class OversampledStereoDrive {
  private readonly leftInterpolator = new FourTimesInterpolator(DRIVE_RESAMPLER_COEFFICIENTS);
  private readonly rightInterpolator = new FourTimesInterpolator(DRIVE_RESAMPLER_COEFFICIENTS);
  private readonly leftDecimator = new FirDecimator(DRIVE_RESAMPLER_COEFFICIENTS);
  private readonly rightDecimator = new FirDecimator(DRIVE_RESAMPLER_COEFFICIENTS);
  private active = false;
  outputLeft = 0;
  outputRight = 0;

  reset(): void {
    this.leftInterpolator.reset(0);
    this.rightInterpolator.reset(0);
    this.leftDecimator.reset(0);
    this.rightDecimator.reset(0);
    this.active = false;
    this.outputLeft = 0;
    this.outputRight = 0;
  }

  deactivate(): void {
    this.active = false;
  }

  process(inputLeft: number, inputRight: number, drive: number): void {
    const normalization = Math.max(1e-9, Math.tanh(drive * 0.65));
    if (!this.active) {
      this.leftInterpolator.reset(inputLeft);
      this.rightInterpolator.reset(inputRight);
      this.leftDecimator.reset(softClip(inputLeft * drive) / normalization);
      this.rightDecimator.reset(softClip(inputRight * drive) / normalization);
      this.active = true;
    }

    this.leftInterpolator.push(inputLeft);
    this.rightInterpolator.push(inputRight);
    for (let phase = 0; phase < DRIVE_OVERSAMPLE; phase += 1) {
      const oversampledLeft = this.leftInterpolator.read(phase);
      const oversampledRight = this.rightInterpolator.read(phase);
      this.leftDecimator.push(softClip(oversampledLeft * drive) / normalization);
      this.rightDecimator.push(softClip(oversampledRight * drive) / normalization);
    }
    this.outputLeft = this.leftDecimator.read();
    this.outputRight = this.rightDecimator.read();
  }
}

class StereoDelay {
  private readonly left: Float32Array;
  private readonly right: Float32Array;
  private writeIndex = 0;
  private delayLeft = 1;
  private delayRight = 1;
  private toneLeft = 0;
  private toneRight = 0;
  private toneFrequency = Number.NaN;
  private toneCoefficient = 0;
  private targetCleanTapBlend = 0;
  private audibleCleanTapBlend = 0;
  private wetMakeup = DELAY_WET_MAKEUP;
  private presentationInitialized = false;
  private readonly presentationSmoothing: number;
  private initialized = false;
  outputLeft = 0;
  outputRight = 0;

  constructor(private readonly rate: number) {
    const length = Math.ceil(rate * 1.3) + 4;
    this.left = new Float32Array(length);
    this.right = new Float32Array(length);
    this.presentationSmoothing = 1 - Math.exp(
      -1 / (DELAY_PRESENTATION_SMOOTHING_SECONDS * rate),
    );
  }

  reset(): void {
    this.left.fill(0);
    this.right.fill(0);
    this.writeIndex = 0;
    this.delayLeft = 1;
    this.delayRight = 1;
    this.toneLeft = 0;
    this.toneRight = 0;
    this.toneFrequency = Number.NaN;
    this.toneCoefficient = 0;
    this.targetCleanTapBlend = 0;
    this.audibleCleanTapBlend = 0;
    this.wetMakeup = DELAY_WET_MAKEUP;
    this.presentationInitialized = false;
    this.initialized = false;
    this.outputLeft = 0;
    this.outputRight = 0;
  }

  private read(buffer: Float32Array, delaySamples: number): number {
    let position = this.writeIndex - delaySamples;
    while (position < 0) position += buffer.length;
    const indexA = Math.floor(position) % buffer.length;
    const indexB = (indexA + 1) % buffer.length;
    const fraction = position - Math.floor(position);
    return buffer[indexA] * (1 - fraction) + buffer[indexB] * fraction;
  }

  process(input: number, params: SynthParams): void {
    const baseSamples = clamp(params.delayTime * 0.001 * this.rate, 1, this.left.length - 3);
    const targetLeft = baseSamples;
    const targetRight = clamp(baseSamples * (1 + params.delaySpread * 0.22), 1, this.right.length - 3);
    if (!this.initialized) {
      this.delayLeft = targetLeft;
      this.delayRight = targetRight;
      this.initialized = true;
    }
    const timeSmoothing = 1 - Math.exp(-1 / (0.055 * this.rate));
    this.delayLeft += (targetLeft - this.delayLeft) * timeSmoothing;
    this.delayRight += (targetRight - this.delayRight) * timeSmoothing;

    const wetLeft = this.read(this.left, this.delayLeft);
    const wetRight = this.read(this.right, this.delayRight);
    const delayTone = clamp(params.delayTone, DELAY_TONE_MINIMUM, DELAY_TONE_MAXIMUM);
    if (delayTone !== this.toneFrequency) {
      this.toneFrequency = delayTone;
      this.toneCoefficient = 1 - Math.exp(-TAU * delayTone / this.rate);
      const normalizedTone = Math.log(delayTone / DELAY_TONE_MINIMUM)
        / Math.log(DELAY_TONE_MAXIMUM / DELAY_TONE_MINIMUM);
      this.targetCleanTapBlend = normalizedTone * DELAY_MAX_CLEAN_TAP_BLEND;
    }
    this.toneLeft += this.toneCoefficient * (wetLeft - this.toneLeft);
    this.toneRight += this.toneCoefficient * (wetRight - this.toneRight);

    const feedback = params.delayFeedback;
    const injectedInput = params.delayEnabled > 0.5 ? input : 0;
    const writeLeft = params.delayPingPong > 0.5
      ? injectedInput + this.toneRight * feedback
      : injectedInput + this.toneLeft * feedback;
    const writeRight = params.delayPingPong > 0.5
      ? this.toneLeft * feedback
      : injectedInput + this.toneRight * feedback;
    this.left[this.writeIndex] = softClip(writeLeft);
    this.right[this.writeIndex] = softClip(writeRight);
    this.writeIndex = (this.writeIndex + 1) % this.left.length;

    if (params.delayEnabled < 0.5) {
      this.outputLeft = input;
      this.outputRight = input;
      return;
    }
    const mix = clamp(params.delayMix, 0, 1);
    const dryGain = Math.cos(mix * Math.PI * 0.5);
    const wetGain = Math.sin(mix * Math.PI * 0.5);
    // Keep the feedback loop fully tone-filtered, while retaining more attack
    // and upper-harmonic detail in the audible tap as Tone moves upward. At
    // the darkest setting the tap remains completely filtered.
    const targetWetMakeup = DELAY_WET_MAKEUP * (
      params.delayPingPong > 0.5 ? DELAY_PING_PONG_POWER_MAKEUP : 1
    );
    if (!this.presentationInitialized) {
      this.audibleCleanTapBlend = this.targetCleanTapBlend;
      this.wetMakeup = targetWetMakeup;
      this.presentationInitialized = true;
    } else {
      this.audibleCleanTapBlend += (
        this.targetCleanTapBlend - this.audibleCleanTapBlend
      ) * this.presentationSmoothing;
      this.wetMakeup += (targetWetMakeup - this.wetMakeup) * this.presentationSmoothing;
    }
    const audibleWetLeft = this.toneLeft
      + (wetLeft - this.toneLeft) * this.audibleCleanTapBlend;
    const audibleWetRight = this.toneRight
      + (wetRight - this.toneRight) * this.audibleCleanTapBlend;
    // A ping-pong repeat occupies one channel at a time, so sqrt(2) restores
    // the same two-channel power as the ordinary stereo delay. Makeup is
    // outside the delay's 0.92-bounded internal loop; the separate downstream
    // output-return path remains protected by its nonlinear stages.
    this.outputLeft = input * dryGain + audibleWetLeft * wetGain * this.wetMakeup;
    this.outputRight = input * dryGain + audibleWetRight * wetGain * this.wetMakeup;
  }
}

export interface OdysseyMeter {
  sampleRate: number;
  gate: boolean;
  lowNote: number;
  highNote: number;
  vco1Frequency: number;
  vco2Frequency: number;
  ar: number;
  adsr: number;
  sampleHold: number;
  peak: number;
  rms: number;
}

export interface PerformanceState {
  bendSemitones: number;
  vibratoSemitones: number;
}

interface KeyboardArticulationEvent {
  gate: boolean;
  lowNote: number;
  highNote: number;
  trigger: boolean;
}

export interface OdysseyDiagnostics {
  currentLowNote: number;
  triggerCount: number;
  lfoPhase: number;
  lfoTriangle: number;
  lfoSquare: number;
  rawSampleHold: number;
  heldSample: number;
  laggedSample: number;
  manualFilterCutoff: number;
  effectiveFilterCutoff: number;
  pulseWidth1: number;
  pulseWidth2: number;
  adsrStage: EnvelopeStage;
  pendingArticulations: number;
  pendingKeyboardTriggers: number;
}

export class OdysseyDSP {
  readonly sampleRate: number;
  readonly internalSampleRate: number;
  readonly oversample = 2;
  private readonly oscillatorOversample = 2;
  params: SynthParams = { ...DEFAULT_PARAMS };

  private readonly keys = new Set<number>();
  private lowNote = 48;
  private highNote = 48;
  private currentLowNote = 48;
  private keyboardGate = false;
  private hardMuted = false;
  private requestedLowNote = 48;
  private requestedHighNote = 48;
  private requestedKeyboardGate = false;
  private readonly articulationQueue: KeyboardArticulationEvent[] = [];
  private readonly keyboardTriggerDelays: number[] = [];
  private keyboardTriggerCount = 0;
  private phase1 = 0;
  private phase2 = 0;
  private lfoPhase = 0;
  private lfoTriangle = -1;
  private lfoSquare = 1;
  private lfoRising = false;
  private previousAdsrGate = false;
  private arValue = 0;
  private adsrValue = 0;
  private vco1Frequency = 0;
  private vco2Frequency = 0;
  private saw1 = 0;
  private pulse1 = 0;
  private saw2 = 0;
  private pulse2 = 0;
  private ring = 0;
  private rawSampleHold = 0;
  private heldSample = 0;
  private laggedSample = 0;
  private filterCutoff = DEFAULT_PARAMS.filterCutoff;
  private effectiveFilterCutoff = DEFAULT_PARAMS.filterCutoff;
  private pulseWidth1 = DEFAULT_PARAMS.vco1PulseWidth;
  private pulseWidth2 = DEFAULT_PARAMS.vco2PulseWidth;
  private masterLevel = DEFAULT_PARAMS.masterVolume;
  private ar = new AREnvelope();
  private adsr = new ADSREnvelope();
  private typeOneLeft = new TptStateVariableFilter();
  private typeOneRight = new TptStateVariableFilter();
  private typeTwoLeft = new TransistorLadderFilter();
  private typeTwoRight = new TransistorLadderFilter();
  private typeThreeLeft = new NortonCascadeFilter();
  private typeThreeRight = new NortonCascadeFilter();
  private highPassLeft = new OnePoleHighPass();
  private highPassRight = new OnePoleHighPass();
  private finalLeft = 0;
  private finalRight = 0;
  private pinkNoise: PinkNoise;
  private delay: StereoDelay;
  private readonly drive = new OversampledStereoDrive();
  private performance: PerformanceState = { bendSemitones: 0, vibratoSemitones: 0 };
  private randomState = 0x6d2b79f5;
  private readonly sawOneDecimator = new FirDecimator(OSCILLATOR_DECIMATOR_COEFFICIENTS);
  private readonly pulseOneDecimator = new FirDecimator(OSCILLATOR_DECIMATOR_COEFFICIENTS);
  private readonly sawTwoDecimator = new FirDecimator(OSCILLATOR_DECIMATOR_COEFFICIENTS);
  private readonly pulseTwoDecimator = new FirDecimator(OSCILLATOR_DECIMATOR_COEFFICIENTS);
  private readonly ringDecimator = new FirDecimator(OSCILLATOR_DECIMATOR_COEFFICIENTS);
  private readonly leftDecimator = new FirDecimator(OUTPUT_DECIMATOR_COEFFICIENTS);
  private readonly rightDecimator = new FirDecimator(OUTPUT_DECIMATOR_COEFFICIENTS);
  private previousExternalSample = 0;
  private outputFeedbackReturn = 0;
  private lastMeter: OdysseyMeter;

  constructor(sampleRate = 44100) {
    this.sampleRate = sampleRate;
    this.internalSampleRate = sampleRate * this.oversample;
    this.pinkNoise = new PinkNoise(this.internalSampleRate);
    this.delay = new StereoDelay(this.internalSampleRate);
    this.lastMeter = {
      sampleRate,
      gate: false,
      lowNote: this.lowNote,
      highNote: this.highNote,
      vco1Frequency: 0,
      vco2Frequency: 0,
      ar: 0,
      adsr: 0,
      sampleHold: 0,
      peak: 0,
      rms: 0,
    };
  }

  setParams(changes: Partial<SynthParams>): void {
    const previousGate = this.requestedKeyboardGate;
    const previousAuto = this.params.autoRun;
    for (const [rawKey, rawValue] of Object.entries(changes)) {
      const key = rawKey as ParamKey;
      if (!(key in DEFAULT_PARAMS) || typeof rawValue !== "number") continue;
      this.params[key] = normalizeParamValue(key, rawValue);
    }
    const nextGate = this.keys.size > 0 || this.params.autoRun > 0.5;
    const autoStartedGate = previousAuto !== this.params.autoRun && !previousGate && nextGate;
    if (autoStartedGate) this.hardMuted = false;
    this.refreshAllocation(autoStartedGate);
  }

  setPerformance(changes: Partial<PerformanceState>): void {
    if (typeof changes.bendSemitones === "number" && Number.isFinite(changes.bendSemitones)) {
      this.performance.bendSemitones = clamp(changes.bendSemitones, -24, 24);
    }
    if (typeof changes.vibratoSemitones === "number" && Number.isFinite(changes.vibratoSemitones)) {
      this.performance.vibratoSemitones = clamp(changes.vibratoSemitones, 0, 12);
    }
  }

  noteOn(note: number): void {
    if (!Number.isFinite(note)) return;
    this.hardMuted = false;
    const midi = clamp(Math.round(note), 0, 127);
    if (this.keys.has(midi)) return;
    this.keys.add(midi);
    this.refreshAllocation(true);
  }

  keyboardTrigger(): void {
    if (this.requestedKeyboardGate) {
      this.hardMuted = false;
      this.refreshAllocation(true, false, true);
    }
  }

  noteOff(note: number): void {
    if (!Number.isFinite(note)) return;
    const midi = clamp(Math.round(note), 0, 127);
    if (!this.keys.delete(midi)) return;
    const wasUsingPhysicalKeys = this.keys.size === 0 && this.params.autoRun > 0.5;
    this.refreshAllocation(wasUsingPhysicalKeys);
  }

  allNotesOff(): void {
    this.keys.clear();
    this.articulationQueue.length = 0;
    this.keyboardTriggerDelays.length = 0;
    this.refreshAllocation(false, true, true);
  }

  allSoundOff(): void {
    this.keys.clear();
    this.articulationQueue.length = 0;
    this.keyboardTriggerDelays.length = 0;
    this.keyboardGate = false;
    this.requestedKeyboardGate = false;
    this.highNote = this.lowNote;
    this.requestedLowNote = this.lowNote;
    this.requestedHighNote = this.lowNote;
    this.hardMuted = true;
    this.ar.reset();
    this.adsr.reset();
    this.previousAdsrGate = false;
    this.arValue = 0;
    this.adsrValue = 0;
    this.lfoRising = false;
    this.saw1 = 0;
    this.pulse1 = 0;
    this.saw2 = 0;
    this.pulse2 = 0;
    this.ring = 0;
    this.rawSampleHold = 0;
    this.heldSample = 0;
    this.laggedSample = 0;
    this.filterCutoff = this.params.filterCutoff;
    this.effectiveFilterCutoff = this.params.filterCutoff;
    this.typeOneLeft.reset();
    this.typeOneRight.reset();
    this.typeTwoLeft.reset();
    this.typeTwoRight.reset();
    this.typeThreeLeft.reset();
    this.typeThreeRight.reset();
    this.highPassLeft.reset();
    this.highPassRight.reset();
    this.delay.reset();
    this.drive.reset();
    this.sawOneDecimator.reset();
    this.pulseOneDecimator.reset();
    this.sawTwoDecimator.reset();
    this.pulseTwoDecimator.reset();
    this.ringDecimator.reset();
    this.leftDecimator.reset();
    this.rightDecimator.reset();
    this.previousExternalSample = 0;
    this.outputFeedbackReturn = 0;
    this.finalLeft = 0;
    this.finalRight = 0;
    this.lastMeter = {
      ...this.lastMeter,
      gate: false,
      lowNote: this.lowNote,
      highNote: this.highNote,
      vco1Frequency: 0,
      vco2Frequency: 0,
      ar: 0,
      adsr: 0,
      sampleHold: 0,
      peak: 0,
      rms: 0,
    };
  }

  /** A newly attached non-MIDI source is allowed to sound after MIDI CC120. */
  resumeSound(): void {
    this.hardMuted = false;
  }

  getHeldNotes(): number[] {
    return [...this.keys].sort((a, b) => a - b);
  }

  getMeter(): OdysseyMeter {
    return { ...this.lastMeter };
  }

  getDiagnostics(): OdysseyDiagnostics {
    return {
      currentLowNote: this.currentLowNote,
      triggerCount: this.keyboardTriggerCount,
      lfoPhase: this.lfoPhase,
      lfoTriangle: this.lfoTriangle,
      lfoSquare: this.lfoSquare,
      rawSampleHold: this.rawSampleHold,
      heldSample: this.heldSample,
      laggedSample: this.laggedSample,
      manualFilterCutoff: this.filterCutoff,
      effectiveFilterCutoff: this.effectiveFilterCutoff,
      pulseWidth1: this.pulseWidth1,
      pulseWidth2: this.pulseWidth2,
      adsrStage: this.adsr.stage,
      pendingArticulations: this.articulationQueue.length,
      pendingKeyboardTriggers: this.keyboardTriggerDelays.length,
    };
  }

  private refreshAllocation(trigger = false, collapseInterval = false, force = false): void {
    const notes = this.keys.size > 0
      ? [...this.keys].sort((a, b) => a - b)
      : this.params.autoRun > 0.5
        ? [Math.round(this.params.autoNote)]
        : [];
    const gate = notes.length > 0;
    let lowNote = this.requestedLowNote;
    let highNote = this.requestedHighNote;
    if (notes.length > 0) {
      lowNote = notes[0];
      highNote = notes[notes.length - 1];
    }
    else if (collapseInterval) highNote = lowNote;
    const changed = gate !== this.requestedKeyboardGate
      || lowNote !== this.requestedLowNote
      || highNote !== this.requestedHighNote;
    this.requestedKeyboardGate = gate;
    this.requestedLowNote = lowNote;
    this.requestedHighNote = highNote;
    if (changed || trigger || force) {
      if (this.articulationQueue.length < MAX_ARTICULATION_EVENTS) {
        this.articulationQueue.push({ gate, lowNote, highNote, trigger });
      } else {
        // Preserve the queued chronology and coalesce only its tail to the
        // newest allocation. OR-ing trigger avoids losing the final retrigger.
        const tail = this.articulationQueue[MAX_ARTICULATION_EVENTS - 1];
        tail.gate = gate;
        tail.lowNote = lowNote;
        tail.highNote = highNote;
        tail.trigger ||= trigger;
      }
    }
  }

  private random(): number {
    let value = this.randomState;
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    this.randomState = value >>> 0;
    return (this.randomState / 0xffffffff) * 2 - 1;
  }

  private updateKeyboardTrigger(shouldSchedule: boolean): boolean {
    let triggerCount = 0;
    let writeIndex = 0;
    for (let index = 0; index < this.keyboardTriggerDelays.length; index += 1) {
      const remaining = this.keyboardTriggerDelays[index] - 1;
      if (remaining <= 0) {
        triggerCount += 1;
      } else {
        this.keyboardTriggerDelays[writeIndex] = remaining;
        writeIndex += 1;
      }
    }
    this.keyboardTriggerDelays.length = writeIndex;
    if (shouldSchedule) {
      const delaySeconds = this.params.portamentoMode > 0.5 ? 0.015 : 0.01;
      const delay = Math.max(1, Math.round(delaySeconds * this.internalSampleRate));
      if (this.keyboardTriggerDelays.length < MAX_PENDING_KEYBOARD_TRIGGERS) {
        this.keyboardTriggerDelays.push(delay);
      } else {
        // Pending triggers are equivalent pulses once their identical delay has
        // elapsed. Under a pathological flood, retain the earliest tail pulse.
        const tailIndex = MAX_PENDING_KEYBOARD_TRIGGERS - 1;
        this.keyboardTriggerDelays[tailIndex] = Math.min(
          this.keyboardTriggerDelays[tailIndex],
          delay,
        );
      }
    }
    this.keyboardTriggerCount += triggerCount;
    return triggerCount > 0;
  }

  private updatePitchGlide(): void {
    if (!this.keyboardGate) return;
    const transposeBeforePortamento = this.params.portamentoMode > 0.5
      ? this.params.transpose
      : 0;
    const target = this.lowNote + transposeBeforePortamento;
    if (this.params.portamento <= 0 || this.params.portamentoFootswitch > 0.5) {
      this.currentLowNote = target;
      return;
    }
    const coefficient = 1 - Math.exp(-1 / (Math.max(0.001, this.params.portamento) * this.internalSampleRate));
    this.currentLowNote += (target - this.currentLowNote) * coefficient;
  }

  private updateLfo(keyboardTrigger: boolean): void {
    const previousSquare = this.lfoSquare;
    if (keyboardTrigger) {
      this.lfoPhase = 0;
    } else {
      const next = this.lfoPhase + this.params.lfoRate / this.internalSampleRate;
      this.lfoPhase = next % 1;
    }
    this.lfoTriangle = 1 - 4 * Math.abs(this.lfoPhase - 0.5);
    this.lfoSquare = this.lfoPhase < 0.5 ? 1 : -1;
    this.lfoRising = previousSquare < 0 && this.lfoSquare > 0;
  }

  private updateEnvelopes(
    keyboardTrigger: boolean,
    lfoSquare: number,
    keyboardGate: boolean,
  ): void {
    const repeatQualified = this.params.repeatMode > 0.5 || keyboardGate;
    const repeatGate = repeatQualified && lfoSquare > 0;

    const arGate = this.params.arSource < 0.5 ? keyboardGate : repeatGate;
    this.ar.setGate(arGate);

    const adsrGate = this.params.adsrSource < 0.5 ? keyboardGate : repeatGate;
    const adsrGateRising = adsrGate && !this.previousAdsrGate;
    this.previousAdsrGate = adsrGate;
    this.adsr.setGate(adsrGate);
    const adsrTrigger = this.params.adsrSource < 0.5
      ? keyboardTrigger
      : adsrGateRising;
    if (adsrTrigger) this.adsr.trigger();

    this.arValue = this.ar.process(this.params.arAttack, this.params.arRelease, this.internalSampleRate);
    this.adsrValue = this.adsr.process(
      this.params.adsrAttack,
      this.params.adsrDecay,
      this.params.adsrSustain,
      this.params.adsrRelease,
      this.internalSampleRate,
    );
  }

  private updateOscillators(
    lfoTriangle: number,
    lfoSquare: number,
    adsr: number,
  ): void {
    this.updatePitchGlide();
    const transposeAfterPortamento = this.params.portamentoMode > 0.5
      ? 0
      : this.params.transpose;
    const transposition = transposeAfterPortamento
      + this.params.masterTune / 100
      + this.performance.bendSemitones;
    const vibrato = lfoTriangle * this.performance.vibratoSemitones;
    const held = this.laggedSample;
    const sharedMixerOrPedal = this.params.pedalConnected > 0.5
      ? this.params.pedalPosition
      : this.rawSampleHold;

    const vco1Fm1 = this.params.vco1Fm1Source < 0.5
      ? lfoTriangle * this.params.vco1Fm1Amount * 6
      : (lfoSquare > 0 ? 18 : 0) * this.params.vco1Fm1Amount;
    const vco1Fm2 = this.params.vco1Fm2Source < 0.5
      ? held * this.params.vco1Fm2Amount * 24
      : adsr * this.params.vco1Fm2Amount * 108;
    const vco2Fm1 = this.params.vco2Fm1Source < 0.5
      ? lfoTriangle * this.params.vco2Fm1Amount * 6
      : sharedMixerOrPedal * this.params.vco2Fm1Amount * 24;
    const vco2Fm2 = this.params.vco2Fm2Source < 0.5
      ? held * this.params.vco2Fm2Amount * 24
      : adsr * this.params.vco2Fm2Amount * 108;

    if (this.params.vco1Mode < 0.5) {
      this.vco1Frequency = this.params.vco1Coarse * 0.01
        * Math.pow(2, (this.params.vco1Fine / 100 + vco1Fm1 + vco1Fm2) / 12);
    } else {
      this.vco1Frequency = this.params.vco1Coarse
        * Math.pow(2, (this.currentLowNote - 36 + transposition + vibrato
          + this.params.vco1Fine / 100 + vco1Fm1 + vco1Fm2) / 12);
    }

    const highInterval = this.highNote - this.lowNote;
    this.vco2Frequency = this.params.vco2Coarse
      * Math.pow(2, (this.currentLowNote + highInterval - 36 + transposition + vibrato
        + this.params.vco2Fine / 100 + vco2Fm1 + vco2Fm2) / 12);

    this.vco1Frequency = clamp(this.vco1Frequency, 0.01, this.sampleRate * 0.45);
    this.vco2Frequency = clamp(this.vco2Frequency, 0.01, this.sampleRate * 0.45);

    const pwm1Source = this.params.vco1PwmSource < 0.5 ? lfoTriangle * 0.15 : adsr * 0.45;
    const pwm2Source = this.params.vco2PwmSource < 0.5 ? lfoTriangle * 0.15 : adsr * 0.45;
    this.pulseWidth1 = clamp(
      this.params.vco1PulseWidth - this.params.vco1PwmAmount * pwm1Source,
      0.01,
      0.99,
    );
    this.pulseWidth2 = clamp(
      this.params.vco2PulseWidth - this.params.vco2PwmAmount * pwm2Source,
      0.01,
      0.99,
    );

    const oscillatorRate = this.internalSampleRate * this.oscillatorOversample;
    const increment1 = this.vco1Frequency / oscillatorRate;
    const increment2 = this.vco2Frequency / oscillatorRate;
    for (let pass = 0; pass < this.oscillatorOversample; pass += 1) {
      const previousPhase2 = this.phase2;
      const phase1Total = this.phase1 + increment1;
      let masterWrapped = false;
      let syncSawCorrection = 0;
      let syncPulseCorrection = 0;
      if (phase1Total >= 1) {
        this.phase1 = phase1Total - 1;
        masterWrapped = true;
      } else this.phase1 = phase1Total;
      if (this.params.vco2Sync > 0.5 && masterWrapped) {
        const fractionAfterReset = increment1 > 0 ? this.phase1 / increment1 : 0;
        const phaseAtReset = (previousPhase2 + increment2 * (1 - fractionAfterReset)) % 1;
        const sawStep = -2 * phaseAtReset;
        const pulseBeforeReset = phaseAtReset < this.pulseWidth2 ? 1 : -1;
        const pulseStep = 1 - pulseBeforeReset;
        this.phase2 = (increment2 * fractionAfterReset) % 1;
        const correctionShape = polyBlep(this.phase1, increment1);
        syncSawCorrection = sawStep * 0.5 * correctionShape;
        syncPulseCorrection = pulseStep * 0.5 * correctionShape;
      } else {
        this.phase2 = (this.phase2 + increment2) % 1;
        if (this.params.vco2Sync > 0.5 && this.phase1 > 1 - increment1) {
          const fractionUntilReset = (1 - this.phase1) / Math.max(increment1, Number.EPSILON);
          const phaseAtReset = (this.phase2 + increment2 * fractionUntilReset) % 1;
          const sawStep = -2 * phaseAtReset;
          const pulseBeforeReset = phaseAtReset < this.pulseWidth2 ? 1 : -1;
          const pulseStep = 1 - pulseBeforeReset;
          const correctionShape = polyBlep(this.phase1, increment1);
          syncSawCorrection = sawStep * 0.5 * correctionShape;
          syncPulseCorrection = pulseStep * 0.5 * correctionShape;
        }
      }

      const forcedResetThisStep = this.params.vco2Sync > 0.5 && masterWrapped;
      const baseSaw2 = forcedResetThisStep
        ? 2 * this.phase2 - 1
        : sawWaveform(this.phase2, increment2);
      const basePulse2 = forcedResetThisStep
        ? (this.phase2 < this.pulseWidth2 ? 1 : -1)
        : pulseWaveform(this.phase2, increment2, this.pulseWidth2);
      this.sawOneDecimator.push(sawWaveform(this.phase1, increment1));
      this.pulseOneDecimator.push(pulseWaveform(this.phase1, increment1, this.pulseWidth1));
      this.sawTwoDecimator.push(clamp(baseSaw2 + syncSawCorrection, -1.25, 1.25));
      this.pulseTwoDecimator.push(clamp(basePulse2 + syncPulseCorrection, -1.25, 1.25));
      const rawPulseOne = this.phase1 < this.pulseWidth1 ? 1 : -1;
      const rawPulseTwo = this.phase2 < this.pulseWidth2 ? 1 : -1;
      this.ringDecimator.push(-rawPulseOne * rawPulseTwo);
    }
    this.saw1 = this.sawOneDecimator.read();
    this.pulse1 = this.pulseOneDecimator.read();
    this.saw2 = this.sawTwoDecimator.read();
    this.pulse2 = this.pulseTwoDecimator.read();
    this.ring = this.ringDecimator.read();
  }

  private updateSampleHold(white: number, pink: number, shouldSample: boolean): void {
    const input1 = this.params.shInput1Source < 0.5 ? this.saw1 : this.pulse1;
    const input2 = this.params.shInput2Source < 0.5 ? pink : this.pulse2;
    const mixed = input1 * this.params.shInput1Level + input2 * this.params.shInput2Level;
    this.rawSampleHold = clamp(Math.tanh(mixed * 0.8) / Math.tanh(0.8), -1.4, 1.4);
    if (shouldSample) this.heldSample = this.rawSampleHold;
    if (this.params.shLag <= 0) this.laggedSample = this.heldSample;
    else {
      const coefficient = 1 - Math.exp(-1 / (this.params.shLag * this.internalSampleRate));
      this.laggedSample += (this.heldSample - this.laggedSample) * coefficient;
    }
    void white;
  }

  private processMixer(noise: number, externalInput: number): number {
    const mixer1 = this.params.mixer1Source < 0.5 ? noise : this.ring;
    const mixer2 = this.params.mixer2Source < 0.5 ? this.saw1 : this.pulse1;
    const mixer3 = this.params.mixer3Source < 0.5 ? this.saw2 : this.pulse2;
    return softClip((
      mixer1 * this.params.mixer1Level
      + mixer2 * this.params.mixer2Level
      + mixer3 * this.params.mixer3Level
      + externalInput * this.params.externalLevel
      + this.outputFeedbackReturn * this.params.outputFeedback
    ) * 0.58);
  }

  private processFinalFilterAndVca(
    inputLeft: number,
    inputRight: number,
    noise: number,
    lfoTriangle: number,
    ar: number,
    adsr: number,
  ): void {
    const transposeAfterPortamento = this.params.portamentoMode > 0.5
      ? 0
      : this.params.transpose;
    const commonKeyboardPitch = this.currentLowNote
      + transposeAfterPortamento
      + this.params.masterTune / 100
      + this.performance.bendSemitones;
    const sharedMixerOrPedal = this.params.pedalConnected > 0.5
      ? this.params.pedalPosition
      : this.rawSampleHold;
    const mod1 = this.params.filterMod1Source < 0.5
      ? ((commonKeyboardPitch - 36) / 12) * this.params.filterMod1Amount
      : sharedMixerOrPedal * this.params.filterMod1Amount * 4;
    const mod2Source = this.params.filterMod2Source < 0.5 ? this.laggedSample : lfoTriangle;
    const mod2Range = this.params.filterMod2Source < 0.5 ? 4 : 2;
    const mod2 = mod2Source * this.params.filterMod2Amount * mod2Range;
    const mod3Source = this.params.filterMod3Source < 0.5 ? adsr : ar;
    const mod3 = mod3Source * this.params.filterMod3Amount * 8;
    const manualCutoffSmoothing = 1 - Math.exp(-1 / (0.004 * this.internalSampleRate));
    this.filterCutoff += (this.params.filterCutoff - this.filterCutoff) * manualCutoffSmoothing;
    const modulatedCutoff = clamp(
      this.filterCutoff * Math.pow(2, mod1 + mod2 + mod3),
      16,
      Math.min(18000, this.internalSampleRate * 0.44),
    );
    const typeThreePanelRatio = clamp(modulatedCutoff / 16000, 0, 1.125);
    const originalTypeThreeCutoff = modulatedCutoff
      * (1 - 0.25 * typeThreePanelRatio * typeThreePanelRatio);
    const typeThreeCutoff = this.params.filter4075Mode < 0.5
      ? originalTypeThreeCutoff
      : modulatedCutoff;
    this.effectiveFilterCutoff = this.params.filterType >= 2.5
      ? typeThreeCutoff
      : modulatedCutoff;

    const resonance = this.params.filterResonance;
    const filterInputLeft = inputLeft + noise * 0.0000003;
    const filterInputRight = inputRight + noise * 0.0000003;
    const typeOneLeft = this.typeOneLeft.process(
      softSaturate(filterInputLeft, 1.05),
      modulatedCutoff,
      resonance,
      this.internalSampleRate,
    );
    const typeOneRight = this.typeOneRight.process(
      softSaturate(filterInputRight, 1.05),
      modulatedCutoff,
      resonance,
      this.internalSampleRate,
    );
    const typeTwoLeft = this.typeTwoLeft.process(filterInputLeft, modulatedCutoff, resonance, this.internalSampleRate);
    const typeTwoRight = this.typeTwoRight.process(filterInputRight, modulatedCutoff, resonance, this.internalSampleRate);
    const typeThreeLeft = this.typeThreeLeft.process(filterInputLeft, typeThreeCutoff, resonance, this.internalSampleRate);
    const typeThreeRight = this.typeThreeRight.process(filterInputRight, typeThreeCutoff, resonance, this.internalSampleRate);
    const filteredLeft = this.params.filterType < 1.5
      ? typeOneLeft
      : this.params.filterType < 2.5 ? typeTwoLeft : typeThreeLeft;
    const filteredRight = this.params.filterType < 1.5
      ? typeOneRight
      : this.params.filterType < 2.5 ? typeTwoRight : typeThreeRight;

    const highPassedLeft = this.highPassLeft.process(filteredLeft, this.params.hpfCutoff, this.internalSampleRate);
    const highPassedRight = this.highPassRight.process(filteredRight, this.params.hpfCutoff, this.internalSampleRate);
    const envelope = this.params.vcaEnvelopeSource < 0.5 ? ar : adsr;
    const vcaControl = clamp(
      this.params.vcaInitialGain + envelope * this.params.vcaEnvelopeAmount,
      0,
      1.2,
    );
    const amplifiedLeft = highPassedLeft * vcaControl;
    const amplifiedRight = highPassedRight * vcaControl;
    if (this.params.driveEnabled > 0.5) {
      this.drive.process(amplifiedLeft, amplifiedRight, this.params.driveAmount);
      this.finalLeft = this.drive.outputLeft;
      this.finalRight = this.drive.outputRight;
      return;
    }
    this.drive.deactivate();
    this.finalLeft = softClip(amplifiedLeft * 1.08);
    this.finalRight = softClip(amplifiedRight * 1.08);
  }

  process(left: Float32Array, right: Float32Array, externalInput?: Float32Array): void {
    if (left.length !== right.length) throw new Error("Stereo output buffers must have equal length.");
    if (this.hardMuted) {
      left.fill(0);
      right.fill(0);
      this.lastMeter.gate = false;
      this.lastMeter.ar = 0;
      this.lastMeter.adsr = 0;
      this.lastMeter.peak = 0;
      this.lastMeter.rms = 0;
      return;
    }
    let peak = 0;
    let sumSquares = 0;

    for (let frame = 0; frame < left.length; frame += 1) {
      let decimatedLeft = 0;
      let decimatedRight = 0;
      const externalSample = externalInput?.[frame] ?? 0;
      for (let pass = 0; pass < this.oversample; pass += 1) {
        const articulation = this.articulationQueue.shift();
        if (articulation) {
          this.keyboardGate = articulation.gate;
          this.lowNote = articulation.lowNote;
          this.highNote = articulation.highNote;
        }
        const keyboardTrigger = this.updateKeyboardTrigger(articulation?.trigger ?? false);
        this.updateLfo(keyboardTrigger);
        this.updateEnvelopes(keyboardTrigger, this.lfoSquare, this.keyboardGate);
        this.updateOscillators(this.lfoTriangle, this.lfoSquare, this.adsrValue);
        const white = this.random();
        const pink = this.pinkNoise.process(white);
        const shouldSample = this.params.shClockSource < 0.5 ? this.lfoRising : keyboardTrigger;
        this.updateSampleHold(white, pink, shouldSample);
        const selectedNoise = this.params.noiseColor < 0.5 ? white : pink;
        const interpolation = (pass + 1) / this.oversample;
        const interpolatedExternal = this.previousExternalSample
          + (externalSample - this.previousExternalSample) * interpolation;
        const mixed = this.processMixer(selectedNoise, interpolatedExternal);
        this.delay.process(mixed, this.params);
        this.processFinalFilterAndVca(
          this.delay.outputLeft,
          this.delay.outputRight,
          selectedNoise,
          this.lfoTriangle,
          this.arValue,
          this.adsrValue,
        );
        const levelCoefficient = 1 - Math.exp(-1 / (0.018 * this.internalSampleRate));
        this.masterLevel += (this.params.masterVolume - this.masterLevel) * levelCoefficient;
        const limitedLeft = softClip(this.finalLeft * this.masterLevel * 0.82);
        const limitedRight = softClip(this.finalRight * this.masterLevel * 0.82);
        this.outputFeedbackReturn = -(limitedLeft + limitedRight) * 0.5;
        this.leftDecimator.push(limitedLeft);
        this.rightDecimator.push(limitedRight);
      }
      decimatedLeft = this.leftDecimator.read();
      decimatedRight = this.rightDecimator.read();
      this.previousExternalSample = externalSample;
      const outputLeft = clamp(decimatedLeft, -1, 1);
      const outputRight = clamp(decimatedRight, -1, 1);
      left[frame] = Number.isFinite(outputLeft) ? outputLeft : 0;
      right[frame] = Number.isFinite(outputRight) ? outputRight : 0;
      const magnitude = Math.max(Math.abs(left[frame]), Math.abs(right[frame]));
      peak = Math.max(peak, magnitude);
      sumSquares += (left[frame] * left[frame] + right[frame] * right[frame]) * 0.5;
    }

    this.lastMeter.sampleRate = this.sampleRate;
    this.lastMeter.gate = this.keyboardGate;
    this.lastMeter.lowNote = this.lowNote;
    this.lastMeter.highNote = this.highNote;
    this.lastMeter.vco1Frequency = this.vco1Frequency;
    this.lastMeter.vco2Frequency = this.vco2Frequency;
    this.lastMeter.ar = this.ar.value;
    this.lastMeter.adsr = this.adsr.value;
    this.lastMeter.sampleHold = this.laggedSample;
    this.lastMeter.peak = peak;
    this.lastMeter.rms = Math.sqrt(sumSquares / Math.max(1, left.length));
  }
}
