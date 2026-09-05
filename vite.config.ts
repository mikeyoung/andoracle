import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import packageMetadata from "./package.json";

if (typeof packageMetadata.version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(packageMetadata.version)) {
  throw new Error("package.json must contain a valid semantic version for the Andoracle HTML metadata.");
}

export const ANDORACLE_VERSION = packageMetadata.version;

export const PWA_INCLUDE_ASSETS = [
  "favicon.ico",
  "favicon-*.png",
  "apple-touch-icon*.png",
] as const;

export const PWA_WORKBOX_GLOB_PATTERNS = [
  "**/*.{js,css,html,woff2}",
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

export default defineConfig({
  // Relative production URLs keep the same build valid at / and at any
  // directory-style subpath (for example, /andoracle/).
  base: "./",
  // Vite applies import.meta.env.* definitions to both client modules and
  // %VITE_APP_VERSION% placeholders in index.html.
  define: {
    "import.meta.env.VITE_APP_VERSION": JSON.stringify(ANDORACLE_VERSION),
  },
  plugins: [
    react(),
    VitePWA({
      registerType: "prompt",
      // Root install artwork is supplied here or by manifest.icons. Keeping
      // root images out of Workbox's glob prevents duplicate precache URLs.
      includeAssets: [...PWA_INCLUDE_ASSETS],
      manifest: {
        name: "Andoracle",
        short_name: "Andoracle",
        description: "Andoracle is an offline-capable, touch-first duophonic synthesizer PWA that recreates the ARP Odyssey signal flow with MIDI, note sequencing, delay, and patch sharing.",
        id: "./",
        lang: "en",
        dir: "ltr",
        theme_color: "#a3a3a3",
        background_color: "#292929",
        display: "standalone",
        orientation: "any",
        start_url: "./",
        scope: "./",
        categories: ["music", "entertainment"],
        icons: [...PWA_MANIFEST_ICONS]
      },
      workbox: {
        navigateFallback: "index.html",
        // Root PWA artwork is contributed through includeAssets and
        // manifest.icons; code and fonts are discovered from the build.
        globPatterns: [...PWA_WORKBOX_GLOB_PATTERNS],
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        skipWaiting: false
      }
    })
  ],
  worker: { format: "es" },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"]
  }
});
