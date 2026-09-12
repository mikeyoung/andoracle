import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const consoleStyles = readFileSync(resolve("src/console-1968.css"), "utf8");
const baseStyles = readFileSync(resolve("src/styles.css"), "utf8");
const rasterLabel = readFileSync(resolve("src/components/RasterLabel.tsx"), "utf8");
const photoSwitchHardware = readFileSync(resolve("src/components/PhotoSwitchHardware.tsx"), "utf8");
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

  it("does not install alternate forced-color or motion presentation modes", () => {
    expect(consoleStyles).not.toContain("@media (forced-colors: active)");
    expect(consoleStyles).not.toContain("@media (prefers-reduced-motion: reduce)");
    expect(baseStyles).not.toContain("@media (forced-colors: active)");
    expect(baseStyles).not.toContain("@media (prefers-reduced-motion: reduce)");
  });

  it("pins faceplate ink and uses content images for Firefox-safe switches", () => {
    expect(consoleStyles).toMatch(/html,[\s\S]*?\.app-shell\s*\{[\s\S]*?forced-color-adjust:\s*none;/);
    expect(consoleStyles).toMatch(/\.raster-label--tone-ink,[\s\S]*?color:\s*#171713 !important;/);
    expect(consoleStyles).toMatch(/\.raster-label--tone-reverse,[\s\S]*?color:\s*#f3eee1 !important;/);
    expect(photoSwitchHardware).toContain('className="photo-switch-hardware"');
    expect(photoSwitchHardware).toContain('src={PHOTO_SWITCH_IMAGES[variant][enabled ? 1 : 0]}');
  });
});
