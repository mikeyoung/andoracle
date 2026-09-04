import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const publicPath = (...parts: string[]): string => resolve("public", ...parts);

const pngInfo = (fileName: string): { width: number; height: number; bitDepth: number; colorType: number } => {
  const png = readFileSync(publicPath(fileName));
  expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  expect(png.toString("ascii", 12, 16)).toBe("IHDR");
  return {
    width: png.readUInt32BE(16),
    height: png.readUInt32BE(20),
    bitDepth: png[24],
    colorType: png[25],
  };
};

const expectedPngs: Readonly<Record<string, number>> = {
  "icon-master-512.png": 512,
  "favicon-16.png": 16,
  "favicon-32.png": 32,
  "favicon-48.png": 48,
  "apple-touch-icon-152.png": 152,
  "apple-touch-icon-167.png": 167,
  "apple-touch-icon-180.png": 180,
  "apple-touch-icon.png": 180,
  "icon-72.png": 72,
  "icon-96.png": 96,
  "icon-128.png": 128,
  "icon-144.png": 144,
  "icon-152.png": 152,
  "icon-192.png": 192,
  "icon-256.png": 256,
  "icon-384.png": 384,
  "icon-512.png": 512,
  "maskable-icon-192.png": 192,
  "maskable-icon-512.png": 512,
};

describe("PWA icon assets", () => {
  it("keeps a 512px opaque master and every derived PNG at its declared square size", () => {
    for (const [fileName, size] of Object.entries(expectedPngs)) {
      expect(pngInfo(fileName), fileName).toEqual({ width: size, height: size, bitDepth: 8, colorType: 2 });
    }
    expect(readFileSync(publicPath("icon-512.png"))).toEqual(readFileSync(publicPath("icon-master-512.png")));
    expect(readFileSync(publicPath("maskable-icon-512.png"))).toEqual(readFileSync(publicPath("icon-master-512.png")));
  });

  it("provides a favicon container with 16px, 32px, and 48px frames", () => {
    const ico = readFileSync(publicPath("favicon.ico"));
    expect(ico.readUInt16LE(0)).toBe(0);
    expect(ico.readUInt16LE(2)).toBe(1);
    expect(ico.readUInt16LE(4)).toBe(3);
    expect([ico[6], ico[22], ico[38]]).toEqual([16, 32, 48]);
  });

  it("references general, maskable, Apple, and favicon assets from app metadata", () => {
    const viteConfig = readFileSync(resolve("vite.config.ts"), "utf8");
    const html = readFileSync(resolve("index.html"), "utf8");
    for (const size of [72, 96, 128, 144, 152, 192, 256, 384, 512]) {
      expect(viteConfig).toContain(`icon-${size}.png`);
    }
    expect(viteConfig).toContain("maskable-icon-192.png");
    expect(viteConfig).toContain("maskable-icon-512.png");
    for (const fileName of [
      "favicon.ico",
      "favicon-16.png",
      "favicon-32.png",
      "favicon-48.png",
      "apple-touch-icon-152.png",
      "apple-touch-icon-167.png",
      "apple-touch-icon.png",
    ]) expect(html).toContain(fileName);
  });
});
