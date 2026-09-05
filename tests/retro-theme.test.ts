import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

const paeth = (left: number, up: number, upperLeft: number): number => {
  const estimate = left + up - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  if (leftDistance <= upDistance && leftDistance <= upperLeftDistance) return left;
  return upDistance <= upperLeftDistance ? up : upperLeft;
};

function decodeRgbPng(bytes: Buffer): { width: number; height: number; pixels: Buffer } {
  if (!bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) throw new Error("Texture is not a PNG file.");
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const imageData: Buffer[] = [];

  for (let offset = PNG_SIGNATURE.length; offset + 12 <= bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === "IDAT") imageData.push(data);
    offset += length + 12;
    if (type === "IEND") break;
  }

  if (bitDepth !== 8 || colorType !== 2 || interlace !== 0) {
    throw new Error("Texture must be a non-interlaced, opaque 8-bit RGB PNG.");
  }

  const channels = 3;
  const stride = width * channels;
  const filtered = inflateSync(Buffer.concat(imageData));
  if (filtered.length !== (stride + 1) * height) throw new Error("Texture pixel data is incomplete.");
  const pixels = Buffer.alloc(width * height * channels);
  let prior = Buffer.alloc(stride);

  for (let y = 0; y < height; y += 1) {
    const filteredOffset = y * (stride + 1);
    const filter = filtered[filteredOffset];
    const row = Buffer.alloc(stride);
    for (let x = 0; x < stride; x += 1) {
      const encoded = filtered[filteredOffset + 1 + x];
      const left = x >= channels ? row[x - channels] : 0;
      const up = prior[x];
      const upperLeft = x >= channels ? prior[x - channels] : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      else if (filter === 2) predictor = up;
      else if (filter === 3) predictor = Math.floor((left + up) / 2);
      else if (filter === 4) predictor = paeth(left, up, upperLeft);
      else if (filter !== 0) throw new Error(`Unsupported PNG row filter ${filter}.`);
      row[x] = (encoded + predictor) & 0xff;
    }
    row.copy(pixels, y * stride);
    prior = row;
  }

  return { width, height, pixels };
}

function assertFourWayMirror(width: number, height: number, pixels: Buffer): void {
  const halfWidth = width / 2;
  const halfHeight = height / 2;
  const offset = (x: number, y: number): number => (y * width + x) * 3;
  for (let y = 0; y < halfHeight; y += 1) {
    for (let x = 0; x < halfWidth; x += 1) {
      const source = offset(x, y);
      const reflected = [
        offset(width - 1 - x, y),
        offset(x, height - 1 - y),
        offset(width - 1 - x, height - 1 - y),
      ];
      for (const target of reflected) {
        if (
          pixels[source] !== pixels[target]
          || pixels[source + 1] !== pixels[target + 1]
          || pixels[source + 2] !== pixels[target + 2]
        ) throw new Error(`Texture mirror mismatch at ${x},${y}.`);
      }
    }
  }
}

describe("1960s instrument finish", () => {
  it("ships an exact four-way mirrored seamless walnut texture at the original scale", () => {
    const sourcePath = resolve("src/assets/walnut-veneer-60s.jpg");
    const texturePath = resolve("src/assets/walnut-veneer-60s-seamless.png");
    const source = readFileSync(sourcePath);
    const texture = decodeRgbPng(readFileSync(texturePath));

    expect(createHash("sha256").update(source).digest("hex")).toBe("1e1bbd9dc2ab253884e828d1e230b2c0212aa5dbb17b4b57fa05d4d7a6e75c79");
    expect({ width: texture.width, height: texture.height }).toEqual({ width: 1536, height: 1536 });
    expect(statSync(texturePath).size).toBeLessThan(2.5 * 1024 * 1024);
    const topLeft = Buffer.alloc(768 * 768 * 3);
    for (let y = 0; y < 768; y += 1) {
      texture.pixels.copy(topLeft, y * 768 * 3, y * texture.width * 3, (y * texture.width + 768) * 3);
    }
    expect(createHash("sha256").update(topLeft).digest("hex")).toBe("95a0d241c80ea8f819f3fde2ebbf4b206153356a9626f2a7764334731d26c3b5");
    expect(createHash("sha256").update(texture.pixels).digest("hex")).toBe("01f57d919d2364f7154221055c14fa185b89e6fb613904d370fe5998211f8c07");
    assertFourWayMirror(texture.width, texture.height, texture.pixels);

    const styles = readFileSync(resolve("src/styles.css"), "utf8");
    expect(styles.match(/url\("\.\/assets\/walnut-veneer-60s-seamless\.png"\)/g)).toHaveLength(2);
    expect(styles).toContain('url("./assets/walnut-veneer-60s-seamless.png") center top / 1536px 1536px repeat');
    expect(styles).toContain('url("./assets/walnut-veneer-60s-seamless.png") center / 1536px 1536px repeat');
    expect(styles).not.toContain('url("./assets/walnut-veneer-60s.jpg")');
    expect(styles).not.toContain("background-attachment: fixed");
    expect(styles).not.toContain("backdrop-filter");
  });

  it("uses period cabinet, enamel, metal, and Bakelite treatments without changing control geometry", () => {
    const styles = readFileSync(resolve("src/styles.css"), "utf8");

    expect(styles).toContain("--ivory-panel: #d9d3bd");
    expect(styles).toContain("--sage: #5b6158");
    expect(styles).toContain("--walnut: #3b2215");
    expect(styles).toContain("--teal: #47746e");
    expect(styles).toMatch(/\.module\s*\{[\s\S]*?isolation:\s*isolate;[\s\S]*?var\(--ivory-panel\)/);
    expect(styles).toMatch(/\.panel-screw\s*\{[\s\S]*?border-radius:\s*50%;[\s\S]*?radial-gradient\(circle at 34% 28%,/);
    expect(styles).toMatch(/\.fader-shell input\[type="range"\]::\-webkit-slider-thumb\s*\{[\s\S]*?width:\s*34px;[\s\S]*?transform:\s*translateX\(\-14px\);/);
    expect(styles).toMatch(/\.piano-key--black\s*\{[\s\S]*?min-width:\s*0;[\s\S]*?height:\s*139px;/);
    expect(styles).toContain("@media (forced-colors: active)");
  });

  it("keeps the texture available offline and aligns browser chrome with the cabinet", () => {
    const viteConfig = readFileSync(resolve("vite.config.ts"), "utf8");
    const html = readFileSync(resolve("index.html"), "utf8");

    expect(viteConfig).toContain("png,jpg,jpeg");
    expect(viteConfig).toContain("maximumFileSizeToCacheInBytes: 4 * 1024 * 1024");
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
