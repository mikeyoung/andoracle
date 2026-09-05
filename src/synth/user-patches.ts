import {
  PARAM_KEYS,
  normalizePatch,
  type ParamKey,
  type SynthParams,
} from "./params";
import { FACTORY_PRESETS } from "./presets";
import {
  USER_LIBRARY_NAME_MAX_LENGTH,
  allocateUserLibraryName,
  fitUserLibraryNameWithSuffix,
  isUserLibraryNameWithinLimit,
} from "../user-library-name";
import {
  defaultLibraryWriteLockManager,
  type LibraryWriteLockManager,
} from "../library-write-lock";

/** Storage key for the versioned collection of patches named by the user. */
// Keep the pre-Andoracle key so existing named patches survive the product rename.
export const USER_PATCHES_STORAGE_KEY = "arpy-odyssey:user-patches:v1";

const USER_PATCHES_STORAGE_VERSION = 1;

/** User patch names are bounded so they remain readable throughout the UI. */
export const USER_PATCH_NAME_MAX_LENGTH = USER_LIBRARY_NAME_MAX_LENGTH;

/** The part of Web Storage used by this module, kept narrow for testability. */
export interface UserPatchStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface UserPatchLockManager extends LibraryWriteLockManager {}

export interface UserPatch {
  readonly name: string;
  readonly params: SynthParams;
}

/** Only user-category names may ever be created, replaced, or removed by this module. */
export type PatchNameCategory = "user" | "factory" | "default";

export interface ImmutablePatchName {
  readonly category: Exclude<PatchNameCategory, "user">;
  /** Canonical UI name of the protected patch or selector state. */
  readonly immutableName: string;
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
      readonly status: "name-too-long";
      readonly maxLength: typeof USER_PATCH_NAME_MAX_LENGTH;
      readonly patches: readonly UserPatch[];
    }
  | {
      readonly status: "duplicate-name";
      readonly existingName: string;
      /** Immutable snapshot that a later, explicit replace confirmation can target safely. */
      readonly existingPatch: UserPatch;
      readonly patches: readonly UserPatch[];
    }
  | ({
      readonly status: "immutable-name";
      readonly patches: readonly UserPatch[];
    } & ImmutablePatchName)
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

export type ReplaceUserPatchResult =
  | {
      readonly status: "replaced";
      readonly patch: UserPatch;
      readonly patches: readonly UserPatch[];
    }
  | {
      readonly status: "empty-name";
      readonly patches: readonly UserPatch[];
    }
  | {
      readonly status: "not-found";
      readonly patches: readonly UserPatch[];
    }
  | {
      /** The stored patch changed after the user was asked to confirm replacement. */
      readonly status: "stale-target";
      readonly currentPatch: UserPatch;
      readonly patches: readonly UserPatch[];
    }
  | ({
      readonly status: "immutable-name";
      readonly patches: readonly UserPatch[];
    } & ImmutablePatchName)
  | {
      readonly status: "storage-error";
      readonly patches: readonly UserPatch[];
    }
  | {
      readonly status: "unsupported-version";
      readonly patches: readonly UserPatch[];
    };

export type SafeReplaceUserPatchResult = ReplaceUserPatchResult | {
  /** Another tab currently owns the short patch-library write lock. */
  readonly status: "busy";
  readonly patches: readonly UserPatch[];
};

export type DeleteUserPatchResult =
  | {
      readonly status: "deleted";
      readonly deletedName: string;
      readonly patches: readonly UserPatch[];
    }
  | {
      readonly status: "empty-name";
      readonly patches: readonly UserPatch[];
    }
  | {
      readonly status: "not-found";
      readonly patches: readonly UserPatch[];
    }
  | {
      /** The name was reused for different settings after confirmation began. */
      readonly status: "stale-target";
      readonly currentPatch: UserPatch;
      readonly patches: readonly UserPatch[];
    }
  | ({
      readonly status: "immutable-name";
      readonly patches: readonly UserPatch[];
    } & ImmutablePatchName)
  | {
      readonly status: "storage-error";
      readonly patches: readonly UserPatch[];
    }
  | {
      readonly status: "unsupported-version";
      readonly patches: readonly UserPatch[];
    };

