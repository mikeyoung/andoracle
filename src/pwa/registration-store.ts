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
  private started = false;

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
    if (this.started) return;
    this.started = true;
    try {
      this.updater = this.registrar({
        onOfflineReady: () => this.update({ offlineReady: true }),
        onNeedRefresh: () => this.update({ needRefresh: true }),
        onRegisterError: (error) => this.update({ error }),
      });
    } catch (error) {
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

  readonly updateServiceWorker = async (reloadPage = true): Promise<void> => {
    this.start();
    await this.updater?.(reloadPage);
  };

  get subscriberCount(): number {
    return this.listeners.size;
  }
}
