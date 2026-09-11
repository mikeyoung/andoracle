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
  validateUpdateBridge,
  validateWorkboxRuntime,
} from "../scripts/verify-precache.mjs";

const matchesIncludePattern = (fileName: string, pattern: string): boolean => {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*");
  return new RegExp(`^${escaped}$`).test(fileName);
};

describe("PWA precache manifest", () => {
  it("partitions root install artwork while precaching emitted console rasters", () => {
    expect(PWA_WORKBOX_GLOB_PATTERNS).toEqual([
      "**/*.{js,css,html,woff2}",
      "assets/**/*.{png,webp}",
    ]);
    expect(isRequiredOfflineUrl("assets/enamel-white.webp")).toBe(true);
    expect(isRequiredOfflineUrl("assets/knob-ivory.png")).toBe(true);

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

  it("requires the service worker's non-precached Workbox bootstrap module", () => {
    const serviceWorker = 'define(["./workbox-a1b2c3"],function(workbox){})';

    expect(validateWorkboxRuntime(serviceWorker, ["index.html", "workbox-a1b2c3.js"]))
      .toBe("workbox-a1b2c3.js");
    expect(() => validateWorkboxRuntime(serviceWorker, ["index.html"]))
      .toThrow(/exactly one emitted Workbox runtime/);
    expect(() => validateWorkboxRuntime(serviceWorker, ["workbox-deadbeef.js"]))
      .toThrow(/does not match emitted/);
    expect(() => validateWorkboxRuntime(
      'define(["./workbox-a1b2c3","./workbox-deadbeef"],function(){})',
      ["workbox-a1b2c3.js"],
    )).toThrow(/does not match emitted/);
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

  it("keeps a versioned migration bridge as the sole client-claim owner", () => {
    const bridge = "sw-update-bridge-1.0.18.js";
    const valid = [
      `importScripts("${bridge}")`,
      "self.skipWaiting()",
      'precacheAndRoute([{url:"sw-update-bridge-1.0.18.js",revision:"one"}],{})',
    ].join(";");

    expect(validateUpdateBridge(valid, [bridge], "1.0.18")).toEqual([bridge]);
    expect(() => validateUpdateBridge(`${valid};workbox.clientsClaim()`, [bridge], "1.0.18"))
      .toThrow(/sole clients\.claim/);
    expect(() => validateUpdateBridge(valid, [bridge], "1.0.19"))
      .toThrow(/versioned Workbox update bridge sw-update-bridge-1\.0\.19\.js/);
    expect(() => validateUpdateBridge(valid, [], "1.0.18"))
      .toThrow(/imports differ from built bridge files/);
    expect(validateUpdateBridge("workbox.clientsClaim()", [], "1.0.19")).toEqual([]);
    expect(() => validateUpdateBridge("self.skipWaiting()", [], "1.0.19"))
      .toThrow(/resume clientsClaim/);
  });
});
