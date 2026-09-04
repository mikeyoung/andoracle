import type { ParamKey } from "../synth/params";

export type LayoutItem =
  | { readonly kind: "range"; readonly param: ParamKey }
  | { readonly kind: "choice"; readonly param: ParamKey }
  | { readonly kind: "toggle"; readonly param: ParamKey }
  | { readonly kind: "route"; readonly source: ParamKey; readonly amount: ParamKey }
  | { readonly kind: "external" }
  | { readonly kind: "ppc" };

export interface PanelSectionDefinition {
  readonly id: string;
  readonly eyebrow: string;
  readonly title: string;
  readonly accent: string;
  readonly items: readonly LayoutItem[];
}

export const PANEL_SECTIONS: readonly PanelSectionDefinition[] = [
  {
    id: "controllers",
    eyebrow: "Keyboard voltage control",
    title: "Controllers",
    accent: "#a85b36",
    items: [
      { kind: "choice", param: "transpose" },
      { kind: "range", param: "portamento" },
      { kind: "choice", param: "portamentoMode" },
      { kind: "toggle", param: "portamentoFootswitch" },
      { kind: "range", param: "masterTune" },
      { kind: "toggle", param: "autoRun" },
      { kind: "range", param: "autoNote" },
      { kind: "range", param: "ppcBendRange" },
      { kind: "range", param: "ppcVibratoRange" },
      { kind: "toggle", param: "pedalConnected" },
      { kind: "range", param: "pedalPosition" },
      { kind: "ppc" },
    ],
  },
  {
    id: "vco1",
    eyebrow: "Low-note voltage control",
    title: "VCO 1",
    accent: "#b58a32",
    items: [
      { kind: "choice", param: "vco1Mode" },
      { kind: "range", param: "vco1Coarse" },
      { kind: "range", param: "vco1Fine" },
      { kind: "route", source: "vco1Fm1Source", amount: "vco1Fm1Amount" },
      { kind: "route", source: "vco1Fm2Source", amount: "vco1Fm2Amount" },
      { kind: "range", param: "vco1PulseWidth" },
      { kind: "route", source: "vco1PwmSource", amount: "vco1PwmAmount" },
    ],
  },
  {
    id: "vco2",
    eyebrow: "High-note voltage control",
    title: "VCO 2",
    accent: "#91453b",
    items: [
      { kind: "toggle", param: "vco2Sync" },
      { kind: "range", param: "vco2Coarse" },
      { kind: "range", param: "vco2Fine" },
      { kind: "route", source: "vco2Fm1Source", amount: "vco2Fm1Amount" },
      { kind: "route", source: "vco2Fm2Source", amount: "vco2Fm2Amount" },
      { kind: "range", param: "vco2PulseWidth" },
      { kind: "route", source: "vco2PwmSource", amount: "vco2PwmAmount" },
    ],
  },
  {
    id: "modulators",
    eyebrow: "S/H mixer · low frequency oscillator",
    title: "LFO · Noise · S/H",
    accent: "#6f7750",
    items: [
      { kind: "range", param: "lfoRate" },
      { kind: "choice", param: "noiseColor" },
      { kind: "route", source: "shInput1Source", amount: "shInput1Level" },
      { kind: "route", source: "shInput2Source", amount: "shInput2Level" },
      { kind: "choice", param: "shClockSource" },
      { kind: "range", param: "shLag" },
    ],
  },
  {
    id: "mixer",
    eyebrow: "Three-channel audio bus",
    title: "Audio Mixer",
    accent: "#8c4038",
    items: [
      { kind: "route", source: "mixer1Source", amount: "mixer1Level" },
      { kind: "route", source: "mixer2Source", amount: "mixer2Level" },
      { kind: "route", source: "mixer3Source", amount: "mixer3Level" },
      { kind: "range", param: "externalLevel" },
      { kind: "range", param: "outputFeedback" },
      { kind: "external" },
    ],
  },
  {
    id: "delay",
    eyebrow: "Post mixer → pre filter",
    title: "Stereo Delay",
    accent: "#47746e",
    items: [
      { kind: "toggle", param: "delayEnabled" },
      { kind: "range", param: "delayTime" },
      { kind: "range", param: "delayFeedback" },
      { kind: "range", param: "delayMix" },
      { kind: "range", param: "delayTone" },
      { kind: "range", param: "delaySpread" },
      { kind: "toggle", param: "delayPingPong" },
    ],
  },
  {
    id: "filter",
    eyebrow: "Voltage controlled filter",
    title: "VCF · HPF",
    accent: "#aa7535",
    items: [
      { kind: "choice", param: "filterType" },
      { kind: "choice", param: "filter4075Mode" },
      { kind: "range", param: "filterCutoff" },
      { kind: "range", param: "filterResonance" },
      { kind: "route", source: "filterMod1Source", amount: "filterMod1Amount" },
      { kind: "route", source: "filterMod2Source", amount: "filterMod2Amount" },
      { kind: "route", source: "filterMod3Source", amount: "filterMod3Amount" },
      { kind: "range", param: "hpfCutoff" },
    ],
  },
  {
    id: "envelopes",
    eyebrow: "AR · ADSR contour generators",
    title: "Envelope Generators",
    accent: "#9a5538",
    items: [
      { kind: "choice", param: "repeatMode" },
      { kind: "choice", param: "arSource" },
      { kind: "range", param: "arAttack" },
      { kind: "range", param: "arRelease" },
      { kind: "choice", param: "adsrSource" },
      { kind: "range", param: "adsrAttack" },
      { kind: "range", param: "adsrDecay" },
      { kind: "range", param: "adsrSustain" },
      { kind: "range", param: "adsrRelease" },
    ],
  },
  {
    id: "amplifier",
    eyebrow: "Voltage controlled amplifier",
    title: "VCA · Output",
    accent: "#8a805f",
    items: [
      { kind: "toggle", param: "driveEnabled" },
      { kind: "range", param: "driveAmount" },
      { kind: "range", param: "vcaInitialGain" },
      { kind: "route", source: "vcaEnvelopeSource", amount: "vcaEnvelopeAmount" },
      { kind: "range", param: "masterVolume" },
    ],
  },
];

export const LAYOUT_PARAM_KEYS = PANEL_SECTIONS.flatMap((section) =>
  section.items.flatMap((item): ParamKey[] => {
    if (item.kind === "ppc" || item.kind === "external") return [];
    if (item.kind === "route") return [item.source, item.amount];
    return [item.param];
  }),
);
