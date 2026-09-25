/**
 * Andoracle atomic release bump.
 *
 * Usage: npm run release -- <version> [--no-bridge] [--dry-run]
 *
 * Keeps every version surface in lockstep with one operation:
 *   - src/version.ts (the canonical ANDORACLE_VERSION constant)
 *   - package.json and package-lock.json (through `npm version`)
 *   - public/sw-update-bridge-<version>.js, renamed for the new release, or
 *     retired with --no-bridge, which also restores Workbox clientsClaim()
 *   - vite.config.ts (PWA_WORKBOX_IMPORT_SCRIPTS / PWA_WORKBOX_CLIENTS_CLAIM)
 *
 * The target must satisfy both semantic-versioning and browser-store rules
 * before anything is written. A failure mid-bump leaves a recoverable tree:
 * the next `npm run check` reports any remaining drift loudly.
 */
import { readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extensionStoreVersion } from "./extension-package-utils.mjs";

export const PROJECT_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

const UPDATE_BRIDGE_NAME_PATTERN = /^sw-update-bridge-(.+)\.js$/;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const VERSION_SOURCE_DECLARATION = /export const ANDORACLE_VERSION = "[^"]*" as const;/;
const IMPORT_SCRIPTS_DECLARATION = /export const PWA_WORKBOX_IMPORT_SCRIPTS = \[[\s\S]*?\] as const;/;
const CLIENTS_CLAIM_DECLARATION = /export const PWA_WORKBOX_CLIENTS_CLAIM = (true|false);/;

export const parseBumpArgs = (argv) => {
  if (!Array.isArray(argv)) throw new Error("Bump arguments must be an array.");
  let retireBridge = false;
  let dryRun = false;
  for (const arg of argv.slice(1)) {
    if (arg === "--no-bridge") retireBridge = true;
    else if (arg === "--dry-run") dryRun = true;
    else throw new Error(`Unknown bump argument "${arg}". Usage: npm run release -- <version> [--no-bridge] [--dry-run].`);
  }
  const version = argv[0];
  if (typeof version !== "string" || version.length === 0) {
    throw new Error("Missing target version. Usage: npm run release -- <version> [--no-bridge] [--dry-run].");
  }
  return { version, retireBridge, dryRun };
};

export const validateTargetVersion = (version) => {
  if (typeof version !== "string" || !SEMVER_PATTERN.test(version)) {
    throw new Error(`Target version "${String(version)}" is not valid semantic version metadata.`);
  }
  return extensionStoreVersion(version);
};

export const rewriteVersionSource = (source, targetVersion) => {
  if (!VERSION_SOURCE_DECLARATION.test(source)) {
    throw new Error("src/version.ts no longer declares ANDORACLE_VERSION in the expected form.");
  }
  return source.replace(VERSION_SOURCE_DECLARATION, () => `export const ANDORACLE_VERSION = "${targetVersion}" as const;`);
};

export const readImportScripts = (source) => {
  const match = IMPORT_SCRIPTS_DECLARATION.exec(source);
  if (!match) throw new Error("vite.config.ts no longer declares PWA_WORKBOX_IMPORT_SCRIPTS in the expected form.");
  return [...match[0].matchAll(/"([^"]*)"/g)].map((entry) => entry[1]);
};

export const rewriteImportScripts = (source, names) => {
  if (!IMPORT_SCRIPTS_DECLARATION.test(source)) {
    throw new Error("vite.config.ts no longer declares PWA_WORKBOX_IMPORT_SCRIPTS in the expected form.");
  }
  const body = names.length === 0 ? "" : `\n${names.map((name) => `  "${name}",`).join("\n")}\n`;
  return source.replace(IMPORT_SCRIPTS_DECLARATION, () => `export const PWA_WORKBOX_IMPORT_SCRIPTS = [${body}] as const;`);
};

