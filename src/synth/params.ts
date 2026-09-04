export type ParamControl = "range" | "toggle" | "choice";
export type ParamScale = "linear" | "log";
export type ParamDisplay =
  | "number"
  | "percent"
  | "hertz"
  | "seconds"
  | "seconds-per-octave"
  | "milliseconds"
  | "cents"
  | "semitones"
  | "midi";

export interface ParamOption {
  readonly value: number;
  readonly label: string;
}

export interface ParamSpec {
  readonly label: string;
  readonly shortLabel?: string;
  readonly group: string;
  readonly control: ParamControl;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly default: number;
  readonly unit?: string;
  readonly scale?: ParamScale;
  readonly display?: ParamDisplay;
  readonly options?: readonly ParamOption[];
}

export const DELAY_TONE_MINIMUM = 500;
export const DELAY_TONE_MAXIMUM = 18_000;

const choice = (
  label: string,
  group: string,
  defaultValue: number,
  options: readonly ParamOption[],
): ParamSpec => ({
  label,
  group,
  control: "choice",
  min: Math.min(...options.map((option) => option.value)),
  max: Math.max(...options.map((option) => option.value)),
  step: 1,
  default: defaultValue,
  options,
});

const toggle = (label: string, group: string, defaultValue = 0): ParamSpec => ({
  label,
  group,
  control: "toggle",
  min: 0,
  max: 1,
  step: 1,
  default: defaultValue,
  options: [
    { value: 0, label: "Off" },
    { value: 1, label: "On" },
  ],
});

const percent = (label: string, group: string, defaultValue: number): ParamSpec => ({
  label,
  group,
  control: "range",
  min: 0,
  max: 1,
  step: 0.001,
  default: defaultValue,
  unit: "%",
  display: "percent",
});

