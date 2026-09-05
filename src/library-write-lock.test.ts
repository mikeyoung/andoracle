import { describe, expect, it, vi } from "vitest";
import { DEFAULT_PARAMS } from "./synth/params";
import {
  USER_PATCHES_STORAGE_KEY,
  deleteUserPatchSafely,
  findUserPatch,
  loadUserPatches,
  replaceUserPatchSafely,
  saveUserPatch,
  saveUserPatchSafely,
  type UserPatchStorage,
} from "./synth/user-patches";
import {
  createIndexedDbLibraryWriteLockManager,
  defaultLibraryWriteLockManager,
  indexedDbLibraryWriteLockManager,
} from "./library-write-lock";

class MemoryStorage implements UserPatchStorage {
  private value: string | null = null;

  getItem(key: string): string | null {
    return key === USER_PATCHES_STORAGE_KEY ? this.value : null;
  }

  setItem(key: string, value: string): void {
    if (key === USER_PATCHES_STORAGE_KEY) this.value = value;
  }
}

interface FakeRequest<Result> {
  result: Result;
  error: DOMException | null;
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
  onblocked?: (() => void) | null;
  onupgradeneeded?: (() => void) | null;
}

const fakeRequest = <Result>(result: Result): FakeRequest<Result> => ({
  result,
  error: null,
  onsuccess: null,
  onerror: null,
});

class FakeTransaction {
  error: DOMException | null = null;
  onabort: (() => void) | null = null;
  onerror: (() => void) | null = null;
  oncomplete: (() => void) | null = null;
  private aborted = false;

  constructor(
    private readonly ready: Promise<void>,
    private readonly release: () => void,
    private readonly failRequest = false,
    private readonly abortAfterSuccess = false,
  ) {}

  objectStore(): Pick<IDBObjectStore, "get" | "put"> {
    const schedule = <Result>(request: FakeRequest<Result>): IDBRequest<Result> => {
      void this.ready.then(() => queueMicrotask(() => {
        if (this.aborted) return;
        if (this.failRequest) {
          request.error = new DOMException("Marker write failed.", "QuotaExceededError");
          this.error = request.error;
          request.onerror?.();
          this.aborted = true;
          this.onabort?.();
          this.release();
          return;
        }
        request.onsuccess?.();
        queueMicrotask(() => {
          if (this.aborted) return;
          if (this.abortAfterSuccess) {
            this.error = new DOMException("Commit failed.", "UnknownError");
            this.aborted = true;
            this.onabort?.();
            this.release();
            return;
          }
          this.oncomplete?.();
          this.release();
        });
      }));
      return request as unknown as IDBRequest<Result>;
    };
    return {
      get: (_name: IDBValidKey | IDBKeyRange) => {
        const request = fakeRequest<unknown>(undefined);
        return schedule(request);
      },
      put: (_value: unknown, _key?: IDBValidKey | IDBKeyRange) => (
        schedule(fakeRequest<IDBValidKey>(0))
      ),
    };
  }

  abort(): void {
    if (this.aborted) return;
    this.aborted = true;
    this.onabort?.();
    this.release();
  }
}

class FakeDatabase {
  readonly objectStoreNames = {
    contains: (name: string) => this.hasStore && name === "locks",
  };
  onversionchange: (() => void) | null = null;
  onclose: (() => void) | null = null;
  closeCount = 0;
  private hasStore = false;
  private transactionAvailable = true;
  failNextRequest = false;
  abortNextCommit = false;
  private transactionTail = Promise.resolve();

  createObjectStore(name: string): void {
    if (name === "locks") this.hasStore = true;
  }

  transaction(): FakeTransaction {
    if (!this.transactionAvailable) {
      throw new DOMException("The database connection is closed.", "InvalidStateError");
    }
    const ready = this.transactionTail;
    let release!: () => void;
    this.transactionTail = new Promise<void>((resolve) => { release = resolve; });
    const failRequest = this.failNextRequest;
    this.failNextRequest = false;
    const abortAfterSuccess = this.abortNextCommit;
    this.abortNextCommit = false;
    return new FakeTransaction(ready, release, failRequest, abortAfterSuccess);
  }

  close(): void {
    this.closeCount += 1;
    this.transactionAvailable = false;
  }

  prepareOpen(): void {
    this.transactionAvailable = true;
  }

  forceClose(emitClose = true): void {
    this.transactionAvailable = false;
    if (emitClose) this.onclose?.();
  }
}

class FakeIndexedDbFactory {
  readonly database = new FakeDatabase();
  blockedThenSucceeds = false;
  blockedUntilReleased = false;
  errorsThenSucceeds = false;
  openCount = 0;
  private blockedRequest: (FakeRequest<FakeDatabase> & {
    onblocked: (() => void) | null;
    onupgradeneeded: (() => void) | null;
  }) | null = null;