export const readClientsClaim = (source) => {
  const match = CLIENTS_CLAIM_DECLARATION.exec(source);
  if (!match) throw new Error("vite.config.ts no longer declares PWA_WORKBOX_CLIENTS_CLAIM in the expected form.");
  return match[1] === "true";
};

export const setClientsClaim = (source, value) => {
  if (!CLIENTS_CLAIM_DECLARATION.test(source)) {
    throw new Error("vite.config.ts no longer declares PWA_WORKBOX_CLIENTS_CLAIM in the expected form.");
  }
  return source.replace(
    CLIENTS_CLAIM_DECLARATION,
    () => `export const PWA_WORKBOX_CLIENTS_CLAIM = ${value ? "true" : "false"};`,
  );
};

export const findBridgeFiles = (publicDirectory) => readdirSync(publicDirectory, { withFileTypes: true })
  .filter((entry) => entry.isFile() && UPDATE_BRIDGE_NAME_PATTERN.test(entry.name))
  .map((entry) => entry.name)
  .toSorted();

export const planBridgeTransition = ({ bridgeFiles, currentVersion, targetVersion, retireBridge }) => {
  if (!Array.isArray(bridgeFiles) || bridgeFiles.length > 1) {
    throw new Error(`Expected at most one update bridge in public/, found ${JSON.stringify(bridgeFiles)}.`);
  }
  const existing = bridgeFiles[0];
  if (existing && !retireBridge) {
    const match = UPDATE_BRIDGE_NAME_PATTERN.exec(existing);
    if (!match || match[1] !== currentVersion) {
      throw new Error(`Update bridge ${existing} is not named for the current version ${currentVersion}.`);
    }
    return { action: "rename", from: existing, to: `sw-update-bridge-${targetVersion}.js` };
  }
  if (existing && retireBridge) return { action: "retire", from: existing };
  return { action: "none" };
};

