import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  ChoiceControl,
  RangeControl,
  ToggleControl,
} from "../src/components/ParameterControls";

const consoleStylesPath = resolve("src/console-1968.css");
const consoleStyles = readFileSync(consoleStylesPath, "utf8");
const baseStyles = readFileSync(resolve("src/styles.css"), "utf8");
const consoleAssetRoot = resolve("src/assets/console");
const outputMeterSource = readFileSync(resolve("src/components/OutputMeter.tsx"), "utf8");

const requiredRasterAssets = [
  { path: "black-walnut-seamless.webp", alpha: false },
  { path: "panel-blank-photo.png", alpha: true },
  { path: "button-phenolic-up.png", alpha: true },
  { path: "button-phenolic-square.png", alpha: true },
  { path: "selector-arrow-photo.png", alpha: true },
  { path: "dial-scale-photo.png", alpha: true },
  { path: "key-white-photo.png", alpha: true },
  { path: "key-white-photo-b.png", alpha: true },
  { path: "key-black-photo.png", alpha: true },
  { path: "enamel-white.webp", alpha: false },
  { path: "phenolic-black.webp", alpha: false },
  { path: "knob-ivory.png", alpha: true },
  { path: "screw-nickel.png", alpha: true },
  { path: "switches/switch-delay-go.png", alpha: true },
  { path: "switches/switch-delay-stop.png", alpha: true },
  { path: "switches/switch-power-go.png", alpha: true },
  { path: "switches/switch-power-stop.png", alpha: true },
  { path: "switches/switch-synth-go.png", alpha: true },
  { path: "switches/switch-synth-stop.png", alpha: true },
  { path: "switches/switch-tapes-go.png", alpha: true },
  { path: "switches/switch-tapes-stop.png", alpha: true },
] as const;

const cssUrls = (source: string): readonly string[] => [
  ...source.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/giu),
].map((match) => match[1]);

const pngDimensions = (bytes: Buffer): readonly [number, number] => {
  expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
};