export type SafeDeleteUserPatchResult = DeleteUserPatchResult | {
  /** Another tab currently owns the short patch-library write lock. */
  readonly status: "busy";
  readonly patches: readonly UserPatch[];
};

// Gate writes by lock-manager identity. An aborted request immediately loses
// its captured write closure. A host that still does not settle is quarantined
// so it cannot retain more targets; writes stay busy rather than bypassing the
// cross-tab lock and risking a lost concurrent update.
const pendingLockWrites = new WeakMap<UserPatchLockManager, Promise<unknown>>();
const retiredLockManagers = new WeakSet<UserPatchLockManager>();
const ABORTED_LOCK_REQUEST_MAX_AGE_MS = 10_000;

// Construct this closure in its own lexical environment. If a broken host
// retains a retired lock callback forever, it may retain storage but never the
// sibling write closure that captured a confirmed patch snapshot.
const createUserPatchBusyReader = (storage: UserPatchStorage | null) => () => ({
  status: "busy" as const,
  patches: readUserPatches(storage).patches,
});

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

const DEFAULT_PATCH_NAMES = ["Custom patch", "Init Andoracle"] as const;
const immutablePatchNames = [
  ...DEFAULT_PATCH_NAMES.map((name) => ({
    name,
    key: userPatchNameKey(name),
    category: "default" as const,
  })),
  ...FACTORY_PRESETS
    .filter((preset) => !DEFAULT_PATCH_NAMES.some((name) => userPatchNameKey(name) === userPatchNameKey(preset.name)))
    .map((preset) => ({
      name: preset.name,
      key: userPatchNameKey(preset.name),
      category: "factory" as const,
    })),
] as const;

/** Classifies a name independently of capitalization, Unicode form, or edge whitespace. */
export const userPatchNameCategory = (name: string): PatchNameCategory => {
  const nameKey = userPatchNameKey(name);
  return immutablePatchNames.find((entry) => entry.key === nameKey)?.category ?? "user";
};

const immutablePatchName = (name: string): ImmutablePatchName | null => {
  const nameKey = userPatchNameKey(name);
  const match = immutablePatchNames.find((entry) => entry.key === nameKey);
  return match ? { category: match.category, immutableName: match.name } : null;
};

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
  return defaultLibraryWriteLockManager();
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

interface ValidStoredPatch {
  readonly name: string;
  readonly nameKey: string;
  readonly params: SynthParams;
  readonly immutable: ImmutablePatchName | null;
  readonly requiresLengthMigration: boolean;
}

const migratedUserPatchName = (
  immutableName: string,
  allocatedNameKeys: ReadonlySet<string>,
): string => {
  for (let sequence = 1; ; sequence += 1) {
    const suffix = sequence === 1 ? " (user patch)" : ` (user patch ${sequence})`;
    const candidate = fitUserLibraryNameWithSuffix(immutableName, suffix);
    const candidateKey = userPatchNameKey(candidate);
    if (!immutablePatchName(candidate) && !allocatedNameKeys.has(candidateKey)) return candidate;
  }
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

  const validStoredPatches: ValidStoredPatch[] = [];
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
    if (!name) {
      recovered = true;
      continue;
    }

    const normalized = normalizeStoredParams(storedPatch.params);
    const requiresLengthMigration = !isUserLibraryNameWithinLimit(name);
    validStoredPatches.push({
      name,
      nameKey,
      params: normalized.params,
      immutable: immutablePatchName(name),
      requiresLengthMigration,
    });
    if (name !== storedPatch.name || normalized.recovered || requiresLengthMigration) recovered = true;
  }

  // Reserve every valid user-category name before assigning migration names.
  // This keeps a newly introduced factory/default name from stealing an
  // existing user's suffix even when that suffix occurs later in storage.
  const allocatedNameKeys = new Set(
    validStoredPatches
      .filter((storedPatch) => (
        !storedPatch.immutable && !storedPatch.requiresLengthMigration
      ))
      .map((storedPatch) => storedPatch.nameKey),
  );
  const seenStoredNameKeys = new Set<string>();
  const patches: UserPatch[] = [];

  for (const storedPatch of validStoredPatches) {
    // Apply duplicate handling to the original stored identity so the first
    // record continues to win even when its display name must be migrated.
    if (seenStoredNameKeys.has(storedPatch.nameKey)) {
      recovered = true;
      continue;
    }
    seenStoredNameKeys.add(storedPatch.nameKey);

    if (!storedPatch.immutable && !storedPatch.requiresLengthMigration) {
      patches.push({ name: storedPatch.name, params: storedPatch.params });
      continue;
    }

    const name = storedPatch.immutable
      ? migratedUserPatchName(storedPatch.immutable.immutableName, allocatedNameKeys)
      : allocateUserLibraryName(
        storedPatch.name,
        allocatedNameKeys,
        userPatchNameKey,
        (candidate) => Boolean(immutablePatchName(candidate)),
      );
    allocatedNameKeys.add(userPatchNameKey(name));
    patches.push({ name, params: storedPatch.params });
    recovered = true;
  }

  return { patches, recovered, unsupportedVersion: false };
};

