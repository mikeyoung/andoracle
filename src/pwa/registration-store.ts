export interface PwaRegistrationCallbacks {
  onOfflineReady: () => void;
  onNeedRefresh: () => void;
  onRegisteredSW: (
    swScriptUrl: string,
    registration: ServiceWorkerUpdateRegistration | undefined,
  ) => void;
  onRegisterError: (error: unknown) => void;
}

export type PwaUpdater = (reloadPage?: boolean) => Promise<void>;
export type PwaRegistrar = (callbacks: PwaRegistrationCallbacks) => PwaUpdater;

export interface ServiceWorkerUpdateRegistration {
  readonly installing?: ServiceWorkerUpdateCandidate | null;
  readonly waiting?: unknown | null;
  addEventListener?(type: "updatefound", listener: () => void): void;
  removeEventListener?(type: "updatefound", listener: () => void): void;
  update(): Promise<unknown>;
}

export interface ServiceWorkerUpdateCandidate {
  readonly state?: string;
  addEventListener?(type: "statechange", listener: () => void): void;
  removeEventListener?(type: "statechange", listener: () => void): void;
}

export interface ServiceWorkerUpdateTimerApi {
  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof globalThis.setTimeout>;
  clearTimeout(handle: ReturnType<typeof globalThis.setTimeout>): void;
}

export const SERVICE_WORKER_UPDATE_CHECK_TIMEOUT_MS = 8_000;

const serviceWorkerUpdateTimers: ServiceWorkerUpdateTimerApi = {
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (handle) => globalThis.clearTimeout(handle),
};

export class PwaUpdatePendingError extends Error {
  constructor() {
    super("A previous app update is still finishing.");
    this.name = "PwaUpdatePendingError";
  }
}

/**
 * A same-URL register() resolves without checking the network when a worker is
 * already waiting. Give a newer deployment one explicit update job in that
 * state, unless the browser is already installing one, so rapid releases
 * converge without adding a network check to ordinary launches.
 */
export const checkForNewerServiceWorker = async (
  registration: ServiceWorkerUpdateRegistration | undefined,
  timeoutMs = SERVICE_WORKER_UPDATE_CHECK_TIMEOUT_MS,
  timers: ServiceWorkerUpdateTimerApi = serviceWorkerUpdateTimers,
): Promise<void> => {
  if (!registration?.waiting) return;

  await new Promise<void>((resolve, reject) => {
    let candidate: ServiceWorkerUpdateCandidate | null = null;
    let updateSettled = false;
    let settled = false;
    let timeout: ReturnType<typeof globalThis.setTimeout> | null = null;

    const stateChanged = (): void => {
      // `installed` means the newly fetched worker has replaced the old
      // waiting slot; `activating`/`activated` means skipWaiting already won;
      // `redundant` means the attempted replacement failed. In every case it
      // is now safe for Workbox to inspect registration.waiting.
      if (candidate?.state !== "installing") finish();
    };
    const detachCandidate = (): void => {
      candidate?.removeEventListener?.("statechange", stateChanged);
      candidate = null;
    };
    const captureInstalling = (): void => {
      // The browser-owned update promise can settle long after our bounded
      // wait timed out. Never let that late continuation reattach a candidate
      // listener after cleanup has already revoked this check.
      if (settled) return;
      const next = registration.installing ?? null;
      if (next === candidate) return;
      detachCandidate();
      candidate = next;
      candidate?.addEventListener?.("statechange", stateChanged);
    };
    const cleanup = (): void => {
      if (timeout !== null) timers.clearTimeout(timeout);
      timeout = null;
      registration.removeEventListener?.("updatefound", captureInstalling);
      detachCandidate();
    };
    const finish = (error?: unknown): void => {
      if (settled) return;
      if (!error && (!updateSettled || candidate?.state === "installing")) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };

    registration.addEventListener?.("updatefound", captureInstalling);
    timeout = timers.setTimeout(() => {
      // Do not activate the pre-existing worker after an inconclusive check.
      // The page-level store retains this rejected barrier, so retries remain
      // fail-closed without adding more listeners or update jobs.
      finish(new PwaUpdatePendingError());
    }, Math.max(0, timeoutMs));

    // Another tab (or the browser's normal update scheduler) may already have
    // started the replacement. Share that installation boundary instead of
    // launching a redundant job or letting Workbox activate the old waiter.
    captureInstalling();
    if (candidate) {
      updateSettled = true;
      finish();
      return;
    }

    let update: Promise<unknown>;
    try {
      update = Promise.resolve(registration.update());
    } catch {
      updateSettled = true;
      finish();
      return;
    }

    void update.then(
      () => {
        updateSettled = true;
        captureInstalling();
        finish();
      },
      () => {
        // This check is opportunistic; keep the usable waiting worker and let
        // the browser retry later if the user is offline or the server failed.
        updateSettled = true;
        finish();
      },
    );
  });
};

