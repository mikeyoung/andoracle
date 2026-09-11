import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const PROJECT_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
export const EXTENSION_BUILD_ROOT = resolve(PROJECT_ROOT, "node_modules", ".tmp", "andoracle-extension");
export const STORE_PACKAGE_ROOT = resolve(PROJECT_ROOT, "store-packages");
export const EXTENSION_DESCRIPTION = "A desktop duophonic synthesizer inspired by the ARP Odyssey, with MIDI, sequencing, delay, patches, and offline play.";
export const FIREFOX_EXTENSION_ID = "andoracle@mikeyoung.org";
export const PUBLIC_APP_URL = "https://mikeyoung.org/andoracle/";

export const EXTENSION_ICON_FILES = Object.freeze({
  16: "icons/icon-16.png",
  32: "icons/icon-32.png",
  48: "icons/icon-48.png",
  128: "icons/icon-128.png",
});

export const BACKGROUND_SOURCE = `"use strict";

const extensionApi = globalThis.browser ?? globalThis.chrome;

extensionApi.action.onClicked.addListener(() => {
  extensionApi.tabs.create({ url: extensionApi.runtime.getURL("index.html") });
});
`;

const FIXED_DOS_TIME = 0;
const FIXED_DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;
const UTF8_FLAG = 0x0800;
const DEFLATE_METHOD = 8;
const ZIP_LOCAL_SIGNATURE = 0x04034b50;
const ZIP_CENTRAL_SIGNATURE = 0x02014b50;
const ZIP_END_SIGNATURE = 0x06054b50;
const compareEntryNames = (left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    }
    table[index] = value >>> 0;
  }
  return table;
})();

export const crc32 = (data) => {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};

const assertSafeOutputDirectory = (directory) => {
  const absolute = resolve(directory);
  if (dirname(absolute) !== PROJECT_ROOT || basename(absolute) !== "store-packages") {
    throw new Error(`Refusing to replace unexpected package directory: ${absolute}`);
  }
  return absolute;
};

const assertInside = (parent, child) => {
  const path = relative(resolve(parent), resolve(child));
  if (path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path))) return;
  throw new Error(`Path escapes its expected directory: ${child}`);
};

export const extensionStoreVersion = (version) => {
  if (typeof version !== "string" || !/^\d+(?:\.\d+){0,3}$/.test(version)) {
    throw new Error("Extension builds require package.json version to contain one to four dot-separated integers.");
  }
  const components = version.split(".");
  if (components.some((component) => component.length > 1 && component.startsWith("0"))) {
    throw new Error("Non-zero extension version components cannot have leading zeroes.");
  }
  const parts = components.map(Number);
  if (parts.every((part) => part === 0) || parts.some((part) => !Number.isSafeInteger(part) || part > 65535)) {
    throw new Error("Extension version components must be 0–65535 and the complete version cannot be zero.");
  }
  return version;
};

export const createExtensionManifest = (target, packageMetadata) => {
  if (target !== "chrome" && target !== "firefox") throw new Error(`Unsupported extension target: ${target}`);
  const version = extensionStoreVersion(packageMetadata.version);
  const common = {
    manifest_version: 3,
    name: "Andoracle",
    version,
    description: EXTENSION_DESCRIPTION,
    homepage_url: PUBLIC_APP_URL,
    icons: EXTENSION_ICON_FILES,
    action: {
      default_title: "Open Andoracle",
      default_icon: {
        16: EXTENSION_ICON_FILES[16],
        32: EXTENSION_ICON_FILES[32],
      },
    },
    content_security_policy: {
      extension_pages: "script-src 'self'; object-src 'none'; worker-src 'self';",
    },
  };

  if (target === "chrome") {
    return {
      ...common,
      background: { service_worker: "background.js" },
    };
  }

  return {
    ...common,
    background: { scripts: ["background.js"] },
    browser_specific_settings: {
      gecko: {
        id: FIREFOX_EXTENSION_ID,
        data_collection_permissions: { required: ["none"] },
      },
    },
  };
};

export const listFiles = (directory) => readdirSync(directory, { withFileTypes: true })
  .flatMap((entry) => {
    const path = resolve(directory, entry.name);
    // Store packages must be self-contained snapshots of reviewed project
    // files. Following a repository symlink could silently copy data from
    // outside the project (and makes the archive depend on the build host).
    if (entry.isSymbolicLink()) {
      throw new Error(`Refusing symbolic link in extension package input: ${path}`);
    }
    return entry.isDirectory() ? listFiles(path) : [path];
  });

export const directoryEntries = (directory) => listFiles(directory)
  .map((path) => ({
    name: relative(directory, path).replaceAll("\\", "/"),
    data: readFileSync(path),
  }))
  .sort(compareEntryNames);

