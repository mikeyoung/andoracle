export interface OperationCancellation {
  readonly cancel: () => void;
  readonly race: <T>(operation: T | PromiseLike<T>) => Promise<T>;
}

/**
 * Lets a component release its async continuation even when the underlying
 * browser-owned promise cannot itself be aborted.
 */
export const createOperationCancellation = (message: string): OperationCancellation => {
  let rejectCancellation!: (error: Error) => void;
  let cancelled = false;
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
      rejectCancellation(error);
    },
    race: <T>(operation: T | PromiseLike<T>): Promise<T> => (
      Promise.race([Promise.resolve(operation), cancellation])
    ),
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
