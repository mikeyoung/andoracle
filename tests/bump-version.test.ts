import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyBump,
  findBridgeFiles,
  parseBumpArgs,
  planBridgeTransition,
  readClientsClaim,
  readImportScripts,
  rewriteImportScripts,
  rewriteVersionSource,
  setClientsClaim,
  validateTargetVersion,
} from "../scripts/bump-version.mjs";

const VERSION_SOURCE = `/**
 * Andoracle release identifier.
 */
export const ANDORACLE_VERSION = "1.0.24" as const;
`;

const VITE_CONFIG = `export const PWA_WORKBOX_IMPORT_SCRIPTS = [
  "sw-update-bridge-1.0.24.js",
] as const;

// The one-release bridge snapshots already-controlled update clients before
// claiming the scope, which prevents a first install from reloading itself.
// Restore Workbox ownership when the bridge is removed in a later release.
export const PWA_WORKBOX_CLIENTS_CLAIM = false;
`;

const VITE_CONFIG_RETIRED = `export const PWA_WORKBOX_IMPORT_SCRIPTS = [] as const;

export const PWA_WORKBOX_CLIENTS_CLAIM = true;
`;

const BRIDGE_SOURCE = `/**
 * Versioned migration bridge for Andoracle 1.0.24's automatic update path.
 */
self.addEventListener("activate", () => undefined);
`;

const createFixtureRoot = (base: string, { withBridge = true, retiredVite = false } = {}): string => {
  const root = join(base, "fixture");
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "public"), { recursive: true });
  writeFileSync(join(root, "package.json"), `${JSON.stringify({ name: "andoracle", version: "1.0.24" }, null, 2)}\n`);
  writeFileSync(
    join(root, "package-lock.json"),
    `${JSON.stringify({ lockfileVersion: 3, name: "andoracle", version: "1.0.24", packages: { "": { name: "andoracle", version: "1.0.24" } } }, null, 2)}\n`,
  );
  writeFileSync(join(root, "src", "version.ts"), VERSION_SOURCE);
  writeFileSync(join(root, "vite.config.ts"), retiredVite ? VITE_CONFIG_RETIRED : VITE_CONFIG);
  if (withBridge) writeFileSync(join(root, "public", "sw-update-bridge-1.0.24.js"), BRIDGE_SOURCE);
  return root;
};

const fakeNpmVersion = (root: string) => {
  const invokedWith: string[] = [];
  const runner = (version: string) => {
    invokedWith.push(version);
    const packageJsonPath = join(root, "package.json");
    const lockfilePath = join(root, "package-lock.json");
    const packageMetadata = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    packageMetadata.version = version;
    writeFileSync(packageJsonPath, `${JSON.stringify(packageMetadata, null, 2)}\n`);
    const lockfile = JSON.parse(readFileSync(lockfilePath, "utf8"));
    lockfile.version = version;
    lockfile.packages[""].version = version;
    writeFileSync(lockfilePath, `${JSON.stringify(lockfile, null, 2)}\n`);
  };
  return { runner, invokedWith };
};

describe("release bump argument parsing", () => {
  it("parses a plain target version", () => {
    expect(parseBumpArgs(["1.0.25"])).toEqual({ version: "1.0.25", retireBridge: false, dryRun: false });
  });

  it("accepts --no-bridge and --dry-run together", () => {
    expect(parseBumpArgs(["1.0.25", "--no-bridge", "--dry-run"])).toEqual({
      version: "1.0.25",
      retireBridge: true,
      dryRun: true,
    });
  });

  it("rejects a missing target version", () => {
    expect(() => parseBumpArgs([])).toThrow(/Missing target version/);
  });

  it("rejects unknown flags and extra positionals", () => {
    expect(() => parseBumpArgs(["1.0.25", "--force"])).toThrow(/Unknown bump argument/);
    expect(() => parseBumpArgs(["1.0.25", "1.0.26"])).toThrow(/Unknown bump argument/);
  });
});