export const sourcePackageEntries = (version) => {
  const entries = [];
  const packageMetadata = JSON.parse(readFileSync(resolve(PROJECT_ROOT, "package.json"), "utf8"));
  const nodeRange = packageMetadata.engines?.node ?? "see package.json";
  const npmRange = packageMetadata.engines?.npm ?? "see package.json";
  const rootFiles = [
    ".gitignore",
    "index.html",
    "LICENSE",
    "package-lock.json",
    "package.json",
    "README.md",
    "tsconfig.app.json",
    "tsconfig.json",
    "tsconfig.node.json",
    "vite.config.ts",
  ];
  for (const name of rootFiles) entries.push({ name, data: readFileSync(resolve(PROJECT_ROOT, name)) });
  // Runtime sources and build tooling are sufficient for reviewer rebuilds.
  // Deliberately omit internal project notes and root-only verification tests.
  for (const directory of ["public", "scripts", "src"]) {
    for (const path of listFiles(resolve(PROJECT_ROOT, directory))) {
      entries.push({
        name: relative(PROJECT_ROOT, path).replaceAll("\\", "/"),
        data: readFileSync(path),
      });
    }
  }
  entries.push({
    name: "FIREFOX-SOURCE-README.txt",
    data: Buffer.from(`Andoracle ${version} — Firefox review source\n\nBuild environment\n- Any operating system supported by Node.js\n- Node.js ${nodeRange} (Mozilla's Node 24 reviewer environment is supported)\n- npm ${npmRange}\n- No global tools or web-based build services are required\n\nReproducible build commands\n1. npm ci\n2. npm run build:extensions\n\nThe Firefox submission archive will be written to:\nstore-packages/andoracle-firefox-${version}.zip\n\nThe build uses only the open-source packages locked in package-lock.json. Vite and TypeScript bundle/transpile the application; scripts/extension-package-utils.mjs creates the deterministic store ZIP. No code is obfuscated and no remotely hosted executable code is used.\n`, "utf8"),
  });
  return entries.sort(compareEntryNames);
};

const assertArchiveName = (name) => {
  if (
    typeof name !== "string"
    || name.length === 0
    || name.startsWith("/")
    || name.includes("\\")
    || name.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`Unsafe ZIP entry name: ${String(name)}`);
  }
};

export const createZipBuffer = (entries) => {
  if (!Array.isArray(entries) || entries.length === 0) throw new Error("A store ZIP must contain at least one file.");
  if (entries.length > 0xffff) throw new Error("ZIP64 archives are not supported by this deterministic packager.");

  const localParts = [];
  const centralParts = [];
  let localOffset = 0;
  const seen = new Set();

  for (const entry of [...entries].sort(compareEntryNames)) {
    assertArchiveName(entry.name);
    if (seen.has(entry.name)) throw new Error(`Duplicate ZIP entry: ${entry.name}`);
    seen.add(entry.name);
    const name = Buffer.from(entry.name, "utf8");
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
    const compressed = deflateRawSync(data, { level: 9 });
    const checksum = crc32(data);
    if (name.length > 0xffff || data.length > 0xffffffff || compressed.length > 0xffffffff) {
      throw new Error(`ZIP entry is too large for the store packager: ${entry.name}`);
    }

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(ZIP_LOCAL_SIGNATURE, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(UTF8_FLAG, 6);
    localHeader.writeUInt16LE(DEFLATE_METHOD, 8);
    localHeader.writeUInt16LE(FIXED_DOS_TIME, 10);
    localHeader.writeUInt16LE(FIXED_DOS_DATE, 12);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localHeader.writeUInt16LE(0, 28);
    localParts.push(localHeader, name, compressed);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(ZIP_CENTRAL_SIGNATURE, 0);
    centralHeader.writeUInt16LE(0x0314, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(UTF8_FLAG, 8);
    centralHeader.writeUInt16LE(DEFLATE_METHOD, 10);
    centralHeader.writeUInt16LE(FIXED_DOS_TIME, 12);
    centralHeader.writeUInt16LE(FIXED_DOS_DATE, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0o100644 * 0x10000, 38);
    centralHeader.writeUInt32LE(localOffset, 42);
    centralParts.push(centralHeader, name);
    localOffset += localHeader.length + name.length + compressed.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(ZIP_END_SIGNATURE, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDirectory, end]);
};

export const readZipEntries = (archive) => {
  const bytes = Buffer.isBuffer(archive) ? archive : Buffer.from(archive);
  if (bytes.length < 22) throw new Error("ZIP archive is truncated.");
  const endOffset = bytes.length - 22;
  if (bytes.readUInt32LE(endOffset) !== ZIP_END_SIGNATURE) throw new Error("ZIP end record is missing.");
  const count = bytes.readUInt16LE(endOffset + 10);
  const centralSize = bytes.readUInt32LE(endOffset + 12);
  const centralOffset = bytes.readUInt32LE(endOffset + 16);
  if (centralOffset + centralSize !== endOffset) throw new Error("ZIP central directory bounds are invalid.");

  const entries = [];
  let cursor = centralOffset;
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > endOffset || bytes.readUInt32LE(cursor) !== ZIP_CENTRAL_SIGNATURE) {
      throw new Error("ZIP central directory entry is invalid.");
    }
    const method = bytes.readUInt16LE(cursor + 10);
    const expectedCrc = bytes.readUInt32LE(cursor + 16);
    const compressedSize = bytes.readUInt32LE(cursor + 20);
    const uncompressedSize = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const localOffset = bytes.readUInt32LE(cursor + 42);
    const nextCursor = cursor + 46 + nameLength + extraLength + commentLength;
    if (nextCursor > endOffset) throw new Error("ZIP central directory entry is truncated.");
    const name = bytes.toString("utf8", cursor + 46, cursor + 46 + nameLength);
    assertArchiveName(name);
    if (localOffset + 30 > centralOffset || bytes.readUInt32LE(localOffset) !== ZIP_LOCAL_SIGNATURE) {
      throw new Error(`ZIP local header is invalid for ${name}.`);
    }
    const localMethod = bytes.readUInt16LE(localOffset + 8);
    const localCrc = bytes.readUInt32LE(localOffset + 14);
    const localCompressedSize = bytes.readUInt32LE(localOffset + 18);
    const localUncompressedSize = bytes.readUInt32LE(localOffset + 22);
    const localNameLength = bytes.readUInt16LE(localOffset + 26);
    const localExtraLength = bytes.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > centralOffset) throw new Error(`ZIP data is truncated for ${name}.`);
    const localName = bytes.toString("utf8", localOffset + 30, localOffset + 30 + localNameLength);
    if (
      localName !== name
      || localMethod !== method
      || localCrc !== expectedCrc
      || localCompressedSize !== compressedSize
      || localUncompressedSize !== uncompressedSize
    ) throw new Error(`ZIP header metadata differs for ${name}.`);
    const compressed = bytes.subarray(dataStart, dataEnd);
    const data = method === 0 ? Buffer.from(compressed) : method === DEFLATE_METHOD ? inflateRawSync(compressed) : null;
    if (!data) throw new Error(`Unsupported ZIP compression method ${method} for ${name}.`);
    if (data.length !== uncompressedSize || crc32(data) !== expectedCrc) throw new Error(`ZIP integrity check failed for ${name}.`);
    entries.push({ name, data });
    cursor = nextCursor;
  }
  if (cursor !== endOffset) throw new Error("ZIP central directory contains trailing data.");
  return entries;
};

