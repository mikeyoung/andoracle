/**
 * The minimal exclusive-lock surface used by the local patch and sequence
 * libraries. It matches the browser Web Locks API closely enough that callers
 * can use either implementation without branching their write transaction.
 */
export interface LibraryWriteLockManager {
  request<T>(
    name: string,
    options: { readonly mode: "exclusive"; readonly ifAvailable: true },
    callback: (lock: unknown | null) => T | PromiseLike<T>,
  ): Promise<T>;
}

const LOCK_DATABASE_NAME = "andoracle:library-write-locks:v1";
const LOCK_DATABASE_VERSION = 1;
const LOCK_STORE_NAME = "locks";

/**
 * IndexedDB read/write transactions are serialized across every same-origin
 * browsing context. Holding one while the synchronous localStorage
 * read/modify/write callback runs gives browsers without Web Locks the same
 * no-lost-update guarantee. The store is intentionally tiny: one marker per
 * Andoracle library lock name.
 */
class IndexedDbLibraryWriteLockManager implements LibraryWriteLockManager {
  private databasePromise: Promise<IDBDatabase> | null = null;
  private database: IDBDatabase | null = null;

  constructor(private readonly factory: IDBFactory) {}

  request<T>(
    name: string,
    _options: { readonly mode: "exclusive"; readonly ifAvailable: true },
    callback: (lock: unknown | null) => T | PromiseLike<T>,
  ): Promise<T> {
    return this.openDatabase().then((database) => new Promise<T>((resolve, reject) => {
      let callbackResult: T | PromiseLike<T> | undefined;
      let callbackInvoked = false;
      let callbackError: unknown;
      let transaction: IDBTransaction;

      try {
        transaction = database.transaction(LOCK_STORE_NAME, "readwrite");
      } catch (error) {
        // A connection may be forcibly closed without delivering `close`
        // before the next transaction attempt. Do not cache an unusable
        // resolved connection forever; the next write may reopen it.
        this.invalidateDatabase(database, true);
        reject(error);
        return;
      }

      const fail = (): void => reject(
        callbackError
        ?? transaction.error
        ?? new Error("The IndexedDB library lock transaction failed."),
      );
      const settleCallback = (): void => {
        if (!callbackInvoked) {
          reject(new Error("The IndexedDB library lock completed without acquiring authority."));
          return;
        }
        Promise.resolve(callbackResult as T | PromiseLike<T>).then(resolve, reject);
      };
      // The marker is only a gate: once its success handler synchronously ran
      // the localStorage transaction, later IDB commit failure cannot undo
      // that write. The exclusive transaction still protected it, so report
      // the callback's real result instead of falsely claiming no change.
      transaction.onabort = () => callbackInvoked ? settleCallback() : fail();
      transaction.onerror = () => undefined;
      transaction.oncomplete = settleCallback;

      let request: IDBRequest<IDBValidKey>;
      try {
        // The marker write both proves that this fallback can commit and
        // establishes the exclusive transaction before localStorage changes.
        // Running the synchronous callback only after it succeeds prevents a
        // failed/quota-blocked IDB write from reporting contention after the
        // local library was already modified.
        request = transaction.objectStore(LOCK_STORE_NAME).put(Date.now(), name);
      } catch (error) {
        callbackError = error;
        transaction.abort();
        return;
      }
      request.onerror = () => {
        callbackError = request.error
          ?? new Error("The IndexedDB library lock could not be acquired.");
      };
      request.onsuccess = () => {
        try {
          // All Andoracle library callbacks perform their localStorage
          // transaction synchronously before returning this result.
          callbackResult = callback({ indexedDb: true });
          callbackInvoked = true;
        } catch (error) {
          callbackError = error;
          transaction.abort();
        }
      };
    }));
  }