/**
 * Reads and validates user patches without modifying storage. Invalid records
 * are ignored, incomplete records receive current defaults, and parameter
 * values are clamped/snapped through the live synth schema. A historical user
 * name that a newer release reserves is migrated to a collision-safe user name
 * in memory and becomes canonical on the next ordinary library write.
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

const snapshotUserPatch = (patch: UserPatch): UserPatch => ({
  name: patch.name,
  params: { ...patch.params },
});

const matchesUserPatchSnapshot = (
  stored: UserPatch,
  expected: UserPatch,
): boolean => userPatchNameKey(stored.name) === userPatchNameKey(expected.name)
  && PARAM_KEYS.every((key) => Object.is(stored.params[key], expected.params[key]));

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
  if (!isUserLibraryNameWithinLimit(normalizedName)) {
    return {
      status: "name-too-long",
      maxLength: USER_PATCH_NAME_MAX_LENGTH,
      patches,
    };
  }

  const immutable = immutablePatchName(normalizedName);
  if (immutable) return { status: "immutable-name", ...immutable, patches };

  const nameKey = userPatchNameKey(normalizedName);
  const duplicate = patches.find((patch) => userPatchNameKey(patch.name) === nameKey);
  if (duplicate) {
    return {
      status: "duplicate-name",
      existingName: duplicate.name,
      existingPatch: snapshotUserPatch(duplicate),
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
 * Replaces one user-created patch only when it still exactly matches the
 * snapshot the user confirmed. The existing display name and collection order
 * are retained, including when the submitted name used different case or a
 * canonically equivalent Unicode representation.
 */
export const replaceUserPatch = (
  expected: UserPatch,
  params: SynthParams,
  storage: UserPatchStorage | null = defaultStorage(),
): ReplaceUserPatchResult => {
  const readResult = readUserPatches(storage);
  const patches = readResult.patches;
  if (readResult.status === "storage-error" || !storage) {
    return { status: "storage-error", patches };
  }
  if (readResult.status === "unsupported-version") {
    return { status: "unsupported-version", patches };
  }

  const normalizedName = normalizeUserPatchName(expected.name);
  if (!normalizedName) return { status: "empty-name", patches };

  const immutable = immutablePatchName(normalizedName);
  if (immutable) return { status: "immutable-name", ...immutable, patches };

  const nameKey = userPatchNameKey(normalizedName);
  const patchIndex = patches.findIndex((patch) => userPatchNameKey(patch.name) === nameKey);
  if (patchIndex < 0) return { status: "not-found", patches };

  const currentPatch = patches[patchIndex];
  if (!matchesUserPatchSnapshot(currentPatch, expected)) {
    return { status: "stale-target", currentPatch, patches };
  }

  const patch: UserPatch = {
    name: currentPatch.name,
    params: normalizePatch(params),
  };
  const nextPatches = [
    ...patches.slice(0, patchIndex),
    patch,
    ...patches.slice(patchIndex + 1),
  ];
  const collection: StoredUserPatchCollection = {
    version: USER_PATCHES_STORAGE_VERSION,
    patches: nextPatches,
  };

  try {
    storage.setItem(USER_PATCHES_STORAGE_KEY, JSON.stringify(collection));
    return { status: "replaced", patch, patches: nextPatches };
  } catch {
    return { status: "storage-error", patches };
  }
};

