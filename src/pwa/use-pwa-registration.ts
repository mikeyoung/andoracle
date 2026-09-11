import { useEffect, useSyncExternalStore } from "react";
import { registerSW } from "virtual:pwa-register";
import {
  PwaRegistrationStore,
  ServiceWorkerCapabilityStore,
  bindPwaRegistrationRetries,
  type ServiceWorkerCapabilityTarget,
} from "./registration-store";

const serviceWorkerCapabilityStore = new ServiceWorkerCapabilityStore();
const registrationStore = new PwaRegistrationStore((callbacks) => registerSW({
  immediate: true,
  ...callbacks,
  onOfflineReady: () => {
    // Workbox has completed the first install. This is stronger evidence than
    // the mount-time capability probe, which may have resolved just before
    // the registration was created and receives no controllerchange on a
    // deliberately unclaimed first-install page.
    serviceWorkerCapabilityStore.markCapable();
    callbacks.onOfflineReady();
  },
}));
const extensionBuild = import.meta.env.VITE_EXTENSION_BUILD === "true";

export const usePwaRegistration = () => {
  const snapshot = useSyncExternalStore(
    registrationStore.subscribe,
    registrationStore.getSnapshot,
    registrationStore.getSnapshot,
  );

  useEffect(() => {
    // Extension assets are already local and the extension build replaces the
    // registrar with a no-op. Do not create an online listener or a page-long
    // unresolved registration check for a service worker that cannot exist.
    if (extensionBuild) return;
    return bindPwaRegistrationRetries(registrationStore, window);
  }, []);

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
