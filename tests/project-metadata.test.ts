import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ANDORACLE_VERSION } from "../vite.config";

const DESCRIPTION = "Andoracle is an offline-capable, touch-first duophonic synthesizer PWA that recreates the ARP Odyssey signal flow with MIDI, note sequencing, delay, and patch sharing.";
const SITE_URL = "https://mikeyoung.org/andoracle/";
const SOCIAL_IMAGE_URL = `${SITE_URL}icon-512.png`;

const readProjectFile = (fileName: string): string => readFileSync(resolve(fileName), "utf8");

describe("Andoracle project metadata", () => {
  it("describes the application and its technology in package metadata", () => {
    const packageJson = JSON.parse(readProjectFile("package.json")) as {
      name: string;
      version: string;
      description: string;
      keywords: string[];
    };

    expect(packageJson.name).toBe("andoracle");
    expect(packageJson.version).toBe(ANDORACLE_VERSION);
    expect(packageJson.version).toMatch(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/);
    expect(packageJson.description).toBe(DESCRIPTION);
    expect(packageJson.keywords).toEqual(expect.arrayContaining([
      "synthesizer",
      "duophonic",
      "web-audio",
      "web-midi",
      "music-sequencer",
      "pwa",
      "arp-odyssey",
    ]));
  });

  it("provides standard, social, and structured metadata in the document head", () => {
    const html = readProjectFile("index.html");

    expect(html).toContain(`<meta name="description" content="${DESCRIPTION}" />`);
    expect(html).toContain('<meta name="application-version" content="%VITE_APP_VERSION%" />');
    expect(html).toContain(`<meta property="og:description" content="${DESCRIPTION}" />`);
    expect(html).toContain(`<meta name="twitter:description" content="${DESCRIPTION}" />`);
    expect(html).toContain('<meta property="og:type" content="website" />');
    expect(html).toContain('<meta name="twitter:card" content="summary" />');
    expect(html).toContain(`<link rel="canonical" href="${SITE_URL}" />`);
    expect(html).toContain(`<meta property="og:url" content="${SITE_URL}" />`);
    expect(html).toContain(`<meta property="og:image" content="${SOCIAL_IMAGE_URL}" />`);
    expect(html).toContain(`<meta name="twitter:image" content="${SOCIAL_IMAGE_URL}" />`);
    expect(html).toContain("<title>Andoracle — ARP Odyssey-Inspired Synthesizer</title>");

    const structuredMatch = html.match(/<script type="application\/ld\+json">\s*([\s\S]*?)\s*<\/script>/);
    expect(structuredMatch).not.toBeNull();
    const structured = JSON.parse(structuredMatch?.[1] ?? "{}") as Record<string, unknown>;
    expect(structured).toMatchObject({
      "@context": "https://schema.org",
      "@type": "WebApplication",
      name: "Andoracle",
      url: SITE_URL,
      image: SOCIAL_IMAGE_URL,
      description: DESCRIPTION,
      applicationCategory: "MultimediaApplication",
      operatingSystem: "Any",
      softwareVersion: "%VITE_APP_VERSION%",
      inLanguage: "en",
    });
    expect(structured.browserRequirements).toContain("44.1 kHz");
    expect(structured.featureList).toEqual(expect.arrayContaining([
      expect.stringContaining("signal flow"),
      expect.stringContaining("URL patch sharing"),
      expect.stringContaining("note sequences"),
    ]));
  });

  it("keeps install metadata aligned with the canonical application identity", () => {
    const viteConfig = readProjectFile("vite.config.ts");

    expect(viteConfig).toContain('name: "Andoracle"');
    expect(viteConfig).toContain(`description: "${DESCRIPTION}"`);
    expect(viteConfig).toContain('id: "./"');
    expect(viteConfig).toContain('lang: "en"');
    expect(viteConfig).toContain('dir: "ltr"');
    expect(viteConfig).toContain('categories: ["music", "entertainment"]');
    expect(viteConfig).toContain('"import.meta.env.VITE_APP_VERSION": JSON.stringify(ANDORACLE_VERSION)');
  });

  it("ships IIS configuration required by the deployed PWA", () => {
    const webConfig = readProjectFile("public/web.config");
    const serviceWorkerLocation = webConfig.match(
      /<location path="sw\.js">([\s\S]*?)<\/location>/,
    )?.[1] ?? "";

    expect(webConfig).toContain('<add value="index.html" />');
    expect(webConfig).toContain('<mimeMap fileExtension=".webmanifest" mimeType="application/manifest+json" />');
    expect(webConfig).toContain('<location path="sw.js">');
    expect(serviceWorkerLocation).toContain('<clientCache cacheControlMode="DisableCache" />');
    expect(serviceWorkerLocation).toContain(
      '<add name="Cache-Control" value="no-cache, no-store, must-revalidate" />',
    );
    expect(serviceWorkerLocation).toContain('<add name="Pragma" value="no-cache" />');
    expect(serviceWorkerLocation).toContain('<add name="Expires" value="0" />');
  });

  it("states the emulation boundary in the durable project documentation", () => {
    const readme = readProjectFile("README.md");
    const research = readProjectFile("docs/arp-odyssey-technical-research.md");
    const app = readProjectFile("src/App.tsx");

    expect(readme).toContain("faithful functional recreation");
    expect(readme).toContain("not component-for-component circuit simulation");
    expect(research).toContain("guides Andoracle's functional behavior and signal routing");
    expect(app).toContain("ARP Odyssey-inspired duophonic browser synthesizer");
  });

  it("keeps the documented panic control aligned with its visible UI label", () => {
    const readme = readProjectFile("README.md");
    const app = readProjectFile("src/App.tsx");

    expect(readme).toContain("Use **Panic** to release every physical note");
    expect(readme).not.toContain("Use **All notes off**");
    expect(app).toContain('aria-label="Panic: all notes off"');
    expect(app).toMatch(/>\s*Panic\s*<\/button>/);
  });
});