const PARAM_SPEC_DEFINITIONS = {
  masterVolume: percent("Master volume", "Performance", 0.72),
  masterTune: {
    label: "Master tune",
    group: "Performance",
    control: "range",
    min: -100,
    max: 100,
    step: 1,
    default: 0,
    unit: "¢",
    display: "cents",
  },
  portamento: {
    label: "Portamento",
    group: "Performance",
    control: "range",
    min: 0,
    max: 1.5,
    step: 0.001,
    default: 0,
    unit: "s/oct",
    scale: "log",
    display: "seconds-per-octave",
  },
  portamentoMode: choice("Transpose glide mode", "Performance", 0, [
    { value: 0, label: "Rev 2/3 · immediate" },
    { value: 1, label: "Rev 1 · portamento" },
  ]),
  portamentoFootswitch: toggle("Portamento footswitch bypass", "Performance"),
  transpose: choice("Transpose", "Performance", 0, [
    { value: -24, label: "2 oct down" },
    { value: 0, label: "Normal" },
    { value: 24, label: "2 oct up" },
  ]),
  autoRun: toggle("Auto gate", "Performance"),
  autoNote: {
    label: "Auto note",
    group: "Performance",
    control: "range",
    min: 36,
    max: 72,
    step: 1,
    default: 48,
    unit: "MIDI",
    display: "midi",
  },
  ppcBendRange: {
    label: "Pitch bend range",
    group: "Performance",
    control: "range",
    min: 1,
    max: 12,
    step: 1,
    default: 8,
    unit: "st",
    display: "semitones",
  },
  ppcVibratoRange: {
    label: "Vibrato depth",
    group: "Performance",
    control: "range",
    min: 0.1,
    max: 2,
    step: 0.01,
    default: 1,
    unit: "st",
    display: "semitones",
  },
  pedalConnected: toggle("Pedal override", "Performance"),
  pedalPosition: percent("Pedal position", "Performance", 0),

  vco1Mode: choice("VCO 1 range", "VCO 1", 1, [
    { value: 0, label: "LF / keyboard off" },
    { value: 1, label: "Audio / keyboard on" },
  ]),
  vco1Coarse: {
    label: "VCO 1 coarse",
    group: "VCO 1",
    control: "range",
    min: 20,
    max: 2000,
    step: 0.01,
    default: 65.41,
    unit: "Hz",
    scale: "log",
    display: "hertz",
  },
  vco1Fine: {
    label: "VCO 1 fine",
    group: "VCO 1",
    control: "range",
    min: -400,
    max: 400,
    step: 1,
    default: 0,
    unit: "¢",
    display: "cents",
  },
  vco1Fm1Source: choice("VCO 1 FM 1 source", "VCO 1", 0, [
    { value: 0, label: "LFO triangle" },
    { value: 1, label: "LFO square" },
  ]),
  vco1Fm1Amount: percent("VCO 1 FM 1", "VCO 1", 0),
  vco1Fm2Source: choice("VCO 1 FM 2 source", "VCO 1", 0, [
    { value: 0, label: "S/H output" },
    { value: 1, label: "ADSR" },
  ]),
  vco1Fm2Amount: percent("VCO 1 FM 2", "VCO 1", 0),
  vco1PulseWidth: {
    label: "VCO 1 pulse width",
    group: "VCO 1",
    control: "range",
    min: 0.05,
    max: 0.5,
    step: 0.001,
    default: 0.5,
    unit: "%",
    display: "percent",
  },
  vco1PwmSource: choice("VCO 1 PWM source", "VCO 1", 0, [
    { value: 0, label: "LFO triangle" },
    { value: 1, label: "ADSR" },
  ]),
  vco1PwmAmount: percent("VCO 1 PWM", "VCO 1", 0),

  vco2Sync: toggle("VCO 2 sync", "VCO 2"),
  vco2Coarse: {
    label: "VCO 2 coarse",
    group: "VCO 2",
    control: "range",
    min: 20,
    max: 2000,
    step: 0.01,
    default: 65.41,
    unit: "Hz",
    scale: "log",
    display: "hertz",
  },
  vco2Fine: {
    label: "VCO 2 fine",
    group: "VCO 2",
    control: "range",
    min: -400,
    max: 400,
    step: 1,
    default: 0,
    unit: "¢",
    display: "cents",
  },
  vco2Fm1Source: choice("VCO 2 FM 1 source", "VCO 2", 0, [
    { value: 0, label: "LFO triangle" },
    { value: 1, label: "S/H mixer / pedal" },
  ]),
  vco2Fm1Amount: percent("VCO 2 FM 1", "VCO 2", 0),
  vco2Fm2Source: choice("VCO 2 FM 2 source", "VCO 2", 0, [
    { value: 0, label: "S/H output" },
    { value: 1, label: "ADSR" },
  ]),
  vco2Fm2Amount: percent("VCO 2 FM 2", "VCO 2", 0),
  vco2PulseWidth: {
    label: "VCO 2 pulse width",
    group: "VCO 2",
    control: "range",
    min: 0.05,
    max: 0.5,
    step: 0.001,
    default: 0.5,
    unit: "%",
    display: "percent",
  },
  vco2PwmSource: choice("VCO 2 PWM source", "VCO 2", 0, [
    { value: 0, label: "LFO triangle" },
    { value: 1, label: "ADSR" },
  ]),
  vco2PwmAmount: percent("VCO 2 PWM", "VCO 2", 0),

  lfoRate: {
    label: "LFO frequency",
    group: "LFO / S&H",
    control: "range",
    min: 0.2,
    max: 20,
    step: 0.001,
    default: 3.2,
    unit: "Hz",
    scale: "log",
    display: "hertz",
  },
  noiseColor: choice("Noise color", "LFO / S&H", 0, [
    { value: 0, label: "White" },
    { value: 1, label: "Pink" },
  ]),
  shInput1Source: choice("S/H mixer input 1", "LFO / S&H", 0, [
    { value: 0, label: "VCO 1 saw" },
    { value: 1, label: "VCO 1 pulse" },
  ]),
  shInput1Level: percent("S/H input 1", "LFO / S&H", 0.55),
  shInput2Source: choice("S/H mixer input 2", "LFO / S&H", 0, [
    { value: 0, label: "Pink noise" },
    { value: 1, label: "VCO 2 pulse" },
  ]),
  shInput2Level: percent("S/H input 2", "LFO / S&H", 0.8),
  shClockSource: choice("S/H clock", "LFO / S&H", 0, [
    { value: 0, label: "LFO" },
    { value: 1, label: "Keyboard trigger" },
  ]),
  shLag: {
    label: "S/H output lag",
    group: "LFO / S&H",
    control: "range",
    min: 0,
    max: 5,
    step: 0.001,
    default: 0,
    unit: "s",
    scale: "log",
    display: "seconds",
  },

  mixer1Source: choice("Mixer channel 1", "Audio mixer", 0, [
    { value: 0, label: "Noise" },
    { value: 1, label: "Ring XOR" },
  ]),
  mixer1Level: percent("Noise / ring level", "Audio mixer", 0),
  mixer2Source: choice("Mixer channel 2", "Audio mixer", 0, [
    { value: 0, label: "VCO 1 saw" },
    { value: 1, label: "VCO 1 pulse" },
  ]),
  mixer2Level: percent("VCO 1 level", "Audio mixer", 0.72),
  mixer3Source: choice("Mixer channel 3", "Audio mixer", 0, [
    { value: 0, label: "VCO 2 saw" },
    { value: 1, label: "VCO 2 pulse" },
  ]),
  mixer3Level: percent("VCO 2 level", "Audio mixer", 0.56),
  externalLevel: percent("External input level", "Audio mixer", 0.7),
  outputFeedback: {
    ...percent("Output feedback return", "Audio mixer", 0),
    max: 2,
  },

  filterType: choice("VCF type", "VCF", 3, [
    { value: 1, label: "Type I · 12 dB" },
    { value: 2, label: "Type II · 24 dB" },
    { value: 3, label: "Type III · 24 dB" },
  ]),
  filter4075Mode: choice("Type III cutoff scaling", "VCF", 1, [
    { value: 0, label: "Original · ~12 kHz ceiling" },
    { value: 1, label: "Repaired · full range" },
  ]),
  filterCutoff: {
    label: "VCF cutoff",
    group: "VCF",
    control: "range",
    min: 16,
    max: 16000,
    step: 0.1,
    default: 4200,
    unit: "Hz",
    scale: "log",
    display: "hertz",
  },
  filterResonance: percent("VCF resonance", "VCF", 0.18),
  filterMod1Source: choice("VCF modulation 1", "VCF", 0, [
    { value: 0, label: "Keyboard CV" },
    { value: 1, label: "S/H mixer / pedal" },
  ]),
  filterMod1Amount: percent("VCF modulation 1", "VCF", 0.25),
  filterMod2Source: choice("VCF modulation 2", "VCF", 1, [
    { value: 0, label: "S/H output" },
    { value: 1, label: "LFO triangle" },
  ]),
  filterMod2Amount: percent("VCF modulation 2", "VCF", 0),
  filterMod3Source: choice("VCF modulation 3", "VCF", 0, [
    { value: 0, label: "ADSR" },
    { value: 1, label: "AR" },
  ]),
  filterMod3Amount: percent("VCF modulation 3", "VCF", 0.22),
  hpfCutoff: {
    label: "HPF cutoff",
    group: "VCF",
    control: "range",
    min: 16,
    max: 16000,
    step: 0.1,
    default: 16,
    unit: "Hz",
    scale: "log",
    display: "hertz",
  },
  driveEnabled: toggle("Drive", "VCA", 0),
  driveAmount: {
    label: "Drive amount",
    group: "VCA",
    control: "range",
    min: 1,
    max: 10,
    step: 0.01,
    default: 2.4,
    unit: "×",
    display: "number",
  },
  vcaInitialGain: percent("VCA initial gain", "VCA", 0),
  vcaEnvelopeSource: choice("VCA envelope", "VCA", 1, [
    { value: 0, label: "AR" },
    { value: 1, label: "ADSR" },
  ]),
  vcaEnvelopeAmount: percent("VCA envelope", "VCA", 0.9),

  repeatMode: choice("Repeat qualifier", "Envelopes", 0, [
    { value: 0, label: "Keyboard repeat" },
    { value: 1, label: "Auto repeat" },
  ]),
  arSource: choice("AR source", "Envelopes", 0, [
    { value: 0, label: "Keyboard gate" },
    { value: 1, label: "LFO repeat" },
  ]),
  arAttack: {
    label: "AR attack",
    group: "Envelopes",
    control: "range",
    min: 0.005,
    max: 5,
    step: 0.001,
    default: 0.01,
    unit: "s",
    scale: "log",
    display: "seconds",
  },
  arRelease: {
    label: "AR release",
    group: "Envelopes",
    control: "range",
    min: 0.01,
    max: 8,
    step: 0.001,
    default: 0.3,
    unit: "s",
    scale: "log",
    display: "seconds",
  },
  adsrSource: choice("ADSR source", "Envelopes", 0, [
    { value: 0, label: "Keyboard gate" },
    { value: 1, label: "LFO repeat" },
  ]),
  adsrAttack: {
    label: "ADSR attack",
    group: "Envelopes",
    control: "range",
    min: 0.005,
    max: 5,
    step: 0.001,
    default: 0.015,
    unit: "s",
    scale: "log",
    display: "seconds",
  },
  adsrDecay: {
    label: "ADSR decay",
    group: "Envelopes",
    control: "range",
    min: 0.01,
    max: 8,
    step: 0.001,
    default: 0.38,
    unit: "s",
    scale: "log",
    display: "seconds",
  },
  adsrSustain: percent("ADSR sustain", "Envelopes", 0.62),
  adsrRelease: {
    label: "ADSR release",
    group: "Envelopes",
    control: "range",
    min: 0.015,
    max: 10,
    step: 0.001,
    default: 0.45,
    unit: "s",
    scale: "log",
    display: "seconds",
  },

  delayEnabled: toggle("Delay enabled", "Delay"),
  delayTime: {
    label: "Delay time",
    group: "Delay",
    control: "range",
    min: 1,
    max: 1000,
    step: 1,
    default: 320,
    unit: "ms",
    scale: "log",
    display: "milliseconds",
  },
  delayFeedback: {
    ...percent("Delay feedback", "Delay", 0.38),
    max: 0.92,
  },
  delayMix: percent("Delay mix", "Delay", 0.2),
  delayTone: {
    label: "Delay tone",
    group: "Delay",
    control: "range",
    min: DELAY_TONE_MINIMUM,
    max: DELAY_TONE_MAXIMUM,
    step: 1,
    default: 6200,
    unit: "Hz",
    scale: "log",
    display: "hertz",
  },
  delaySpread: percent("Stereo spread", "Delay", 0.35),
  delayPingPong: toggle("Ping-pong", "Delay", 1),
} as const satisfies Record<string, ParamSpec>;

