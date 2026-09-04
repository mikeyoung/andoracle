import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const DESCRIPTION = "Andoracle is an offline-capable, touch-first duophonic synthesizer PWA that recreates the ARP Odyssey signal flow with modern MIDI, delay, and patch sharing.";

const readProjectFile = (fileName: string): string => readFileSync(resolve(fileName), "utf8");

describe("Andoracle project metadata", () => {
  it("describes the application and its technology in package metadata", () => {
    const packageJson = JSON.parse(readProjectFile("package.json")) as {
      name: string;
      description: string;
      keywords: string[];
    };

    expect(packageJson.name).toBe("andoracle");
    expect(packageJson.description).toBe(DESCRIPTION);
    expect(packageJson.keywords).toEqual(expect.arrayContaining([
      "synthesizer",
      "duophonic",
      "web-audio",
      "web-midi",
      "pwa",
      "arp-odyssey",
    ]));
  });

  it("provides standard, social, and structured metadata in the document head", () => {
    const html = readProjectFile("index.html");

    expect(html).toContain(`<meta name="description" content="${DESCRIPTION}" />`);
    expect(html).toContain(`<meta property="og:description" content="${DESCRIPTION}" />`);
    expect(html).toContain(`<meta name="twitter:description" content="${DESCRIPTION}" />`);
    expect(html).toContain('<meta property="og:type" content="website" />');
    expect(html).toContain('<meta name="twitter:card" content="summary" />');
    expect(html).toContain("<title>Andoracle — ARP Odyssey-Inspired Synthesizer</title>");

    const structuredMatch = html.match(/<script type="application\/ld\+json">\s*([\s\S]*?)\s*<\/script>/);
    expect(structuredMatch).not.toBeNull();
    const structured = JSON.parse(structuredMatch?.[1] ?? "{}") as Record<string, unknown>;
    expect(structured).toMatchObject({
      "@context": "https://schema.org",
      "@type": "WebApplication",
      name: "Andoracle",
      description: DESCRIPTION,
      applicationCategory: "MultimediaApplication",
      operatingSystem: "Any",
      softwareVersion: "1.0.0",
      inLanguage: "en",
    });
    expect(structured.browserRequirements).toContain("44.1 kHz");
    expect(structured.featureList).toEqual(expect.arrayContaining([
      expect.stringContaining("signal flow"),
      expect.stringContaining("URL patch sharing"),
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
});
