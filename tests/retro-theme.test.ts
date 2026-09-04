import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function readJpegDimensions(bytes: Buffer): { width: number; height: number } {
  expect(bytes[0]).toBe(0xff);
  expect(bytes[1]).toBe(0xd8);

  let offset = 2;
  const startOfFrameMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

  while (offset + 8 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }

    const marker = bytes[offset + 1];
    if (startOfFrameMarkers.has(marker)) {
      return {
        height: bytes.readUInt16BE(offset + 5),
        width: bytes.readUInt16BE(offset + 7),
      };
    }

    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }

    const segmentLength = bytes.readUInt16BE(offset + 2);
    expect(segmentLength).toBeGreaterThanOrEqual(2);
    offset += segmentLength + 2;
  }

  throw new Error("JPEG dimensions were not found");
}

describe("1960s instrument finish", () => {
  it("ships a compact square walnut veneer texture as a bundled CSS asset", () => {
    const texturePath = resolve("src/assets/walnut-veneer-60s.jpg");
    const dimensions = readJpegDimensions(readFileSync(texturePath));

    expect(dimensions).toEqual({ width: 768, height: 768 });
    expect(statSync(texturePath).size).toBeLessThan(150_000);

    const styles = readFileSync(resolve("src/styles.css"), "utf8");
    expect(styles).toContain('url("./assets/walnut-veneer-60s.jpg")');
    expect(styles).not.toContain("background-attachment: fixed");
    expect(styles).not.toContain("backdrop-filter");
  });

  it("uses period cabinet, enamel, metal, and Bakelite treatments without changing control geometry", () => {
    const styles = readFileSync(resolve("src/styles.css"), "utf8");

    expect(styles).toContain("--ivory-panel: #d9d3bd");
    expect(styles).toContain("--sage: #5b6158");
    expect(styles).toContain("--walnut: #3b2215");
    expect(styles).toContain("--teal: #47746e");
    expect(styles).toMatch(/\.module\s*\{[\s\S]*?radial-gradient\(circle at 8px 8px,[\s\S]*?var\(--ivory-panel\)/);
    expect(styles).toMatch(/\.fader-shell input\[type="range"\]::\-webkit-slider-thumb\s*\{[\s\S]*?width:\s*34px;[\s\S]*?transform:\s*translateX\(\-14px\);/);
    expect(styles).toMatch(/\.piano-key--black\s*\{[\s\S]*?min-width:\s*24px;/);
    expect(styles).toContain("@media (forced-colors: active)");
  });

  it("keeps the texture available offline and aligns browser chrome with the cabinet", () => {
    const viteConfig = readFileSync(resolve("vite.config.ts"), "utf8");
    const html = readFileSync(resolve("index.html"), "utf8");

    expect(viteConfig).toContain("jpg,jpeg");
    expect(viteConfig).toContain('theme_color: "#50564f"');
    expect(viteConfig).toContain('background_color: "#24150e"');
    expect(html).toContain('<meta name="theme-color" content="#50564f" />');
  });

  it("assigns muted functional colors to every signal-path module", () => {
    const layout = readFileSync(resolve("src/ui/layout.ts"), "utf8");
    const accents = [...layout.matchAll(/accent: "(#[0-9a-f]{6})"/gi)].map((match) => match[1]);

    expect(accents).toEqual([
      "#a85b36",
      "#b58a32",
      "#91453b",
      "#6f7750",
      "#8c4038",
      "#47746e",
      "#aa7535",
      "#9a5538",
      "#8a805f",
    ]);
  });
});
