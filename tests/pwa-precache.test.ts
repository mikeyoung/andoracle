import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PWA_INCLUDE_ASSETS,
  PWA_MANIFEST_ICONS,
  PWA_WORKBOX_GLOB_PATTERNS,
} from "../vite.config";
import {
  extractPrecacheUrls,
  isRequiredOfflineUrl,
  validateBuiltVersion,
  validatePrecache,
} from "../scripts/verify-precache.mjs";

const matchesIncludePattern = (fileName: string, pattern: string): boolean => {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*");
  return new RegExp(`^${escaped}$`).test(fileName);
};

describe("PWA precache manifest", () => {
  it("partitions root install artwork away from Workbox's generated-asset glob", () => {
    expect(PWA_WORKBOX_GLOB_PATTERNS).toEqual([
      "**/*.{js,css,html,woff2}",
    ]);

    const publicImages = readdirSync(resolve("public"))
      .filter((fileName) => /\.(?:ico|jpe?g|png)$/i.test(fileName));
    expect(publicImages).toContain("icon-master-512.png");
    expect(isRequiredOfflineUrl("icon-master-512.png")).toBe(false);
    expect(isRequiredOfflineUrl("icon-512.png")).toBe(true);
    const manifestIcons = new Set<string>(PWA_MANIFEST_ICONS.map(({ src }) => src));
    const runtimeImages = publicImages.filter(isRequiredOfflineUrl);
    const explicitlyIncluded = new Set(runtimeImages.filter((fileName) => (
      PWA_INCLUDE_ASSETS.some((pattern) => matchesIncludePattern(fileName, pattern))
    )));

    expect([...manifestIcons].filter((fileName) => explicitlyIncluded.has(fileName))).toEqual([]);
    expect(runtimeImages.filter((fileName) => (
      !manifestIcons.has(fileName) && !explicitlyIncluded.has(fileName)
    ))).toEqual([]);
  });

  it("extracts each emitted Workbox URL once", () => {
    const serviceWorker = 'precacheAndRoute([{url:"index.html",revision:"one"},{url:"assets/app.js",revision:null}],{})';
    expect(extractPrecacheUrls(serviceWorker)).toEqual(["index.html", "assets/app.js"]);
    expect(validatePrecache(serviceWorker, ["index.html", "assets/app.js"])).toEqual([
      "index.html",
      "assets/app.js",
    ]);
  });

  it("rejects duplicate URLs and missing required offline assets", () => {
    const duplicated = 'precacheAndRoute([{url:"index.html",revision:"one"},{url:"index.html",revision:"two"}],{})';
    expect(() => validatePrecache(duplicated, ["index.html"])).toThrow(/Duplicate Workbox precache URLs: index\.html/);

    const incomplete = 'precacheAndRoute([{url:"index.html",revision:"one"}],{})';
    expect(() => validatePrecache(incomplete, ["index.html", "assets/odyssey-worklet.js"]))
      .toThrow(/Required offline assets missing.*odyssey-worklet\.js/);
  });

  it("requires the built HTML to expose one resolved release version", () => {
    const valid = [
      '<meta name="application-version" content="1.0.1" />',
      '<script type="application/ld+json">{"softwareVersion":"1.0.1"}</script>',
    ].join("\n");

    expect(validateBuiltVersion(valid, "1.0.1")).toBe("1.0.1");
    expect(() => validateBuiltVersion(valid.replaceAll("1.0.1", "%VITE_APP_VERSION%"), "1.0.1"))
      .toThrow(/Unresolved %VITE_APP_VERSION%/);
    expect(() => validateBuiltVersion(valid, "1.0.2"))
      .toThrow(/does not declare application-version 1\.0\.2/);
  });
});
