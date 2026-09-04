export interface PwaRegistrationCallbacks {
  onOfflineReady: () => void;
  onNeedRefresh: () => void;
  onRegisterError: (error: unknown) => void;
}

export type PwaUpdater = (reloadPage?: boolean) => Promise<void>;
export type PwaRegistrar = (callbacks: PwaRegistrationCallbacks) => PwaUpdater;

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
    for (const listener of this.listeners) listener();
  }

  readonly start = (): void => {
    if (this.registrationAttempt !== null) return;
    const attempt = ++this.registrationSequence;
    this.registrationAttempt = attempt;
    try {
      const updater = this.registrar({
        onOfflineReady: () => {
          if (this.registrationAttempt === attempt) this.update({ offlineReady: true });
        },
        onNeedRefresh: () => {
          if (this.registrationAttempt === attempt) this.update({ needRefresh: true });
        },
        onRegisterError: (error) => {
          if (this.registrationAttempt !== attempt) return;
          this.registrationAttempt = null;
          this.updater = null;
          this.update({ error });
        },
      });
      // onRegisterError may be invoked synchronously by a registrar. Do not
      // resurrect an updater that its own attempt already invalidated.
      if (this.registrationAttempt === attempt) {
        this.updater = updater;
        this.update({ error: null });
      }
    } catch (error) {
      if (this.registrationAttempt === attempt) {
        this.registrationAttempt = null;
        this.updater = null;
      }
      this.update({ error });
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
    this.start();
    if (this.updatePromise) return this.updatePromise;

    let rawUpdate: Promise<void>;
    try {
      rawUpdate = Promise.resolve(this.updater?.(reloadPage)).then(() => undefined);
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
    this.setCapable(true);
  };

  private setCapable(value: boolean): void {
    if (value === this.capable) return;
    this.capable = value;
    for (const listener of this.listeners) listener();
  }

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
