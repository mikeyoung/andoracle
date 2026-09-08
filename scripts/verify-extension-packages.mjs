import { existsSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BACKGROUND_SOURCE,
  EXTENSION_DESCRIPTION,
  EXTENSION_ICON_FILES,
  FIREFOX_EXTENSION_ID,
  STORE_PACKAGE_ROOT,
  createExtensionManifest,
  directoryEntries,
  extensionStoreVersion,
  readZipEntries,
  sourcePackageEntries,
} from "./extension-package-utils.mjs";

const FORBIDDEN_RUNTIME_NAMES = /^(?:sw\.js|manifest\.webmanifest|web\.config|workbox-[^/]+\.js)$/i;

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const entryMap = (entries) => {
  const result = new Map();
  for (const entry of entries) {
    if (result.has(entry.name)) throw new Error(`Duplicate package entry: ${entry.name}`);
    result.set(entry.name, entry.data);
  }
  return result;
};

const validateHtml = (html, target) => {
  assert(!/<script\b(?![^>]*\bsrc=)[^>]*>/i.test(html), `${target} index.html contains an inline script blocked by Manifest V3.`);
  assert(!/<link\b[^>]*\brel=["']manifest["']/i.test(html), `${target} index.html still links the PWA manifest.`);
  assert(!/%(?:BASE_URL|VITE_[A-Z0-9_]+)%/.test(html), `${target} index.html contains an unresolved Vite placeholder.`);
  assert(/<script\b[^>]*\btype=["']module["'][^>]*\bsrc=["']\.\/assets\//i.test(html), `${target} index.html does not load its local application bundle.`);
};

const resolveLocalReference = (owner, reference, target) => {
  const clean = reference.split(/[?#]/, 1)[0];
  assert(clean.length > 0, `${target} has an empty runtime reference in ${owner}.`);
  assert(!/^(?:[a-z][a-z\d+.-]*:|\/\/|\/)/i.test(clean), `${target} has a non-local runtime reference in ${owner}: ${reference}`);
  const parts = owner.split("/").slice(0, -1);
  for (const part of clean.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      assert(parts.length > 0, `${target} runtime reference escapes the package: ${reference}`);
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.join("/");
};

const validateLocalAssetGraph = (files, target) => {
  const requireReference = (owner, reference) => {
    if (/^(?:data:|blob:|#)/i.test(reference)) return;
    const path = resolveLocalReference(owner, reference, target);
    assert(files.has(path), `${target} package is missing runtime asset ${path}, referenced by ${owner}.`);
  };

  const htmlName = "index.html";
  const html = files.get(htmlName)?.toString("utf8") ?? "";
  for (const match of html.matchAll(/<(script|link)\b[^>]*>/gi)) {
    const tag = match[0];
    const kind = match[1].toLowerCase();
    const source = tag.match(/\bsrc=["']([^"']+)["']/i)?.[1];
    const href = tag.match(/\bhref=["']([^"']+)["']/i)?.[1];
    const relation = tag.match(/\brel=["']([^"']+)["']/i)?.[1].toLowerCase().split(/\s+/) ?? [];
    if (kind === "script" && source) requireReference(htmlName, source);
    if (kind === "link" && href && relation.some((value) => ["icon", "stylesheet", "modulepreload", "preload"].includes(value))) {
      requireReference(htmlName, href);
    }
  }

  for (const [name, data] of files) {
    const source = data.toString("utf8");
    if (name.endsWith(".css")) {
      for (const match of source.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) requireReference(name, match[1]);
    }
    if (name.endsWith(".js")) {
      for (const match of source.matchAll(/new URL\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url\s*\)/g)) requireReference(name, match[1]);
      for (const match of source.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)) requireReference(name, match[1]);
    }
  }
};

const validateManifest = (manifest, target, version) => {
  assert(manifest.manifest_version === 3, `${target} manifest must use Manifest V3.`);
  assert(manifest.name === "Andoracle", `${target} manifest has the wrong application name.`);
  assert(manifest.version === version, `${target} manifest version does not match package.json.`);
  assert(manifest.description === EXTENSION_DESCRIPTION && manifest.description.length <= 132, `${target} store description is invalid.`);
  assert(!("permissions" in manifest) && !("host_permissions" in manifest), `${target} requests unnecessary permissions.`);
  assert(manifest.action?.default_popup === undefined, `${target} must open a full tab rather than an audio-destroying popup.`);
  assert(manifest.content_security_policy?.extension_pages === "script-src 'self'; object-src 'none'; worker-src 'self';", `${target} has an unexpected extension-page CSP.`);
  assert(JSON.stringify(manifest.icons) === JSON.stringify(EXTENSION_ICON_FILES), `${target} icon declarations are incomplete.`);
  assert(JSON.stringify(manifest) === JSON.stringify(createExtensionManifest(target, { version })), `${target} manifest differs from the reviewed least-privilege template.`);
  if (target === "chrome") {
    assert(manifest.background?.service_worker === "background.js", "Chrome package is missing its MV3 service worker.");
    assert(!("browser_specific_settings" in manifest), "Chrome package contains Firefox-only manifest metadata.");
  } else {
    assert(Array.isArray(manifest.background?.scripts) && manifest.background.scripts.length === 1 && manifest.background.scripts[0] === "background.js", "Firefox package is missing its supported background script.");
    const gecko = manifest.browser_specific_settings?.gecko;
    assert(gecko?.id === FIREFOX_EXTENSION_ID, "Firefox package is missing its stable signing ID.");
    assert(JSON.stringify(gecko?.data_collection_permissions?.required) === '["none"]', "Firefox package must explicitly declare that it collects no data.");
  }
};

export const verifyExtensionPackage = (target, version, packageRoot = STORE_PACKAGE_ROOT) => {
  const targetDirectory = resolve(packageRoot, target);
  const archivePath = resolve(packageRoot, `andoracle-${target}-${version}.zip`);
  assert(existsSync(targetDirectory), `Missing unpacked ${target} extension directory.`);
  assert(existsSync(archivePath), `Missing ${target} store ZIP.`);

  const directory = directoryEntries(targetDirectory);
  const archive = readZipEntries(readFileSync(archivePath));
  const unpackedFiles = entryMap(directory);
  const archivedFiles = entryMap(archive);
  assert(archivedFiles.has("manifest.json"), `${target} ZIP does not have manifest.json at its root.`);
  for (const required of ["index.html", "background.js", "LICENSE"]) {
    assert(archivedFiles.has(required), `${target} ZIP is missing ${required} at its root.`);
  }
  assert(archivedFiles.size === unpackedFiles.size, `${target} ZIP file count differs from its unpacked package.`);
  for (const [name, data] of unpackedFiles) {
    const archived = archivedFiles.get(name);
    assert(archived && archived.equals(data), `${target} ZIP differs from its unpacked file: ${name}`);
    assert(!FORBIDDEN_RUNTIME_NAMES.test(name.split("/").at(-1) ?? ""), `${target} package contains PWA/server-only file: ${name}`);
    assert(!name.endsWith(".map"), `${target} package contains an unnecessary source map: ${name}`);
  }

  const manifest = JSON.parse(unpackedFiles.get("manifest.json")?.toString("utf8") ?? "null");
  validateManifest(manifest, target, version);
  validateHtml(unpackedFiles.get("index.html")?.toString("utf8") ?? "", target);
  validateLocalAssetGraph(unpackedFiles, target);
  assert(unpackedFiles.get("background.js")?.equals(Buffer.from(BACKGROUND_SOURCE, "utf8")), `${target} toolbar action differs from the reviewed full-tab launcher.`);
  for (const icon of Object.values(EXTENSION_ICON_FILES)) assert(unpackedFiles.has(icon), `${target} package is missing ${icon}.`);

  const archiveSize = readFileSync(archivePath).length;
  assert(archiveSize > 0 && archiveSize <= 200 * 1024 * 1024, `${target} store ZIP exceeds the Firefox Add-ons upload limit.`);

  return {
    target,
    archivePath,
    fileCount: archivedFiles.size,
    archiveSize,
  };
};

export const verifyExtensionPackages = (packageRoot = STORE_PACKAGE_ROOT) => {
  const packageMetadata = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
  const version = extensionStoreVersion(packageMetadata.version);
  const sourceArchivePath = resolve(packageRoot, `andoracle-firefox-source-${version}.zip`);
  assert(existsSync(sourceArchivePath), "Missing Firefox review source ZIP.");
  const sourceEntries = entryMap(readZipEntries(readFileSync(sourceArchivePath)));
  const expectedSourceEntries = entryMap(sourcePackageEntries(version));
  assert(sourceEntries.size === expectedSourceEntries.size, "Firefox source ZIP does not match the current source tree.");
  for (const [name, data] of expectedSourceEntries) {
    assert(sourceEntries.get(name)?.equals(data), `Firefox source ZIP is stale or differs from ${name}.`);
  }
  for (const required of [
    "FIREFOX-SOURCE-README.txt",
    "package.json",
    "package-lock.json",
    "vite.config.ts",
    "scripts/package-extensions.mjs",
    "src/main.tsx",
  ]) assert(sourceEntries.has(required), `Firefox source ZIP is missing ${required}.`);
  const sourceInstructions = sourceEntries.get("FIREFOX-SOURCE-README.txt")?.toString("utf8") ?? "";
  assert(sourceInstructions.includes("npm ci") && sourceInstructions.includes("npm run build:extensions"), "Firefox source ZIP is missing reproducible build instructions.");
  for (const name of sourceEntries.keys()) {
    assert(!/(^|\/)(?:node_modules|dist|store-packages|\.git)(?:\/|$)/.test(name), `Firefox source ZIP contains generated or private files: ${name}`);
  }

  return {
    version,
    sourceArchivePath,
    packages: [
      verifyExtensionPackage("chrome", version, packageRoot),
      verifyExtensionPackage("firefox", version, packageRoot),
    ],
  };
};

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const result = verifyExtensionPackages();
    for (const entry of result.packages) {
      console.log(`Verified ${entry.target} store ZIP (${entry.fileCount} files, ${entry.archiveSize} bytes): ${relative(resolve(), entry.archivePath)}`);
    }
    console.log(`Verified Firefox review source ZIP: ${relative(resolve(), result.sourceArchivePath)}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
