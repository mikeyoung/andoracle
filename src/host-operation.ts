export const HOST_OPERATION_UI_TIMEOUT_MS = 10_000;

export interface HostOperationTimerApi {
  setTimeout(callback: () => void, delayMs: number): number;
  clearTimeout(handle: number): void;
}

const browserTimers: HostOperationTimerApi = {
  setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
  clearTimeout: (handle) => window.clearTimeout(handle),
};

export interface HostOperationDeadline {
  readonly timedOut: boolean;
  dispose(): void;
}

/**
 * Bounds only the UI's wait for a browser-owned promise. The raw host work is
 * deliberately left observed by its gate because APIs such as Web Share and
 * service-worker updates do not provide a portable abort operation.
 */
export const createHostOperationDeadline = (
  cancelWait: () => void,
  timeoutMs = HOST_OPERATION_UI_TIMEOUT_MS,
  timers: HostOperationTimerApi = browserTimers,
): HostOperationDeadline => {
  let timedOut = false;
  let handle: number | null = timers.setTimeout(() => {
    handle = null;
    timedOut = true;
    cancelWait();
  }, timeoutMs);

  return {
    get timedOut(): boolean {
      return timedOut;
    },
    dispose: (): void => {
      if (handle === null) return;
      timers.clearTimeout(handle);
      handle = null;
    },
  };
};

export type CoalescedHostOperation<Result> =
  | {
      readonly status: "started";
      readonly promise: Promise<Result>;
    }
  | {
      readonly status: "busy";
    };

interface PendingHostOperation<Result> {
  readonly promise: Promise<Result>;
}

/**
 * Keeps at most one non-abortable host operation alive at a time. A pending
 * operation is never handed to a second UI waiter: cancelling Promise.race
 * cannot detach its reaction from a never-settling browser promise, so joins
 * would otherwise retain one more abandoned continuation on every retry.
 */
export class KeyedHostOperationGate<Key, Result> {
  private pending: PendingHostOperation<Result> | null = null;

  run(_key: Key, start: () => Result | PromiseLike<Result>): CoalescedHostOperation<Result> {
    if (this.pending) return { status: "busy" };

    let raw: Promise<Result>;
    try {
      raw = Promise.resolve(start());
    } catch (error) {
      raw = Promise.reject(error);
    }

    let tracked: Promise<Result>;
    tracked = raw.finally(() => {
      if (this.pending?.promise === tracked) this.pending = null;
    });
    // A UI deadline may release its only waiter before the host settles.
    // Observe a later rejection without extending the UI continuation.
    void tracked.catch(() => undefined);
    this.pending = { promise: tracked };
    return { status: "started", promise: tracked };
  }

  get isPending(): boolean {
    return this.pending !== null;
  }
}
