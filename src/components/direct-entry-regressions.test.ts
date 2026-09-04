import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DirectEntryModal } from "./DirectEntryModal";
import { DEFAULT_PARAMS, PARAM_KEYS, PARAM_SPECS } from "../synth/params";

describe("direct-entry coverage for every persistent control", () => {
  it.each(PARAM_KEYS)("renders %s with its declared numeric constraints", (param) => {
    const spec = PARAM_SPECS[param];
    const multiplier = spec.display === "percent" ? 100 : 1;
    const markup = renderToStaticMarkup(createElement(DirectEntryModal, {
      param,
      value: DEFAULT_PARAMS[param],
      origin: null,
      onApply: vi.fn(),
      onClose: vi.fn(),
    }));

    expect(markup).toContain(spec.label);
    expect(markup).toContain("Valid values:");
    expect(markup).toContain(`min="${spec.min * multiplier}"`);
    expect(markup).toContain(`max="${spec.max * multiplier}"`);
    expect(markup).toContain(`step="${spec.step * multiplier}"`);
    expect(markup).toContain('aria-describedby="direct-entry-range direct-entry-error"');
  });

  it("uses the displayed low-frequency scale for VCO 1 keyboard-off mode", () => {
    const markup = renderToStaticMarkup(createElement(DirectEntryModal, {
      param: "vco1Coarse",
      value: DEFAULT_PARAMS.vco1Coarse,
      displayScale: 0.01,
      origin: null,
      onApply: vi.fn(),
      onClose: vi.fn(),
    }));

    expect(markup).toContain('min="0.2"');
    expect(markup).toContain('max="20"');
    expect(markup).toContain('step="0.0001"');
    expect(markup).toContain("Valid values: 0.2 Hz to 20 Hz; step 0.0001 Hz");
  });
});
