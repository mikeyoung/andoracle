import { describe, expect, it, vi } from "vitest";
import { DEFAULT_PARAMS, PARAM_KEYS } from "./params";
import { FACTORY_PRESETS } from "./presets";
import {
  USER_PATCH_NAME_MAX_LENGTH,
  USER_PATCHES_STORAGE_KEY,
  deleteUserPatch,
  deleteUserPatchSafely,
  findUserPatch,
  hasUserPatchNamed,
  loadUserPatches,
  readUserPatches,
  saveUserPatch,
  saveUserPatchSafely,
  userPatchNameKey,
  userPatchNameCategory,
  type SafeDeleteUserPatchResult,
  type SafeSaveUserPatchResult,
  type UserPatch,
  type UserPatchLockManager,
  type UserPatchStorage,
} from "./user-patches";

class MemoryStorage implements UserPatchStorage {
  private readonly values = new Map<string, string>();
  writes = 0;

  constructor(initialValue?: string) {
    if (initialValue !== undefined) this.values.set(USER_PATCHES_STORAGE_KEY, initialValue);
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.writes += 1;
    this.values.set(key, value);
  }

  raw(): string | null {
    return this.getItem(USER_PATCHES_STORAGE_KEY);
  }
}

class IfAvailableLockManager implements UserPatchLockManager {
  private held = false;

  async request<T>(
    _name: string,
    _options: { readonly mode: "exclusive"; readonly ifAvailable: true },
    callback: (lock: unknown | null) => T | PromiseLike<T>,
  ): Promise<T> {
    await Promise.resolve();
    if (this.held) return callback(null);
    this.held = true;
    try {
      return await callback({});
    } finally {
      this.held = false;
    }
  }
}

const patchSnapshot = (name: string, params = DEFAULT_PARAMS): UserPatch => ({ name, params });

const requireStoredPatch = (name: string, storage: UserPatchStorage): UserPatch => {
  const patch = findUserPatch(name, storage);
  if (!patch) throw new Error(`Expected stored patch “${name}”.`);
  return patch;
};