describe("target version validation", () => {
  it("accepts store-safe versions", () => {
    expect(validateTargetVersion("1.0.25")).toBe("1.0.25");
    expect(validateTargetVersion("1.2.3")).toBe("1.2.3");
  });

  it("fails early on versions the store would accept but vite's canonical form rejects", () => {
    // Four-component versions pass extensionStoreVersion but not the x.y.z
    // pattern enforced by vite.config.ts, so the bump refuses them up front.
    expect(() => validateTargetVersion("1.2.3.4")).toThrow(/not valid semantic version/);
  });

  it("rejects non-semantic versions", () => {
    for (const invalid of ["abc", "1..2", "", "1.0"]) {
      expect(() => validateTargetVersion(invalid)).toThrow(/not valid semantic version/);
    }
  });

  it("rejects semver that the browser stores would reject", () => {
    for (const invalid of ["1.0.25-beta", "1.0.25+build", "01.0.25"]) {
      expect(() => validateTargetVersion(invalid)).toThrow();
    }
  });
});

describe("version source rewriting", () => {
  it("replaces only the release constant", () => {
    const next = rewriteVersionSource(VERSION_SOURCE, "1.0.25");
    expect(next).toBe(`/**
 * Andoracle release identifier.
 */
export const ANDORACLE_VERSION = "1.0.25" as const;
`);
  });

  it("throws when the declaration is missing", () => {
    expect(() => rewriteVersionSource("export const OTHER = \"1\" as const;", "1.0.25"))
      .toThrow(/expected form/);
  });
});

describe("vite config rewriting", () => {
  it("reads the current import scripts and clientsClaim values", () => {
    expect(readImportScripts(VITE_CONFIG)).toEqual(["sw-update-bridge-1.0.24.js"]);
    expect(readClientsClaim(VITE_CONFIG)).toBe(false);
    expect(readClientsClaim(VITE_CONFIG_RETIRED)).toBe(true);
  });

  it("rewrites the import scripts for a renamed bridge", () => {
    const next = rewriteImportScripts(VITE_CONFIG, ["sw-update-bridge-1.0.25.js"]);
    expect(next).toContain(`export const PWA_WORKBOX_IMPORT_SCRIPTS = [
  "sw-update-bridge-1.0.25.js",
] as const;`);
    expect(readImportScripts(next)).toEqual(["sw-update-bridge-1.0.25.js"]);
  });

  it("rewrites the import scripts to empty for a retired bridge", () => {
    const next = rewriteImportScripts(VITE_CONFIG, []);
    expect(next).toContain("export const PWA_WORKBOX_IMPORT_SCRIPTS = [] as const;");
    expect(readImportScripts(next)).toEqual([]);
  });

  it("flips clientsClaim without touching the import scripts", () => {
    const next = setClientsClaim(VITE_CONFIG, true);
    expect(next).toContain("export const PWA_WORKBOX_CLIENTS_CLAIM = true;");
    expect(readImportScripts(next)).toEqual(["sw-update-bridge-1.0.24.js"]);
  });

  it("throws when a declaration is missing", () => {
    expect(() => readImportScripts("const x = 1;")).toThrow(/expected form/);
    expect(() => rewriteImportScripts("const x = 1;", [])).toThrow(/expected form/);
    expect(() => setClientsClaim("const x = 1;", true)).toThrow(/expected form/);
  });
});

