import { existsSync, readFileSync, readdirSync } from "node:fs";
import { extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PRECACHE_URL_PATTERN = /\burl\s*:\s*["']([^"']+)["']\s*,\s*revision\s*:/g;
const OFFLINE_EXTENSIONS = new Set([
  ".css",
  ".html",
  ".ico",
  ".jpeg",
  ".jpg",
  ".js",
  ".png",
  ".webmanifest",
  ".woff2",
]);

const listFiles = (directory) => readdirSync(directory, { withFileTypes: true })
  .flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? listFiles(path) : [path];
  });

export const extractPrecacheUrls = (serviceWorkerSource) => [
  ...serviceWorkerSource.matchAll(PRECACHE_URL_PATTERN),
].map((match) => match[1]);

export const requiredOfflineUrls = (distDirectory) => listFiles(distDirectory)
  .map((path) => relative(distDirectory, path).replaceAll("\\", "/"))
  .filter((url) => {
    if (url === "sw.js" || /^workbox-[^/]+\.js$/i.test(url)) return false;
    return OFFLINE_EXTENSIONS.has(extname(url).toLowerCase());
  })
  .sort();

export const validatePrecache = (serviceWorkerSource, requiredUrls) => {
  const urls = extractPrecacheUrls(serviceWorkerSource);
  if (urls.length === 0) throw new Error("No Workbox precache entries were found in sw.js.");

  const counts = new Map();
  for (const url of urls) counts.set(url, (counts.get(url) ?? 0) + 1);
  const duplicates = [...counts]
    .filter(([, count]) => count > 1)
    .map(([url]) => url)
    .sort();
  if (duplicates.length > 0) {
    throw new Error(`Duplicate Workbox precache URLs: ${duplicates.join(", ")}`);
  }

  const cached = new Set(urls);
  const missing = [...requiredUrls].filter((url) => !cached.has(url)).sort();
  if (missing.length > 0) {
    throw new Error(`Required offline assets missing from Workbox precache: ${missing.join(", ")}`);
  }

  return urls;
};

export const verifyBuiltPrecache = (distDirectory = resolve("dist")) => {
  const serviceWorkerPath = resolve(distDirectory, "sw.js");
  if (!existsSync(serviceWorkerPath)) throw new Error(`Missing generated service worker: ${serviceWorkerPath}`);
  const requiredUrls = requiredOfflineUrls(distDirectory);
  const urls = validatePrecache(readFileSync(serviceWorkerPath, "utf8"), requiredUrls);
  return { precacheCount: urls.length, requiredCount: requiredUrls.length };
};

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const result = verifyBuiltPrecache();
    console.log(
      `Verified ${result.precacheCount} unique Workbox precache URLs, including all ${result.requiredCount} required offline assets.`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
