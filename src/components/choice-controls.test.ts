import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_PARAMS, PARAM_KEYS, PARAM_SPECS, type ParamKey } from "../synth/params";
import { ChoiceControl } from "./ParameterControls";

const CHOICE_PARAMS = PARAM_KEYS.filter((param) => PARAM_SPECS[param].control === "choice");

const renderChoice = (param: ParamKey, compact = false): string => renderToStaticMarkup(createElement(ChoiceControl, {
  param,
  value: DEFAULT_PARAMS[param],
  accent: "#e86b24",
  compact,
  onChange: vi.fn(),
  onDirectEdit: vi.fn(),
}));

describe("power-style selector switches", () => {
  it("covers every module selector with labelled, directly selectable positions", () => {
    expect(CHOICE_PARAMS).toHaveLength(25);

    for (const param of CHOICE_PARAMS) {
      const spec = PARAM_SPECS[param];
      const options = spec.options ?? [];
      const markup = renderChoice(param);

      expect(markup).toContain('class="choice-switch-bank"');
      expect(markup).toContain('role="radiogroup"');
      expect(markup).toContain(`aria-labelledby="label-${param}"`);
      expect(markup).toContain(`data-choice-count="${options.length}"`);
      expect(markup.match(/type="radio"/g) ?? []).toHaveLength(options.length);
      expect(markup.match(/checked=""/g) ?? []).toHaveLength(1);
      expect(markup).not.toContain("<select");

      for (const option of options) {
        expect(markup).toContain(option.label);
        expect(markup).toContain(`aria-label="${spec.label}: ${option.label}`);
      }
    }
  });

  it("uses two positions for binary selectors and three for transpose and filter type", () => {
    const optionCounts = CHOICE_PARAMS.map((param) => PARAM_SPECS[param].options?.length ?? 0);

    expect(optionCounts.filter((count) => count === 2)).toHaveLength(23);
    expect(optionCounts.filter((count) => count === 3)).toHaveLength(2);
  });

  it("keeps compact routed switches labelled as sources without a duplicate output", () => {
    const markup = renderChoice("vco1Fm1Source", true);

    expect(markup).toContain('<span class="choice-label" id="label-vco1Fm1Source">Source</span>');
    expect(markup).toContain('role="radiogroup" aria-label="VCO 1 FM 1 source"');
    expect(markup).not.toContain('aria-labelledby="label-vco1Fm1Source"');
    expect(markup).toContain("LFO triangle");
    expect(markup).toContain("LFO square");
    expect(markup).not.toContain("<output");
  });
});
