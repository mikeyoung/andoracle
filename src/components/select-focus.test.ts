import { describe, expect, it, vi } from "vitest";
import { DeferredSelectFocusRelease } from "./select-focus";

const focusReleaseHarness = () => {
  let nextTimerId = 1;
  let nextFrameId = 100;
  const callbacks = new Map<number, () => void>();
  const frames = new Map<number, FrameRequestCallback>();
  const clearTimer = vi.fn((timerId: number) => {
    callbacks.delete(timerId);
  });
  const cancelFrame = vi.fn((frameId: number) => {
    frames.delete(frameId);
  });
  const setTimer = vi.fn((callback: () => void) => {
    const timerId = nextTimerId;
    nextTimerId += 1;
    callbacks.set(timerId, callback);
    return timerId;
  });
  const release = new DeferredSelectFocusRelease(setTimer, clearTimer, (callback) => {
    const frameId = nextFrameId;
    nextFrameId += 1;
    frames.set(frameId, callback);
    return frameId;
  }, cancelFrame, () => true);

  return { callbacks, cancelFrame, clearTimer, frames, release, setTimer };
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

  it("waits for a pointer-opened native picker to close even when no value changes", () => {
    const blur = vi.fn();
    let open = true;
    const select = {
      blur,
      matches: vi.fn(() => open),
    };
    const { callbacks, frames, release, setTimer } = focusReleaseHarness();

    expect(release.watchPointerPicker(select)).toBe(true);
    expect(frames.size).toBe(1);
    const openedFrame = frames.values().next().value;
    frames.clear();
    openedFrame?.(0);
    expect(select.matches).toHaveBeenCalledWith(":open");
    expect(frames.size).toBe(0);
    expect(callbacks.size).toBe(1);
    expect(setTimer).toHaveBeenCalledWith(expect.any(Function), 100);
    expect(blur).not.toHaveBeenCalled();

    open = false;
    const pollTimerId = callbacks.keys().next().value;
    const closedPoll = callbacks.get(pollTimerId!);
    callbacks.delete(pollTimerId!);
    closedPoll?.();
    expect(callbacks.size).toBe(1);
    expect(release.hasPointerFocusReleasePending).toBe(true);
    expect(blur).not.toHaveBeenCalled();
    callbacks.values().next().value?.();
    expect(blur).toHaveBeenCalledTimes(1);
    expect(release.hasPointerFocusReleasePending).toBe(false);
  });

  it("cancels a pointer picker watch when its owner disposes", () => {
    const select = { blur: vi.fn(), matches: vi.fn(() => true) };
    const { cancelFrame, frames, release } = focusReleaseHarness();

    release.watchPointerPicker(select);
    expect(release.hasPointerFocusReleasePending).toBe(true);
    expect(frames.size).toBe(1);
    release.dispose();

    expect(cancelFrame).toHaveBeenCalledTimes(1);
    expect(frames.size).toBe(0);
    expect(release.hasPointerFocusReleasePending).toBe(false);
    expect(select.blur).not.toHaveBeenCalled();
  });

  it("cancels the throttled open-picker poll on disposal", () => {
    const select = { blur: vi.fn(), matches: vi.fn(() => true) };
    const { callbacks, clearTimer, frames, release } = focusReleaseHarness();

    release.watchPointerPicker(select);
    const initialFrame = frames.values().next().value;
    frames.clear();
    initialFrame?.(0);
    expect(callbacks.size).toBe(1);
    expect(release.hasPointerFocusReleasePending).toBe(true);

    release.dispose();
    expect(clearTimer).toHaveBeenCalledTimes(1);
    expect(callbacks.size).toBe(0);
    expect(release.hasPointerFocusReleasePending).toBe(false);
  });

  it("replaces the open-state watch with one deferred blur when change fires", () => {
    const select = { blur: vi.fn(), matches: vi.fn(() => true) };
    const { callbacks, cancelFrame, frames, release } = focusReleaseHarness();

    release.watchPointerPicker(select);
    expect(frames.size).toBe(1);
    expect(release.finish(select, "pointer")).toBe(true);

    expect(cancelFrame).toHaveBeenCalledTimes(1);
    expect(frames.size).toBe(0);
    expect(callbacks.size).toBe(1);
    callbacks.values().next().value?.();
    expect(select.blur).toHaveBeenCalledTimes(1);
  });

  it("retains the change-event fallback when select-open state is unsupported", () => {
    const requestFrame = vi.fn(() => 101);
    const release = new DeferredSelectFocusRelease(
      vi.fn(() => 1),
      vi.fn(),
      requestFrame,
      vi.fn(),
      () => false,
    );
    const select = { blur: vi.fn(), matches: vi.fn(() => false) };

    expect(release.watchPointerPicker(select)).toBe(false);
    expect(requestFrame).not.toHaveBeenCalled();
    expect(select.matches).not.toHaveBeenCalled();
  });
});
