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
  ".webp",
  ".webmanifest",
  ".woff2",
]);
const VERSION_PLACEHOLDER = "%VITE_APP_VERSION%";
const UPDATE_BRIDGE_NAME_PATTERN = /^sw-update-bridge-(.+)\.js$/;
const IMPORT_SCRIPT_PATTERN = /\bimportScripts\(\s*["']([^"']+)["']\s*\)/g;
const WORKBOX_RUNTIME_NAME_PATTERN = /^workbox-[0-9a-f]+\.js$/i;
const WORKBOX_MODULE_PATTERN = /["']\.\/(workbox-[0-9a-f]+)["']/gi;

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

/**
 * Workbox's bootstrap module is loaded before the precache can run, so it is
 * intentionally not itself a precache entry. Verify that the emitted worker
 * nevertheless points to exactly one real local runtime file.
 */
export const validateWorkboxRuntime = (serviceWorkerSource, emittedUrls) => {
  const emittedRuntimes = emittedUrls
    .filter((url) => WORKBOX_RUNTIME_NAME_PATTERN.test(url))
    .sort();
  const referencedRuntimes = [
    ...serviceWorkerSource.matchAll(WORKBOX_MODULE_PATTERN),
  ].map((match) => `${match[1]}.js`);

  if (emittedRuntimes.length !== 1) {
    throw new Error(`Expected exactly one emitted Workbox runtime, found [${emittedRuntimes.join(", ")}].`);
  }
  if (
    referencedRuntimes.length !== 1
    || referencedRuntimes[0] !== emittedRuntimes[0]
  ) {
    throw new Error(
      `Service worker Workbox runtime reference [${referencedRuntimes.join(", ")}] does not match emitted [${emittedRuntimes.join(", ")}].`,
    );
  }
  return emittedRuntimes[0];
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

export const validateUpdateBridge = (serviceWorkerSource, requiredUrls, expectedVersion) => {
  const bridgeFiles = requiredUrls.filter((url) => UPDATE_BRIDGE_NAME_PATTERN.test(url));
  const importedBridges = [...serviceWorkerSource.matchAll(IMPORT_SCRIPT_PATTERN)]
    .map((match) => match[1])
    .filter((url) => UPDATE_BRIDGE_NAME_PATTERN.test(url));

  if (JSON.stringify(importedBridges) !== JSON.stringify(bridgeFiles)) {
    throw new Error(
      `Workbox update bridge imports differ from built bridge files: imported [${importedBridges.join(", ")}], built [${bridgeFiles.join(", ")}].`,
    );
  }
  if (bridgeFiles.length === 0) {
    if (!/\.clientsClaim\(\)/.test(serviceWorkerSource)) {
      throw new Error("Workbox must resume clientsClaim() ownership after the update bridge is removed.");
    }
    return [];
  }

  const expectedBridge = `sw-update-bridge-${expectedVersion}.js`;
  if (bridgeFiles.length !== 1 || bridgeFiles[0] !== expectedBridge) {
    throw new Error(`Expected exactly the versioned Workbox update bridge ${expectedBridge}.`);
  }
  if (!/\bself\.skipWaiting\(\)/.test(serviceWorkerSource)) {
    throw new Error("The Workbox update bridge requires skipWaiting() for prompt-worker migration.");
  }
  if (/\.clientsClaim\(\)/.test(serviceWorkerSource)) {
    throw new Error("The update bridge must be the sole clients.claim() owner so it can snapshot update clients first.");
  }
  return bridgeFiles;
};

export const verifyBuiltPrecache = (distDirectory = resolve("dist")) => {
  const serviceWorkerPath = resolve(distDirectory, "sw.js");
  const indexPath = resolve(distDirectory, "index.html");
  if (!existsSync(serviceWorkerPath)) throw new Error(`Missing generated service worker: ${serviceWorkerPath}`);
  if (!existsSync(indexPath)) throw new Error(`Missing built application document: ${indexPath}`);
  const packageMetadata = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
  const version = validateBuiltVersion(readFileSync(indexPath, "utf8"), packageMetadata.version);
  const requiredUrls = requiredOfflineUrls(distDirectory);
  const emittedUrls = listFiles(distDirectory)
    .map((path) => relative(distDirectory, path).replaceAll("\\", "/"));
  const serviceWorkerSource = readFileSync(serviceWorkerPath, "utf8");
  validateWorkboxRuntime(serviceWorkerSource, emittedUrls);
  validateUpdateBridge(serviceWorkerSource, requiredUrls, version);
  const urls = validatePrecache(serviceWorkerSource, requiredUrls);
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
