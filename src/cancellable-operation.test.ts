import { describe, expect, it, vi } from "vitest";
import appSource from "./App.tsx?raw";
import { OperationCancellationRegistry, createOperationCancellation } from "./cancellable-operation";

describe("createOperationCancellation", () => {
  it("can be cancelled before any waiter is attached without an unhandled rejection", async () => {
    const cancellation = createOperationCancellation("no waiter");
    expect(() => cancellation.cancel()).not.toThrow();
    await expect(cancellation.race(Promise.resolve("too late"))).rejects.toMatchObject({
      name: "AbortError",
      message: "no waiter",
    });
    await Promise.resolve();
  });

  it("promptly releases every waiter without requiring a host promise to settle", async () => {
    const cancellation = createOperationCancellation("component unmounted");
    const neverSettles = new Promise<void>(() => undefined);
    const waits = Array.from({ length: 10 }, () => (
      cancellation.race(neverSettles).catch((error: unknown) => error)
    ));

    cancellation.cancel();
    cancellation.cancel();

    for (const wait of waits) {
      await expect(wait).resolves.toMatchObject({
        name: "AbortError",
        message: "component unmounted",
      });
    }
    expect(cancellation.signal.aborted).toBe(true);
    expect(cancellation.signal.reason).toMatchObject({
      name: "AbortError",
      message: "component unmounted",
    });
  });

  it("passes through normal settlement and ignores a later cancellation", async () => {
    const cancellation = createOperationCancellation("too late");
    const operation = vi.fn(async () => 42);

    await expect(cancellation.race(operation())).resolves.toBe(42);
    cancellation.cancel();
    await Promise.resolve();
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("releases never-settling host waits across ten component unmount cycles", async () => {
    const neverSettles = new Promise<void>(() => undefined);

    for (let cycle = 0; cycle < 10; cycle += 1) {
      const registry = new OperationCancellationRegistry();
      const operation = registry.begin("share", "component unmounted");
      const waiting = operation.race(neverSettles).catch((error: unknown) => error);
      registry.cancelAll();
      await expect(waiting).resolves.toMatchObject({ name: "AbortError" });
      expect(registry.size).toBe(0);
    }
  });

  it("bounds and coalesces browser-owned share and update waits", () => {
    expect(appSource).toMatch(/browserOperations\.begin\(\s*"share"/);
    expect(appSource).toContain("patchShareOperationGate.run(");
    expect(appSource).toContain("cancellation.race(hostOperation.promise)");
    expect(appSource.match(/createHostOperationDeadline\(/g)).toHaveLength(2);
    expect(appSource).toContain("Patch sharing timed out.");
    expect(appSource).toContain("App update timed out.");
    expect(appSource).toContain("cancelUpdateWaitRef.current?.();");
    const laterAction = appSource.indexOf("cancelUpdateWaitRef.current?.();");
    const laterButton = appSource.slice(
      appSource.lastIndexOf("<button", laterAction),
      appSource.indexOf("</button>", laterAction),
    );
    expect(laterButton).not.toContain("disabled=");
    expect(appSource).toContain("browserOperations.cancelAll();");
  });
});
