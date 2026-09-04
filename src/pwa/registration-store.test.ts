import { describe, expect, it, vi } from "vitest";
import appSource from "../App.tsx?raw";
import { PwaRegistrationStore, type PwaRegistrationCallbacks } from "./registration-store";

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

  it("surfaces a synchronous registration failure without retrying or leaking subscribers", () => {
    const failure = new Error("registration failed");
    const registrar = vi.fn(() => {
      throw failure;
    });
    const store = new PwaRegistrationStore(registrar);
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    store.start();
    store.start();
    expect(registrar).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot().error).toBe(failure);
    expect(listener).toHaveBeenCalledTimes(1);
    store.clearError();
    expect(store.getSnapshot().error).toBeNull();

    unsubscribe();
    expect(store.subscriberCount).toBe(0);
  });

  it("routes App through the singleton store instead of a mount-scoped Workbox hook", () => {
    expect(appSource).toContain('from "./pwa/use-pwa-registration"');
    expect(appSource).not.toContain("virtual:pwa-register/react");
  });
});
