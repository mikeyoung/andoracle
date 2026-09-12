import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { photoSwitchVariantForParam } from "../src/components/ParameterControls";
import { PARAM_KEYS, PARAM_SPECS } from "../src/synth/params";

const baseStyles = readFileSync(resolve("src/styles.css"), "utf8");
const consoleStyles = readFileSync(resolve("src/console-1968.css"), "utf8");
const rasterLabel = readFileSync(resolve("src/components/RasterLabel.tsx"), "utf8");
const app = readFileSync(resolve("src/App.tsx"), "utf8");
const externalInput = readFileSync(resolve("src/components/ExternalInputControl.tsx"), "utf8");
const photoSwitchHardware = readFileSync(resolve("src/components/PhotoSwitchHardware.tsx"), "utf8");
const main = readFileSync(resolve("src/main.tsx"), "utf8");
const html = readFileSync(resolve("index.html"), "utf8");
const viteConfig = readFileSync(resolve("vite.config.ts"), "utf8");

const CHAOTIC_SWITCH_HASHES = {
  "switch-delay-go.png": "0B782419242FD386042DD2C80B9F1FAA084A2D17BEFAA6F45A7F9585FFC90EE0",
  "switch-delay-stop.png": "AFC68E8575F984C74C368774EDB21E20F10EB50872C6A7A330AA7704621F7B6E",
  "switch-power-go.png": "9392B4C7501994D4D4DBD82A57838A2ADE32E14A6D3492AD7944DEE7E432A9DC",
  "switch-power-stop.png": "B7C43E3331A69249979B2410325EAB99F93FFB147EBD78D864C9C9F77F90DCDF",
  "switch-synth-go.png": "F0974F35BA149F136FAEFD7822B3106D5648703E9EA78A5315A74BC219FE3097",
  "switch-synth-stop.png": "09A74C82B8283328122E6B4F858480924C8444307247304E1BDD8D3345342431",
  "switch-tapes-go.png": "6FFFF70257B0AE60A873F2538B72EBBD81A8A3B4D786942AF63F268D2EFC3C3D",
  "switch-tapes-stop.png": "BB2185ACF62060D7099BA4785E034999A8D842B67218F414F3E040EF34AF0962",
} as const;

const pngDimensions = (bytes: Buffer): readonly [number, number] => {
  expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
};

