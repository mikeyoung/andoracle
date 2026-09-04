import { describe, expect, it, vi } from "vitest";
import appSource from "../App.tsx?raw";
import {
  PwaRegistrationStore,
  ServiceWorkerCapabilityStore,
  bindPwaRegistrationRetries,
  type PwaRegistrationCallbacks,
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

  it("coalesces repeated update requests while the browser updater never settles", () => {
    const neverSettles = new Promise<void>(() => undefined);
    const updater = vi.fn(() => neverSettles);
    const store = new PwaRegistrationStore(() => updater);

    const first = store.updateServiceWorker(true);
    for (let cycle = 0; cycle < 10; cycle += 1) {
      expect(store.updateServiceWorker(false)).toBe(first);
    }

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
    expect(store.updateServiceWorker(false)).toBe(firstAttempt);
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
});

describe("ServiceWorkerCapabilityStore", () => {
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