const copyRuntime = (targetDirectory) => {
  if (!existsSync(EXTENSION_BUILD_ROOT) || !statSync(EXTENSION_BUILD_ROOT).isDirectory()) {
    throw new Error(`Missing extension build output: ${EXTENSION_BUILD_ROOT}`);
  }
  cpSync(EXTENSION_BUILD_ROOT, targetDirectory, { recursive: true, errorOnExist: false });
  const iconDirectory = resolve(targetDirectory, "icons");
  mkdirSync(iconDirectory, { recursive: true });
  const iconSources = {
    16: "favicon-16.png",
    32: "favicon-32.png",
    48: "favicon-48.png",
    128: "icon-128.png",
  };
  for (const [size, source] of Object.entries(iconSources)) {
    const destination = resolve(targetDirectory, EXTENSION_ICON_FILES[size]);
    assertInside(targetDirectory, destination);
    cpSync(resolve(PROJECT_ROOT, "public", source), destination);
  }
  cpSync(resolve(PROJECT_ROOT, "LICENSE"), resolve(targetDirectory, "LICENSE"));
};

export const packageExtensions = (packageMetadata) => {
  const version = extensionStoreVersion(packageMetadata.version);
  const outputRoot = assertSafeOutputDirectory(STORE_PACKAGE_ROOT);
  rmSync(outputRoot, { recursive: true, force: true });
  mkdirSync(outputRoot, { recursive: true });
  const packages = [];

  for (const target of ["chrome", "firefox"]) {
    const targetDirectory = resolve(outputRoot, target);
    assertInside(outputRoot, targetDirectory);
    mkdirSync(targetDirectory, { recursive: true });
    copyRuntime(targetDirectory);
    const manifest = createExtensionManifest(target, packageMetadata);
    writeFileSync(resolve(targetDirectory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    writeFileSync(resolve(targetDirectory, "background.js"), BACKGROUND_SOURCE);
    const archivePath = resolve(outputRoot, `andoracle-${target}-${version}.zip`);
    writeFileSync(archivePath, createZipBuffer(directoryEntries(targetDirectory)));
    packages.push({ target, targetDirectory, archivePath });
  }

  const sourceArchivePath = resolve(outputRoot, `andoracle-firefox-source-${version}.zip`);
  writeFileSync(sourceArchivePath, createZipBuffer(sourcePackageEntries(version)));

  return { version, outputRoot, packages, sourceArchivePath };
};
