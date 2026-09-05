import { describe, expect, it, vi } from "vitest";
import {
  KeyedHostOperationGate,
  createHostOperationDeadline,
  type HostOperationTimerApi,
} from "./host-operation";

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
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

describe("host-owned operation lifecycle", () => {
  it("refuses repeated waits for the same pending operation", async () => {
    const pending = deferred<number>();
    const start = vi.fn(() => pending.promise);
    const gate = new KeyedHostOperationGate<string, number>();
    const first = gate.run("same patch URL", start);
    const retries = Array.from({ length: 10 }, () => gate.run("same patch URL", start));

    expect(first.status).toBe("started");
    expect(retries).toEqual(Array.from({ length: 10 }, () => ({ status: "busy" })));
    expect(start).toHaveBeenCalledTimes(1);
    if (first.status === "busy") throw new Error("Expected the first operation to start.");

    pending.resolve(7);
    await expect(first.promise).resolves.toBe(7);
    expect(gate.isPending).toBe(false);
  });

  it("refuses a different operation while the raw host call is unresolved", async () => {
    const pending = deferred<void>();
    const firstStart = vi.fn(() => pending.promise);
    const secondStart = vi.fn(async () => undefined);
    const gate = new KeyedHostOperationGate<string, void>();

    expect(gate.run("old patch URL", firstStart).status).toBe("started");
    expect(gate.run("new patch URL", secondStart)).toEqual({ status: "busy" });
    expect(firstStart).toHaveBeenCalledTimes(1);
    expect(secondStart).not.toHaveBeenCalled();

    pending.resolve(undefined);
    await pending.promise;
    await Promise.resolve();
    expect(gate.run("new patch URL", secondStart).status).toBe("started");
    expect(secondStart).toHaveBeenCalledTimes(1);
  });

  it("releases the UI deadline while leaving host settlement independent", () => {
    const callbacks = new Map<number, () => void>();
    const timers: HostOperationTimerApi = {
      setTimeout: vi.fn((callback) => {
        callbacks.set(71, callback);
        return 71;
      }),
      clearTimeout: vi.fn((handle) => {
        callbacks.delete(handle);
      }),
    };
    const cancelWait = vi.fn();
    const deadline = createHostOperationDeadline(cancelWait, 250, timers);

    expect(deadline.timedOut).toBe(false);
    callbacks.get(71)?.();
    expect(deadline.timedOut).toBe(true);
    expect(cancelWait).toHaveBeenCalledTimes(1);
    deadline.dispose();
    expect(timers.clearTimeout).not.toHaveBeenCalled();
  });

  it("clears an owned deadline timer after normal settlement", () => {
    const timers: HostOperationTimerApi = {
      setTimeout: vi.fn(() => 72),
      clearTimeout: vi.fn(),
    };
    const cancelWait = vi.fn();
    const deadline = createHostOperationDeadline(cancelWait, 250, timers);

    deadline.dispose();
    deadline.dispose();

    expect(timers.clearTimeout).toHaveBeenCalledExactlyOnceWith(72);
    expect(cancelWait).not.toHaveBeenCalled();
    expect(deadline.timedOut).toBe(false);
  });
});
