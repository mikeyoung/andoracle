import { describe, expect, it } from "vitest";
import {
  DEFAULT_PARAMS,
  PARAM_KEYS,
  PARAM_SPECS,
  isValidParamValue,
  normalizedToParam,
  paramToNormalized,
} from "./params";
import { FACTORY_PRESETS } from "./presets";
import { LAYOUT_PARAM_KEYS, PANEL_SECTIONS } from "../ui/layout";

describe("parameter schema", () => {
  it("renders every persistent parameter exactly once", () => {
    expect(new Set(LAYOUT_PARAM_KEYS).size).toBe(LAYOUT_PARAM_KEYS.length);
    expect([...LAYOUT_PARAM_KEYS].sort()).toEqual([...PARAM_KEYS].sort());
  });

  it("renders every parameter with a control compatible with its schema", () => {
    for (const section of PANEL_SECTIONS) {
      for (const item of section.items) {
        switch (item.kind) {
          case "range":
          case "choice":
          case "toggle":
            expect(PARAM_SPECS[item.param].control, `${section.id}.${item.param}`).toBe(item.kind);
            break;
          case "route":
            expect(PARAM_SPECS[item.source].control, `${section.id}.${item.source}`).toBe("choice");
            expect(PARAM_SPECS[item.amount].control, `${section.id}.${item.amount}`).toBe("range");
            break;
          case "external":
          case "ppc":
            break;
        }
      }
    }
  });

  it("keeps every module and control in the canonical widest-desktop sequence", () => {
    const sectionIds = PANEL_SECTIONS.map((section) => section.id);
    expect(sectionIds).toEqual([
      "controllers",
      "vco1",
      "vco2",
      "envelopes",
      "amplifier",
      "modulators",
      "filter",
      "mixer",
      "delay",
    ]);

    const itemOrder = Object.fromEntries(PANEL_SECTIONS.map((section) => [
      section.id,
      section.items.flatMap((item) => {
        if (item.kind === "route") return [item.source, item.amount];
        if (item.kind === "external" || item.kind === "ppc") return [item.kind];
        return [item.param];
      }),
    ]));

    expect(itemOrder).toEqual({
      controllers: [
        "transpose", "portamento", "portamentoMode", "portamentoFootswitch", "masterTune",
        "autoRun", "autoNote", "ppcBendRange", "ppcVibratoRange", "pedalConnected",
        "pedalPosition", "ppc",
      ],
      vco1: [
        "vco1Mode", "vco1Coarse", "vco1Fine", "vco1Fm1Source", "vco1Fm1Amount",
        "vco1Fm2Source", "vco1Fm2Amount", "vco1PulseWidth", "vco1PwmSource", "vco1PwmAmount",
      ],
      vco2: [
        "vco2Sync", "vco2Coarse", "vco2Fine", "vco2Fm1Source", "vco2Fm1Amount",
        "vco2Fm2Source", "vco2Fm2Amount", "vco2PulseWidth", "vco2PwmSource", "vco2PwmAmount",
      ],
      envelopes: [
        "repeatMode", "arSource", "arAttack", "arRelease", "adsrSource", "adsrAttack",
        "adsrDecay", "adsrSustain", "adsrRelease",
      ],
      amplifier: [
        "driveEnabled", "driveAmount", "vcaInitialGain", "vcaEnvelopeSource",
        "vcaEnvelopeAmount", "masterVolume",
      ],
      modulators: [
        "lfoRate", "noiseColor", "shInput1Source", "shInput1Level", "shInput2Source",
        "shInput2Level", "shClockSource", "shLag",
      ],
      filter: [
        "filterType", "filter4075Mode", "filterCutoff", "filterResonance", "hpfCutoff",
        "filterMod1Source", "filterMod1Amount", "filterMod2Source", "filterMod2Amount",
        "filterMod3Source", "filterMod3Amount",
      ],
      mixer: [
        "mixer1Source", "mixer1Level", "mixer2Source", "mixer2Level", "mixer3Source",
        "mixer3Level", "externalLevel", "outputFeedback", "external",
      ],
      delay: [
        "delayEnabled", "delayTime", "delayFeedback", "delayMix", "delayTone", "delaySpread",
        "delayPingPong", "delayTrails",
      ],
    });
  });

  it("maps logarithmic midpoint geometrically", () => {
    const midpoint = normalizedToParam("filterCutoff", 0.5);
    expect(midpoint).toBeCloseTo(Math.sqrt(16 * 16000), 0);
    expect(paramToNormalized("filterCutoff", midpoint)).toBeCloseTo(0.5, 3);
  });

  it("preserves a true zero on logarithmic time controls", () => {
    expect(normalizedToParam("portamento", 0)).toBe(0);
    expect(paramToNormalized("portamento", 0)).toBe(0);
    expect(normalizedToParam("portamento", 1)).toBe(1.5);
  });

  it("rejects invalid direct-entry values and selector codes", () => {
    expect(isValidParamValue("delayFeedback", 0.92)).toBe(true);
    expect(isValidParamValue("delayFeedback", 0.921)).toBe(false);
    expect(isValidParamValue("transpose", 0)).toBe(true);
    expect(isValidParamValue("transpose", 12)).toBe(false);
  });

  it("keeps every default and factory-patch value inside its declared range", () => {
    expect(DEFAULT_PARAMS.ppcBendRange).toBe(8);
    expect(DEFAULT_PARAMS.filter4075Mode).toBe(1);
    for (const key of PARAM_KEYS) expect(isValidParamValue(key, DEFAULT_PARAMS[key])).toBe(true);
    for (const preset of FACTORY_PRESETS) {
      expect(Object.keys(preset.params).sort()).toEqual([...PARAM_KEYS].sort());
      for (const key of PARAM_KEYS) expect(isValidParamValue(key, preset.params[key])).toBe(true);
    }
  });
});