describe("user patch storage", () => {
  it("categorically distinguishes user names from immutable default and factory names", () => {
    expect(userPatchNameCategory("  CUSTOM PATCH  ")).toBe("default");
    for (const preset of FACTORY_PRESETS) {
      expect(userPatchNameCategory(`  ${preset.name.toUpperCase()}  `), preset.name)
        .toBe(preset.name === "Init Andoracle" ? "default" : "factory");
    }
    expect(userPatchNameCategory("My Rubber Bass")).toBe("user");
    expect(userPatchNameCategory(" ")).toBe("user");
  });

  it("saves a trimmed name and a complete normalized parameter set", () => {
    const storage = new MemoryStorage();
    const result = saveUserPatch(" \u00a0Bright Lead\t", {
      ...DEFAULT_PARAMS,
      filterCutoff: 16_001,
      masterVolume: 0.7346,
    }, storage);

    expect(result.status).toBe("saved");
    if (result.status !== "saved") throw new Error("Expected the patch to be saved.");
    expect(result.patch.name).toBe("Bright Lead");
    expect(result.patch.params.filterCutoff).toBe(16_000);
    expect(result.patch.params.masterVolume).toBe(0.735);
    expect(Object.keys(result.patch.params).sort()).toEqual([...PARAM_KEYS].sort());

    const reread = readUserPatches(storage);
    expect(reread.status).toBe("ok");
    expect(reread.patches).toEqual([result.patch]);
  });

  it("rejects empty trimmed names without writing", () => {
    const storage = new MemoryStorage();

    const result = saveUserPatch(" \n\t ", DEFAULT_PARAMS, storage);

    expect(result).toEqual({ status: "empty-name", patches: [] });
    expect(storage.writes).toBe(0);
    expect(storage.raw()).toBeNull();
  });

  it("accepts exactly 33 trimmed characters and rejects a longer name without writing", () => {
    const storage = new MemoryStorage();
    const boundaryName = "P".repeat(USER_PATCH_NAME_MAX_LENGTH);

    expect(saveUserPatch(`  ${boundaryName}  `, DEFAULT_PARAMS, storage))
      .toMatchObject({ status: "saved", patch: { name: boundaryName } });
    const beforeRejectedSave = storage.raw();

    expect(saveUserPatch(`${boundaryName}X`, DEFAULT_PARAMS, storage)).toEqual({
      status: "name-too-long",
      maxLength: 33,
      patches: [{ name: boundaryName, params: DEFAULT_PARAMS }],
    });
    expect(storage.writes).toBe(1);
    expect(storage.raw()).toBe(beforeRejectedSave);
  });

  it("rejects duplicate names case-insensitively and never overwrites", () => {
    const storage = new MemoryStorage();
    const firstParams = { ...DEFAULT_PARAMS, filterCutoff: 800 };
    const replacementParams = { ...DEFAULT_PARAMS, filterCutoff: 4_000 };
    expect(saveUserPatch("Bass", firstParams, storage).status).toBe("saved");
    const beforeDuplicate = storage.raw();

    const duplicate = saveUserPatch("  bAsS  ", replacementParams, storage);

    expect(duplicate.status).toBe("duplicate-name");
    if (duplicate.status !== "duplicate-name") throw new Error("Expected a duplicate name.");
    expect(duplicate.existingName).toBe("Bass");
    expect(storage.writes).toBe(1);
    expect(storage.raw()).toBe(beforeDuplicate);
    expect(loadUserPatches(storage)[0].params.filterCutoff).toBe(800);
  });

  it("refuses to create default or factory identities at the storage boundary", () => {
    const storage = new MemoryStorage();

    expect(saveUserPatch(" custom PATCH ", DEFAULT_PARAMS, storage)).toEqual({
      status: "immutable-name",
      category: "default",
      immutableName: "Custom patch",
      patches: [],
    });
    expect(saveUserPatch("INIT ANDORACLE", DEFAULT_PARAMS, storage)).toEqual({
      status: "immutable-name",
      category: "default",
      immutableName: "Init Andoracle",
      patches: [],
    });
    expect(saveUserPatch(" rubber bass ", DEFAULT_PARAMS, storage)).toEqual({
      status: "immutable-name",
      category: "factory",
      immutableName: "Rubber Bass",
      patches: [],
    });
    expect(storage.writes).toBe(0);
    expect(storage.raw()).toBeNull();
  });

  it("treats canonically equivalent Unicode names as duplicates", () => {
    const storage = new MemoryStorage();
    expect(saveUserPatch("Café", DEFAULT_PARAMS, storage).status).toBe("saved");

    const duplicate = saveUserPatch("  CAFE\u0301  ", DEFAULT_PARAMS, storage);

    expect(duplicate.status).toBe("duplicate-name");
    expect(storage.writes).toBe(1);
  });

  it("case-folds expanding and positional Unicode letters for duplicate checks", () => {
    const storage = new MemoryStorage();
    expect(saveUserPatch("Straße", DEFAULT_PARAMS, storage).status).toBe("saved");
    expect(saveUserPatch("STRASSE", DEFAULT_PARAMS, storage).status).toBe("duplicate-name");
    expect(saveUserPatch("Σ", DEFAULT_PARAMS, storage).status).toBe("saved");
    expect(saveUserPatch("ς", DEFAULT_PARAMS, storage).status).toBe("duplicate-name");
  });

  it("preserves internal whitespace instead of collapsing the user's name", () => {
    const storage = new MemoryStorage();

    const result = saveUserPatch("  Wide  Pad  ", DEFAULT_PARAMS, storage);

    expect(result.status).toBe("saved");
    if (result.status !== "saved") throw new Error("Expected the patch to be saved.");
    expect(result.patch.name).toBe("Wide  Pad");
  });

  it("appends distinct patches while preserving the existing patch", () => {
    const storage = new MemoryStorage();
    saveUserPatch("One", { ...DEFAULT_PARAMS, lfoRate: 1 }, storage);

    const second = saveUserPatch("Two", { ...DEFAULT_PARAMS, lfoRate: 2 }, storage);

    expect(second.status).toBe("saved");
    expect(loadUserPatches(storage).map((patch) => [patch.name, patch.params.lfoRate])).toEqual([
      ["One", 1],
      ["Two", 2],
    ]);
  });

  it("stores an immutable snapshot rather than retaining the caller's object", () => {
    const storage = new MemoryStorage();
    const currentPatch = { ...DEFAULT_PARAMS, filterCutoff: 1_234 };
    expect(saveUserPatch("Snapshot", currentPatch, storage).status).toBe("saved");

    currentPatch.filterCutoff = 9_876;

    expect(findUserPatch("Snapshot", storage)?.params.filterCutoff).toBe(1_234);
  });

  it("recovers valid records, ignores corrupt records, and keeps the first duplicate", () => {
    const storage = new MemoryStorage(JSON.stringify({
      version: 1,
      patches: [
        {
          name: "  Lead  ",
          params: {
            filterCutoff: 20_000,
            delayEnabled: 0.6,
            masterVolume: "loud",
            unknownFutureControl: 12,
          },
        },
        { name: "lead", params: { filterCutoff: 16 } },
        { name: "   ", params: {} },
        { name: "Broken params", params: null },
        null,
      ],
    }));
    const originalValue = storage.raw();

    const result = readUserPatches(storage);

    expect(result.status).toBe("recovered");
    expect(result.patches).toHaveLength(1);
    expect(result.patches[0].name).toBe("Lead");
    expect(result.patches[0].params.filterCutoff).toBe(16_000);
    expect(result.patches[0].params.delayEnabled).toBe(1);
    expect(result.patches[0].params.masterVolume).toBe(DEFAULT_PARAMS.masterVolume);
    expect(Object.keys(result.patches[0].params).sort()).toEqual([...PARAM_KEYS].sort());
    expect(storage.writes).toBe(0);
    expect(storage.raw()).toBe(originalValue);
  });

  it("migrates every distinct legacy long name with deterministic collision-safe suffixes", () => {
    const fullWidthName = "A".repeat(USER_PATCH_NAME_MAX_LENGTH);
    const suffixTwoName = `${"A".repeat(USER_PATCH_NAME_MAX_LENGTH - 4)} (2)`;
    const longFirst = "A".repeat(USER_PATCH_NAME_MAX_LENGTH + 7);
    const longSecond = `${"A".repeat(USER_PATCH_NAME_MAX_LENGTH + 6)}B`;
    const factoryPrefixLongName = `Custom patch${" ".repeat(30)}legacy`;
    const storage = new MemoryStorage(JSON.stringify({
      version: 1,
      patches: [
        { name: longFirst, params: { ...DEFAULT_PARAMS, filterCutoff: 1_101 } },
        { name: longSecond, params: { ...DEFAULT_PARAMS, filterCutoff: 1_102 } },
        { name: longFirst.toLowerCase(), params: { ...DEFAULT_PARAMS, filterCutoff: 9_999 } },
        { name: factoryPrefixLongName, params: { ...DEFAULT_PARAMS, filterCutoff: 1_103 } },
        // These appear later deliberately: valid short identities must win
        // their exact names before any earlier long record is truncated.
        { name: fullWidthName, params: { ...DEFAULT_PARAMS, filterCutoff: 1_104 } },
        { name: suffixTwoName, params: { ...DEFAULT_PARAMS, filterCutoff: 1_105 } },
        { name: "Custom patch (2)", params: { ...DEFAULT_PARAMS, filterCutoff: 1_106 } },
      ],
    }));
    const originalValue = storage.raw();

    const firstRead = readUserPatches(storage);
    const secondRead = readUserPatches(storage);

    expect(firstRead).toEqual(secondRead);
    expect(firstRead.status).toBe("recovered");
    expect(firstRead.patches.map((patch) => [patch.name, patch.params.filterCutoff])).toEqual([
      [`${"A".repeat(USER_PATCH_NAME_MAX_LENGTH - 4)} (3)`, 1_101],
      [`${"A".repeat(USER_PATCH_NAME_MAX_LENGTH - 4)} (4)`, 1_102],
      ["Custom patch (3)", 1_103],
      [fullWidthName, 1_104],
      [suffixTwoName, 1_105],
      ["Custom patch (2)", 1_106],
    ]);
    expect(firstRead.patches).toHaveLength(6);
    expect(new Set(firstRead.patches.map((patch) => userPatchNameKey(patch.name))).size).toBe(6);
    for (const patch of firstRead.patches) {
      expect(patch.name.length).toBeLessThanOrEqual(USER_PATCH_NAME_MAX_LENGTH);
      expect(userPatchNameCategory(patch.name)).toBe("user");
    }
    expect(storage.writes).toBe(0);
    expect(storage.raw()).toBe(originalValue);

    expect(saveUserPatch("Fresh", DEFAULT_PARAMS, storage).status).toBe("saved");
    expect(readUserPatches(storage)).toMatchObject({
      status: "ok",
      patches: [...firstRead.patches, { name: "Fresh" }],
    });
  });

  it("keeps first-record-wins Unicode duplicate recovery while shortening its display name", () => {
    const composed = `${"Q".repeat(29)}Café extension`;
    const decomposedEquivalent = `${"q".repeat(29)}CAFE\u0301 EXTENSION`;
    const storage = new MemoryStorage(JSON.stringify({
      version: 1,
      patches: [
        { name: composed, params: { ...DEFAULT_PARAMS, filterCutoff: 1_201 } },
        { name: decomposedEquivalent, params: { ...DEFAULT_PARAMS, filterCutoff: 9_999 } },
      ],
    }));

    const result = readUserPatches(storage);

    expect(result.status).toBe("recovered");
    expect(result.patches).toHaveLength(1);
    expect(result.patches[0]).toMatchObject({
      name: `${"Q".repeat(29)}Café`,
      params: { filterCutoff: 1_201 },
    });
    expect(result.patches[0].name.length).toBe(USER_PATCH_NAME_MAX_LENGTH);
  });

  it("migrates historical user snapshots whose names later become immutable", () => {
    const storage = new MemoryStorage(JSON.stringify({
      version: 1,
      patches: [
        { name: "Custom patch", params: { ...DEFAULT_PARAMS, filterCutoff: 701 } },
        { name: " init andoracle ", params: { ...DEFAULT_PARAMS, filterCutoff: 702 } },
        { name: "RUBBER BASS", params: { ...DEFAULT_PARAMS, filterCutoff: 703 } },
        { name: "Mine", params: { ...DEFAULT_PARAMS, filterCutoff: 704 } },
      ],
    }));
    const originalValue = storage.raw();

    const result = readUserPatches(storage);

    expect(result.status).toBe("recovered");
    expect(result.patches.map((patch) => [patch.name, patch.params.filterCutoff])).toEqual([
      ["Custom patch (user patch)", 701],
      ["Init Andoracle (user patch)", 702],
      ["Rubber Bass (user patch)", 703],
      ["Mine", 704],
    ]);
    for (const patch of result.patches) expect(userPatchNameCategory(patch.name)).toBe("user");
    expect(storage.writes).toBe(0);
    expect(storage.raw()).toBe(originalValue);
  });

  it("reserves existing user suffixes before naming a migrated collision", () => {
    const storage = new MemoryStorage(JSON.stringify({
      version: 1,
      patches: [
        { name: "Before", params: { ...DEFAULT_PARAMS, filterCutoff: 801 } },
        { name: " rubber bass ", params: { ...DEFAULT_PARAMS, filterCutoff: 802 } },
        { name: "RUBBER BASS", params: { ...DEFAULT_PARAMS, filterCutoff: 8_999 } },
        { name: "Rubber Bass (user patch 2)", params: { ...DEFAULT_PARAMS, filterCutoff: 803 } },
        { name: "rubber bass (USER PATCH)", params: { ...DEFAULT_PARAMS, filterCutoff: 804 } },
        { name: "After", params: { ...DEFAULT_PARAMS, filterCutoff: 805 } },
      ],
    }));

    const result = readUserPatches(storage);

    expect(result.status).toBe("recovered");
    expect(result.patches.map((patch) => [patch.name, patch.params.filterCutoff])).toEqual([
      ["Before", 801],
      ["Rubber Bass (user patch 3)", 802],
      ["Rubber Bass (user patch 2)", 803],
      ["rubber bass (USER PATCH)", 804],
      ["After", 805],
    ]);
  });

  it("returns the same collision migration on every non-mutating read", () => {
    const storage = new MemoryStorage(JSON.stringify({
      version: 1,
      patches: [
        { name: "Rubber Bass", params: { ...DEFAULT_PARAMS, filterCutoff: 901 } },
        { name: "Rubber Bass (user patch)", params: { ...DEFAULT_PARAMS, filterCutoff: 902 } },
      ],
    }));
    const originalValue = storage.raw();

    const first = readUserPatches(storage);
    const second = readUserPatches(storage);
    const third = readUserPatches(storage);

    expect(first).toEqual(second);
    expect(second).toEqual(third);
    expect(first).toMatchObject({
      status: "recovered",
      patches: [
        { name: "Rubber Bass (user patch 2)", params: { filterCutoff: 901 } },
        { name: "Rubber Bass (user patch)", params: { filterCutoff: 902 } },
      ],
    });
    expect(storage.writes).toBe(0);
    expect(storage.raw()).toBe(originalValue);
  });

  it("persists migrated snapshots through later save and delete transactions", () => {
    const storage = new MemoryStorage(JSON.stringify({
      version: 1,
      patches: [
        { name: "Rubber Bass", params: { ...DEFAULT_PARAMS, filterCutoff: 1_001 } },
        { name: "Keep", params: { ...DEFAULT_PARAMS, filterCutoff: 1_002 } },
      ],
    }));

    const migrated = requireStoredPatch("Rubber Bass (user patch)", storage);
    expect(migrated.params.filterCutoff).toBe(1_001);
    expect(saveUserPatch("New", { ...DEFAULT_PARAMS, filterCutoff: 1_003 }, storage))
      .toMatchObject({ status: "saved", patch: { name: "New" } });
    expect(readUserPatches(storage)).toMatchObject({
      status: "ok",
      patches: [
        { name: "Rubber Bass (user patch)", params: { filterCutoff: 1_001 } },
        { name: "Keep", params: { filterCutoff: 1_002 } },
        { name: "New", params: { filterCutoff: 1_003 } },
      ],
    });

    expect(deleteUserPatch(migrated, storage)).toMatchObject({
      status: "deleted",
      deletedName: "Rubber Bass (user patch)",
      patches: [{ name: "Keep" }, { name: "New" }],
    });
    expect(readUserPatches(storage)).toMatchObject({
      status: "ok",
      patches: [{ name: "Keep" }, { name: "New" }],
    });
    expect(saveUserPatch("Rubber Bass", DEFAULT_PARAMS, storage)).toMatchObject({
      status: "immutable-name",
      category: "factory",
      immutableName: "Rubber Bass",
      patches: [{ name: "Keep" }, { name: "New" }],
    });
    expect(deleteUserPatch(patchSnapshot("Rubber Bass"), storage)).toMatchObject({
      status: "immutable-name",
      category: "factory",
      immutableName: "Rubber Bass",
      patches: [{ name: "Keep" }, { name: "New" }],
    });
  });

  it("returns an empty recovered collection for malformed serialized data", () => {
    const storage = new MemoryStorage("{ definitely not json");

    expect(readUserPatches(storage)).toEqual({ status: "recovered", patches: [] });
    expect(loadUserPatches(storage)).toEqual([]);
    expect(storage.writes).toBe(0);
  });

  it("can explicitly save a new patch after recovering malformed data", () => {
    const storage = new MemoryStorage(JSON.stringify({ patches: "invalid" }));

    const result = saveUserPatch("Recovery", DEFAULT_PARAMS, storage);

    expect(result.status).toBe("saved");
    expect(readUserPatches(storage)).toMatchObject({
      status: "ok",
      patches: [{ name: "Recovery" }],
    });
  });

  it("preserves an unsupported library version instead of overwriting it", () => {
    const storage = new MemoryStorage(JSON.stringify({ version: 2, patches: [] }));
    const beforeSave = storage.raw();

    expect(readUserPatches(storage)).toEqual({ status: "unsupported-version", patches: [] });
    expect(saveUserPatch("Do not overwrite", DEFAULT_PARAMS, storage)).toEqual({
      status: "unsupported-version",
      patches: [],
    });
    expect(storage.writes).toBe(0);
    expect(storage.raw()).toBe(beforeSave);
  });

  it("finds names with trimmed, case-insensitive matching", () => {
    const storage = new MemoryStorage();
    saveUserPatch("Slow Pad", { ...DEFAULT_PARAMS, adsrAttack: 2 }, storage);

    expect(findUserPatch("  SLOW PAD ", storage)?.params.adsrAttack).toBe(2);
    expect(findUserPatch("missing", storage)).toBeNull();
    expect(findUserPatch("   ", storage)).toBeNull();
  });

  it("checks an in-memory library with the same canonical name rules", () => {
    const patches = [
      { name: "Café", params: DEFAULT_PARAMS },
      { name: "Wide  Pad", params: DEFAULT_PARAMS },
    ];

    expect(hasUserPatchNamed(patches, "  CAFE\u0301  ")).toBe(true);
    expect(hasUserPatchNamed(patches, "wide  pad")).toBe(true);
    expect(hasUserPatchNamed(patches, "Wide Pad")).toBe(false);
    expect(hasUserPatchNamed(patches, "   ")).toBe(false);
    expect(hasUserPatchNamed([], "Café")).toBe(false);
  });

  it("deletes a canonically matched user patch and preserves the remaining order", () => {
    const storage = new MemoryStorage();
    saveUserPatch("One", { ...DEFAULT_PARAMS, lfoRate: 1 }, storage);
    saveUserPatch("Café", { ...DEFAULT_PARAMS, lfoRate: 2 }, storage);
    saveUserPatch("Three", { ...DEFAULT_PARAMS, lfoRate: 3 }, storage);

    const expected = { ...requireStoredPatch("Café", storage), name: "  CAFE\u0301  " };
    const result = deleteUserPatch(expected, storage);

    expect(result).toMatchObject({
      status: "deleted",
      deletedName: "Café",
    });
    expect(result.patches.map((patch) => [patch.name, patch.params.lfoRate])).toEqual([
      ["One", 1],
      ["Three", 3],
    ]);
    expect(loadUserPatches(storage).map((patch) => patch.name)).toEqual(["One", "Three"]);
    expect(storage.writes).toBe(4);
  });

  it("deletes the final user patch into a valid empty collection", () => {
    const storage = new MemoryStorage();
    saveUserPatch("Only", DEFAULT_PARAMS, storage);

    expect(deleteUserPatch(requireStoredPatch("Only", storage), storage)).toMatchObject({
      status: "deleted",
      deletedName: "Only",
      patches: [],
    });
    expect(readUserPatches(storage)).toEqual({ status: "ok", patches: [] });
  });

  it("does not accumulate ghost entries through repeated save/delete churn", () => {
    const storage = new MemoryStorage();

    for (let iteration = 0; iteration < 1_000; iteration += 1) {
      const saved = saveUserPatch("Reusable patch", DEFAULT_PARAMS, storage);
      if (saved.status !== "saved") throw new Error(`Save churn failed at ${iteration}.`);
      const deleted = deleteUserPatch(saved.patch, storage);
      if (deleted.status !== "deleted") throw new Error(`Delete churn failed at ${iteration}.`);
    }

    expect(readUserPatches(storage)).toEqual({ status: "ok", patches: [] });
    expect(JSON.parse(storage.raw() as string)).toEqual({ version: 1, patches: [] });
    expect(storage.writes).toBe(2_000);
  });

  it("does not write for an empty or stale deletion target and returns the fresh library", () => {
    const storage = new MemoryStorage();
    saveUserPatch("Still here", DEFAULT_PARAMS, storage);
    const beforeDelete = storage.raw();

    expect(deleteUserPatch(patchSnapshot(" \t\n "), storage)).toEqual({
      status: "empty-name",
      patches: loadUserPatches(storage),
    });
    expect(deleteUserPatch(patchSnapshot("Already removed"), storage)).toEqual({
      status: "not-found",
      patches: loadUserPatches(storage),
    });
    expect(storage.writes).toBe(1);
    expect(storage.raw()).toBe(beforeDelete);
  });

  it("categorically refuses to delete default and factory identities", () => {
    const storage = new MemoryStorage();
    saveUserPatch("Mine", DEFAULT_PARAMS, storage);
    const beforeDelete = storage.raw();

    expect(deleteUserPatch(patchSnapshot(" custom PATCH "), storage)).toMatchObject({
      status: "immutable-name",
      category: "default",
      immutableName: "Custom patch",
      patches: [{ name: "Mine" }],
    });
    expect(deleteUserPatch(patchSnapshot("INIT ANDORACLE"), storage)).toMatchObject({
      status: "immutable-name",
      category: "default",
      immutableName: "Init Andoracle",
    });
    expect(deleteUserPatch(patchSnapshot(" metallic xor "), storage)).toMatchObject({
      status: "immutable-name",
      category: "factory",
      immutableName: "Metallic XOR",
    });
    expect(storage.writes).toBe(1);
    expect(storage.raw()).toBe(beforeDelete);
  });

  it("canonicalizes recoverable records when deleting a valid patch from malformed storage", () => {
    const storage = new MemoryStorage(JSON.stringify({
      version: 1,
      patches: [
        { name: "  Delete me ", params: { filterCutoff: 777 } },
        { name: " Keep me ", params: { lfoRate: 2.2 } },
        { nope: true },
      ],
    }));

    const expected = { ...requireStoredPatch("Delete me", storage), name: "delete ME" };
    expect(deleteUserPatch(expected, storage)).toMatchObject({
      status: "deleted",
      deletedName: "Delete me",
      patches: [{ name: "Keep me" }],
    });
    expect(readUserPatches(storage)).toMatchObject({
      status: "ok",
      patches: [{ name: "Keep me", params: { lfoRate: 2.2 } }],
    });
    expect(storage.writes).toBe(1);
  });

  it("preserves wholly malformed storage when a deletion target cannot be found", () => {
    const storage = new MemoryStorage("{ definitely not json");
    const beforeDelete = storage.raw();

    expect(deleteUserPatch(patchSnapshot("Missing"), storage)).toEqual({ status: "not-found", patches: [] });
    expect(storage.writes).toBe(0);
    expect(storage.raw()).toBe(beforeDelete);
  });

  it("preserves a newer storage schema instead of deleting from it", () => {
    const storage = new MemoryStorage(JSON.stringify({
      version: 2,
      patches: [{ name: "Mine", params: DEFAULT_PARAMS }],
    }));
    const beforeDelete = storage.raw();

    expect(deleteUserPatch(patchSnapshot("Mine"), storage)).toEqual({
      status: "unsupported-version",
      patches: [],
    });
    expect(storage.writes).toBe(0);
    expect(storage.raw()).toBe(beforeDelete);
  });

  it("distinguishes read and write storage failures", () => {
    const readFailure: UserPatchStorage = {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => undefined,
    };
    const writeFailure: UserPatchStorage = {
      getItem: () => null,
      setItem: () => { throw new Error("quota"); },
    };

    expect(readUserPatches(readFailure)).toEqual({ status: "storage-error", patches: [] });
    expect(saveUserPatch("Patch", DEFAULT_PARAMS, readFailure)).toEqual({
      status: "storage-error",
      patches: [],
    });
    expect(saveUserPatch("Patch", DEFAULT_PARAMS, writeFailure)).toEqual({
      status: "storage-error",
      patches: [],
    });
    expect(deleteUserPatch(patchSnapshot("Patch"), readFailure)).toEqual({
      status: "storage-error",
      patches: [],
    });
    const populatedWriteFailure: UserPatchStorage = {
      getItem: () => JSON.stringify({
        version: 1,
        patches: [{ name: "Patch", params: DEFAULT_PARAMS }],
      }),
      setItem: () => { throw new Error("quota"); },
    };
    expect(deleteUserPatch(requireStoredPatch("Patch", populatedWriteFailure), populatedWriteFailure)).toMatchObject({
      status: "storage-error",
      patches: [{ name: "Patch" }],
    });
  });

  it("allows only one simultaneous same-name save to enter the write transaction", async () => {
    const storage = new MemoryStorage();
    const locks = new IfAvailableLockManager();

    const [first, second] = await Promise.all([
      saveUserPatchSafely("Concurrent", { ...DEFAULT_PARAMS, filterCutoff: 800 }, storage, locks),
      saveUserPatchSafely(" concurrent ", { ...DEFAULT_PARAMS, filterCutoff: 4_000 }, storage, locks),
    ]);

    expect(first.status).toBe("saved");
    expect(second.status).toBe("busy");
    expect(storage.writes).toBe(1);
    expect(findUserPatch("Concurrent", storage)?.params.filterCutoff).toBe(800);
  });

  it("asks a simultaneous distinct-name save to retry instead of losing either patch", async () => {
    const storage = new MemoryStorage();
    const locks = new IfAvailableLockManager();

    const results = await Promise.all([
      saveUserPatchSafely("One", DEFAULT_PARAMS, storage, locks),
      saveUserPatchSafely("Two", DEFAULT_PARAMS, storage, locks),
    ]);

    expect(results.map((result) => result.status)).toEqual(["saved", "busy"]);
    expect((await saveUserPatchSafely("Two", DEFAULT_PARAMS, storage, locks)).status).toBe("saved");
    expect(loadUserPatches(storage).map((patch) => patch.name)).toEqual(["One", "Two"]);
  });

  it("serializes delete against save so cross-tab writes cannot lose or resurrect patches", async () => {
    const storage = new MemoryStorage();
    saveUserPatch("Victim", DEFAULT_PARAMS, storage);
    const locks = new IfAvailableLockManager();

    const victim = requireStoredPatch("Victim", storage);
    const deleting = deleteUserPatchSafely(victim, storage, locks);
    const blockedSave = saveUserPatchSafely("Concurrent", DEFAULT_PARAMS, storage, locks);

    await expect(blockedSave).resolves.toMatchObject({
      status: "busy",
      patches: [{ name: "Victim" }],
    });
    await expect(deleting).resolves.toMatchObject({
      status: "deleted",
      deletedName: "Victim",
      patches: [],
    });
    await expect(saveUserPatchSafely("Concurrent", DEFAULT_PARAMS, storage, locks))
      .resolves.toMatchObject({ status: "saved", patch: { name: "Concurrent" } });
    expect(loadUserPatches(storage).map((patch) => patch.name)).toEqual(["Concurrent"]);
  });

  it("rejects a same-name replacement discovered inside the deletion lock", async () => {
    const storage = new MemoryStorage();
    saveUserPatch("Target", { ...DEFAULT_PARAMS, filterCutoff: 800 }, storage);
    const expected = requireStoredPatch("Target", storage);
    const locks = new IfAvailableLockManager();

    const deleting = deleteUserPatchSafely(expected, storage, locks);
    storage.setItem(USER_PATCHES_STORAGE_KEY, JSON.stringify({
      version: 1,
      patches: [{
        name: " target ",
        params: { ...DEFAULT_PARAMS, filterCutoff: 4_000 },
      }],
    }));
    const writesBeforeDeletionSettled = storage.writes;

    await expect(deleting).resolves.toMatchObject({
      status: "stale-target",
      currentPatch: {
        name: "target",
        params: { filterCutoff: 4_000 },
      },
      patches: [{
        name: "target",
        params: { filterCutoff: 4_000 },
      }],
    });
    expect(storage.writes).toBe(writesBeforeDeletionSettled);
    expect(findUserPatch("Target", storage)?.params.filterCutoff).toBe(4_000);
  });

  it("snapshots the confirmed target before a delayed host lock can observe caller mutation", async () => {
    const storage = new MemoryStorage();
    saveUserPatch("Target", { ...DEFAULT_PARAMS, filterCutoff: 800 }, storage);
    saveUserPatch("Other", { ...DEFAULT_PARAMS, filterCutoff: 4_000 }, storage);
    const target = requireStoredPatch("Target", storage);
    const mutableExpected = { name: target.name, params: { ...target.params } };
    let releaseLock!: () => void;
    const locks: UserPatchLockManager = {
      request<T>(
        _name: string,
        _options: { readonly mode: "exclusive"; readonly ifAvailable: true },
        callback: (lock: unknown | null) => T | PromiseLike<T>,
      ): Promise<T> {
        return new Promise<T>((resolve) => {
          releaseLock = () => {
            void Promise.resolve(callback({})).then(resolve);
          };
        });
      },
    };

    const deleting = deleteUserPatchSafely(mutableExpected, storage, locks);
    mutableExpected.name = "Other";
    mutableExpected.params.filterCutoff = 4_000;
    releaseLock();

    await expect(deleting).resolves.toMatchObject({
      status: "deleted",
      deletedName: "Target",
      patches: [{ name: "Other" }],
    });
    expect(loadUserPatches(storage).map((patch) => patch.name)).toEqual(["Other"]);
  });

  it("revokes deletion authority before a delayed lock callback can run", async () => {
    const storage = new MemoryStorage();
    saveUserPatch("Cancelled authority", DEFAULT_PARAMS, storage);
    const expected = requireStoredPatch("Cancelled authority", storage);
    const locks = new IfAvailableLockManager();
    const controller = new AbortController();

    const pending = deleteUserPatchSafely(expected, storage, locks, controller.signal);
    controller.abort();

    await expect(pending).resolves.toMatchObject({
      status: "busy",
      patches: [{ name: "Cancelled authority" }],
    });
    expect(findUserPatch("Cancelled authority", storage)).toEqual(expected);
    expect(storage.writes).toBe(1);
  });

  it("never falls back to deleting after an aborted lock request rejects", async () => {
    const storage = new MemoryStorage();
    saveUserPatch("Cancelled rejection", DEFAULT_PARAMS, storage);
    const expected = requireStoredPatch("Cancelled rejection", storage);
    let rejectRequest!: (error: Error) => void;
    const request = new Promise<SafeDeleteUserPatchResult>((_resolve, reject) => {
      rejectRequest = reject;
    });
    const locks: UserPatchLockManager = {
      request: vi.fn(() => request),
    } as UserPatchLockManager;
    const controller = new AbortController();

    const pending = deleteUserPatchSafely(expected, storage, locks, controller.signal);
    controller.abort();
    rejectRequest(new Error("late host failure"));

    await expect(pending).resolves.toMatchObject({
      status: "busy",
      patches: [{ name: "Cancelled rejection" }],
    });
    expect(findUserPatch("Cancelled rejection", storage)).toEqual(expected);
    expect(storage.writes).toBe(1);
  });

  it("quarantines an unresponsive aborted lock without bypassing it, then rehabilitates it", async () => {
    vi.useFakeTimers();
    try {
      const storage = new MemoryStorage();
      saveUserPatch("Keep after timeout", DEFAULT_PARAMS, storage);
      const expected = requireStoredPatch("Keep after timeout", storage);
      let releaseRequest!: () => void;
      let requestCount = 0;
      const locks: UserPatchLockManager = {
        request<T>(
          _name: string,
          _options: { readonly mode: "exclusive"; readonly ifAvailable: true },
          callback: (lock: unknown | null) => T | PromiseLike<T>,
        ): Promise<T> {
          requestCount += 1;
          if (requestCount > 1) return Promise.resolve(callback({}));
          return new Promise<T>((resolve) => {
            releaseRequest = () => { void Promise.resolve(callback({})).then(resolve); };
          });
        },
      };
      const controller = new AbortController();

      const abandoned = deleteUserPatchSafely(expected, storage, locks, controller.signal);
      controller.abort(new DOMException("timed out", "TimeoutError"));
      await vi.advanceTimersByTimeAsync(10_001);

      await expect(saveUserPatchSafely("Unsafe bypass", DEFAULT_PARAMS, storage, locks))
        .resolves.toMatchObject({ status: "busy", patches: [{ name: "Keep after timeout" }] });
      expect(requestCount).toBe(1);
      expect(storage.writes).toBe(1);
      releaseRequest();
      await expect(abandoned).resolves.toMatchObject({ status: "busy" });
      expect(vi.getTimerCount()).toBe(0);

      await expect(saveUserPatchSafely("Recovered write", DEFAULT_PARAMS, storage, locks))
        .resolves.toMatchObject({ status: "saved", patch: { name: "Recovered write" } });
      expect(requestCount).toBe(2);
      expect(loadUserPatches(storage).map((patch) => patch.name))
        .toEqual(["Keep after timeout", "Recovered write"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a slow lock serialized and usable when it settles before quarantine", async () => {
    vi.useFakeTimers();
    try {
      const storage = new MemoryStorage();
      saveUserPatch("Slow target", DEFAULT_PARAMS, storage);
      const expected = requireStoredPatch("Slow target", storage);
      let releaseRequest!: () => void;
      let requestCount = 0;
      const locks: UserPatchLockManager = {
        request<T>(
          _name: string,
          _options: { readonly mode: "exclusive"; readonly ifAvailable: true },
          callback: (lock: unknown | null) => T | PromiseLike<T>,
        ): Promise<T> {
          requestCount += 1;
          if (requestCount > 1) return Promise.resolve(callback({}));
          return new Promise<T>((resolve) => {
            releaseRequest = () => { void Promise.resolve(callback({})).then(resolve); };
          });
        },
      };
      const controller = new AbortController();

      const abandoned = deleteUserPatchSafely(expected, storage, locks, controller.signal);
      controller.abort();
      await vi.advanceTimersByTimeAsync(5_000);
      releaseRequest();
      await expect(abandoned).resolves.toMatchObject({ status: "busy" });
      expect(vi.getTimerCount()).toBe(0);

      await expect(saveUserPatchSafely("Healthy next write", DEFAULT_PARAMS, storage, locks))
        .resolves.toMatchObject({ status: "saved", patch: { name: "Healthy next write" } });
      expect(requestCount).toBe(2);
      expect(loadUserPatches(storage).map((patch) => patch.name))
        .toEqual(["Slow target", "Healthy next write"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("serializes save against delete and allows the deletion on retry", async () => {
    const storage = new MemoryStorage();
    saveUserPatch("Keep", DEFAULT_PARAMS, storage);
    const locks = new IfAvailableLockManager();

    const keep = requireStoredPatch("Keep", storage);
    const saving = saveUserPatchSafely("New", DEFAULT_PARAMS, storage, locks);
    const blockedDelete = deleteUserPatchSafely(keep, storage, locks);

    await expect(blockedDelete).resolves.toMatchObject({
      status: "busy",
      patches: [{ name: "Keep" }],
    });
    await expect(saving).resolves.toMatchObject({
      status: "saved",
      patch: { name: "New" },
    });
    await expect(deleteUserPatchSafely(keep, storage, locks))
      .resolves.toMatchObject({ status: "deleted", deletedName: "Keep" });
    expect(loadUserPatches(storage).map((patch) => patch.name)).toEqual(["New"]);
  });

  it("returns busy without writing when another tab owns the patch lock", async () => {
    const storage = new MemoryStorage();
    const unavailableLock: UserPatchLockManager = {
      request: async (_name, _options, callback) => callback(null),
    };

    const result = await saveUserPatchSafely("Wait", DEFAULT_PARAMS, storage, unavailableLock);

    expect(result).toEqual({ status: "busy", patches: [] });
    expect(storage.writes).toBe(0);
  });

  it("returns a fresh busy snapshot without deleting when another tab owns the patch lock", async () => {
    const storage = new MemoryStorage();
    saveUserPatch("Wait", DEFAULT_PARAMS, storage);
    const unavailableLock: UserPatchLockManager = {
      request: async (_name, _options, callback) => callback(null),
    };

    const result = await deleteUserPatchSafely(requireStoredPatch("Wait", storage), storage, unavailableLock);

    expect(result).toMatchObject({ status: "busy", patches: [{ name: "Wait" }] });
    expect(loadUserPatches(storage).map((patch) => patch.name)).toEqual(["Wait"]);
    expect(storage.writes).toBe(1);
  });

  it("bounds repeated saves behind one never-settling host lock request", async () => {
    const storage = new MemoryStorage();
    const neverSettles = new Promise<SafeSaveUserPatchResult>(() => undefined);
    const request = vi.fn(() => neverSettles);
    const locks: UserPatchLockManager = { request } as UserPatchLockManager;

    void saveUserPatchSafely("First", DEFAULT_PARAMS, storage, locks);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await expect(saveUserPatchSafely(`Retry ${attempt}`, DEFAULT_PARAMS, storage, locks))
        .resolves.toEqual({ status: "busy", patches: [] });
    }

    expect(request).toHaveBeenCalledTimes(1);
    expect(storage.writes).toBe(0);
  });

  it("bounds mixed saves and deletes behind one never-settling host lock request", async () => {
    const storage = new MemoryStorage();
    saveUserPatch("Victim", DEFAULT_PARAMS, storage);
    const neverSettles = new Promise<SafeDeleteUserPatchResult>(() => undefined);
    const request = vi.fn(() => neverSettles);
    const locks: UserPatchLockManager = { request } as UserPatchLockManager;

    const victim = requireStoredPatch("Victim", storage);
    void deleteUserPatchSafely(victim, storage, locks);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const operation = attempt % 2 === 0
        ? saveUserPatchSafely(`Retry ${attempt}`, DEFAULT_PARAMS, storage, locks)
        : deleteUserPatchSafely(victim, storage, locks);
      await expect(operation).resolves.toMatchObject({ status: "busy" });
    }

    expect(request).toHaveBeenCalledTimes(1);
    expect(loadUserPatches(storage).map((patch) => patch.name)).toEqual(["Victim"]);
    expect(storage.writes).toBe(1);
  });

  it("allows a fresh lock request after the raw request actually settles", async () => {
    const storage = new MemoryStorage();
    let resolveFirst!: (result: SafeSaveUserPatchResult) => void;
    const first = new Promise<SafeSaveUserPatchResult>((resolve) => {
      resolveFirst = resolve;
    });
    const request = vi.fn()
      .mockReturnValueOnce(first)
      .mockImplementationOnce((_name, _options, callback) => Promise.resolve(callback({})));
    const locks: UserPatchLockManager = { request } as UserPatchLockManager;

    const pending = saveUserPatchSafely("First", DEFAULT_PARAMS, storage, locks);
    await expect(saveUserPatchSafely("Blocked", DEFAULT_PARAMS, storage, locks))
      .resolves.toMatchObject({ status: "busy" });
    resolveFirst({ status: "busy", patches: [] });
    await expect(pending).resolves.toMatchObject({ status: "busy" });

    await expect(saveUserPatchSafely("Retry", DEFAULT_PARAMS, storage, locks))
      .resolves.toMatchObject({ status: "saved", patch: { name: "Retry" } });
    expect(request).toHaveBeenCalledTimes(2);
  });
});