  private openDatabase(): Promise<IDBDatabase> {
    if (this.databasePromise) return this.databasePromise;

    let tracked: Promise<IDBDatabase>;
    let blockedRequestPending = false;
    const opening = new Promise<IDBDatabase>((resolve, reject) => {
      let request: IDBOpenDBRequest;
      let abandoned = false;
      const abandon = (error: unknown): void => {
        if (abandoned) return;
        abandoned = true;
        reject(error);
      };
      try {
        request = this.factory.open(LOCK_DATABASE_NAME, LOCK_DATABASE_VERSION);
      } catch (error) {
        abandon(error);
        return;
      }

      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(LOCK_STORE_NAME)) {
          database.createObjectStore(LOCK_STORE_NAME);
        }
      };
      request.onerror = () => {
        abandon(
          request.error ?? new Error("The IndexedDB library lock database could not be opened."),
        );
        // Unlike `blocked`, an error is terminal for this open request, so a
        // later user retry may safely create a fresh request.
        blockedRequestPending = false;
        if (this.databasePromise === tracked) this.databasePromise = null;
      };
      request.onblocked = () => {
        // An IDB open request cannot be cancelled. Keep its rejected promise
        // cached until the browser eventually delivers success/error; without
        // this quarantine, every click would accumulate another blocked open
        // request and its event-handler closure.
        blockedRequestPending = true;
        abandon(new Error("The IndexedDB library lock database upgrade was blocked."));
      };
      request.onsuccess = () => {
        const database = request.result;
        if (abandoned) {
          database.close();
          blockedRequestPending = false;
          if (this.databasePromise === tracked) this.databasePromise = null;
          return;
        }
        this.database = database;
        database.onversionchange = () => {
          this.invalidateDatabase(database, true);
        };
        database.onclose = () => this.invalidateDatabase(database, false);
        resolve(database);
      };
    });
    tracked = opening.catch((error) => {
      if (!blockedRequestPending && this.databasePromise === tracked) {
        this.databasePromise = null;
      }
      throw error;
    });
    this.databasePromise = tracked;
    return tracked;
  }

  private invalidateDatabase(database: IDBDatabase, close: boolean): void {
    if (this.database !== database) return;
    this.database = null;
    this.databasePromise = null;
    if (close) database.close();
  }
}

const indexedDbManagers = new WeakMap<IDBFactory, LibraryWriteLockManager>();
const unavailableBrowserLockManager: LibraryWriteLockManager = {
  request: async (_name, _options, callback) => callback(null),
};

/** Creates an independent manager, mirroring one instance in another tab. */
export const createIndexedDbLibraryWriteLockManager = (
  factory: IDBFactory,
): LibraryWriteLockManager => new IndexedDbLibraryWriteLockManager(factory);

/** Returns one stable fallback manager for a particular IndexedDB factory. */
export const indexedDbLibraryWriteLockManager = (
  factory: IDBFactory,
): LibraryWriteLockManager => {
  const existing = indexedDbManagers.get(factory);
  if (existing) return existing;
  const manager = createIndexedDbLibraryWriteLockManager(factory);
  indexedDbManagers.set(factory, manager);
  return manager;
};

/**
 * Prefer native Web Locks. IndexedDB supplies equivalent cross-tab exclusion
 * on older engines; null is reserved for non-browser/test callers that
 * explicitly accept a synchronous single-context transaction.
 */
export const defaultLibraryWriteLockManager = (): LibraryWriteLockManager | null => {
  try {
    if (
      typeof navigator !== "undefined"
      && navigator.locks
      && typeof navigator.locks.request === "function"
    ) {
      return navigator.locks as unknown as LibraryWriteLockManager;
    }
  } catch {
    // Try the transactional IndexedDB fallback below.
  }

  try {
    if (typeof indexedDB !== "undefined") return indexedDbLibraryWriteLockManager(indexedDB);
  } catch {
    // A context without either API can still be used as a single-context
    // injected-storage environment by explicitly passing null.
  }
  // A real browser without either cross-context primitive must fail closed;
  // returning null here would silently opt its localStorage writes out of
  // serialization. Null remains available only to explicit injected callers.
  return typeof window !== "undefined" || typeof navigator !== "undefined"
    ? unavailableBrowserLockManager
    : null;
};
