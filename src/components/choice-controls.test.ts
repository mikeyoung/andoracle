import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_PARAMS, PARAM_KEYS, PARAM_SPECS, type ParamKey } from "../synth/params";
import { ChoiceControl, nextChoiceValue } from "./ParameterControls";

const CHOICE_PARAMS = PARAM_KEYS.filter((param) => PARAM_SPECS[param].control === "choice");

const renderChoice = (param: ParamKey, compact = false): string => renderToStaticMarkup(createElement(ChoiceControl, {
  param,
  value: DEFAULT_PARAMS[param],
  accent: "#e86b24",
  compact,
  onChange: vi.fn(),
  onDirectEdit: vi.fn(),
}));

describe("compact selector controls", () => {
  it("renders every module selector as one dropdown-style cycling button", () => {
    expect(CHOICE_PARAMS).toHaveLength(25);

    for (const param of CHOICE_PARAMS) {
      const spec = PARAM_SPECS[param];
      const selected = spec.options?.find((option) => option.value === DEFAULT_PARAMS[param]);
      const markup = renderChoice(param);

      expect(markup).toContain(`class="choice-button" id="param-${param}"`);
      expect(markup).toContain(`aria-label="${spec.label}: ${selected?.label}"`);
      expect(markup.match(/class="choice-button"/g) ?? []).toHaveLength(1);
      expect(markup).not.toContain('type="radio"');
      expect(markup).not.toContain('role="radiogroup"');
      expect(markup).not.toContain("choice-switch-bank");
      expect(markup).not.toContain("<select");
    }
  });

  it("cycles every selector through its options and wraps to the first value", () => {
    for (const param of CHOICE_PARAMS) {
      const options = PARAM_SPECS[param].options ?? [];
      for (const [index, option] of options.entries()) {
        expect(nextChoiceValue(param, option.value)).toBe(options[(index + 1) % options.length]?.value);
      }
    }
  });

  it("keeps routed selectors compact and omits the duplicate output", () => {
    const markup = renderChoice("vco1Fm1Source", true);

    expect(markup).toContain('<label for="param-vco1Fm1Source">Source</label>');
    expect(markup).toContain("LFO triangle");
    expect(markup).not.toContain("<output");
  });
});