/**
 * Removes exactly one user-created patch using the same canonical name rules
 * as save. Factory presets and the default/custom selector identities are
 * categorically immutable even if corrupt storage attempts to inject them.
 */
export const deleteUserPatch = (
  expected: UserPatch,
  storage: UserPatchStorage | null = defaultStorage(),
): DeleteUserPatchResult => {
  const readResult = readUserPatches(storage);
  const patches = readResult.patches;
  if (readResult.status === "storage-error" || !storage) {
    return { status: "storage-error", patches };
  }
  if (readResult.status === "unsupported-version") {
    return { status: "unsupported-version", patches };
  }

  const normalizedName = normalizeUserPatchName(expected.name);
  if (!normalizedName) return { status: "empty-name", patches };

  const immutable = immutablePatchName(normalizedName);
  if (immutable) return { status: "immutable-name", ...immutable, patches };

  const nameKey = userPatchNameKey(normalizedName);
  const patchIndex = patches.findIndex((patch) => userPatchNameKey(patch.name) === nameKey);
  if (patchIndex < 0) return { status: "not-found", patches };

  const currentPatch = patches[patchIndex];
  if (!matchesUserPatchSnapshot(currentPatch, expected)) {
    return { status: "stale-target", currentPatch, patches };
  }

  const deletedName = currentPatch.name;
  const nextPatches = [...patches.slice(0, patchIndex), ...patches.slice(patchIndex + 1)];
  const collection: StoredUserPatchCollection = {
    version: USER_PATCHES_STORAGE_VERSION,
    patches: nextPatches,
  };

  try {
    storage.setItem(USER_PATCHES_STORAGE_KEY, JSON.stringify(collection));
    return { status: "deleted", deletedName, patches: nextPatches };
  } catch {
    return { status: "storage-error", patches };
  }
};

const runUserPatchWriteSafely = <Result>(
  write: (() => Result) | null,
  busy: () => Result,
  lockManager: UserPatchLockManager | null,
  signal?: AbortSignal,
): Promise<Result> => {
  if (signal?.aborted) return Promise.resolve(busy());
  if (!write) return Promise.resolve(busy());
  if (!lockManager) return Promise.resolve(write());
  // Never fall back to an unlocked write merely because a browser lock request
  // is slow. If the raw request eventually settles, finally() rehabilitates the
  // manager and subsequent operations can use cross-tab serialization again.
  if (retiredLockManagers.has(lockManager)) return Promise.resolve(busy());
  if (pendingLockWrites.has(lockManager)) return Promise.resolve(busy());

  const authority: {
    write: (() => Result) | null;
    signal: AbortSignal | null;
  } = { write, signal: signal ?? null };
  // From this point the revocable holder is the only reference that can
  // retain the payload-bearing write closure.
  write = null;
  let abortSignal: AbortSignal | null = signal ?? null;
  let retireTimer: ReturnType<typeof setTimeout> | null = null;
  let tracked: Promise<Result>;
  const requestStartedAt = Date.now();
  const guardedWrite = (): Result => {
    if (authority.signal?.aborted) {
      authority.write = null;
      authority.signal = null;
    }
    return authority.write ? authority.write() : busy();
  };
  const revokeAuthority = (): void => {
    authority.write = null;
    authority.signal = null;
    const currentSignal = abortSignal;
    abortSignal = null;
    currentSignal?.removeEventListener("abort", revokeAuthority);
    if (retireTimer !== null) return;
    const requestAge = Math.max(0, Date.now() - requestStartedAt);
    retireTimer = setTimeout(() => {
      retireTimer = null;
      if (pendingLockWrites.get(lockManager) !== tracked) return;
      pendingLockWrites.delete(lockManager);
      retiredLockManagers.add(lockManager);
    }, Math.max(0, ABORTED_LOCK_REQUEST_MAX_AGE_MS - requestAge));
  };

  let request: Promise<Result>;
  try {
    request = Promise.resolve(lockManager.request(
      `${USER_PATCHES_STORAGE_KEY}:write`,
      // The Web Locks specification forbids combining signal + ifAvailable.
      // Local authority revocation below makes a late callback non-destructive.
      { mode: "exclusive", ifAvailable: true },
      (lock): Result => lock ? guardedWrite() : busy(),
    ));
  } catch {
    // A failed lock request cannot prove that another tab is absent. Never
    // turn that failure into an unlocked read/modify/write transaction.
    authority.write = null;
    authority.signal = null;
    return Promise.resolve(busy());
  }

  tracked = request
    .catch(() => {
      authority.write = null;
      authority.signal = null;
      return busy();
    })
    .finally(() => {
      authority.write = null;
      authority.signal = null;
      abortSignal?.removeEventListener("abort", revokeAuthority);
      abortSignal = null;
      if (retireTimer !== null) clearTimeout(retireTimer);
      retireTimer = null;
      if (pendingLockWrites.get(lockManager) === tracked) pendingLockWrites.delete(lockManager);
      retiredLockManagers.delete(lockManager);
    });
  pendingLockWrites.set(lockManager, tracked);
  if (abortSignal?.aborted) revokeAuthority();
  else abortSignal?.addEventListener("abort", revokeAuthority, { once: true });
  if (!signal) return tracked;

  // Revocation must also release the caller immediately. The browser-owned
  // lock promise remains observed by `tracked`, but it can retain only the
  // small busy reader after revokeAuthority clears the write closure.
  return new Promise<Result>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => signal.removeEventListener("abort", handleAbort);
    const settle = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const handleAbort = (): void => settle(() => resolve(busy()));
    signal.addEventListener("abort", handleAbort, { once: true });
    tracked.then(
      (result) => settle(() => resolve(result)),
      (error: unknown) => settle(() => reject(error)),
    );
    if (signal.aborted) handleAbort();
  });
};

