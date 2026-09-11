import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import rasterLabelSource from "./RasterLabel.tsx?raw";
import {
  RasterLabel,
  type RasterLabelTone,
  type RasterLabelVariant,
} from "./RasterLabel";

const VARIANTS: readonly RasterLabelVariant[] = [
  "brand",
  "model",
  "title",
  "eyebrow",
  "control",
  "button",
  "micro",
];

const TONES: readonly RasterLabelTone[] = ["ink", "muted", "reverse"];

const occurrences = (value: string, fragment: string): number => (
  value.split(fragment).length - 1
);

describe("RasterLabel", () => {
  it.each(VARIANTS.flatMap((variant) => TONES.map((tone) => [variant, tone] as const)))(
    "renders the %s/%s treatment as one semantic system-text label",
    (variant, tone) => {
      const markup = renderToStaticMarkup(createElement(RasterLabel, {
        text: "Filter mode",
        variant,
        tone,
      }));

      expect(markup).toContain(`raster-label--${variant}`);
      expect(markup).toContain(`raster-label--tone-${tone}`);
      expect(markup).toContain('<span class="raster-label__text">Filter mode</span>');
      expect(occurrences(markup, "Filter mode")).toBe(1);
      expect(markup).not.toMatch(/<canvas\b|aria-hidden|visually-hidden/);
    },
  );

  it("keeps caller classes and makes preserveCase an explicit visual treatment", () => {
    const markup = renderToStaticMarkup(createElement(RasterLabel, {
      text: "Andoracle Mk II",
      variant: "brand",
      tone: "reverse",
      preserveCase: true,
      className: "custom-faceplate-label",
    }));

    expect(markup).toContain(
      'class="raster-label raster-label--brand raster-label--tone-reverse raster-label--preserve-case custom-faceplate-label"',
    );
    expect(markup).toContain('<span class="raster-label__text">Andoracle Mk II</span>');
    expect(occurrences(markup, "Andoracle Mk II")).toBe(1);
  });

  it("uses the default control/ink treatment without changing source casing", () => {
    const markup = renderToStaticMarkup(createElement(RasterLabel, { text: "Mixed Case" }));

    expect(markup).toContain(
      'class="raster-label raster-label--control raster-label--tone-ink"',
    );
    expect(markup).not.toContain("raster-label--preserve-case");
    expect(markup).toContain('class="raster-label__text">Mixed Case</span>');
    expect(markup).not.toContain("MIXED CASE");
  });

  it("keeps long labels intact for browser word-boundary wrapping", () => {
    const label = "Sample and hold clock source selector";
    const markup = renderToStaticMarkup(createElement(RasterLabel, { text: label }));

    expect(markup).toContain(`class="raster-label__text">${label}</span>`);
    expect(occurrences(markup, label)).toBe(1);
    expect(markup).not.toMatch(/\u2026|&hellip;|text-overflow|line-clamp|<wbr\b|<br\b|style=/);
  });

  it("contains no canvas APIs, render effects, or duplicate hidden-label path", () => {
    expect(rasterLabelSource).not.toMatch(/\bcanvas\b|CanvasRenderingContext2D|getContext|measureText|fillText/);
    expect(rasterLabelSource).not.toMatch(/useEffect|useLayoutEffect|useRef/);
    expect(rasterLabelSource).not.toMatch(/visually-hidden|aria-hidden/);
    expect(rasterLabelSource).toContain("export const RasterLabel = memo(RasterLabelComponent)");
  });
});
