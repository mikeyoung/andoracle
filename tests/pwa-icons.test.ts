import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";

const publicPath = (...parts: string[]): string => resolve("public", ...parts);

const pngSignatureLength = 8;

const paeth = (left: number, up: number, upperLeft: number): number => {
  const estimate = left + up - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  if (leftDistance <= upDistance && leftDistance <= upperLeftDistance) return left;
  return upDistance <= upperLeftDistance ? up : upperLeft;
};

const readRgbPixels = (fileName: string): { width: number; height: number; pixels: Uint8Array } => {
  const png = readFileSync(publicPath(fileName));
  const idat: Buffer[] = [];
  let width = 0;
  let height = 0;
  for (let offset = pngSignatureLength; offset + 12 <= png.length;) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
    } else if (type === "IDAT") idat.push(data);
    offset += length + 12;
    if (type === "IEND") break;
  }

  const channels = 3;
  const stride = width * channels;
  const filtered = inflateSync(Buffer.concat(idat));
  const pixels = new Uint8Array(width * height * channels);
  let prior = new Uint8Array(stride);
  for (let y = 0; y < height; y += 1) {
    const filteredOffset = y * (stride + 1);
    const filter = filtered[filteredOffset];
    const row = new Uint8Array(stride);
    for (let x = 0; x < stride; x += 1) {
      const encoded = filtered[filteredOffset + 1 + x];
      const left = x >= channels ? row[x - channels] : 0;
      const up = prior[x];
      const upperLeft = x >= channels ? prior[x - channels] : 0;
      const predictor = filter === 1
        ? left
        : filter === 2
          ? up
          : filter === 3
            ? Math.floor((left + up) / 2)
            : filter === 4
              ? paeth(left, up, upperLeft)
              : 0;
      row[x] = (encoded + predictor) & 0xff;
    }
    pixels.set(row, y * stride);
    prior = row;
  }
  return { width, height, pixels };
};

const pixelAt = (
  image: ReturnType<typeof readRgbPixels>,
  x: number,
  y: number,
): readonly [number, number, number] => {
  const offset = (y * image.width + x) * 3;
  return [image.pixels[offset], image.pixels[offset + 1], image.pixels[offset + 2]];
};

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

  it("keeps contiguous retro sawtooth bands without dark gutters or spectral flag order", () => {
    const master = readRgbPixels("icon-master-512.png");
    let minimumRgbSum = Number.POSITIVE_INFINITY;
    for (let index = 0; index < master.pixels.length; index += 3) {
      minimumRgbSum = Math.min(
        minimumRgbSum,
        master.pixels[index] + master.pixels[index + 1] + master.pixels[index + 2],
      );
    }
    expect(minimumRgbSum).toBeGreaterThan(100);

    const [ochre, teal, sienna, olive, plum, cream] = [30, 120, 210, 310, 410, 490]
      .map((y) => pixelAt(master, 4, y));
    expect(ochre[0]).toBeGreaterThan(ochre[1]);
    expect(ochre[1]).toBeGreaterThan(ochre[2]);
    expect(teal[1]).toBeGreaterThan(teal[0] + 25);
    expect(teal[2]).toBeGreaterThan(teal[0] + 25);
    expect(sienna[0]).toBeGreaterThan(sienna[1] * 2);
    expect(olive[1]).toBeGreaterThan(olive[0]);
    expect(olive[2]).toBeLessThan(olive[0] / 2);
    expect(plum[0]).toBeGreaterThan(plum[1]);
    expect(plum[2]).toBeGreaterThan(plum[1]);
    expect(cream.every((channel) => channel > 140)).toBe(true);
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