/**
 * Serializes the collection's read/append/write transaction across tabs when
 * a browser lock is available. Proposed controls are snapshotted before any
 * wait, and aborting revokes a delayed callback's authority. A simultaneous
 * save is asked to retry rather than risking a lost patch or overwrite.
 */
export const saveUserPatchSafely = (
  name: string,
  params: SynthParams,
  storage: UserPatchStorage | null = defaultStorage(),
  lockManager: UserPatchLockManager | null = defaultLockManager(),
  signal?: AbortSignal,
): Promise<SafeSaveUserPatchResult> => {
  if (signal?.aborted) return Promise.resolve(createUserPatchBusyReader(storage)());
  const paramsSnapshot = normalizePatch(params);
  return runUserPatchWriteSafely<SafeSaveUserPatchResult>(
    () => saveUserPatch(name, paramsSnapshot, storage),
    createUserPatchBusyReader(storage),
    lockManager,
    signal,
  );
};

/**
 * Serializes an explicitly confirmed replacement with every other patch write.
 * Both the confirmed target and the proposed controls are captured before a
 * browser-owned lock request can defer the transaction.
 */
export const replaceUserPatchSafely = (
  expected: UserPatch,
  params: SynthParams,
  storage: UserPatchStorage | null = defaultStorage(),
  lockManager: UserPatchLockManager | null = defaultLockManager(),
  signal?: AbortSignal,
): Promise<SafeReplaceUserPatchResult> => {
  const expectedSnapshot = snapshotUserPatch(expected);
  const paramsSnapshot = normalizePatch(params);
  return runUserPatchWriteSafely<SafeReplaceUserPatchResult>(
    () => replaceUserPatch(expectedSnapshot, paramsSnapshot, storage),
    createUserPatchBusyReader(storage),
    lockManager,
    signal,
  );
};

/**
 * Serializes delete with every other patch-library write. A stale tab must
 * retry instead of overwriting a save or resurrecting another tab's deletion.
 */
export const deleteUserPatchSafely = (
  expected: UserPatch,
  storage: UserPatchStorage | null = defaultStorage(),
  lockManager: UserPatchLockManager | null = defaultLockManager(),
  signal?: AbortSignal,
): Promise<SafeDeleteUserPatchResult> => {
  // The Web Locks host may defer the callback. Capture the confirmed target
  // now so caller mutation cannot silently retarget that later transaction.
  const expectedSnapshot = snapshotUserPatch(expected);
  return runUserPatchWriteSafely<SafeDeleteUserPatchResult>(
    () => deleteUserPatch(expectedSnapshot, storage),
    createUserPatchBusyReader(storage),
    lockManager,
    signal,
  );
};
