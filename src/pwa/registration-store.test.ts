import { describe, expect, it, vi } from "vitest";
import appSource from "../App.tsx?raw";
import {
  PwaRegistrationStore,
  PwaUpdatePendingError,
  ServiceWorkerCapabilityStore,
  bindPwaRegistrationRetries,
  checkForNewerServiceWorker,
  type PwaRegistrationCallbacks,
  type ServiceWorkerUpdateRegistration,
  type ServiceWorkerUpdateTimerApi,
  type ServiceWorkerCapabilityTarget,
} from "./registration-store";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const controlledTimers = () => {
  let nextHandle = 1;
  const callbacks = new Map<number, () => void>();
  const timers: ServiceWorkerUpdateTimerApi = {
    setTimeout: (callback) => {
      const handle = nextHandle++;
      callbacks.set(handle, callback);
      return handle as ReturnType<typeof globalThis.setTimeout>;
    },
    clearTimeout: (handle) => {
      callbacks.delete(handle as number);
    },
  };
  return {
    timers,
    fire: (handle = Math.min(...callbacks.keys())) => {
      const callback = callbacks.get(handle);
      callbacks.delete(handle);
      callback?.();
    },
    get size() {
      return callbacks.size;
    },
  };
};

describe("PwaRegistrationStore", () => {
  it("keeps one page-lifetime registration across ten mount and unmount cycles", () => {
    let callbacks: PwaRegistrationCallbacks | null = null;
    const registrar = vi.fn((nextCallbacks: PwaRegistrationCallbacks) => {
      callbacks = nextCallbacks;
      return vi.fn(async () => undefined);
    });
    const store = new PwaRegistrationStore(registrar);
    const notifications = Array.from({ length: 10 }, () => vi.fn());

    for (const listener of notifications) {
      store.start();
      const unsubscribe = store.subscribe(listener);
      expect(store.subscriberCount).toBe(1);
      unsubscribe();
      expect(store.subscriberCount).toBe(0);
    }

    expect(registrar).toHaveBeenCalledTimes(1);
    callbacks!.onOfflineReady();
    expect(notifications.every((listener) => listener.mock.calls.length === 0)).toBe(true);
    expect(store.getSnapshot().offlineReady).toBe(true);
  });

  it("publishes install state, supports dismissal, and delegates updates", async () => {
    let callbacks: PwaRegistrationCallbacks | null = null;
    const updater = vi.fn(async () => undefined);
    const store = new PwaRegistrationStore((nextCallbacks) => {
      callbacks = nextCallbacks;
      return updater;
    });
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    store.start();
    callbacks!.onOfflineReady();
    callbacks!.onNeedRefresh();
    expect(store.getSnapshot()).toMatchObject({ offlineReady: true, needRefresh: true });
    expect(listener).toHaveBeenCalledTimes(2);

    store.setOfflineReady(false);
    store.setNeedRefresh(false);
    await store.updateServiceWorker(true);
    expect(store.getSnapshot()).toMatchObject({ offlineReady: false, needRefresh: false });
    expect(updater).toHaveBeenCalledWith(true);
    expect(updater).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("publishes each snapshot to a stable subscriber set", () => {
    let callbacks: PwaRegistrationCallbacks | null = null;
    const store = new PwaRegistrationStore((nextCallbacks) => {
      callbacks = nextCallbacks;
      return vi.fn(async () => undefined);
    });
    const lateSubscriber = vi.fn();
    const firstSubscriber = vi.fn(() => {
      store.subscribe(lateSubscriber);
    });
    store.subscribe(firstSubscriber);

    store.start();
    callbacks!.onOfflineReady();
    expect(firstSubscriber).toHaveBeenCalledTimes(1);
    expect(lateSubscriber).not.toHaveBeenCalled();

    callbacks!.onNeedRefresh();
    expect(firstSubscriber).toHaveBeenCalledTimes(2);
    expect(lateSubscriber).toHaveBeenCalledTimes(1);
  });

  it("asks the browser to check past a pre-existing waiting worker", async () => {
    let callbacks: PwaRegistrationCallbacks | null = null;
    const store = new PwaRegistrationStore((nextCallbacks) => {
      callbacks = nextCallbacks;
      return vi.fn(async () => undefined);
    });
    const waiting = { version: "1.0.12" };
    const registration: {
      installing: ServiceWorkerUpdateRegistration["installing"];
      waiting: unknown | null;
      update: ReturnType<typeof vi.fn<() => Promise<void>>>;
    } = {
      installing: null,
      waiting,
      update: vi.fn(async () => undefined),
    };

    store.start();
    callbacks!.onRegisteredSW("./sw.js", registration);
    await vi.waitFor(() => expect(registration.update).toHaveBeenCalledTimes(1));
    expect(registration.update).toHaveBeenCalledWith();
  });

  it("holds a fast reload until the newer installing worker leaves installation", async () => {
    let callbacks: PwaRegistrationCallbacks | null = null;
    const update = deferred<void>();
    const stateListeners = new Set<() => void>();
    const candidate = {
      state: "installing",
      addEventListener: vi.fn((_type: "statechange", listener: () => void) => stateListeners.add(listener)),
      removeEventListener: vi.fn((_type: "statechange", listener: () => void) => stateListeners.delete(listener)),
    };
    const updateFoundListeners = new Set<() => void>();
    const registration = {
      installing: null as typeof candidate | null,
      waiting: { version: "1.0.17" },
      update: vi.fn(() => update.promise),
      addEventListener: vi.fn((_type: "updatefound", listener: () => void) => updateFoundListeners.add(listener)),
      removeEventListener: vi.fn((_type: "updatefound", listener: () => void) => updateFoundListeners.delete(listener)),
    };
    const activatedVersions: string[] = [];
    const updater = vi.fn(async () => {
      activatedVersions.push(registration.waiting.version);
    });
    const store = new PwaRegistrationStore((nextCallbacks) => {
      callbacks = nextCallbacks;
      return updater;
    });

    store.start();
    callbacks!.onNeedRefresh();
    callbacks!.onRegisteredSW("./sw.js", registration);
    const reload = store.updateServiceWorker(true);
    expect(updater).not.toHaveBeenCalled();

    registration.installing = candidate;
    for (const listener of updateFoundListeners) listener();
    update.resolve();
    await update.promise;
    await Promise.resolve();
    expect(updater).not.toHaveBeenCalled();

    registration.waiting = { version: "1.0.18" };
    candidate.state = "installed";
    for (const listener of stateListeners) listener();
    await expect(reload).resolves.toBeUndefined();
    expect(updater).toHaveBeenCalledExactlyOnceWith(true);
    expect(activatedVersions).toEqual(["1.0.18"]);
    expect(updateFoundListeners.size).toBe(0);
    expect(stateListeners.size).toBe(0);
  });

  it("shares a newer installation already started by another tab", async () => {
    let callbacks: PwaRegistrationCallbacks | null = null;
    const stateListeners = new Set<() => void>();
    const candidate = {
      state: "installing",
      addEventListener: vi.fn((_type: "statechange", listener: () => void) => stateListeners.add(listener)),
      removeEventListener: vi.fn((_type: "statechange", listener: () => void) => stateListeners.delete(listener)),
    };
    const registration = {
      installing: candidate,
      waiting: { version: "1.0.17" },
      update: vi.fn(async () => undefined),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    const activatedVersions: string[] = [];
    const updater = vi.fn(async () => {
      activatedVersions.push(registration.waiting.version);
    });
    const store = new PwaRegistrationStore((nextCallbacks) => {
      callbacks = nextCallbacks;
      return updater;
    });

    store.start();
    callbacks!.onNeedRefresh();
    callbacks!.onRegisteredSW("./sw.js", registration);
    const reload = store.updateServiceWorker(true);
    await Promise.resolve();
    expect(registration.update).not.toHaveBeenCalled();
    expect(updater).not.toHaveBeenCalled();

    registration.waiting = { version: "1.0.18" };
    candidate.state = "installed";
    for (const listener of stateListeners) listener();
    await expect(reload).resolves.toBeUndefined();
    expect(updater).toHaveBeenCalledExactlyOnceWith(true);
    expect(activatedVersions).toEqual(["1.0.18"]);
    expect(stateListeners.size).toBe(0);
  });

  it("waits for onRegisteredSW when the update prompt arrives first", async () => {
    let callbacks: PwaRegistrationCallbacks | null = null;
    const updater = vi.fn(async () => undefined);
    const store = new PwaRegistrationStore((nextCallbacks) => {
      callbacks = nextCallbacks;
      return updater;
    });

    store.start();
    callbacks!.onNeedRefresh();
    const reload = store.updateServiceWorker(true);
    await Promise.resolve();
    expect(updater).not.toHaveBeenCalled();

    callbacks!.onRegisteredSW("./sw.js", undefined);
    await expect(reload).resolves.toBeUndefined();
    expect(updater).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("refuses new UI waiters while the browser updater never settles", async () => {
    const neverSettles = new Promise<void>(() => undefined);
    const updater = vi.fn(() => neverSettles);
    const store = new PwaRegistrationStore(() => updater);

    const first = store.updateServiceWorker(true);
    const retries: Promise<void>[] = [];
    for (let cycle = 0; cycle < 10; cycle += 1) {
      const retry = store.updateServiceWorker(false);
      expect(retry).not.toBe(first);
      retries.push(retry);
    }

    await Promise.all(retries.map((retry) => expect(retry).rejects.toBeInstanceOf(PwaUpdatePendingError)));
    expect(updater).toHaveBeenCalledTimes(1);
    expect(updater).toHaveBeenCalledWith(true);
  });

  it("allows exactly one new update attempt after each success or failure settles", async () => {
    const first = deferred<void>();
    const failure = new Error("update rejected");
    const updater = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(undefined);
    const store = new PwaRegistrationStore(() => updater);

    const firstAttempt = store.updateServiceWorker(true);
    await expect(store.updateServiceWorker(false)).rejects.toBeInstanceOf(PwaUpdatePendingError);
    first.resolve(undefined);
    await expect(firstAttempt).resolves.toBeUndefined();

    await expect(store.updateServiceWorker(false)).rejects.toBe(failure);
    await expect(store.updateServiceWorker(true)).resolves.toBeUndefined();
    expect(updater.mock.calls).toEqual([[true], [false], [true]]);
  });

  it("surfaces a synchronous registration failure and permits one explicit retry", () => {
    const failure = new Error("registration failed");
    const updater = vi.fn(async () => undefined);
    const registrar = vi.fn()
      .mockImplementationOnce(() => { throw failure; })
      .mockReturnValueOnce(updater);
    const store = new PwaRegistrationStore(registrar);
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    store.start();
    expect(registrar).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot().error).toBe(failure);
    expect(listener).toHaveBeenCalledTimes(1);
    store.start();
    expect(registrar).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot().error).toBeNull();
    expect(listener).toHaveBeenCalledTimes(2);
    store.start();
    expect(registrar).toHaveBeenCalledTimes(2);

    unsubscribe();
    expect(store.subscriberCount).toBe(0);
  });

  it("retries after an active registration error and ignores stale attempt callbacks", async () => {
    const callbacks: PwaRegistrationCallbacks[] = [];
    const firstUpdater = vi.fn(async () => undefined);
    const secondUpdater = vi.fn(async () => undefined);
    const registrar = vi.fn((nextCallbacks: PwaRegistrationCallbacks) => {
      callbacks.push(nextCallbacks);
      return callbacks.length === 1 ? firstUpdater : secondUpdater;
    });
    const store = new PwaRegistrationStore(registrar);

    store.start();
    callbacks[0].onRegisterError(new Error("first failed"));
    store.start();
    callbacks[0].onRegisterError(new Error("stale failure"));
    callbacks[0].onOfflineReady();
    callbacks[1].onNeedRefresh();
    callbacks[1].onRegisteredSW("./sw.js", undefined);

    expect(registrar).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot()).toMatchObject({
      offlineReady: false,
      needRefresh: true,
      error: null,
    });
    await store.updateServiceWorker(false);
    expect(firstUpdater).not.toHaveBeenCalled();
    expect(secondUpdater).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("does not let a stale registrar throw overwrite a re-entrant retry", async () => {
    const reportedFailure = new Error("first attempt reported failure");
    const staleThrow = new Error("first registrar threw afterward");
    const updater = vi.fn(async () => undefined);
    let attempts = 0;
    let store!: PwaRegistrationStore;
    const registrar = vi.fn((callbacks: PwaRegistrationCallbacks) => {
      attempts += 1;
      if (attempts === 1) {
        callbacks.onRegisterError(reportedFailure);
        throw staleThrow;
      }
      return updater;
    });
    store = new PwaRegistrationStore(registrar);
    let retried = false;
    store.subscribe(() => {
      if (!retried && store.getSnapshot().error === reportedFailure) {
        retried = true;
        store.start();
      }
    });

    store.start();
    expect(registrar).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot().error).toBeNull();
    await expect(store.updateServiceWorker(false)).resolves.toBeUndefined();
    expect(updater).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("rejects an in-flight reload when registration fails and removes its stale prompt", async () => {
    let callbacks: PwaRegistrationCallbacks | null = null;
    const updater = vi.fn(async () => undefined);
    const failure = new Error("registration disappeared");
    const store = new PwaRegistrationStore((nextCallbacks) => {
      callbacks = nextCallbacks;
      return updater;
    });

    store.start();
    callbacks!.onNeedRefresh();
    const reload = store.updateServiceWorker(true);
    callbacks!.onRegisterError(failure);

    await expect(reload).rejects.toBe(failure);
    expect(updater).not.toHaveBeenCalled();
    expect(store.getSnapshot()).toMatchObject({
      needRefresh: false,
      error: failure,
    });
  });

  it("does not report success when a synchronous registration failure leaves no updater", async () => {
    const failure = new Error("registration unavailable");
    const store = new PwaRegistrationStore(() => { throw failure; });

    await expect(store.updateServiceWorker(true)).rejects.toBe(failure);
    expect(store.getSnapshot()).toMatchObject({
      needRefresh: false,
      error: failure,
    });
  });

  it("keeps a timed-out newer-worker check single-flight and never activates the old waiter", async () => {
    vi.useFakeTimers();
    try {
      let callbacks: PwaRegistrationCallbacks | null = null;
      const updater = vi.fn(async () => undefined);
      const registration = {
        installing: null,
        waiting: { version: "1.0.17" },
        update: vi.fn(() => new Promise<void>(() => undefined)),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      };
      const store = new PwaRegistrationStore((nextCallbacks) => {
        callbacks = nextCallbacks;
        return updater;
      });

      store.start();
      callbacks!.onNeedRefresh();
      callbacks!.onRegisteredSW("./sw.js", registration);
      const reload = store.updateServiceWorker(true);
      const reloadResult = expect(reload).rejects.toBeInstanceOf(PwaUpdatePendingError);
      await vi.advanceTimersByTimeAsync(8_000);

      await reloadResult;
      await expect(store.updateServiceWorker(true)).rejects.toBeInstanceOf(PwaUpdatePendingError);
      expect(registration.update).toHaveBeenCalledTimes(1);
      expect(updater).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not restart registration merely to reject a concurrent updater", async () => {
    const update = deferred<void>();
    const callbacks: PwaRegistrationCallbacks[] = [];
    const registrar = vi.fn((nextCallbacks: PwaRegistrationCallbacks) => {
      callbacks.push(nextCallbacks);
      return vi.fn(() => update.promise);
    });
    const store = new PwaRegistrationStore(registrar);

    store.start();
    const pending = store.updateServiceWorker(true);
    await Promise.resolve();
    callbacks[0].onRegisterError(new Error("registration failed while update remained pending"));
    await expect(store.updateServiceWorker(false)).rejects.toBeInstanceOf(PwaUpdatePendingError);
    expect(registrar).toHaveBeenCalledTimes(1);

    update.resolve(undefined);
    await expect(pending).resolves.toBeUndefined();
  });

  it("pairs online retry listeners across remounts without duplicating successful registration", () => {
    const listeners = new Set<() => void>();
    const target = {
      addEventListener: vi.fn((_type: "online", listener: () => void) => listeners.add(listener)),
      removeEventListener: vi.fn((_type: "online", listener: () => void) => listeners.delete(listener)),
    };
    const registrar = vi.fn(() => vi.fn(async () => undefined));
    const store = new PwaRegistrationStore(registrar);

    for (let cycle = 0; cycle < 10; cycle += 1) {
      const unbind = bindPwaRegistrationRetries(store, target);
      expect(listeners.size).toBe(1);
      for (const listener of listeners) listener();
      unbind();
      unbind();
      expect(listeners.size).toBe(0);
    }

    expect(registrar).toHaveBeenCalledTimes(1);
    expect(target.addEventListener).toHaveBeenCalledTimes(10);
    expect(target.removeEventListener).toHaveBeenCalledTimes(10);
  });

  it("routes App through the singleton store instead of a mount-scoped Workbox hook", () => {
    expect(appSource).toContain('from "./pwa/use-pwa-registration"');
    expect(appSource).not.toContain("virtual:pwa-register/react");
  });

  it("dismisses a latched offline-ready notice together with a postponed update", () => {
    const laterAction = appSource.slice(
      appSource.indexOf("if (updateBusyRef.current) return;", appSource.indexOf("A newer app version is ready.")),
      appSource.indexOf("}}", appSource.indexOf("if (updateBusyRef.current) return;", appSource.indexOf("A newer app version is ready."))),
    );

    expect(laterAction).toContain("setNeedRefresh(false);");
    expect(laterAction).toContain("setOfflineReady(false);");
  });
});

describe("checkForNewerServiceWorker", () => {
  it("does not add a redundant update job without a waiting worker", async () => {
    const update = vi.fn(async () => undefined);
    const registration = (overrides: Partial<ServiceWorkerUpdateRegistration>) => ({
      installing: null,
      waiting: null,
      update,
      ...overrides,
    });

    await checkForNewerServiceWorker(undefined);
    await checkForNewerServiceWorker(registration({}));
    await checkForNewerServiceWorker(registration({ waiting: {}, installing: {} }));

    expect(update).not.toHaveBeenCalled();
  });

  it("contains rejected and synchronously thrown opportunistic update checks", async () => {
    const failure = new Error("offline");
    const rejectedRegistration = {
      waiting: {},
      update: vi.fn(async () => { throw failure; }),
    };
    const thrownRegistration = {
      waiting: {},
      update: vi.fn<() => Promise<unknown>>(() => { throw failure; }),
    };

    await expect(checkForNewerServiceWorker(rejectedRegistration)).resolves.toBeUndefined();
    await expect(checkForNewerServiceWorker(thrownRegistration)).resolves.toBeUndefined();
    expect(rejectedRegistration.update).toHaveBeenCalledTimes(1);
    expect(thrownRegistration.update).toHaveBeenCalledTimes(1);
  });

  it("bounds a stuck update, removes listeners, and fails closed", async () => {
    const clock = controlledTimers();
    const updateFoundListeners = new Set<() => void>();
    const registration = {
      installing: null,
      waiting: {},
      update: vi.fn(() => new Promise<void>(() => undefined)),
      addEventListener: vi.fn((_type: "updatefound", listener: () => void) => updateFoundListeners.add(listener)),
      removeEventListener: vi.fn((_type: "updatefound", listener: () => void) => updateFoundListeners.delete(listener)),
    };

    const check = checkForNewerServiceWorker(registration, 25, clock.timers);
    expect(clock.size).toBe(1);
    expect(updateFoundListeners.size).toBe(1);
    clock.fire();

    await expect(check).rejects.toBeInstanceOf(PwaUpdatePendingError);
    expect(clock.size).toBe(0);
    expect(updateFoundListeners.size).toBe(0);
  });

  it("bounds an already-running installation and removes its state listener", async () => {
    const clock = controlledTimers();
    const stateListeners = new Set<() => void>();
    const candidate = {
      state: "installing",
      addEventListener: vi.fn((_type: "statechange", listener: () => void) => stateListeners.add(listener)),
      removeEventListener: vi.fn((_type: "statechange", listener: () => void) => stateListeners.delete(listener)),
    };
    const registration = {
      installing: candidate,
      waiting: {},
      update: vi.fn(async () => undefined),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };

    const check = checkForNewerServiceWorker(registration, 25, clock.timers);
    expect(clock.size).toBe(1);
    expect(stateListeners.size).toBe(1);
    expect(registration.update).not.toHaveBeenCalled();
    clock.fire();

    await expect(check).rejects.toBeInstanceOf(PwaUpdatePendingError);
    expect(clock.size).toBe(0);
    expect(stateListeners.size).toBe(0);
  });

  it("does not reattach a candidate listener when update settles after timeout", async () => {
    const clock = controlledTimers();
    const update = deferred<void>();
    const stateListeners = new Set<() => void>();
    const candidate = {
      state: "installing",
      addEventListener: vi.fn((_type: "statechange", listener: () => void) => stateListeners.add(listener)),
      removeEventListener: vi.fn((_type: "statechange", listener: () => void) => stateListeners.delete(listener)),
    };
    const registration = {
      installing: null as typeof candidate | null,
      waiting: {},
      update: vi.fn(() => update.promise),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };

    const check = checkForNewerServiceWorker(registration, 25, clock.timers);
    clock.fire();
    await expect(check).rejects.toBeInstanceOf(PwaUpdatePendingError);

    registration.installing = candidate;
    update.resolve(undefined);
    await update.promise;
    await Promise.resolve();
    expect(candidate.addEventListener).not.toHaveBeenCalled();
    expect(stateListeners.size).toBe(0);
  });
});

describe("ServiceWorkerCapabilityStore", () => {
  it("publishes capability to a stable subscriber set", () => {
    const store = new ServiceWorkerCapabilityStore();
    const lateSubscriber = vi.fn();
    const firstSubscriber = vi.fn(() => {
      store.subscribe(lateSubscriber);
    });
    store.subscribe(firstSubscriber);

    store.markCapable();
    expect(firstSubscriber).toHaveBeenCalledTimes(1);
    expect(lateSubscriber).not.toHaveBeenCalled();
  });

  it("ignores controllerchange callbacks that have no current controller", () => {
    let controllerChanged: (() => void) | null = null;
    const target = {
      controller: null as unknown | null,
      getRegistration: vi.fn(async () => undefined),
      addEventListener: vi.fn((_type: "controllerchange", listener: () => void) => {
        controllerChanged = listener;
      }),
      removeEventListener: vi.fn(),
    };
    const store = new ServiceWorkerCapabilityStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.start(target);

    controllerChanged!();
    expect(store.getSnapshot()).toBe(false);
    expect(listener).not.toHaveBeenCalled();

    target.controller = {};
    controllerChanged!();
    expect(store.getSnapshot()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("latches an authoritative offline-ready install after an empty early probe", async () => {
    const listener = vi.fn();
    const target: ServiceWorkerCapabilityTarget = {
      controller: null,
      getRegistration: vi.fn(async () => undefined),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    const store = new ServiceWorkerCapabilityStore();
    const unsubscribe = store.subscribe(listener);

    store.start(target);
    await Promise.resolve();
    expect(store.getSnapshot()).toBe(false);

    store.markCapable();
    store.markCapable();
    expect(store.getSnapshot()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    store.stop();
    expect(store.subscriberCount).toBe(0);
  });

  it("owns one page-lifetime registration lookup and one controller listener across remounts", async () => {
    const registration = deferred<{ readonly active?: unknown | null } | undefined>();
    const controllerListeners = new Set<() => void>();
    const target: ServiceWorkerCapabilityTarget = {
      controller: null,
      getRegistration: vi.fn(() => registration.promise),
      addEventListener: vi.fn((_type, listener) => controllerListeners.add(listener)),
      removeEventListener: vi.fn((_type, listener) => controllerListeners.delete(listener)),
    };
    const store = new ServiceWorkerCapabilityStore();
    const notifications = Array.from({ length: 10 }, () => vi.fn());

    for (const listener of notifications) {
      store.start(target);
      const unsubscribe = store.subscribe(listener);
      expect(store.subscriberCount).toBe(1);
      unsubscribe();
      expect(store.subscriberCount).toBe(0);
    }

    expect(target.getRegistration).toHaveBeenCalledTimes(1);
    expect(target.addEventListener).toHaveBeenCalledTimes(1);
    expect(controllerListeners.size).toBe(1);
    registration.resolve({ active: {} });
    await registration.promise;
    await Promise.resolve();
    expect(store.getSnapshot()).toBe(true);
    expect(notifications.every((listener) => listener.mock.calls.length === 0)).toBe(true);

    store.stop();
    expect(target.removeEventListener).toHaveBeenCalledTimes(1);
    expect(controllerListeners.size).toBe(0);
  });

  it("ignores a late registration result after ownership stops", async () => {
    const registration = deferred<{ readonly active?: unknown | null } | undefined>();
    const target: ServiceWorkerCapabilityTarget = {
      controller: null,
      getRegistration: vi.fn(() => registration.promise),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    const store = new ServiceWorkerCapabilityStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.start(target);
    store.stop();

    registration.resolve({ active: {} });
    await registration.promise;
    await Promise.resolve();
    expect(store.getSnapshot()).toBe(false);
    expect(listener).not.toHaveBeenCalled();
  });
});
