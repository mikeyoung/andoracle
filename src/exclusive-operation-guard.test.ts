import { describe, expect, it } from "vitest";
import { ExclusiveOperationGuard } from "./exclusive-operation-guard";

describe("ExclusiveOperationGuard", () => {
  it("allows the first cancellation and rejects overlapping retries", () => {
    const guard = new ExclusiveOperationGuard();
    const first = guard.acquire();

    expect(first).not.toBeNull();
    expect(guard.isActive).toBe(true);
    expect(guard.acquire()).toBeNull();
  });

  it("allows a new operation after the active lease completes or fails", () => {
    const guard = new ExclusiveOperationGuard();
    const first = guard.acquire()!;

    expect(guard.release(first)).toBe(true);
    expect(guard.isActive).toBe(false);
    expect(guard.acquire()).not.toBeNull();
  });

  it("does not let a stale continuation release a post-unmount lease", () => {
    const guard = new ExclusiveOperationGuard();
    const stale = guard.acquire()!;
    guard.invalidate();
    const current = guard.acquire()!;

    expect(guard.release(stale)).toBe(false);
    expect(guard.isActive).toBe(true);
    expect(guard.release(current)).toBe(true);
    expect(guard.isActive).toBe(false);
  });
});
