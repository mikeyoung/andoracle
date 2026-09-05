import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PWA_INCLUDE_ASSETS,
  PWA_MANIFEST_ICONS,
  PWA_WORKBOX_GLOB_PATTERNS,
} from "../vite.config";
import { extractPrecacheUrls, validatePrecache } from "../scripts/verify-precache.mjs";

const matchesIncludePattern = (fileName: string, pattern: string): boolean => {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*");
  return new RegExp(`^${escaped}$`).test(fileName);
};

describe("PWA precache manifest", () => {
  it("partitions root install artwork away from Workbox's generated-asset glob", () => {
    expect(PWA_WORKBOX_GLOB_PATTERNS).toEqual([
      "**/*.{js,css,html,woff2}",
      "assets/**/*.{png,jpg,jpeg}",
    ]);

    const publicImages = readdirSync(resolve("public"))
      .filter((fileName) => /\.(?:ico|jpe?g|png)$/i.test(fileName));
    const manifestIcons = new Set<string>(PWA_MANIFEST_ICONS.map(({ src }) => src));
    const explicitlyIncluded = new Set(publicImages.filter((fileName) => (
      PWA_INCLUDE_ASSETS.some((pattern) => matchesIncludePattern(fileName, pattern))
    )));

    expect([...manifestIcons].filter((fileName) => explicitlyIncluded.has(fileName))).toEqual([]);
    expect(publicImages.filter((fileName) => (
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
});