describe("photographic raster skin contract", () => {
  it("keeps the Chaotic Sound Effects VU faces byte-exact and layered at their native ratio", () => {
    const vuFaces = [
      ["vu-meter-face.png", "35ED4835FB28607A3A3DB44FF091C9C6423F455582E84F6532FEAA8FBD65F88F"],
      ["vu-meter-face-off.png", "E6CA3F78E35FED57014ECC7A5DF558F816C36F6DE9F9E63AF1FE75C14F34030F"],
    ] as const;

    for (const [name, expectedHash] of vuFaces) {
      const bytes = readFileSync(resolve(consoleAssetRoot, name));
      expect(pngDimensions(bytes), name).toEqual([698, 260]);
      expect(createHash("sha256").update(bytes).digest("hex").toUpperCase(), name).toBe(expectedHash);
      expect(outputMeterSource, name).toContain(`../assets/console/${name}`);
    }

    expect(consoleStyles).toMatch(/\.output-vu-meter\s*\{[\s\S]*?aspect-ratio:\s*698 \/ 260;/u);
    expect(consoleStyles).toMatch(/\.output-vu-meter__face,[\s\S]*?\.output-vu-meter__needles\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?inset:\s*0;/u);
    expect(outputMeterSource).toContain("OUTPUT_VU_METER_CANVAS_WIDTH = 698");
    expect(outputMeterSource).toContain("OUTPUT_VU_METER_CANVAS_HEIGHT = 260");
  });

  it("keeps every required photographic surface local, decodable, and within the offline cache budget", () => {
    for (const asset of requiredRasterAssets) {
      const path = resolve(consoleAssetRoot, asset.path);
      expect(existsSync(path), asset.path).toBe(true);
      const bytes = readFileSync(path);
      expect(bytes.byteLength, asset.path).toBeGreaterThan(10_000);
      expect(bytes.byteLength, asset.path).toBeLessThanOrEqual(4 * 1024 * 1024);

      if (asset.path.endsWith(".webp")) {
        expect(bytes.subarray(0, 4).toString("ascii"), asset.path).toBe("RIFF");
        expect(bytes.subarray(8, 12).toString("ascii"), asset.path).toBe("WEBP");
      } else {
        const [width, height] = pngDimensions(bytes);
        expect(width, asset.path).toBeGreaterThanOrEqual(256);
        expect(height, asset.path).toBeGreaterThanOrEqual(256);
        // RGBA preserves the photographed silhouettes instead of baking them
        // into rectangular UI plates.
        if (asset.alpha) expect(bytes[25], asset.path).toBe(6);
      }
    }
  });

  it("allows only package-local image references and resolves every CSS asset", () => {
    const references = cssUrls(consoleStyles);
    expect(references.length).toBeGreaterThan(0);

    for (const reference of references) {
      expect(reference, reference).not.toMatch(/^(?:[a-z][a-z\d+.-]*:|\/|#)/iu);
      const resolved = resolve(dirname(consoleStylesPath), reference);
      expect(existsSync(resolved), reference).toBe(true);
      const relativeAssetPath = relative(consoleAssetRoot, resolved);
      expect(relativeAssetPath.startsWith(".."), reference).toBe(false);
      expect(isAbsolute(relativeAssetPath), reference).toBe(false);
    }

    for (const asset of requiredRasterAssets) {
      expect(references).toContain(`./assets/console/${asset.path}`);
    }
  });

  it("does not replace photographic controls with perspective or pixel-art CSS", () => {
    expect(consoleStyles).not.toMatch(/\bperspective\s*:/iu);
    expect(consoleStyles).not.toMatch(/\b(?:rotate[xy3d]|skew[xy]?|matrix3d)\s*\(/iu);
    expect(consoleStyles).not.toMatch(/image-rendering\s*:\s*(?:pixelated|crisp-edges)/iu);
    expect(consoleStyles).toMatch(/\.dial-face\s*\{[\s\S]*?background-image:\s*url\("\.\/assets\/console\/knob-ivory\.png"\)/u);
    expect(consoleStyles).toMatch(/\.panel-screw\s*\{[\s\S]*?url\("\.\/assets\/console\/screw-nickel\.png"\)/u);
    expect(consoleStyles).toMatch(/\.toggle-switch > span:not\(\.raster-label\)::after\s*\{[\s\S]*?content:\s*none/u);
  });

  it("mounts each photographic panel plate directly on the black walnut without distorting its fasteners", () => {
    expect(consoleStyles).toMatch(/html\s*\{[\s\S]*?black-walnut-seamless\.webp[\s\S]*?background-repeat:\s*repeat;[\s\S]*?background-size:\s*1880px 1880px;/u);
    expect(consoleStyles).not.toContain("console-faceplate-photo.png");
    expect(consoleStyles).toMatch(/\.app-shell\s*\{[\s\S]*?border:\s*0;[\s\S]*?background:\s*transparent;[\s\S]*?box-shadow:\s*none/u);
    expect(consoleStyles).toMatch(/:is\([\s\S]*?\.module,[\s\S]*?\)\s*\{[\s\S]*?background-image:\s*none;/u);
    expect(consoleStyles).toMatch(/\.module::after\s*\{[\s\S]*?display:\s*none/u);
    expect(consoleStyles).toMatch(/border-image-source:\s*url\("\.\/assets\/console\/panel-blank-photo\.png"\);[\s\S]*?border-image-slice:\s*150 fill;[\s\S]*?border-image-repeat:\s*stretch/u);
    expect(consoleStyles).toMatch(/\.panel-screws\s*\{[\s\S]*?display:\s*none/u);
    expect(consoleStyles).toMatch(/\.panel-screw\s*\{[\s\S]*?width:\s*13px;[\s\S]*?height:\s*13px;[\s\S]*?aspect-ratio:\s*1;[\s\S]*?border-radius:\s*50%/u);
    expect(baseStyles).toMatch(/\.panel-screw--top-left\s*\{[\s\S]*?top:\s*var\(--panel-screw-offset\);[\s\S]*?left:\s*var\(--panel-screw-offset\);/u);
    expect(baseStyles).toMatch(/\.panel-screw--bottom-right\s*\{[\s\S]*?right:\s*var\(--panel-screw-offset\);[\s\S]*?bottom:\s*var\(--panel-screw-offset\);/u);
    expect(consoleStyles).toMatch(/\.dial-shell::before\s*\{[\s\S]*?display:\s*none/u);
    expect(consoleStyles).toMatch(/\.dial-scale\s*\{[\s\S]*?dial-scale-photo\.png/u);
    expect(consoleStyles).toMatch(/\.button,[\s\S]*?button-phenolic-up\.png/u);
    expect(consoleStyles).toMatch(/\.piano-key--white,[\s\S]*?key-white-photo\.png/u);
    expect(consoleStyles).toMatch(/\.piano-key--black,[\s\S]*?key-black-photo\.png/u);
  });

  it("keeps the raster skin above native, operable parameter controls", () => {
    const shared = {
      accent: "#777",
      onChange: vi.fn(),
      onDirectEdit: vi.fn(),
    };
    const range = renderToStaticMarkup(createElement(RangeControl, {
      ...shared,
      param: "masterVolume",
      value: 0.5,
    }));
    const choice = renderToStaticMarkup(createElement(ChoiceControl, {
      ...shared,
      param: "vco1Mode",
      value: 1,
    }));
    const toggle = renderToStaticMarkup(createElement(ToggleControl, {
      ...shared,
      param: "autoRun",
      value: 1,
    }));

    expect(range).toContain('type="range"');
    expect(range).toContain('aria-orientation="vertical"');
    expect(range).toContain('aria-describedby="param-masterVolume-range"');
    expect(range).toContain('<output for="param-masterVolume">');
    expect(range).toContain('class="dial-face" aria-hidden="true"');

    expect(choice).toContain('<button type="button" class="choice-button"');
    expect(choice).toContain('aria-label="VCO 1 range: Audio / keyboard on"');

    expect(toggle).toContain('<button type="button" class="toggle-switch"');
    expect(toggle).toContain('role="switch"');
    expect(toggle).toContain('aria-checked="true"');
    expect(toggle).toContain('aria-labelledby="label-autoRun"');
  });
});