const defaultRunNpmVersion = (version, root) => {
  const result = spawnSync("npm", ["version", version, "--no-git-tag-version"], {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.error) throw new Error(`Could not start npm for the version bump: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`npm version exited with code ${String(result.status)}.`);
};

export const applyBump = ({
  root = PROJECT_ROOT,
  targetVersion,
  retireBridge = false,
  dryRun = false,
  runNpmVersion = defaultRunNpmVersion,
} = {}) => {
  validateTargetVersion(targetVersion);

  const versionSourcePath = resolve(root, "src", "version.ts");
  const packageJsonPath = resolve(root, "package.json");
  const lockfilePath = resolve(root, "package-lock.json");
  const viteConfigPath = resolve(root, "vite.config.ts");
  const publicDirectory = resolve(root, "public");

  const versionSource = readFileSync(versionSourcePath, "utf8");
  const packageMetadata = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  const viteConfig = readFileSync(viteConfigPath, "utf8");
  const bridgeFiles = findBridgeFiles(publicDirectory);

  if (typeof packageMetadata.version !== "string") {
    throw new Error("package.json has no version to bump from.");
  }
  const currentVersion = packageMetadata.version;
  const sourceVersionMatch = /export const ANDORACLE_VERSION = "([^"]*)" as const;/.exec(versionSource);
  if (!sourceVersionMatch) {
    throw new Error("src/version.ts no longer declares ANDORACLE_VERSION in the expected form.");
  }
  const healedDrift = sourceVersionMatch[1] !== currentVersion;

  const plan = planBridgeTransition({ bridgeFiles, currentVersion, targetVersion, retireBridge });
  const importScripts = readImportScripts(viteConfig);
  const clientsClaim = readClientsClaim(viteConfig);

  let nextImportScripts;
  let nextClientsClaim;
  if (plan.action === "rename") {
    if (importScripts.length !== 1 || importScripts[0] !== plan.from) {
      throw new Error(
        `vite.config.ts PWA_WORKBOX_IMPORT_SCRIPTS (${JSON.stringify(importScripts)}) does not match the existing bridge ${plan.from}.`,
      );
    }
    if (clientsClaim) {
      throw new Error(
        "PWA_WORKBOX_CLIENTS_CLAIM is already restored while the update bridge is still active. Pass --no-bridge to retire it or fix vite.config.ts first.",
      );
    }
    nextImportScripts = [plan.to];
    nextClientsClaim = false;
  } else if (retireBridge) {
    nextImportScripts = [];
    nextClientsClaim = true;
  } else {
    // No bridge file and no retirement flag: the retired state must already be consistent.
    if (importScripts.length !== 0 || !clientsClaim) {
      throw new Error("No update bridge is present but vite.config.ts still expects one. Pass --no-bridge to normalize the retired state.");
    }
    nextImportScripts = importScripts;
    nextClientsClaim = clientsClaim;
  }

  const changes = [
    `Set ANDORACLE_VERSION in src/version.ts from ${currentVersion} to ${targetVersion}.`,
  ];
  if (healedDrift) {
    changes.push(`Healed pre-existing drift: src/version.ts was at ${sourceVersionMatch[1]} while package.json was at ${currentVersion}.`);
  }
  changes.push(`Run npm version ${targetVersion} --no-git-tag-version to update package.json and package-lock.json.`);
  if (plan.action === "rename") {
    changes.push(`Rename public/${plan.from} to public/${plan.to} and refresh its release note.`);
  } else if (plan.action === "retire") {
    changes.push(`Remove the retired update bridge public/${plan.from}.`);
  }
  if (JSON.stringify(nextImportScripts) !== JSON.stringify(importScripts)) {
    changes.push(`Set PWA_WORKBOX_IMPORT_SCRIPTS in vite.config.ts to ${JSON.stringify(nextImportScripts)}.`);
  }
  if (nextClientsClaim !== clientsClaim) {
    changes.push(`Restore Workbox ownership: set PWA_WORKBOX_CLIENTS_CLAIM in vite.config.ts to ${String(nextClientsClaim)}.`);
  }

  if (!dryRun) {
    writeFileSync(versionSourcePath, rewriteVersionSource(versionSource, targetVersion));
    runNpmVersion(targetVersion, root);
    const bumped = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    if (bumped.version !== targetVersion) {
      throw new Error(`npm version did not set package.json to ${targetVersion}.`);
    }
    const lockfile = JSON.parse(readFileSync(lockfilePath, "utf8"));
    if (lockfile.version !== targetVersion || lockfile.packages?.[""]?.version !== targetVersion) {
      throw new Error(`npm version did not update package-lock.json to ${targetVersion}.`);
    }
    if (plan.action === "rename") {
      const fromPath = resolve(publicDirectory, plan.from);
      writeFileSync(fromPath, readFileSync(fromPath, "utf8").split(currentVersion).join(targetVersion));
      renameSync(fromPath, resolve(publicDirectory, plan.to));
    } else if (plan.action === "retire") {
      rmSync(resolve(publicDirectory, plan.from), { force: true });
    }
    let nextViteConfig = rewriteImportScripts(viteConfig, nextImportScripts);
    if (nextClientsClaim !== clientsClaim) {
      nextViteConfig = setClientsClaim(nextViteConfig, nextClientsClaim);
    }
    writeFileSync(viteConfigPath, nextViteConfig);
  }

  return { targetVersion, healedDrift, bridgeAction: plan.action, changes };
};

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const args = parseBumpArgs(process.argv.slice(2));
    const summary = applyBump({ targetVersion: args.version, retireBridge: args.retireBridge, dryRun: args.dryRun });
    console.log(`${args.dryRun ? "Dry run" : "Bumping"} Andoracle to ${summary.targetVersion}${args.retireBridge ? ", retiring the update bridge" : ""}:`);
    for (const change of summary.changes) console.log(`- ${change}`);
    if (args.dryRun) {
      console.log("Nothing was written.");
    } else {
      console.log('Next: run `npm run check`, then commit as "Release Andoracle <version> …".');
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
