import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const styles = readFileSync(resolve("src/styles.css"), "utf8");
const layout = readFileSync(resolve("src/ui/layout.ts"), "utf8");
const html = readFileSync(resolve("index.html"), "utf8");
const viteConfig = readFileSync(resolve("vite.config.ts"), "utf8");

const sixDigitColors = (source: string): string[] => (
  [...source.matchAll(/#[0-9a-f]{6}\b/gi)].map((match) => match[0].toLowerCase())
);

const isGrayHex = (color: string): boolean => (
  color.slice(1, 3) === color.slice(3, 5)
  && color.slice(1, 3) === color.slice(5, 7)
);

describe("1950s electronics-console finish", () => {
  it("uses only neutral CSS, module-accent, and browser-chrome color literals", () => {
    for (const [name, source] of Object.entries({ styles, layout, html, viteConfig })) {
      const nonGrayHex = sixDigitColors(source).filter((color) => !isGrayHex(color));
      const nonGrayRgb = [...source.matchAll(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/g)]
        .filter((match) => match[1] !== match[2] || match[1] !== match[3])
        .map((match) => match[0]);
      expect(nonGrayHex, `${name} contains chromatic hexadecimal colors`).toEqual([]);
      expect(nonGrayRgb, `${name} contains chromatic RGB colors`).toEqual([]);
    }
  });

  it("replaces the large veneer with lightweight neutral enamel and metal textures", () => {
    expect(styles).not.toContain("walnut-veneer-60s-seamless.png");
    expect(styles).not.toContain("filter: grayscale");
    expect(styles).not.toContain("backdrop-filter");
    expect(styles).toMatch(/body\s*\{[\s\S]*?background-image:[\s\S]*?radial-gradient[\s\S]*?repeating-linear-gradient/);
    expect(styles).toMatch(/\.module\s*\{[\s\S]*?var\(--ivory-raised\)[\s\S]*?var\(--ivory-panel\)/);
    expect(styles).toMatch(/\.keyboard-module\s*\{[\s\S]*?background:[\s\S]*?radial-gradient[\s\S]*?linear-gradient/);
  });

  it("keeps bright off-white modules, dark legible text, and period hardware geometry", () => {
    expect(styles).toContain("--ivory-panel: #dddddd");
    expect(styles).toContain("--ivory-raised: #f0f0f0");
    expect(styles).toMatch(/\.module-header\s*\{[\s\S]*?linear-gradient\(180deg, #d7d7d7, #b6b6b6\)/);
    expect(styles).toMatch(/\.module-header h2,[\s\S]*?color:\s*#202020;/);
    expect(styles).toMatch(/\.panel-screw\s*\{[\s\S]*?border-radius:\s*50%;[\s\S]*?radial-gradient\(circle at 34% 28%,/);
    expect(styles).toMatch(/\.fader-shell input\[type="range"\]::\-webkit-slider-thumb\s*\{[\s\S]*?width:\s*34px;[\s\S]*?transform:\s*translateX\(\-14px\);/);
    expect(styles).toMatch(/\.piano-key--black\s*\{[\s\S]*?min-width:\s*0;[\s\S]*?height:\s*139px;/);
    expect(styles).toContain("@media (forced-colors: active)");
  });

  it("aligns browser chrome and install surfaces with the grayscale console", () => {
    expect(viteConfig).toContain('theme_color: "#a3a3a3"');
    expect(viteConfig).toContain('background_color: "#292929"');
    expect(html).toContain('<meta name="theme-color" content="#a3a3a3" />');
    expect(html).toContain('<meta name="color-scheme" content="light" />');
  });

  it("assigns a neutral functional accent to every signal-path module", () => {
    const accents = [...layout.matchAll(/accent: "(#[0-9a-f]{6})"/gi)].map((match) => match[1]);
    expect(accents).toHaveLength(9);
    expect(accents.every(isGrayHex)).toBe(true);
    expect(new Set(accents).size).toBeGreaterThan(4);
  });

  it("flashes only the powered-off control and leaves its powered-on state steady", () => {
    expect(styles).toMatch(/\.power-button:not\(\.is-on\):not\(:disabled\)\s*\{[\s\S]*?animation:\s*power-ready-flash/);
    expect(styles).toMatch(/\.power-button:not\(\.is-on\):not\(:disabled\) i\s*\{[\s\S]*?animation:\s*power-lamp-flash/);
    expect(styles).toMatch(/\.power-button\.is-on\s*\{[\s\S]*?animation:\s*none;/);
    expect(styles).toMatch(/\.power-button\.is-on i\s*\{[\s\S]*?animation:\s*none;/);
  });

  it("reserves at least 20px touch-free gutters on compact screens", () => {
    const compactStart = styles.indexOf("/* Leave a guaranteed touch-free scroll lane");
    const compact = styles.slice(compactStart, styles.indexOf("@media (hover: hover)", compactStart));
    expect(compactStart).toBeGreaterThanOrEqual(0);
    for (const selector of [".topbar", ".status-deck", "main", "footer"]) {
      const escaped = selector.replace(".", "\\.");
      expect(compact).toMatch(new RegExp(`${escaped}\\s*\\{[\\s\\S]*?padding-right:\\s*calc\\(20px \\+ env\\(safe-area-inset-right\\)\\);[\\s\\S]*?padding-left:\\s*calc\\(20px \\+ env\\(safe-area-inset-left\\)\\);`));
    }
  });
});