  open(): IDBOpenDBRequest {
    this.openCount += 1;
    this.database.prepareOpen();
    const request: FakeRequest<FakeDatabase> & {
      onblocked: (() => void) | null;
      onupgradeneeded: (() => void) | null;
    } = {
      ...fakeRequest(this.database),
      onblocked: null,
      onupgradeneeded: null,
    };
    queueMicrotask(() => {
      request.onupgradeneeded?.();
      if (this.blockedUntilReleased) {
        this.blockedRequest = request;
        request.onblocked?.();
        return;
      }
      if (this.blockedThenSucceeds) request.onblocked?.();
      if (this.errorsThenSucceeds) {
        request.error = new DOMException("Open failed.", "UnknownError");
        request.onerror?.();
      }
      request.onsuccess?.();
    });
    return request as unknown as IDBOpenDBRequest;
  }

  releaseBlockedOpen(): void {
    const request = this.blockedRequest;
    this.blockedRequest = null;
    this.blockedUntilReleased = false;
    request?.onsuccess?.();
  }
}

describe("IndexedDB local-library write lock fallback", () => {
  it("selects IndexedDB when Web Locks are absent", () => {
    const factory = new FakeIndexedDbFactory();
    vi.stubGlobal("navigator", {});
    vi.stubGlobal("indexedDB", factory);
    vi.stubGlobal("window", {});
    try {
      expect(defaultLibraryWriteLockManager())
        .toBe(indexedDbLibraryWriteLockManager(factory as unknown as IDBFactory));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("fails closed in a browser lacking both cross-tab lock primitives", async () => {
    vi.stubGlobal("navigator", {});
    vi.stubGlobal("indexedDB", undefined);
    vi.stubGlobal("window", {});
    try {
      const manager = defaultLibraryWriteLockManager();
      let receivedLock: unknown = "not-called";
      const result = await manager?.request(
        "patches",
        { mode: "exclusive", ifAvailable: true },
        (lock) => {
          receivedLock = lock;
          return lock ? "write" : "busy";
        },
      );
      expect(result).toBe("busy");
      expect(receivedLock).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("serializes independent tab managers so distinct patch saves cannot overwrite", async () => {
    const factory = new FakeIndexedDbFactory();
    const firstTab = createIndexedDbLibraryWriteLockManager(factory as unknown as IDBFactory);
    const secondTab = createIndexedDbLibraryWriteLockManager(factory as unknown as IDBFactory);
    const storage = new MemoryStorage();

    const results = await Promise.all([
      saveUserPatchSafely("Tab A", DEFAULT_PARAMS, storage, firstTab),
      saveUserPatchSafely("Tab B", DEFAULT_PARAMS, storage, secondTab),
    ]);

    expect(results.map((result) => result.status)).toEqual(["saved", "saved"]);
    expect(loadUserPatches(storage).map((patch) => patch.name)).toEqual(["Tab A", "Tab B"]);
  });

  it("serializes replacement with a save across independent tab managers", async () => {
    const factory = new FakeIndexedDbFactory();
    const firstTab = createIndexedDbLibraryWriteLockManager(factory as unknown as IDBFactory);
    const secondTab = createIndexedDbLibraryWriteLockManager(factory as unknown as IDBFactory);
    const storage = new MemoryStorage();
    saveUserPatch("Target", { ...DEFAULT_PARAMS, filterCutoff: 800 }, storage);
    const target = findUserPatch("Target", storage);
    if (!target) throw new Error("Expected the replacement target to exist.");

    const [replaced, saved] = await Promise.all([
      replaceUserPatchSafely(
        target,
        { ...DEFAULT_PARAMS, filterCutoff: 4_000 },
        storage,
        firstTab,
      ),
      saveUserPatchSafely("Other", DEFAULT_PARAMS, storage, secondTab),
    ]);

    expect(replaced.status).toBe("replaced");
    expect(saved.status).toBe("saved");
    expect(findUserPatch("Target", storage)?.params.filterCutoff).toBe(4_000);
    expect(loadUserPatches(storage).map((patch) => patch.name)).toEqual(["Target", "Other"]);
  });

  it("serializes deletion with a save across independent tab managers", async () => {
    const factory = new FakeIndexedDbFactory();
    const firstTab = createIndexedDbLibraryWriteLockManager(factory as unknown as IDBFactory);
    const secondTab = createIndexedDbLibraryWriteLockManager(factory as unknown as IDBFactory);
    const storage = new MemoryStorage();
    saveUserPatch("Victim", DEFAULT_PARAMS, storage);
    const victim = findUserPatch("Victim", storage);
    if (!victim) throw new Error("Expected the deletion target to exist.");

    const [deleted, saved] = await Promise.all([
      deleteUserPatchSafely(victim, storage, firstTab),
      saveUserPatchSafely("Survivor", DEFAULT_PARAMS, storage, secondTab),
    ]);

    expect(deleted.status).toBe("deleted");
    expect(saved.status).toBe("saved");
    expect(loadUserPatches(storage).map((patch) => patch.name)).toEqual(["Survivor"]);
  });

  it("closes a late database connection after a blocked open was abandoned", async () => {
    const factory = new FakeIndexedDbFactory();
    factory.blockedThenSucceeds = true;
    const manager = createIndexedDbLibraryWriteLockManager(factory as unknown as IDBFactory);

    await expect(manager.request(
      "patches",
      { mode: "exclusive", ifAvailable: true },
      () => "must not run",
    )).rejects.toThrow(/blocked/u);
    expect(factory.database.closeCount).toBe(1);
  });

  it("quarantines one blocked open request instead of accumulating retries", async () => {
    const factory = new FakeIndexedDbFactory();
    factory.blockedUntilReleased = true;
    const manager = createIndexedDbLibraryWriteLockManager(factory as unknown as IDBFactory);
    const request = (): Promise<unknown> => manager.request(
      "patches",
      { mode: "exclusive", ifAvailable: true },
      () => "must not run",
    );

    await expect(request()).rejects.toThrow(/blocked/u);
    await expect(request()).rejects.toThrow(/blocked/u);
    await expect(request()).rejects.toThrow(/blocked/u);
    expect(factory.openCount).toBe(1);

    factory.releaseBlockedOpen();
    await Promise.resolve();
    expect(factory.database.closeCount).toBe(1);
    await expect(request()).resolves.toBe("must not run");
    expect(factory.openCount).toBe(2);
  });

  it("reopens after an unexpected database close event", async () => {
    const factory = new FakeIndexedDbFactory();
    const manager = createIndexedDbLibraryWriteLockManager(factory as unknown as IDBFactory);

    await expect(manager.request(
      "patches",
      { mode: "exclusive", ifAvailable: true },
      () => "first",
    )).resolves.toBe("first");
    factory.database.forceClose();
    await expect(manager.request(
      "patches",
      { mode: "exclusive", ifAvailable: true },
      () => "second",
    )).resolves.toBe("second");
    expect(factory.openCount).toBe(2);
  });

  it("invalidates a closed cached connection even when no close event arrives", async () => {
    const factory = new FakeIndexedDbFactory();
    const manager = createIndexedDbLibraryWriteLockManager(factory as unknown as IDBFactory);

    await expect(manager.request(
      "sequences",
      { mode: "exclusive", ifAvailable: true },
      () => "first",
    )).resolves.toBe("first");
    factory.database.forceClose(false);
    await expect(manager.request(
      "sequences",
      { mode: "exclusive", ifAvailable: true },
      () => "cannot run",
    )).rejects.toMatchObject({ name: "InvalidStateError" });
    await expect(manager.request(
      "sequences",
      { mode: "exclusive", ifAvailable: true },
      () => "recovered",
    )).resolves.toBe("recovered");
    expect(factory.openCount).toBe(2);
  });

  it("never invokes the localStorage callback when its lock marker cannot commit", async () => {
    const factory = new FakeIndexedDbFactory();
    factory.database.failNextRequest = true;
    const manager = createIndexedDbLibraryWriteLockManager(factory as unknown as IDBFactory);
    const callback = vi.fn(() => "must not write");

    await expect(manager.request(
      "patches",
      { mode: "exclusive", ifAvailable: true },
      callback,
    )).rejects.toMatchObject({ name: "QuotaExceededError" });
    expect(callback).not.toHaveBeenCalled();
  });

  it("returns the completed callback result if the marker transaction aborts afterward", async () => {
    const factory = new FakeIndexedDbFactory();
    factory.database.abortNextCommit = true;
    const manager = createIndexedDbLibraryWriteLockManager(factory as unknown as IDBFactory);
    const callback = vi.fn(() => "localStorage was written");

    await expect(manager.request(
      "patches",
      { mode: "exclusive", ifAvailable: true },
      callback,
    )).resolves.toBe("localStorage was written");
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("closes a late database connection after an errored open was abandoned", async () => {
    const factory = new FakeIndexedDbFactory();
    factory.errorsThenSucceeds = true;
    const manager = createIndexedDbLibraryWriteLockManager(factory as unknown as IDBFactory);

    await expect(manager.request(
      "sequences",
      { mode: "exclusive", ifAvailable: true },
      () => "must not run",
    )).rejects.toThrow("Open failed.");
    expect(factory.database.closeCount).toBe(1);
  });
});
