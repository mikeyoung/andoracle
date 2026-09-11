import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const consoleStyles = readFileSync(resolve("src/console-1968.css"), "utf8");
const baseStyles = readFileSync(resolve("src/styles.css"), "utf8");
const rasterLabel = readFileSync(resolve("src/components/RasterLabel.tsx"), "utf8");
const responsiveStyles = consoleStyles.slice(
  consoleStyles.indexOf("Responsive photographic console assembly"),
);

describe("responsive faceplate system text", () => {
  it("renders one visible semantic text node without a canvas duplicate", () => {
    expect(rasterLabel).toContain('<span className="raster-label__text">{text}</span>');
    expect(rasterLabel).not.toContain("<canvas");
    expect(rasterLabel).not.toContain("visually-hidden");
    expect(rasterLabel).not.toContain("getContext");
    expect(rasterLabel).not.toContain("useEffect");
    expect(rasterLabel).not.toContain("useRef");
    expect(responsiveStyles).toMatch(/\.raster-label,[\s\S]*?pointer-events:\s*none;[\s\S]*?text-align:\s*center;/);
  });

  it("styles every faceplate role as readable native text with intrinsic height", () => {
    for (const variant of ["brand", "model", "title", "eyebrow", "control", "button", "micro"]) {
      expect(rasterLabel).toContain('| "' + variant + '"');
      expect(responsiveStyles).toMatch(
        new RegExp("\\.raster-label--" + variant + "\\s*\\{[^}]*font-size:\\s*(?:clamp\\([^;]+|[\\d.]+px);"),
      );
    }
    expect(responsiveStyles).toMatch(/\.raster-label,[\s\S]*?height:\s*auto;/);
    expect(responsiveStyles).toMatch(/\.raster-label__text\s*\{[\s\S]*?text-transform:\s*uppercase;[\s\S]*?white-space:\s*normal;/);
    expect(responsiveStyles).toMatch(/\.raster-label--preserve-case \.raster-label__text\s*\{[^}]*text-transform:\s*none;/);
  });

  it("wraps complete labels without ellipses, mid-word breaks, or canvas fitting", () => {
    expect(consoleStyles).not.toMatch(/text-overflow:\s*ellipsis/);
    expect(consoleStyles).not.toMatch(/line-clamp/);
    expect(responsiveStyles).toMatch(/\.raster-label__text\s*\{[\s\S]*?overflow:\s*visible;[\s\S]*?white-space:\s*normal;[\s\S]*?overflow-wrap:\s*normal;[\s\S]*?word-break:\s*normal;[\s\S]*?hyphens:\s*none;/);
    expect(responsiveStyles).toMatch(/\.choice-button span\s*\{[\s\S]*?overflow:\s*visible;[\s\S]*?white-space:\s*normal;[\s\S]*?word-break:\s*normal;[\s\S]*?hyphens:\s*none;/);
    expect(rasterLabel).not.toContain("horizontalScale");
    expect(rasterLabel).not.toContain("minimumFontSize");
  });

  it("keeps changing values and MIDI status at legible native-text sizes", () => {
    expect(responsiveStyles).toMatch(/\.parameter output,[\s\S]*?min-height:\s*18px;[\s\S]*?font-family:\s*var\(--andoracle-font\);[\s\S]*?font-size:\s*12px;/);
    expect(responsiveStyles).toMatch(/\.midi-dialog__status\s*\{[\s\S]*?font-size:\s*12px;[\s\S]*?line-height:\s*1\.45;/);
  });

  it("uses the signal-path typeface throughout while preserving per-role weights", () => {
    expect(baseStyles).toContain('--andoracle-font: "Arial Narrow", "Roboto Condensed", "Franklin Gothic Medium", "Helvetica Neue", Arial, ui-sans-serif, system-ui, sans-serif;');
    expect(baseStyles).toMatch(/:root\s*\{[\s\S]*?font-family:\s*var\(--andoracle-font\);/);
    const families = `${baseStyles}\n${consoleStyles}`.match(/font-family:\s*[^;]+;/g) ?? [];
    expect(new Set(families)).toEqual(new Set([
      "font-family: var(--andoracle-font);",
      "font-family: inherit;",
    ]));
    expect(responsiveStyles).toMatch(/\.raster-label,[\s\S]*?font-weight:\s*800;/);
  });

  it("keeps the longest module title inside the faceplate at ultra-narrow widths", () => {
    expect(responsiveStyles).toMatch(
      /@media \(max-width:\s*220px\)\s*\{[\s\S]*?\.module-header\s*\{[\s\S]*?padding-right:\s*12px;[\s\S]*?padding-left:\s*12px;[\s\S]*?\.module-header \.raster-label--title\s*\{[\s\S]*?font-size:\s*13px;[\s\S]*?letter-spacing:\s*0\.04em;/,
    );
  });

  it("keeps semantic text available when forced colors suppress photographs", () => {
    const forcedColors = consoleStyles.slice(consoleStyles.indexOf("@media (forced-colors: active)"));
    expect(forcedColors).toMatch(/\.raster-label\s*\{[\s\S]*?overflow:\s*visible;[\s\S]*?font-size:\s*9px;/);
    expect(rasterLabel).toContain("raster-label--tone-");
    expect(rasterLabel).toContain('preserveCase ? "raster-label--preserve-case" : null');
  });

  it("keeps photographic controls identifiable in forced colors", () => {
    const forcedColors = consoleStyles.slice(consoleStyles.indexOf("@media (forced-colors: active)"));
    expect(forcedColors).toMatch(/\.button,[\s\S]*?\.library-picker select\s*\{[\s\S]*?border:\s*1px solid ButtonText;[\s\S]*?background-color:\s*ButtonFace;/);
    expect(forcedColors).toMatch(/\.toggle-switch > span:not\(\.raster-label\),[\s\S]*?background-image:\s*none !important;/);
    expect(forcedColors).toMatch(/\.dial-scale i,\s*\.dial-face i\s*\{[\s\S]*?display:\s*block;[\s\S]*?background:\s*CanvasText;/);
    expect(forcedColors).toMatch(/\.piano-key\s*\{[\s\S]*?border:\s*1px solid ButtonText;[\s\S]*?background-color:\s*ButtonFace;/);
    expect(forcedColors).toMatch(/button:focus-visible,[\s\S]*?\.keyboard-banks:focus-visible\s*\{[\s\S]*?outline-color:\s*Highlight;[\s\S]*?box-shadow:\s*none;/);
  });
});