export type ParamKey = keyof typeof PARAM_SPEC_DEFINITIONS;
export type SynthParams = Record<ParamKey, number>;

export const PARAM_SPECS: Record<ParamKey, ParamSpec> = PARAM_SPEC_DEFINITIONS;

export const PARAM_KEYS = Object.keys(PARAM_SPECS) as ParamKey[];

export const DEFAULT_PARAMS = Object.fromEntries(
  PARAM_KEYS.map((key) => [key, PARAM_SPECS[key].default]),
) as SynthParams;

const decimalsForStep = (step: number): number => {
  const stringValue = step.toString();
  if (stringValue.includes("e-")) return Number(stringValue.split("e-")[1]);
  return stringValue.includes(".") ? stringValue.split(".")[1].length : 0;
};

export const isValidParamValue = (key: ParamKey, value: number): boolean => {
  const spec = PARAM_SPECS[key];
  if (!Number.isFinite(value) || value < spec.min || value > spec.max) return false;
  if (spec.options) return spec.options.some((option) => option.value === value);
  const steps = (value - spec.min) / spec.step;
  return Math.abs(steps - Math.round(steps)) < 1e-6;
};

export const normalizeParamValue = (key: ParamKey, value: number): number => {
  const spec = PARAM_SPECS[key];
  if (!Number.isFinite(value)) return spec.default;
  if (spec.options) {
    return spec.options.reduce((nearest, option) =>
      Math.abs(option.value - value) < Math.abs(nearest.value - value) ? option : nearest,
    ).value;
  }
  const clamped = Math.min(spec.max, Math.max(spec.min, value));
  const stepped = spec.min + Math.round((clamped - spec.min) / spec.step) * spec.step;
  return Number(stepped.toFixed(decimalsForStep(spec.step)));
};

