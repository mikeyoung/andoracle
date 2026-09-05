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
const VERSION_PLACEHOLDER = "%VITE_APP_VERSION%";

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const listFiles = (directory) => readdirSync(directory, { withFileTypes: true })
  .flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? listFiles(path) : [path];
  });

export const extractPrecacheUrls = (serviceWorkerSource) => [
  ...serviceWorkerSource.matchAll(PRECACHE_URL_PATTERN),
].map((match) => match[1]);

export const isRequiredOfflineUrl = (url) => {
  // The canonical 512 px source is retained in public/ for deterministic icon
  // generation, but the application never requests it at runtime. Some static
  // hosts also reject this build-only filename, so it must not gate SW install.
  if (url === "icon-master-512.png") return false;
  if (url === "sw.js" || /^workbox-[^/]+\.js$/i.test(url)) return false;
  return OFFLINE_EXTENSIONS.has(extname(url).toLowerCase());
};

export const requiredOfflineUrls = (distDirectory) => listFiles(distDirectory)
  .map((path) => relative(distDirectory, path).replaceAll("\\", "/"))
  .filter(isRequiredOfflineUrl)
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

export const validateBuiltVersion = (html, expectedVersion) => {
  if (typeof expectedVersion !== "string" || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(expectedVersion)) {
    throw new Error("The expected Andoracle version is not valid semantic version metadata.");
  }
  if (html.includes(VERSION_PLACEHOLDER)) {
    throw new Error(`Unresolved ${VERSION_PLACEHOLDER} placeholder in built index.html.`);
  }

  const escapedVersion = escapeRegExp(expectedVersion);
  const versionMeta = new RegExp(
    `<meta\\s+name=["']application-version["']\\s+content=["']${escapedVersion}["']\\s*/?>`,
    "i",
  );
  if (!versionMeta.test(html)) {
    throw new Error(`Built index.html does not declare application-version ${expectedVersion}.`);
  }
  const structuredVersion = new RegExp(
    `"softwareVersion"\\s*:\\s*"${escapedVersion}"`,
  );
  if (!structuredVersion.test(html)) {
    throw new Error(`Built index.html does not declare structured softwareVersion ${expectedVersion}.`);
  }

  return expectedVersion;
};

export const verifyBuiltPrecache = (distDirectory = resolve("dist")) => {
  const serviceWorkerPath = resolve(distDirectory, "sw.js");
  const indexPath = resolve(distDirectory, "index.html");
  if (!existsSync(serviceWorkerPath)) throw new Error(`Missing generated service worker: ${serviceWorkerPath}`);
  if (!existsSync(indexPath)) throw new Error(`Missing built application document: ${indexPath}`);
  const packageMetadata = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
  const version = validateBuiltVersion(readFileSync(indexPath, "utf8"), packageMetadata.version);
  const requiredUrls = requiredOfflineUrls(distDirectory);
  const urls = validatePrecache(readFileSync(serviceWorkerPath, "utf8"), requiredUrls);
  return { precacheCount: urls.length, requiredCount: requiredUrls.length, version };
};

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const result = verifyBuiltPrecache();
    console.log(
      `Verified Andoracle ${result.version} in index.html and ${result.precacheCount} unique Workbox precache URLs, including all ${result.requiredCount} required offline assets.`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
