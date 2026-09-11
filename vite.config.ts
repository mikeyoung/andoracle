import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import packageMetadata from "./package.json";
import { ANDORACLE_VERSION } from "./src/version";

export { ANDORACLE_VERSION };

if (typeof packageMetadata.version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(packageMetadata.version)) {
  throw new Error("package.json must contain a valid semantic version for the Andoracle HTML metadata.");
}
if (packageMetadata.version !== ANDORACLE_VERSION) {
  throw new Error("package.json version must match src/version.ts.");
}

export const PWA_INCLUDE_ASSETS = [
  "favicon.ico",
  "favicon-*.png",
  "apple-touch-icon*.png",
] as const;

export const PWA_WORKBOX_GLOB_PATTERNS = [
  "**/*.{js,css,html,woff2}",
  "assets/**/*.{png,webp}",
] as const;

export const PWA_WORKBOX_IMPORT_SCRIPTS = [
  "sw-update-bridge-1.0.20.js",
] as const;

// The one-release bridge snapshots already-controlled update clients before
// claiming the scope, which prevents a first install from reloading itself.
// Restore Workbox ownership when the bridge is removed in a later release.
export const PWA_WORKBOX_CLIENTS_CLAIM = false;
export const PWA_INJECT_REGISTER = false;

// Normal builds replace these generated trees. Excluding them from the dev
// watcher prevents a simultaneous extension build from racing Vite's Windows
// file handles and crashing the live development server with EBUSY.
export const VITE_DEV_WATCH_IGNORED = [
  "**/dist/**",
  "**/store-packages/**",
  "**/node_modules/.tmp/andoracle-extension/**",
] as const;

export const PWA_MANIFEST_ICONS = [
  { src: "icon-72.png", sizes: "72x72", type: "image/png" },
  { src: "icon-96.png", sizes: "96x96", type: "image/png" },
  { src: "icon-128.png", sizes: "128x128", type: "image/png" },
  { src: "icon-144.png", sizes: "144x144", type: "image/png" },
  { src: "icon-152.png", sizes: "152x152", type: "image/png" },
  { src: "icon-192.png", sizes: "192x192", type: "image/png" },
  { src: "icon-256.png", sizes: "256x256", type: "image/png" },
  { src: "icon-384.png", sizes: "384x384", type: "image/png" },
  { src: "icon-512.png", sizes: "512x512", type: "image/png" },
  { src: "maskable-icon-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
  { src: "maskable-icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
] as const;

const PUBLIC_APP_URL = "https://mikeyoung.org/andoracle/";
const EXTENSION_BUILD_DIRECTORY = "node_modules/.tmp/andoracle-extension";
const EXTENSION_REGISTER_MODULE_ID = "\0andoracle-extension-register-sw";

const pwaPlugin = () => VitePWA({
      registerType: "autoUpdate",
      // The application owns registration through virtual:pwa-register.
      // Keeping this explicit also prevents vite-plugin-pwa's auto-register
      // normalization from overriding the bridge-owned clientsClaim setting.
      injectRegister: PWA_INJECT_REGISTER,
      // Root install artwork is supplied here or by manifest.icons. Keeping
      // root images out of Workbox's glob prevents duplicate precache URLs.
      includeAssets: [...PWA_INCLUDE_ASSETS],
      manifest: {
        name: "Andoracle",
        short_name: "Andoracle",
        description: "Andoracle is an offline-capable desktop duophonic synthesizer PWA that recreates the ARP Odyssey signal flow with MIDI, note sequencing, delay, and patch sharing.",
        id: "./",
        lang: "en",
        dir: "ltr",
        theme_color: "#4a2c1c",
        background_color: "#4a2c1c",
        display: "standalone",
        orientation: "any",
        start_url: "./",
        scope: "./",
        categories: ["music", "entertainment"],
        icons: [...PWA_MANIFEST_ICONS]
      },
      workbox: {
        navigateFallback: "index.html",
        importScripts: [...PWA_WORKBOX_IMPORT_SCRIPTS],
        // Root PWA artwork is contributed through includeAssets and
        // manifest.icons; code and fonts are discovered from the build.
        globPatterns: [...PWA_WORKBOX_GLOB_PATTERNS],
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        cleanupOutdatedCaches: true,
        clientsClaim: PWA_WORKBOX_CLIENTS_CLAIM,
        skipWaiting: true
      }
    });

const extensionHtmlPlugin = {
  name: "andoracle-extension-html",
  enforce: "pre" as const,
  transformIndexHtml(html: string): string {
    return html
      .replace(/\s*<script type="application\/ld\+json">[\s\S]*?<\/script>/i, "")
      .replace(/\s*<link rel="(?:icon|apple-touch-icon)"[^>]*>/gi, "")
      .replace(
        "    <title>",
        '    <link rel="icon" type="image/png" sizes="32x32" href="./icons/icon-32.png" />\n    <title>',
      );
  },
};

const extensionRegisterPlugin = {
  name: "andoracle-extension-registration",
  enforce: "pre" as const,
  resolveId(source: string): string | null {
    return source === "virtual:pwa-register" ? EXTENSION_REGISTER_MODULE_ID : null;
  },
  load(id: string): string | null {
    if (id !== EXTENSION_REGISTER_MODULE_ID) return null;
    return "export const registerSW = () => async () => undefined;";
  },
};

export default defineConfig(({ mode }) => {
  const extensionBuild = mode === "extension";
  return {
    // Relative production URLs keep both the hosted PWA and packaged
    // extension pages valid without knowing their final origin in advance.
    base: "./",
    publicDir: extensionBuild ? false : "public",
    server: {
      watch: {
        ignored: [...VITE_DEV_WATCH_IGNORED],
      },
    },
    build: extensionBuild ? {
      outDir: EXTENSION_BUILD_DIRECTORY,
      emptyOutDir: true,
    } : undefined,
    // Vite applies import.meta.env.* definitions to both client modules and
    // %VITE_APP_VERSION% placeholders in index.html.
    define: {
      "import.meta.env.VITE_APP_VERSION": JSON.stringify(ANDORACLE_VERSION),
      "import.meta.env.VITE_EXTENSION_BUILD": JSON.stringify(extensionBuild ? "true" : "false"),
      "import.meta.env.VITE_PUBLIC_APP_URL": JSON.stringify(PUBLIC_APP_URL),
    },
    plugins: [
      react(),
      ...(extensionBuild ? [extensionRegisterPlugin, extensionHtmlPlugin] : [pwaPlugin()]),
    ],
    worker: { format: "es" },
    test: {
      environment: "node",
      include: ["src/**/*.test.ts", "tests/**/*.test.ts"]
    }
  };
});
