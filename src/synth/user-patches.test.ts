import { describe, expect, it, vi } from "vitest";
import { DEFAULT_PARAMS, PARAM_KEYS } from "./params";
import {
  USER_PATCHES_STORAGE_KEY,
  findUserPatch,
  hasUserPatchNamed,
  loadUserPatches,
  readUserPatches,
  saveUserPatch,
  saveUserPatchSafely,
  type SafeSaveUserPatchResult,
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

describe("user patch storage", () => {
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

  it("returns busy without writing when another tab owns the patch lock", async () => {
    const storage = new MemoryStorage();
    const unavailableLock: UserPatchLockManager = {
      request: async (_name, _options, callback) => callback(null),
    };

    const result = await saveUserPatchSafely("Wait", DEFAULT_PARAMS, storage, unavailableLock);

    expect(result).toEqual({ status: "busy", patches: [] });
    expect(storage.writes).toBe(0);
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
