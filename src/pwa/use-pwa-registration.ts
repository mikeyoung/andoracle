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
    if (!("serviceWorker" in navigator)) return;
    serviceWorkerCapabilityStore.start(
      navigator.serviceWorker as unknown as ServiceWorkerCapabilityTarget,
    );
  }, []);

  return capable;
};
