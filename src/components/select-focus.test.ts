import { describe, expect, it, vi } from "vitest";
import { DeferredSelectFocusRelease } from "./select-focus";

const focusReleaseHarness = () => {
  let nextTimerId = 1;
  const callbacks = new Map<number, () => void>();
  const clearTimer = vi.fn((timerId: number) => {
    callbacks.delete(timerId);
  });
  const release = new DeferredSelectFocusRelease((callback) => {
    const timerId = nextTimerId;
    nextTimerId += 1;
    callbacks.set(timerId, callback);
    return timerId;
  }, clearTimer);

  return { callbacks, clearTimer, release };
};

describe("native selector focus modality", () => {
  it("defers blur after a pointer selection so native focus restoration cannot win", () => {
    const blur = vi.fn();
    const { callbacks, release } = focusReleaseHarness();

    expect(release.finish({ blur }, "pointer")).toBe(true);
    expect(blur).not.toHaveBeenCalled();

    callbacks.values().next().value?.();
    expect(blur).toHaveBeenCalledTimes(1);
  });

  it("retains focus after a keyboard selection for continued option navigation", () => {
    const blur = vi.fn();
    const { release } = focusReleaseHarness();

    expect(release.finish({ blur }, "keyboard")).toBe(false);
    expect(blur).not.toHaveBeenCalled();
  });

  it("coalesces repeated pointer changes and cancels pending work on disposal", () => {
    const firstBlur = vi.fn();
    const secondBlur = vi.fn();
    const { callbacks, clearTimer, release } = focusReleaseHarness();

    release.finish({ blur: firstBlur }, "pointer");
    release.finish({ blur: secondBlur }, "pointer");

    expect(clearTimer).toHaveBeenCalledTimes(1);
    expect(callbacks.size).toBe(1);
    release.dispose();
    expect(clearTimer).toHaveBeenCalledTimes(2);
    expect(callbacks.size).toBe(0);
    expect(firstBlur).not.toHaveBeenCalled();
    expect(secondBlur).not.toHaveBeenCalled();
  });
});
