import { useEffect, useSyncExternalStore } from "react";
import { registerSW } from "virtual:pwa-register";
import {
  PwaRegistrationStore,
  ServiceWorkerCapabilityStore,
  bindPwaRegistrationRetries,
  type ServiceWorkerCapabilityTarget,
} from "./registration-store";

const registrationStore = new PwaRegistrationStore((callbacks) => registerSW({
  immediate: true,
  ...callbacks,
}));
const serviceWorkerCapabilityStore = new ServiceWorkerCapabilityStore();
const extensionBuild = import.meta.env.VITE_EXTENSION_BUILD === "true";

export const usePwaRegistration = () => {
  const snapshot = useSyncExternalStore(
    registrationStore.subscribe,
    registrationStore.getSnapshot,
    registrationStore.getSnapshot,
  );

  useEffect(() => bindPwaRegistrationRetries(registrationStore, window), []);

  return {
    ...snapshot,
    setOfflineReady: registrationStore.setOfflineReady,
    setNeedRefresh: registrationStore.setNeedRefresh,
    clearError: registrationStore.clearError,
    updateServiceWorker: registrationStore.updateServiceWorker,
  };
};

export const useServiceWorkerCapability = (): boolean => {
  const capable = useSyncExternalStore(
    serviceWorkerCapabilityStore.subscribe,
    serviceWorkerCapabilityStore.getSnapshot,
    serviceWorkerCapabilityStore.getSnapshot,
  );

  useEffect(() => {
    if (extensionBuild) return;
    if (!("serviceWorker" in navigator)) return;
    serviceWorkerCapabilityStore.start(
      navigator.serviceWorker as unknown as ServiceWorkerCapabilityTarget,
    );
  }, []);

  // Packaged extension resources are local to the browser and remain
  // available without the hosted PWA's Workbox service worker.
  return extensionBuild || capable;
};