export interface PwaRegistrationSnapshot {
  offlineReady: boolean;
  needRefresh: boolean;
  error: unknown | null;
}

const INITIAL_SNAPSHOT: PwaRegistrationSnapshot = Object.freeze({
  offlineReady: false,
  needRefresh: false,
  error: null,
});

/**
 * Owns the one page-lifetime service-worker registration. UI subscribers may
 * mount and unmount freely without creating additional Workbox instances or
 * leaving old React state setters attached to navigator.serviceWorker.
 */
export class PwaRegistrationStore {
  private snapshot: PwaRegistrationSnapshot = INITIAL_SNAPSHOT;
  private readonly listeners = new Set<() => void>();
  private updater: PwaUpdater | null = null;
  private updatePromise: Promise<void> | null = null;
  private registrationCheckPromise: Promise<void> | null = null;
  private registrationAttempt: number | null = null;
  private registrationSequence = 0;

  constructor(private readonly registrar: PwaRegistrar) {}

  readonly getSnapshot = (): PwaRegistrationSnapshot => this.snapshot;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private update(changes: Partial<PwaRegistrationSnapshot>): void {
    const next = Object.freeze({ ...this.snapshot, ...changes });
    if (
      next.offlineReady === this.snapshot.offlineReady
      && next.needRefresh === this.snapshot.needRefresh
      && next.error === this.snapshot.error
    ) return;
    this.snapshot = next;
    // Subscribers added while publishing observe the next snapshot change,
    // not this one. Iterating the live Set can otherwise revisit a listener
    // that unsubscribes and re-subscribes itself indefinitely.
    for (const listener of [...this.listeners]) listener();
  }

  readonly start = (): void => {
    if (this.registrationAttempt !== null) return;
    const attempt = ++this.registrationSequence;
    this.registrationAttempt = attempt;
    let resolveRegistrationCheck!: () => void;
    let rejectRegistrationCheck!: (error: unknown) => void;
    const registrationCheck = new Promise<void>((resolve, reject) => {
      resolveRegistrationCheck = resolve;
      rejectRegistrationCheck = reject;
    });
    this.registrationCheckPromise = registrationCheck;
    // The update prompt might never be shown, so observe a timed-out check
    // even when no UI caller ever awaits it.
    void registrationCheck.catch(() => undefined);
    let registrationCheckStarted = false;
    try {
      const updater = this.registrar({
        onOfflineReady: () => {
          if (this.registrationAttempt === attempt) this.update({ offlineReady: true });
        },
        onNeedRefresh: () => {
          if (this.registrationAttempt === attempt) this.update({ needRefresh: true });
        },
        onRegisteredSW: (_swScriptUrl, registration) => {
          if (this.registrationAttempt !== attempt || registrationCheckStarted) return;
          registrationCheckStarted = true;
          void checkForNewerServiceWorker(registration).then(
            resolveRegistrationCheck,
            rejectRegistrationCheck,
          );
        },
        onRegisterError: (error) => {
          if (this.registrationAttempt !== attempt) return;
          resolveRegistrationCheck();
          this.registrationAttempt = null;
          this.updater = null;
          // A refresh prompt belongs to the failed registration attempt. Do
          // not leave behind a Reload action whose updater no longer exists.
          this.update({ error, needRefresh: false });
        },
      });
      // onRegisterError may be invoked synchronously by a registrar. Do not
      // resurrect an updater that its own attempt already invalidated.
      if (this.registrationAttempt === attempt) {
        this.updater = updater;
        this.update({ error: null });
      }
    } catch (error) {
      // onRegisterError is allowed to publish synchronously. A subscriber may
      // start a fresh attempt before a poorly behaved registrar then throws;
      // that stale throw must not overwrite the newer attempt's state.
      if (this.registrationAttempt !== attempt) return;
      resolveRegistrationCheck();
      this.registrationAttempt = null;
      this.updater = null;
      this.update({ error, needRefresh: false });
    }
  };

