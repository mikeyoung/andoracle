import { describe, expect, it } from "vitest";
import {
  DEFAULT_PARAMS,
  PARAM_KEYS,
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

  it("places the complete delay panel between the mixer and final filters", () => {
    const sectionIds = PANEL_SECTIONS.map((section) => section.id);
    expect(sectionIds.indexOf("delay")).toBe(sectionIds.indexOf("mixer") + 1);
    expect(sectionIds.indexOf("filter")).toBe(sectionIds.indexOf("delay") + 1);

    const delay = PANEL_SECTIONS.find((section) => section.id === "delay");
    expect(delay?.items.map((item) => "param" in item ? item.param : item.kind)).toEqual([
      "delayEnabled",
      "delayTime",
      "delayFeedback",
      "delayMix",
      "delayTone",
      "delaySpread",
      "delayPingPong",
    ]);
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