export const normalizePatch = (candidate: Partial<Record<ParamKey, number>>): SynthParams => {
  const result = { ...DEFAULT_PARAMS };
  for (const key of PARAM_KEYS) {
    const value = candidate[key];
    if (typeof value === "number") result[key] = normalizeParamValue(key, value);
  }
  return result;
};

export const paramToNormalized = (key: ParamKey, value: number): number => {
  const spec = PARAM_SPECS[key];
  if (spec.scale === "log") {
    if (spec.min === 0) {
      if (value <= 0) return 0;
      const floor = Math.max(spec.step, 0.001);
      return 0.04 + 0.96 * Math.log(value / floor) / Math.log(spec.max / floor);
    }
    return Math.log(value / spec.min) / Math.log(spec.max / spec.min);
  }
  return (value - spec.min) / (spec.max - spec.min);
};

export const normalizedToParam = (key: ParamKey, normalized: number): number => {
  const spec = PARAM_SPECS[key];
  const amount = Math.min(1, Math.max(0, normalized));
  if (spec.scale === "log") {
    if (spec.min === 0) {
      if (amount < 0.04) return 0;
      const floor = Math.max(spec.step, 0.001);
      const remapped = (amount - 0.04) / 0.96;
      return normalizeParamValue(key, floor * Math.pow(spec.max / floor, remapped));
    }
    return normalizeParamValue(key, spec.min * Math.pow(spec.max / spec.min, amount));
  }
  return normalizeParamValue(key, spec.min + amount * (spec.max - spec.min));
};

