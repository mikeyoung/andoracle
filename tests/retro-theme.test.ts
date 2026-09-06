import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const styles = readFileSync(resolve("src/styles.css"), "utf8");
const app = readFileSync(resolve("src/App.tsx"), "utf8");
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
    expect(styles).toMatch(/\.midi-strip\s*\{[\s\S]*?var\(--ivory-raised\)[\s\S]*?var\(--ivory-panel\)/);
    expect(styles).toMatch(/\.keyboard-module\s*\{[\s\S]*?background:[\s\S]*?radial-gradient[\s\S]*?linear-gradient/);
  });

  it("keeps bright off-white modules, dark legible text, and period hardware geometry", () => {
    expect(styles).toContain("--ivory-panel: #e9e9e9");
    expect(styles).toContain("--ivory-raised: #f7f7f7");
    expect(styles).toMatch(/\.topbar\s*\{[\s\S]*?linear-gradient\(180deg, #eeeeee, #d4d4d4 58%, #b9b9b9\)/);
    expect(styles).toMatch(/\.module-header\s*\{[\s\S]*?linear-gradient\(180deg, #f0f0f0, #d6d6d6\)/);
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
    expect(styles).toMatch(/\.power-switch\[aria-checked="false"\]:not\(:disabled\)\s*\{[\s\S]*?animation:\s*power-ready-flash/);
    expect(styles).toMatch(/\.power-switch\[aria-checked="false"\]:not\(:disabled\) span::after\s*\{[\s\S]*?animation:\s*power-switch-actuator-flash/);
    expect(styles).toMatch(/\.power-switch\[aria-checked="true"\],[\s\S]*?\.power-switch\[aria-checked="true"\] span::after\s*\{[\s\S]*?animation:\s*none;/);
  });

  it("uses the module switch component with a horizontal left-off/right-on power orientation", () => {
    const toggleStart = styles.indexOf(".toggle-switch {");
    const toggleSwitch = styles.slice(toggleStart, styles.indexOf(".route-control", toggleStart));
    expect(toggleSwitch).toMatch(/width:\s*58px;/);
    expect(toggleSwitch).toMatch(/min-height:\s*86px;/);
    expect(toggleSwitch).toMatch(/\.toggle-switch span::after\s*\{[\s\S]*?left:\s*50%;[\s\S]*?width:\s*16px;[\s\S]*?height:\s*18px;/);
    expect(toggleSwitch).toMatch(/\.power-switch\s*\{[\s\S]*?width:\s*122px;[\s\S]*?min-height:\s*38px;[\s\S]*?flex-direction:\s*row;[\s\S]*?margin-top:\s*0;/);
    expect(toggleSwitch).toMatch(/\.power-switch span\s*\{[\s\S]*?width:\s*45px;[\s\S]*?height:\s*24px;/);
    expect(toggleSwitch).toMatch(/\.power-switch span::after\s*\{[\s\S]*?left:\s*3px;[\s\S]*?transform:\s*translateY\(-50%\);/);
    expect(toggleSwitch).toMatch(/\.power-switch\[aria-checked="true"\] span::after\s*\{[\s\S]*?transform:\s*translate\(21px, -50%\);/);
    expect(app).toContain('aria-label={externalInputBusy');
    expect(app).toContain('className="toggle-switch power-switch"');
    expect(app).toContain('role="switch"');
    expect(app).toContain('aria-checked={powered}');
    expect(app).toMatch(/<b aria-hidden="true">OFF<\/b>[\s\S]*?<span aria-hidden="true" \/>[\s\S]*?<b aria-hidden="true">ON<\/b>/);
    expect(app).not.toContain('className="power-button');
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
