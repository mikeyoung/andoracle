import {
  PARAM_KEYS,
  normalizePatch,
  type ParamKey,
  type SynthParams,
} from "./params";

/** Storage key for the versioned collection of patches named by the user. */
// Keep the pre-Andoracle key so existing named patches survive the product rename.
export const USER_PATCHES_STORAGE_KEY = "arpy-odyssey:user-patches:v1";

const USER_PATCHES_STORAGE_VERSION = 1;

/** The part of Web Storage used by this module, kept narrow for testability. */
export interface UserPatchStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface UserPatchLockManager {
  request<T>(
    name: string,
    options: { readonly mode: "exclusive"; readonly ifAvailable: true },
    callback: (lock: unknown | null) => T | PromiseLike<T>,
  ): Promise<T>;
}

export interface UserPatch {
  readonly name: string;
  readonly params: SynthParams;
}

export type ReadUserPatchesResult =
  | {
      /** The stored collection was already canonical (or did not exist). */
      readonly status: "ok";
      readonly patches: readonly UserPatch[];
    }
  | {
      /** At least one malformed or non-canonical value was safely repaired or ignored. */
      readonly status: "recovered";
      readonly patches: readonly UserPatch[];
    }
  | {
      /** Accessing local storage failed, for example because the browser blocked it. */
      readonly status: "storage-error";
      readonly patches: readonly [];
    }
  | {
      /** The library belongs to a schema this app must not overwrite. */
      readonly status: "unsupported-version";
      readonly patches: readonly [];
    };

export type SaveUserPatchResult =
  | {
      readonly status: "saved";
      readonly patch: UserPatch;
      readonly patches: readonly UserPatch[];
    }
  | {
      readonly status: "empty-name";
      readonly patches: readonly UserPatch[];
    }
  | {
      readonly status: "duplicate-name";
      readonly existingName: string;
      readonly patches: readonly UserPatch[];
    }
  | {
      readonly status: "storage-error";
      readonly patches: readonly UserPatch[];
    }
  | {
      readonly status: "unsupported-version";
      readonly patches: readonly UserPatch[];
    };

export type SafeSaveUserPatchResult = SaveUserPatchResult | {
  /** Another tab currently owns the short patch-library write lock. */
  readonly status: "busy";
  readonly patches: readonly UserPatch[];
};

// A host-owned Web Locks request cannot be force-settled by the page. Gate it
// by lock-manager identity so broken implementations cannot accumulate one
// retained request (and patch snapshot) per component remount.
const pendingLockSaves = new WeakMap<UserPatchLockManager, Promise<SafeSaveUserPatchResult>>();

interface StoredUserPatchCollection {
  readonly version: typeof USER_PATCHES_STORAGE_VERSION;
  readonly patches: readonly UserPatch[];
}

interface ParsedCollection {
  readonly patches: UserPatch[];
  readonly recovered: boolean;
  readonly unsupportedVersion: boolean;
}

const isObjectRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Returns the exact name that will be displayed and persisted. */
export const normalizeUserPatchName = (name: string): string => name.trim();

/** Locale-independent comparison key used for duplicate detection. */
export const userPatchNameKey = (name: string): string => normalizeUserPatchName(name)
  .normalize("NFC")
  .toUpperCase()
  .toLowerCase()
  .normalize("NFC");

/** Uses the library's canonical duplicate-name rules to retain a UI selection. */
export const hasUserPatchNamed = (
  patches: readonly UserPatch[],
  name: string,
): boolean => {
  const nameKey = userPatchNameKey(name);
  return Boolean(nameKey) && patches.some((patch) => userPatchNameKey(patch.name) === nameKey);
};

const defaultStorage = (): UserPatchStorage | null => {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
};

const defaultLockManager = (): UserPatchLockManager | null => {
  try {
    if (typeof navigator === "undefined" || !("locks" in navigator)) return null;
    return navigator.locks as unknown as UserPatchLockManager;
  } catch {
    return null;
  }
};

const normalizeStoredParams = (
  value: Record<string, unknown>,
): { params: SynthParams; recovered: boolean } => {
  const candidate: Partial<Record<ParamKey, number>> = {};
  let recovered = Object.keys(value).some((key) => !PARAM_KEYS.includes(key as ParamKey));

  for (const key of PARAM_KEYS) {
    const storedValue = value[key];
    if (typeof storedValue === "number") candidate[key] = storedValue;
    else recovered = true;
  }

  const params = normalizePatch(candidate);
  for (const key of PARAM_KEYS) {
    if (!Object.is(value[key], params[key])) recovered = true;
  }
  return { params, recovered };
};