  readonly setOfflineReady = (value: boolean): void => {
    this.update({ offlineReady: value });
  };

  readonly setNeedRefresh = (value: boolean): void => {
    this.update({ needRefresh: value });
  };

  readonly clearError = (): void => {
    this.update({ error: null });
  };

  readonly updateServiceWorker = (reloadPage = true): Promise<void> => {
    // Never attach a second UI observer to the pending browser promise. A
    // timed-out Promise.race cannot remove its reaction, so returning the raw
    // promise here would leak one abandoned continuation per Retry click.
    if (this.updatePromise) return Promise.reject(new PwaUpdatePendingError());
    this.start();

    let rawUpdate: Promise<void>;
    try {
      const registrationCheck = this.snapshot.needRefresh
        ? this.registrationCheckPromise
        : null;
      rawUpdate = Promise.resolve(registrationCheck)
        .then(() => {
          const updater = this.updater;
          if (updater) return updater(reloadPage);
          throw this.snapshot.error instanceof Error
            ? this.snapshot.error
            : new Error("The offline app updater is unavailable.");
        })
        .then(() => undefined);
    } catch (error) {
      rawUpdate = Promise.reject(error);
    }
    let update: Promise<void>;
    update = rawUpdate.finally(() => {
      if (this.updatePromise === update) this.updatePromise = null;
    });
    this.updatePromise = update;
    return update;
  };

  get subscriberCount(): number {
    return this.listeners.size;
  }
}

export interface OnlineEventTarget {
  addEventListener(type: "online", listener: () => void): void;
  removeEventListener(type: "online", listener: () => void): void;
}

/** Binds one mount's explicit initial/online registration retry triggers. */
export const bindPwaRegistrationRetries = (
  store: Pick<PwaRegistrationStore, "start">,
  target: OnlineEventTarget,
): (() => void) => {
  const retry = store.start;
  retry();
  target.addEventListener("online", retry);
  let bound = true;
  return () => {
    if (!bound) return;
    bound = false;
    target.removeEventListener("online", retry);
  };
};

export interface ServiceWorkerCapabilityTarget {
  readonly controller: unknown | null;
  getRegistration(): Promise<{ readonly active?: unknown | null } | undefined>;
  addEventListener(type: "controllerchange", listener: () => void): void;
  removeEventListener(type: "controllerchange", listener: () => void): void;
}

/**
 * Owns the page-lifetime service-worker capability probe. Keeping the raw
 * registration lookup outside React prevents StrictMode and later remounts
 * from attaching component state setters to repeated host promises.
 */
export class ServiceWorkerCapabilityStore {
  private capable = false;
  private readonly listeners = new Set<() => void>();
  private target: ServiceWorkerCapabilityTarget | null = null;
  private generation = 0;

  readonly getSnapshot = (): boolean => this.capable;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private readonly controlled = (): void => {
    // A queued callback can still run at the edge of stop(), and a
    // controllerchange is not evidence of control when the new controller is
    // null (for example after unregistration).
    if (this.target?.controller) this.setCapable(true);
  };

  private setCapable(value: boolean): void {
    if (value === this.capable) return;
    this.capable = value;
    for (const listener of [...this.listeners]) listener();
  }

  /**
   * Latches capability from an authoritative successful install callback.
   * The initial getRegistration() probe can legitimately resolve before a
   * first-install worker reaches the active state, and that page may not
   * receive controllerchange until its next navigation.
   */
  readonly markCapable = (): void => {
    this.setCapable(true);
  };

  start(target: ServiceWorkerCapabilityTarget): void {
    if (this.target) return;
    this.target = target;
    const generation = ++this.generation;
    target.addEventListener("controllerchange", this.controlled);
    if (target.controller) this.setCapable(true);

    let lookup: Promise<{ readonly active?: unknown | null } | undefined>;
    try {
      lookup = Promise.resolve(target.getRegistration());
    } catch {
      return;
    }
    const owner = new WeakRef(this);
    void lookup.then(
      (registration) => {
        const store = owner.deref();
        if (!store || store.generation !== generation) return;
        if (registration?.active || store.target?.controller) store.setCapable(true);
      },
      () => undefined,
    );
  }

  /** Removes the owned browser listener; the production singleton is page-lifetime. */
  stop(): void {
    const target = this.target;
    this.target = null;
    this.generation += 1;
    target?.removeEventListener("controllerchange", this.controlled);
  }

  get subscriberCount(): number {
    return this.listeners.size;
  }
}