describe("bridge transition planning", () => {
  it("renames an existing bridge for the new version", () => {
    expect(planBridgeTransition({
      bridgeFiles: ["sw-update-bridge-1.0.24.js"],
      currentVersion: "1.0.24",
      targetVersion: "1.0.25",
      retireBridge: false,
    })).toEqual({ action: "rename", from: "sw-update-bridge-1.0.24.js", to: "sw-update-bridge-1.0.25.js" });
  });

  it("retires an existing bridge when requested", () => {
    expect(planBridgeTransition({
      bridgeFiles: ["sw-update-bridge-1.0.24.js"],
      currentVersion: "1.0.24",
      targetVersion: "1.0.25",
      retireBridge: true,
    })).toEqual({ action: "retire", from: "sw-update-bridge-1.0.24.js" });
  });

  it("plans no file work when no bridge exists", () => {
    for (const retireBridge of [false, true]) {
      expect(planBridgeTransition({
        bridgeFiles: [],
        currentVersion: "1.0.24",
        targetVersion: "1.0.25",
        retireBridge,
      })).toEqual({ action: "none" });
    }
  });

  it("rejects multiple bridges and misnamed bridges", () => {
    expect(() => planBridgeTransition({
      bridgeFiles: ["sw-update-bridge-1.0.23.js", "sw-update-bridge-1.0.24.js"],
      currentVersion: "1.0.24",
      targetVersion: "1.0.25",
      retireBridge: false,
    })).toThrow(/at most one/);
    expect(() => planBridgeTransition({
      bridgeFiles: ["sw-update-bridge-1.0.23.js"],
      currentVersion: "1.0.24",
      targetVersion: "1.0.25",
      retireBridge: false,
    })).toThrow(/not named for the current version/);
  });

  it("discovers only bridge files in a public directory", () => {
    const base = mkdtempSync(join(tmpdir(), "andoracle-bump-bridge-"));
    try {
      mkdirSync(base, { recursive: true });
      writeFileSync(join(base, "sw-update-bridge-1.0.24.js"), "");
      writeFileSync(join(base, "icon-512.png"), "");
      expect(findBridgeFiles(base)).toEqual(["sw-update-bridge-1.0.24.js"]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("atomic bump application", () => {
  it("bumps every version surface and renames the bridge", () => {
    const base = mkdtempSync(join(tmpdir(), "andoracle-bump-rename-"));
    const root = createFixtureRoot(base);
    const npm = fakeNpmVersion(root);

    try {
      const summary = applyBump({ root, targetVersion: "1.0.25", runNpmVersion: npm.runner });

      expect(npm.invokedWith).toEqual(["1.0.25"]);
      expect(summary.healedDrift).toBe(false);
      expect(summary.bridgeAction).toBe("rename");
      expect(readFileSync(join(root, "src", "version.ts"), "utf8"))
        .toContain('export const ANDORACLE_VERSION = "1.0.25" as const;');
      expect(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version).toBe("1.0.25");
      const lockfile = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
      expect(lockfile.version).toBe("1.0.25");
      expect(lockfile.packages[""].version).toBe("1.0.25");
      expect(findBridgeFiles(join(root, "public"))).toEqual(["sw-update-bridge-1.0.25.js"]);
      const bridge = readFileSync(join(root, "public", "sw-update-bridge-1.0.25.js"), "utf8");
      expect(bridge).toContain("Andoracle 1.0.25's automatic update path");
      expect(bridge).not.toContain("1.0.24");
      const viteConfig = readFileSync(join(root, "vite.config.ts"), "utf8");
      expect(readImportScripts(viteConfig)).toEqual(["sw-update-bridge-1.0.25.js"]);
      expect(readClientsClaim(viteConfig)).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("retires the bridge and restores Workbox ownership with --no-bridge", () => {
    const base = mkdtempSync(join(tmpdir(), "andoracle-bump-retire-"));
    const root = createFixtureRoot(base);
    const npm = fakeNpmVersion(root);

    try {
      const summary = applyBump({ root, targetVersion: "1.0.25", retireBridge: true, runNpmVersion: npm.runner });

      expect(summary.bridgeAction).toBe("retire");
      expect(findBridgeFiles(join(root, "public"))).toEqual([]);
      const viteConfig = readFileSync(join(root, "vite.config.ts"), "utf8");
      expect(readImportScripts(viteConfig)).toEqual([]);
      expect(readClientsClaim(viteConfig)).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("normalizes an already-retired tree with --no-bridge", () => {
    const base = mkdtempSync(join(tmpdir(), "andoracle-bump-normalize-"));
    const root = createFixtureRoot(base, { withBridge: false, retiredVite: true });
    const npm = fakeNpmVersion(root);

    try {
      const summary = applyBump({ root, targetVersion: "1.0.25", retireBridge: true, runNpmVersion: npm.runner });

      expect(summary.bridgeAction).toBe("none");
      expect(readImportScripts(readFileSync(join(root, "vite.config.ts"), "utf8"))).toEqual([]);
      expect(readClientsClaim(readFileSync(join(root, "vite.config.ts"), "utf8"))).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("refuses an inconsistent retired state without --no-bridge", () => {
    const base = mkdtempSync(join(tmpdir(), "andoracle-bump-inconsistent-"));
    const root = createFixtureRoot(base, { withBridge: false });
    const npm = fakeNpmVersion(root);

    try {
      expect(() => applyBump({ root, targetVersion: "1.0.25", runNpmVersion: npm.runner }))
        .toThrow(/Pass --no-bridge/);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("refuses a rename when clientsClaim was already restored", () => {
    const base = mkdtempSync(join(tmpdir(), "andoracle-bump-claim-"));
    const root = createFixtureRoot(base);
    writeFileSync(
      join(root, "vite.config.ts"),
      VITE_CONFIG.replace("PWA_WORKBOX_CLIENTS_CLAIM = false", "PWA_WORKBOX_CLIENTS_CLAIM = true"),
    );
    const npm = fakeNpmVersion(root);

    try {
      expect(() => applyBump({ root, targetVersion: "1.0.25", runNpmVersion: npm.runner }))
        .toThrow(/already restored/);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("heals pre-existing drift between src/version.ts and package.json", () => {
    const base = mkdtempSync(join(tmpdir(), "andoracle-bump-drift-"));
    const root = createFixtureRoot(base);
    writeFileSync(
      join(root, "src", "version.ts"),
      VERSION_SOURCE.replace('"1.0.24"', '"1.0.23"'),
    );
    const npm = fakeNpmVersion(root);

    try {
      const summary = applyBump({ root, targetVersion: "1.0.25", runNpmVersion: npm.runner });

      expect(summary.healedDrift).toBe(true);
      expect(readFileSync(join(root, "src", "version.ts"), "utf8"))
        .toContain('export const ANDORACLE_VERSION = "1.0.25" as const;');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("writes nothing during a dry run", () => {
    const base = mkdtempSync(join(tmpdir(), "andoracle-bump-dry-"));
    const root = createFixtureRoot(base);
    const before = [
      readFileSync(join(root, "src", "version.ts"), "utf8"),
      readFileSync(join(root, "package.json"), "utf8"),
      readFileSync(join(root, "vite.config.ts"), "utf8"),
      readFileSync(join(root, "public", "sw-update-bridge-1.0.24.js"), "utf8"),
    ];
    const npm = fakeNpmVersion(root);

    try {
      applyBump({ root, targetVersion: "1.0.25", dryRun: true, runNpmVersion: npm.runner });

      expect(npm.invokedWith).toEqual([]);
      expect([
        readFileSync(join(root, "src", "version.ts"), "utf8"),
        readFileSync(join(root, "package.json"), "utf8"),
        readFileSync(join(root, "vite.config.ts"), "utf8"),
        readFileSync(join(root, "public", "sw-update-bridge-1.0.24.js"), "utf8"),
      ]).toEqual(before);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

const npmAvailable = (() => {
  try {
    const result = spawnSync("npm", ["--version"], { shell: process.platform === "win32" });
    return !result.error && result.status === 0;
  } catch {
    return false;
  }
})();

  it.skipIf(!npmAvailable)("updates package.json and the lockfile through real npm version", () => {
    const base = mkdtempSync(join(tmpdir(), "andoracle-bump-npm-"));
    const root = createFixtureRoot(base);

    try {
      applyBump({ root, targetVersion: "1.0.25" });

      expect(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version).toBe("1.0.25");
      const lockfile = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
      expect(lockfile.version).toBe("1.0.25");
      expect(lockfile.packages[""].version).toBe("1.0.25");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