const parseCollection = (raw: string): ParsedCollection => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { patches: [], recovered: true, unsupportedVersion: false };
  }

  if (
    isObjectRecord(parsed)
    && typeof parsed.version === "number"
    && Number.isInteger(parsed.version)
    && parsed.version > USER_PATCHES_STORAGE_VERSION
  ) {
    return { patches: [], recovered: false, unsupportedVersion: true };
  }
  if (
    !isObjectRecord(parsed)
    || parsed.version !== USER_PATCHES_STORAGE_VERSION
    || !Array.isArray(parsed.patches)
  ) {
    return { patches: [], recovered: true, unsupportedVersion: false };
  }

  const patches: UserPatch[] = [];
  const seenNames = new Set<string>();
  let recovered = false;

  for (const storedPatch of parsed.patches) {
    if (
      !isObjectRecord(storedPatch)
      || typeof storedPatch.name !== "string"
      || !isObjectRecord(storedPatch.params)
    ) {
      recovered = true;
      continue;
    }

    const name = normalizeUserPatchName(storedPatch.name);
    const nameKey = userPatchNameKey(name);
    if (!name || seenNames.has(nameKey)) {
      recovered = true;
      continue;
    }

    const normalized = normalizeStoredParams(storedPatch.params);
    patches.push({ name, params: normalized.params });
    seenNames.add(nameKey);
    if (name !== storedPatch.name || normalized.recovered) recovered = true;
  }

  return { patches, recovered, unsupportedVersion: false };
};

/**
 * Reads and validates user patches without modifying storage. Invalid records
 * are ignored, incomplete records receive current defaults, and parameter
 * values are clamped/snapped through the live synth schema.
 */
export const readUserPatches = (
  storage: UserPatchStorage | null = defaultStorage(),
): ReadUserPatchesResult => {
  if (!storage) return { status: "storage-error", patches: [] };

  try {
    const raw = storage.getItem(USER_PATCHES_STORAGE_KEY);
    if (raw === null) return { status: "ok", patches: [] };
    const collection = parseCollection(raw);
    if (collection.unsupportedVersion) return { status: "unsupported-version", patches: [] };
    return {
      status: collection.recovered ? "recovered" : "ok",
      patches: collection.patches,
    };
  } catch {
    return { status: "storage-error", patches: [] };
  }
};

/** Convenience array-only reader for callers that do not need diagnostics. */
export const loadUserPatches = (
  storage: UserPatchStorage | null = defaultStorage(),
): readonly UserPatch[] => readUserPatches(storage).patches;

/** Looks up a patch using the same trimmed, case-insensitive name rules as save. */
export const findUserPatch = (
  name: string,
  storage: UserPatchStorage | null = defaultStorage(),
): UserPatch | null => {
  const nameKey = userPatchNameKey(name);
  if (!nameKey) return null;
  return loadUserPatches(storage).find((patch) => userPatchNameKey(patch.name) === nameKey) ?? null;
};

/**
 * Adds a new named patch. Existing names are never overwritten, including
 * names that differ only by surrounding whitespace or letter case.
 */
export const saveUserPatch = (
  name: string,
  params: SynthParams,
  storage: UserPatchStorage | null = defaultStorage(),
): SaveUserPatchResult => {
  const readResult = readUserPatches(storage);
  const patches = readResult.patches;
  if (readResult.status === "storage-error" || !storage) {
    return { status: "storage-error", patches };
  }
  if (readResult.status === "unsupported-version") {
    return { status: "unsupported-version", patches };
  }

  const normalizedName = normalizeUserPatchName(name);
  if (!normalizedName) return { status: "empty-name", patches };

  const nameKey = userPatchNameKey(normalizedName);
  const duplicate = patches.find((patch) => userPatchNameKey(patch.name) === nameKey);
  if (duplicate) {
    return {
      status: "duplicate-name",
      existingName: duplicate.name,
      patches,
    };
  }

  const patch: UserPatch = {
    name: normalizedName,
    params: normalizePatch(params),
  };
  const nextPatches = [...patches, patch];
  const collection: StoredUserPatchCollection = {
    version: USER_PATCHES_STORAGE_VERSION,
    patches: nextPatches,
  };

  try {
    storage.setItem(USER_PATCHES_STORAGE_KEY, JSON.stringify(collection));
    return { status: "saved", patch, patches: nextPatches };
  } catch {
    return { status: "storage-error", patches };
  }
};

/**
 * Serializes the collection's read/append/write transaction across tabs when
 * Web Locks is available. A simultaneous save is asked to retry rather than
 * risking a lost patch or an implicit same-name overwrite.
 */
export const saveUserPatchSafely = (
  name: string,
  params: SynthParams,
  storage: UserPatchStorage | null = defaultStorage(),
  lockManager: UserPatchLockManager | null = defaultLockManager(),
): Promise<SafeSaveUserPatchResult> => {
  if (!lockManager) return Promise.resolve(saveUserPatch(name, params, storage));
  if (pendingLockSaves.has(lockManager)) {
    return Promise.resolve({ status: "busy", patches: readUserPatches(storage).patches });
  }

  let request: Promise<SafeSaveUserPatchResult>;
  try {
    request = Promise.resolve(lockManager.request(
      `${USER_PATCHES_STORAGE_KEY}:write`,
      { mode: "exclusive", ifAvailable: true },
      (lock): SafeSaveUserPatchResult => lock
        ? saveUserPatch(name, params, storage)
        : { status: "busy", patches: readUserPatches(storage).patches },
    ));
  } catch {
    // Some privacy modes expose navigator.locks but reject requests. Retain
    // normal single-tab storage behavior in that environment.
    return Promise.resolve(saveUserPatch(name, params, storage));
  }

  let tracked: Promise<SafeSaveUserPatchResult>;
  tracked = request
    .catch(() => saveUserPatch(name, params, storage))
    .finally(() => {
      if (pendingLockSaves.get(lockManager) === tracked) pendingLockSaves.delete(lockManager);
    });
  pendingLockSaves.set(lockManager, tracked);
  return tracked;
};
