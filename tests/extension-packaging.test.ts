import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BACKGROUND_SOURCE,
  EXTENSION_DESCRIPTION,
  EXTENSION_ICON_FILES,
  FIREFOX_EXTENSION_ID,
  createExtensionManifest,
  createZipBuffer,
  extensionStoreVersion,
  readZipEntries,
} from "../scripts/extension-package-utils.mjs";

describe("browser-extension store packaging", () => {
  it("accepts only Chrome-store-safe numeric versions", () => {
    expect(extensionStoreVersion("1.0.15")).toBe("1.0.15");
    expect(extensionStoreVersion("1.2.3.4")).toBe("1.2.3.4");
    for (const invalid of ["0", "1.2.3-beta.1", "1.2.3+build", "1.65536.0", "1..2", "01.2.3", "01.a"]) {
      expect(() => extensionStoreVersion(invalid)).toThrow();
    }
  });

  it("creates least-privilege target-specific Manifest V3 metadata", () => {
    const metadata = { version: "1.0.15" };
    const chrome = createExtensionManifest("chrome", metadata);
    const firefox = createExtensionManifest("firefox", metadata);

    for (const manifest of [chrome, firefox]) {
      expect(manifest).toMatchObject({
        manifest_version: 3,
        name: "Andoracle",
        version: metadata.version,
        description: EXTENSION_DESCRIPTION,
        icons: EXTENSION_ICON_FILES,
        action: { default_title: "Open Andoracle" },
      });
      expect(EXTENSION_DESCRIPTION.length).toBeLessThanOrEqual(132);
      expect(manifest).not.toHaveProperty("permissions");
      expect(manifest).not.toHaveProperty("host_permissions");
      expect(manifest.action).not.toHaveProperty("default_popup");
    }
    expect(chrome).toMatchObject({ background: { service_worker: "background.js" } });
    expect(chrome).not.toHaveProperty("browser_specific_settings");
    expect(firefox).toMatchObject({
      background: { scripts: ["background.js"] },
      browser_specific_settings: {
        gecko: {
          id: FIREFOX_EXTENSION_ID,
          data_collection_permissions: { required: ["none"] },
        },
      },
    });
    expect(BACKGROUND_SOURCE).toContain("action.onClicked");
    expect(BACKGROUND_SOURCE).toContain("tabs.create");
  });

  it("writes deterministic, root-relative ZIP entries and verifies their bytes", () => {
    const entries = [
      { name: "manifest.json", data: Buffer.from('{"manifest_version":3}') },
      { name: "assets/app.js", data: Buffer.from("console.log('Andoracle');") },
      { name: "index.html", data: Buffer.from("<!doctype html>") },
    ];
    const first = createZipBuffer(entries);
    const second = createZipBuffer([...entries].reverse());
    expect(second.equals(first)).toBe(true);
    expect(readZipEntries(first)).toEqual(entries
      .toSorted((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
      .map((entry) => ({ name: entry.name, data: entry.data })));
    expect(() => createZipBuffer([{ name: "../manifest.json", data: Buffer.alloc(0) }])).toThrow(/Unsafe ZIP entry/);
    const corrupted = Buffer.from(first);
    corrupted[35] ^= 0xff;
    expect(() => readZipEntries(corrupted)).toThrow();
  });

  it("keeps both store archives in the normal build contract", () => {
    const packageJson = JSON.parse(readFileSync(resolve("package.json"), "utf8")) as {
      engines: Record<string, string>;
      scripts: Record<string, string>;
    };
    const viteConfig = readFileSync(resolve("vite.config.ts"), "utf8");
    const pwaHook = readFileSync(resolve("src/pwa/use-pwa-registration.ts"), "utf8");
    const app = readFileSync(resolve("src/App.tsx"), "utf8");

    expect(packageJson.scripts.build).toContain("vite build --mode extension");
    expect(packageJson.scripts.build).toContain("scripts/package-extensions.mjs");
    expect(packageJson.scripts.postbuild).toContain("scripts/verify-extension-packages.mjs");
    expect(packageJson.scripts["build:extensions"]).toContain("scripts/verify-extension-packages.mjs");
    expect(packageJson.engines.node).toBe(">=22.12.0");
    expect(packageJson.engines.npm).toBe(">=10.0.0");
    expect(viteConfig).toContain('source === "virtual:pwa-register" ? EXTENSION_REGISTER_MODULE_ID');
    expect(viteConfig).toContain("extensionBuild ? [extensionRegisterPlugin, extensionHtmlPlugin] : [pwaPlugin()]");
    expect(pwaHook).toContain("return extensionBuild || capable;");
    expect(app).toContain("urlWithPatch(import.meta.env.VITE_PUBLIC_APP_URL, paramsRef.current)");
  });
});
