export interface OperationCancellation {
  readonly cancel: () => void;
  readonly race: <T>(operation: T | PromiseLike<T>) => Promise<T>;
  /** Aborts alongside the rejected race so underlying work can revoke writes. */
  readonly signal: AbortSignal;
}

/** Bounds browser-owned library locks that fail to settle or invoke a callback. */
export const LIBRARY_WRITE_TIMEOUT_MS = 10_000;

/**
 * Lets a component release its async continuation even when the underlying
 * browser-owned promise cannot itself be aborted.
 */
export const createOperationCancellation = (message: string): OperationCancellation => {
  let rejectCancellation!: (error: Error) => void;
  let cancelled = false;
  let cancellationError: Error | null = null;
  const controller = new AbortController();
  const cancellation = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject;
  });
  // Cleanup can run between construction and the first race (for example,
  // during a synchronous unmount). Keep that valid path rejection-handled.
  void cancellation.catch(() => undefined);

  return {
    cancel: () => {
      if (cancelled) return;
      cancelled = true;
      const error = new Error(message);
      error.name = "AbortError";
      cancellationError = error;
      // Queue the cancellation rejection before firing abort listeners so the
      // public race always observes cancellation, even if an underlying API
      // resolves its own abort path synchronously.
      rejectCancellation(error);
      controller.abort(error);
    },
    race: <T>(operation: T | PromiseLike<T>): Promise<T> => {
      const observedOperation = Promise.resolve(operation);
      if (cancellationError) {
        void observedOperation.catch(() => undefined);
        return Promise.reject(cancellationError);
      }
      return Promise.race([observedOperation, cancellation]);
    },
    signal: controller.signal,
  };
};

/** Owns all cancellable waits for one mounted component instance. */
export class OperationCancellationRegistry {
  private readonly operations = new Map<string, OperationCancellation>();

  begin(key: string, message: string): OperationCancellation {
    this.operations.get(key)?.cancel();
    const operation = createOperationCancellation(message);
    this.operations.set(key, operation);
    return operation;
  }

  finish(key: string, operation: OperationCancellation): void {
    if (this.operations.get(key) === operation) this.operations.delete(key);
  }

  cancelAll(): void {
    const operations = [...this.operations.values()];
    this.operations.clear();
    for (const operation of operations) operation.cancel();
  }

  get size(): number {
    return this.operations.size;
  }
}
