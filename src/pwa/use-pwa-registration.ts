import { useEffect, useSyncExternalStore } from "react";
import { registerSW } from "virtual:pwa-register";
import { PwaRegistrationStore } from "./registration-store";

const registrationStore = new PwaRegistrationStore((callbacks) => registerSW({
  immediate: true,
  ...callbacks,
}));

export const usePwaRegistration = () => {
  const snapshot = useSyncExternalStore(
    registrationStore.subscribe,
    registrationStore.getSnapshot,
    registrationStore.getSnapshot,
  );

  useEffect(() => {
    registrationStore.start();
  }, []);

  return {
    ...snapshot,
    setOfflineReady: registrationStore.setOfflineReady,
    setNeedRefresh: registrationStore.setNeedRefresh,
    clearError: registrationStore.clearError,
    updateServiceWorker: registrationStore.updateServiceWorker,
  };
};