describe("late-1960s photographic console finish", () => {
  it("loads the fixed-console skin after the functional base stylesheet", () => {
    const baseImport = main.indexOf('import "./styles.css"');
    const consoleImport = main.indexOf('import "./console-1968.css"');

    expect(baseImport).toBeGreaterThanOrEqual(0);
    expect(consoleImport).toBeGreaterThan(baseImport);
    expect(consoleStyles).toContain("Andoracle 1968 console skin");
  });

  it("builds the direct-mounted plates and controls from generated photographic raster surfaces", () => {
    for (const asset of [
      "black-walnut-seamless.webp",
      "enamel-white.webp",
      "phenolic-black.webp",
      "knob-ivory.png",
      "screw-nickel.png",
    ]) {
      expect(readFileSync(resolve("src/assets/console", asset)).byteLength).toBeGreaterThan(10_000);
      expect(consoleStyles).toContain(`url("./assets/console/${asset}")`);
    }

    expect(consoleStyles).toContain("--console-enamel: #eee9da");
    expect(consoleStyles).toMatch(/html\s*\{[\s\S]*?background-image:\s*url\("\.\/assets\/console\/black-walnut-seamless\.webp"\);/);
    expect(consoleStyles).toMatch(/\.app-shell\s*\{[\s\S]*?background:\s*transparent;/);
    expect(consoleStyles).not.toContain("console-faceplate-photo.png");
    expect(consoleStyles).toMatch(/\.module\s*\{[\s\S]*?background-color:\s*var\(--console-enamel\);/);
    expect(consoleStyles).toMatch(/\.keyboard-module\s*\{[\s\S]*?background-color:\s*var\(--console-well\);/);
    expect(consoleStyles).not.toContain("backdrop-filter");
  });

  it("retains every exact high-resolution Chaotic Sound Effects switch state", () => {
    for (const [fileName, expectedHash] of Object.entries(CHAOTIC_SWITCH_HASHES)) {
      const path = resolve("src/assets/console/switches", fileName);
      const bytes = readFileSync(path);
      const hash = createHash("sha256").update(bytes).digest("hex").toUpperCase();

      expect(basename(path)).toBe(fileName);
      expect(pngDimensions(bytes)).toEqual([552, 576]);
      expect(hash).toBe(expectedHash);
    }
  });

  it("maps all four photographic variants to distinct off and on states", () => {
    for (const variant of ["power", "tapes", "synth", "delay"] as const) {
      expect(consoleStyles).toContain(
        `url("./assets/console/switches/switch-${variant}-stop.png")`,
      );
      expect(consoleStyles).toContain(
        `url("./assets/console/switches/switch-${variant}-go.png")`,
      );
    }

    const toggleParams = PARAM_KEYS.filter((param) => PARAM_SPECS[param].control === "toggle");
    const assignedVariants = toggleParams.map(photoSwitchVariantForParam);
    expect(toggleParams.length).toBeGreaterThan(0);
    expect(assignedVariants.every((variant) => ["tapes", "synth", "delay"].includes(variant))).toBe(true);
    expect(new Set(assignedVariants).size).toBeGreaterThan(1);
    expect(app).toContain('data-switch-variant="power"');
    expect(externalInput).toContain('data-switch-variant="power"');
  });

  it("rotates the complete smooth overhead 1960s knob raster as one control", () => {
    const knob = readFileSync(resolve("src/assets/console/knob-ivory.png"));
    expect(pngDimensions(knob)).toEqual([1254, 1254]);
    expect(createHash("sha256").update(knob).digest("hex")).toBe(
      "93acfb1d5e7940399582c276d01344872760448c85a14f79b87e5203ecafb4d6",
    );
    expect(consoleStyles).toMatch(/\.dial-face\s*\{[\s\S]*?background-image:\s*url\("\.\/assets\/console\/knob-ivory\.png"\);[\s\S]*?transform:\s*rotate\(var\(--dial-angle\)\);/);
    expect(consoleStyles).toMatch(/\.dial-face i\s*\{[\s\S]*?display:\s*none;/);
    expect(consoleStyles).toMatch(/\.dial-shell input\[type="range"\]\s*\{[\s\S]*?opacity:\s*0;/);
  });

  it("flashes only the photographic power lever while off", () => {
    expect(consoleStyles).toMatch(/@keyframes console-power-ready-flash\s*\{/);
    expect(consoleStyles).toMatch(/brightness\(0\.8325\)[\s\S]*?brightness\(1\.4985\)/);
    expect(consoleStyles).toMatch(/\.power-switch\[aria-checked="false"\]:not\(:disabled\) > span:not\(\.raster-label\)\s*\{[\s\S]*?animation:\s*console-power-ready-flash 1\.6s/);
    expect(consoleStyles).toMatch(/\.power-switch\[aria-checked="true"\],[\s\S]*?animation:\s*none;/);
    expect(photoSwitchHardware).toContain('variant: PhotoSwitchVariant');
    expect(app).toContain('<PhotoSwitchHardware variant="power" enabled={powered} />');
  });

  it("lightens every photographic switch by exactly eleven percent", () => {
    expect(consoleStyles).toMatch(
      /\.toggle-switch > span:not\(\.raster-label\),\s*\.external-input-button i\s*\{[\s\S]*?1\.12 × 1\.11 = 1\.2432[\s\S]*?filter:\s*brightness\(1\.2432\);/,
    );
  });

  it("keeps photographed button geometry intact in every hover state", () => {
    expect(consoleStyles).toMatch(
      /\.button:hover,\s*\.choice-button:hover,\s*\.ppc-pad:hover\s*\{[\s\S]*?background:\s*transparent url\("\.\/assets\/console\/button-phenolic-up\.png"\) center \/ 100% 100% no-repeat;[\s\S]*?filter:\s*brightness\(1\.08\);/,
    );
  });

  it("keeps busy and unsupported MIDI modal actions visually disabled", () => {
    expect(consoleStyles).toMatch(
      /\.midi-dialog\[aria-busy="true"\] \.button\[aria-disabled="true"\]\s*\{[\s\S]*?cursor:\s*wait;[\s\S]*?filter:\s*grayscale\(1\) brightness\(0\.84\);[\s\S]*?opacity:\s*0\.46;/,
    );
    expect(consoleStyles).toMatch(/\.midi-dialog \.button:disabled\s*\{[\s\S]*?cursor:\s*not-allowed;/);
    expect(consoleStyles).toMatch(/\.midi-dialog__status\.control-error\s*\{[\s\S]*?font-weight:\s*700;/);
    expect(consoleStyles).toMatch(/\.midi-dialog h2:focus\s*\{[\s\S]*?outline:\s*none;/);
  });

  it("keeps semantic system labels available over the photographic rendering", () => {
    expect(rasterLabel).toContain('<span className="raster-label__text">{text}</span>');
    expect(rasterLabel).not.toContain("<canvas");
    expect(rasterLabel).not.toContain("visually-hidden");
    expect(consoleStyles).toMatch(/\.raster-label__text\s*\{[\s\S]*?text-transform:\s*uppercase;[\s\S]*?white-space:\s*normal;/);
    expect(consoleStyles).toMatch(/\.raster-label,[\s\S]*?overflow:\s*visible;[\s\S]*?color:\s*var\(--console-ink\);/);
  });

  it("keeps browser chrome and install surfaces coordinated with the console", () => {
    expect(viteConfig).toContain('theme_color: "#4a2c1c"');
    expect(viteConfig).toContain('background_color: "#4a2c1c"');
    expect(html).toContain('<meta name="theme-color" content="#4a2c1c" />');
    expect(html).toContain('<meta name="color-scheme" content="light" />');
    expect(baseStyles).not.toContain("@media (forced-colors: active)");
    expect(consoleStyles).not.toContain("@media (forced-colors: active)");
  });
});