const NOTE_NAMES = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];

export const midiNoteName = (note: number): string => {
  const rounded = Math.round(note);
  return `${NOTE_NAMES[((rounded % 12) + 12) % 12]}${Math.floor(rounded / 12) - 1}`;
};

export const formatParamValue = (key: ParamKey, value: number): string => {
  const spec = PARAM_SPECS[key];
  const option = spec.options?.find((candidate) => candidate.value === value);
  if (option) return option.label;
  switch (spec.display) {
    case "percent":
      return `${Math.round(value * 100)}%`;
    case "hertz":
      return value >= 1000 ? `${(value / 1000).toFixed(value >= 10000 ? 1 : 2)} kHz` : `${value.toFixed(value < 10 ? 2 : 1)} Hz`;
    case "seconds":
      return value < 1 ? `${Math.round(value * 1000)} ms` : `${value.toFixed(2)} s`;
    case "seconds-per-octave":
      return `${Number(value.toFixed(3))} s/oct`;
    case "milliseconds":
      return `${Math.round(value)} ms`;
    case "cents":
      return `${value > 0 ? "+" : ""}${Math.round(value)}¢`;
    case "semitones":
      return `${value > 0 ? "+" : ""}${Number(value.toFixed(2))} st`;
    case "midi":
      return `${midiNoteName(value)} · ${Math.round(value)}`;
    default:
      return `${Number(value.toFixed(3))}${spec.unit ? ` ${spec.unit}` : ""}`;
  }
};

export const describeValidValues = (key: ParamKey): string => {
  const spec = PARAM_SPECS[key];
  if (spec.options) {
    return spec.options.map((option) => `${option.value} = ${option.label}`).join(" · ");
  }
  if (spec.display === "percent") {
    const minimum = Number((spec.min * 100).toFixed(4));
    const maximum = Number((spec.max * 100).toFixed(4));
    const step = Number((spec.step * 100).toFixed(4));
    return `${minimum}% to ${maximum}%; step ${step}%`;
  }
  const unit = spec.unit ? ` ${spec.unit}` : "";
  return `${spec.min}${unit} to ${spec.max}${unit}; step ${spec.step}${unit}`;
};
