import { describe, expect, it, vi } from "vitest";
import {
  AUDIO_KEEPALIVE_MEDIA_RETRY_MS,
  AUDIO_KEEPALIVE_RECOVERY_RETRY_BASE_MS,
  AUDIO_KEEPALIVE_STABLE_PLAYBACK_MS,
  AUDIO_KEEPALIVE_WATCHDOG_MS,
  AudioKeepAliveController,
  type AudioKeepAliveEnvironment,
  type AudioKeepAliveMediaElement,
  type AudioKeepAliveWakeLockSentinel,
} from "./keepalive";

const deferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

class FakeEventTarget {
  readonly listeners = new Map<string, Set<() => void>>();

  addEventListener(type: string, listener: () => void): void {
    const listeners = this.listeners.get(type) ?? new Set<() => void>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: () => void): void {
    const listeners = this.listeners.get(type);
    listeners?.delete(listener);
    if (listeners?.size === 0) this.listeners.delete(type);
  }

  dispatch(type: string): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener();
  }

  get listenerCount(): number {
    return [...this.listeners.values()].reduce((total, listeners) => total + listeners.size, 0);
  }
}

class FakeMedia extends FakeEventTarget implements AudioKeepAliveMediaElement {
  src = "";
  loop = false;
  preload = "none";
  muted = true;
  volume = 0;
  currentTime = 17;
  paused = true;
  readonly play = vi.fn<() => Promise<void> | void>(() => {
    this.paused = false;
    this.dispatch("playing");
    return Promise.resolve();
  });
  readonly pause = vi.fn(() => {
    this.paused = true;
    this.dispatch("pause");
  });
  readonly load = vi.fn();
  readonly remove = vi.fn();

  hostPause(): void {
    this.paused = true;
    this.dispatch("pause");
  }
}

class FakeWakeSentinel extends FakeEventTarget implements AudioKeepAliveWakeLockSentinel {
  released = false;
  readonly release = vi.fn(async () => {
    if (this.released) return;
    this.released = true;
    this.dispatch("release");
  });

  hostRelease(): void {
    this.released = true;
    this.dispatch("release");
  }
}

class FakeTimers {
  readonly callbacks = new Map<number, () => void>();
  readonly delays = new Map<number, number>();
  readonly cleared: number[] = [];
  readonly timeoutCallbacks = new Map<number, () => void>();
  readonly timeoutDelays = new Map<number, number>();
  readonly clearedTimeouts: number[] = [];
  private nextHandle = 1;

  readonly setInterval = (callback: () => void, delayMs: number): number => {
    const handle = this.nextHandle++;
    this.callbacks.set(handle, callback);
    this.delays.set(handle, delayMs);
    return handle;
  };

  readonly clearInterval = (handle: number): void => {
    this.callbacks.delete(handle);
    this.delays.delete(handle);
    this.cleared.push(handle);
  };

  readonly setTimeout = (callback: () => void, delayMs: number): number => {
    const handle = this.nextHandle++;
    this.timeoutCallbacks.set(handle, callback);
    this.timeoutDelays.set(handle, delayMs);
    return handle;
  };

  readonly clearTimeout = (handle: number): void => {
    this.timeoutCallbacks.delete(handle);
    this.timeoutDelays.delete(handle);
    this.clearedTimeouts.push(handle);
  };

  fire(): void {
    for (const callback of [...this.callbacks.values()]) callback();
  }

  fireTimeouts(): void {
    const callbacks = [...this.timeoutCallbacks.values()];
    this.timeoutCallbacks.clear();
    this.timeoutDelays.clear();
    for (const callback of callbacks) callback();
  }
}

const settle = async (): Promise<void> => {
  for (let microtask = 0; microtask < 10; microtask += 1) {
    await Promise.resolve();
  }
};

const makeHarness = (options: {
  recover?: () => void | Promise<void>;
  ready?: () => boolean;
  play?: () => void | Promise<void>;
  requestWakeLock?: () => Promise<FakeWakeSentinel>;
} = {}) => {
  const documentTarget = Object.assign(new FakeEventTarget(), { hidden: false });
  const windowTarget = new FakeEventTarget();
  const media = new FakeMedia();
  if (options.play) media.play.mockImplementation(options.play);
  const timers = new FakeTimers();
  const audioSession = { type: "auto" };
  const mediaSession = { playbackState: "none" as MediaSessionPlaybackState };
  const wakeRequest = vi.fn(options.requestWakeLock ?? (async () => new FakeWakeSentinel()));
  const recover = vi.fn(options.recover ?? (() => undefined));
  const environment: AudioKeepAliveEnvironment = {
    document: documentTarget,
    window: windowTarget,
    navigator: {
      wakeLock: { request: wakeRequest },
      audioSession,
      mediaSession,
    },
    timers,
    createMediaElement: () => media,
  };
  const controller = new AudioKeepAliveController({
    sourceUrl: "/assets/audio-keepalive.wav",
    ensureAudioReady: recover,
    isAudioReady: options.ready,
    environment,
  });
  return {
    audioSession,
    controller,
    documentTarget,
    media,
    mediaSession,
    recover,
    timers,
    wakeRequest,
    windowTarget,
  };
};

describe("AudioKeepAliveController", () => {
  it("starts the unmuted media session, recovery watchdog, and screen wake lock with Power", async () => {
    const harness = makeHarness();
    const { controller, media, timers, recover, wakeRequest, audioSession, mediaSession } = harness;

    expect(media).toMatchObject({
      src: "/assets/audio-keepalive.wav",
      loop: true,
      preload: "auto",
      muted: false,
      volume: 1,
    });
    expect(media.load).toHaveBeenCalledTimes(1);

    controller.enableFromUserGesture();
    await settle();

    expect(controller.isEnabled).toBe(true);
    expect(media.play).toHaveBeenCalledTimes(1);
    expect(recover).toHaveBeenCalledTimes(1);
    expect(wakeRequest).toHaveBeenCalledTimes(1);
    expect(audioSession.type).toBe("playback");
    expect(mediaSession.playbackState).toBe("playing");
    expect([...timers.delays.values()]).toEqual([AUDIO_KEEPALIVE_WATCHDOG_MS]);
    expect(harness.documentTarget.listenerCount).toBe(2);
    expect(harness.windowTarget.listenerCount).toBe(4);
    expect(media.listenerCount).toBe(2);

    controller.setCaptureActive(true);
    expect(audioSession.type).toBe("play-and-record");
    controller.setCaptureActive(false);
    expect(audioSession.type).toBe("playback");
  });

  it("releases every power-scoped resource and ignores later events when disabled", async () => {
    const sentinel = new FakeWakeSentinel();
    const harness = makeHarness({ requestWakeLock: async () => sentinel });
    harness.controller.enableFromUserGesture();
    await settle();
    harness.media.currentTime = 9;
    harness.media.hostPause();
    expect(harness.timers.timeoutCallbacks.size).toBe(1);

    harness.controller.disable();
    const recoveryCount = harness.recover.mock.calls.length;
    harness.documentTarget.dispatch("visibilitychange");
    harness.documentTarget.dispatch("resume");
    harness.windowTarget.dispatch("pageshow");
    harness.windowTarget.dispatch("focus");
    harness.windowTarget.dispatch("pointerdown");
    harness.windowTarget.dispatch("keydown");
    harness.timers.fire();
    await settle();

    expect(harness.controller.isEnabled).toBe(false);
    expect(harness.documentTarget.listenerCount).toBe(0);
    expect(harness.windowTarget.listenerCount).toBe(0);
    expect(harness.media.listenerCount).toBe(0);
    expect(harness.timers.callbacks.size).toBe(0);
    expect(harness.timers.timeoutCallbacks.size).toBe(0);
    expect(harness.timers.cleared).toEqual([1]);
    expect(harness.timers.clearedTimeouts).toHaveLength(1);
    expect(sentinel.release).toHaveBeenCalledTimes(1);
    expect(harness.media.pause).toHaveBeenCalledTimes(1);
    expect(harness.media.currentTime).toBe(0);
    expect(harness.audioSession.type).toBe("auto");
    expect(harness.mediaSession.playbackState).toBe("none");
    expect(harness.recover).toHaveBeenCalledTimes(recoveryCount);
  });

  it("keeps media alive while hidden, releases the screen lock, and restores on return", async () => {
    const firstSentinel = new FakeWakeSentinel();
    const secondSentinel = new FakeWakeSentinel();
    const sentinels = [firstSentinel, secondSentinel];
    const harness = makeHarness({
      requestWakeLock: async () => sentinels.shift() ?? new FakeWakeSentinel(),
    });
    harness.controller.enableFromUserGesture();
    await settle();
    const initialRecoveries = harness.recover.mock.calls.length;

    harness.documentTarget.hidden = true;
    harness.documentTarget.dispatch("visibilitychange");
    expect(firstSentinel.release).toHaveBeenCalledTimes(1);
    expect(harness.media.pause).not.toHaveBeenCalled();

    harness.media.hostPause();
    harness.timers.fire();
    await settle();
    expect(harness.media.play).toHaveBeenCalledTimes(1);
    expect(harness.recover.mock.calls.length).toBe(initialRecoveries + 1);

    harness.documentTarget.hidden = false;
    harness.documentTarget.dispatch("visibilitychange");
    await settle();
    expect(harness.media.play).toHaveBeenCalledTimes(2);
    expect(harness.wakeRequest).toHaveBeenCalledTimes(2);
    expect(harness.mediaSession.playbackState).toBe("playing");
  });

  it("makes one bounded media retry per interruption epoch instead of stealing focus in a loop", async () => {
    const harness = makeHarness();
    harness.controller.enableFromUserGesture();
    await settle();
    harness.media.hostPause();

    harness.timers.fire();
    await settle();
    expect(harness.media.play).toHaveBeenCalledTimes(1);
    expect(harness.mediaSession.playbackState).toBe("paused");
    expect([...harness.timers.timeoutDelays.values()]).toEqual([AUDIO_KEEPALIVE_MEDIA_RETRY_MS]);

    harness.timers.fireTimeouts();
    await settle();
    expect(harness.media.play).toHaveBeenCalledTimes(2);

    harness.media.hostPause();
    harness.timers.fire();
    harness.timers.fireTimeouts();
    await settle();
    expect(harness.media.play).toHaveBeenCalledTimes(2);

    harness.windowTarget.dispatch("focus");
    await settle();
    expect(harness.media.play).toHaveBeenCalledTimes(3);

    harness.media.hostPause();
    harness.windowTarget.dispatch("pointerdown");
    await settle();
    expect(harness.media.play).toHaveBeenCalledTimes(4);
  });

  it("permits a later independent retry only after playback remains stable", async () => {
    const harness = makeHarness();
    harness.controller.enableFromUserGesture();
    await settle();
    harness.media.hostPause();
    harness.timers.fireTimeouts();
    await settle();
    expect(harness.media.play).toHaveBeenCalledTimes(2);
    expect([...harness.timers.timeoutDelays.values()]).toEqual([AUDIO_KEEPALIVE_STABLE_PLAYBACK_MS]);

    harness.timers.fireTimeouts();
    harness.media.hostPause();
    expect([...harness.timers.timeoutDelays.values()]).toEqual([AUDIO_KEEPALIVE_MEDIA_RETRY_MS]);
    harness.timers.fireTimeouts();
    await settle();
    expect(harness.media.play).toHaveBeenCalledTimes(3);
  });

  it("deduplicates pending recovery and retries after it settles", async () => {
    const pending = deferred<void>();
    const harness = makeHarness({ recover: () => pending.promise });
    harness.controller.enableFromUserGesture();
    harness.controller.notifyAudioInterruption();
    harness.timers.fire();
    harness.windowTarget.dispatch("focus");
    expect(harness.recover).toHaveBeenCalledTimes(1);

    pending.resolve();
    await settle();
    harness.controller.notifyAudioInterruption();
    expect(harness.recover).toHaveBeenCalledTimes(2);
  });

  it("skips promise-producing recovery work for healthy global input and watchdog probes", async () => {
    let ready = true;
    const readiness = vi.fn(() => ready);
    const harness = makeHarness({ ready: readiness });
    harness.controller.enableFromUserGesture();
    await settle();

    harness.windowTarget.dispatch("pointerdown");
    harness.windowTarget.dispatch("keydown");
    harness.windowTarget.dispatch("focus");
    harness.timers.fire();
    await settle();
    expect(readiness.mock.calls.length).toBeGreaterThanOrEqual(5);
    expect(harness.recover).not.toHaveBeenCalled();

    ready = false;
    harness.controller.notifyAudioInterruption();
    expect(harness.recover).toHaveBeenCalledTimes(1);
  });

  it("retries failed AudioContext recovery with bounded exponential backoff", async () => {
    let attempts = 0;
    const harness = makeHarness({
      recover: async () => {
        attempts += 1;
        if (attempts < 3) throw new Error("host still sleeping");
      },
    });
    harness.controller.enableFromUserGesture();
    await settle();
    expect(harness.recover).toHaveBeenCalledTimes(1);
    expect([...harness.timers.timeoutDelays.values()]).toEqual([
      AUDIO_KEEPALIVE_RECOVERY_RETRY_BASE_MS,
    ]);

    harness.timers.fireTimeouts();
    await settle();
    expect(harness.recover).toHaveBeenCalledTimes(2);
    expect([...harness.timers.timeoutDelays.values()]).toEqual([
      AUDIO_KEEPALIVE_RECOVERY_RETRY_BASE_MS * 2,
    ]);

    harness.timers.fireTimeouts();
    await settle();
    expect(harness.recover).toHaveBeenCalledTimes(3);
    expect(harness.timers.timeoutCallbacks.size).toBe(0);
  });

  it("preempts a scheduled recovery backoff when a fresh user gesture is available", async () => {
    let attempts = 0;
    const harness = makeHarness({
      recover: async () => {
        attempts += 1;
        if (attempts === 1) throw new DOMException("gesture required", "NotAllowedError");
      },
    });
    harness.controller.enableFromUserGesture();
    await settle();
    expect(harness.recover).toHaveBeenCalledTimes(1);
    expect(harness.timers.timeoutCallbacks.size).toBe(1);

    harness.windowTarget.dispatch("pointerdown");
    await settle();
    expect(harness.recover).toHaveBeenCalledTimes(2);
    expect(harness.timers.timeoutCallbacks.size).toBe(0);
    expect(harness.timers.clearedTimeouts).toHaveLength(1);
  });

  it("quarantines a late wake-lock request across a power cycle without stacking requests", async () => {
    const firstRequest = deferred<FakeWakeSentinel>();
    const secondSentinel = new FakeWakeSentinel();
    let requests = 0;
    const harness = makeHarness({
      requestWakeLock: () => {
        requests += 1;
        return requests === 1 ? firstRequest.promise : Promise.resolve(secondSentinel);
      },
    });
    harness.controller.enableFromUserGesture();
    harness.controller.disable();
    harness.controller.enableFromUserGesture();
    expect(harness.wakeRequest).toHaveBeenCalledTimes(1);

    const staleSentinel = new FakeWakeSentinel();
    firstRequest.resolve(staleSentinel);
    await settle();
    expect(staleSentinel.release).toHaveBeenCalledTimes(1);
    expect(harness.wakeRequest).toHaveBeenCalledTimes(2);
    await settle();

    harness.controller.disable();
    expect(secondSentinel.release).toHaveBeenCalledTimes(1);
  });

  it("backs off after wake-lock denial until a foreground event permits a retry", async () => {
    const sentinel = new FakeWakeSentinel();
    let attempt = 0;
    const harness = makeHarness({
      requestWakeLock: async () => {
        attempt += 1;
        if (attempt === 1) throw new DOMException("denied", "NotAllowedError");
        return sentinel;
      },
    });
    harness.controller.enableFromUserGesture();
    await settle();
    harness.timers.fire();
    harness.controller.notifyAudioInterruption();
    await settle();
    expect(harness.wakeRequest).toHaveBeenCalledTimes(1);

    harness.windowTarget.dispatch("focus");
    await settle();
    expect(harness.wakeRequest).toHaveBeenCalledTimes(2);
    harness.controller.disable();
    expect(sentinel.release).toHaveBeenCalledTimes(1);
  });

  it("re-pauses a late media-play completion after Power is turned off", async () => {
    const play = deferred<void>();
    const harness = makeHarness({
      play: () => play.promise,
    });
    harness.controller.enableFromUserGesture();
    harness.controller.disable();
    expect(harness.media.pause).toHaveBeenCalledTimes(1);

    harness.media.paused = false;
    play.resolve();
    await settle();
    expect(harness.media.pause).toHaveBeenCalledTimes(2);
    expect(harness.mediaSession.playbackState).toBe("none");
  });

  it("bounds unresolved media-play and wake requests across controller remounts", () => {
    const pendingPlay = deferred<void>();
    const pendingWake = deferred<FakeWakeSentinel>();
    const documentTarget = Object.assign(new FakeEventTarget(), { hidden: false });
    const windowTarget = new FakeEventTarget();
    const timers = new FakeTimers();
    const mediaElements: FakeMedia[] = [];
    const wakeRequest = vi.fn(() => pendingWake.promise);
    const environment: AudioKeepAliveEnvironment = {
      document: documentTarget,
      window: windowTarget,
      navigator: { wakeLock: { request: wakeRequest } },
      timers,
      createMediaElement: () => {
        const media = new FakeMedia();
        media.play.mockImplementation(() => pendingPlay.promise);
        mediaElements.push(media);
        return media;
      },
    };

    for (let iteration = 0; iteration < 20; iteration += 1) {
      const controller = new AudioKeepAliveController({
        sourceUrl: "/assets/audio-keepalive.wav",
        ensureAudioReady: () => undefined,
        environment,
      });
      controller.enableFromUserGesture();
      controller.dispose();
    }

    expect(mediaElements).toHaveLength(20);
    expect(mediaElements.reduce((total, media) => total + media.play.mock.calls.length, 0)).toBe(1);
    expect(wakeRequest).toHaveBeenCalledTimes(1);
    expect(documentTarget.listenerCount).toBe(0);
    expect(windowTarget.listenerCount).toBe(0);
    expect(timers.callbacks.size).toBe(0);
  });

  it("does not acquire or release more wake locks while a prior release is unresolved", async () => {
    const pendingRelease = deferred<void>();
    const sentinel = new FakeWakeSentinel();
    sentinel.release.mockImplementation(() => pendingRelease.promise);
    const documentTarget = Object.assign(new FakeEventTarget(), { hidden: false });
    const windowTarget = new FakeEventTarget();
    const timers = new FakeTimers();
    const wakeRequest = vi.fn(async () => sentinel);
    const environment: AudioKeepAliveEnvironment = {
      document: documentTarget,
      window: windowTarget,
      navigator: { wakeLock: { request: wakeRequest } },
      timers,
      createMediaElement: () => new FakeMedia(),
    };

    const first = new AudioKeepAliveController({
      sourceUrl: "/assets/audio-keepalive.wav",
      ensureAudioReady: () => undefined,
      environment,
    });
    first.enableFromUserGesture();
    await settle();
    first.dispose();
    expect(sentinel.release).toHaveBeenCalledTimes(1);

    for (let iteration = 0; iteration < 20; iteration += 1) {
      const controller = new AudioKeepAliveController({
        sourceUrl: "/assets/audio-keepalive.wav",
        ensureAudioReady: () => undefined,
        environment,
      });
      controller.enableFromUserGesture();
      await settle();
      controller.dispose();
    }

    expect(wakeRequest).toHaveBeenCalledTimes(1);
    expect(sentinel.release).toHaveBeenCalledTimes(1);
    expect(documentTarget.listenerCount).toBe(0);
    expect(windowTarget.listenerCount).toBe(0);
    expect(timers.callbacks.size).toBe(0);
  });

  it("disposes idempotently and cannot resurrect from saved callbacks", async () => {
    const harness = makeHarness();
    harness.controller.enableFromUserGesture();
    await settle();
    const savedCallbacks = [
      ...[...harness.documentTarget.listeners.values()].flatMap((listeners) => [...listeners]),
      ...[...harness.windowTarget.listeners.values()].flatMap((listeners) => [...listeners]),
      ...harness.timers.callbacks.values(),
    ];
    const recoveryCount = harness.recover.mock.calls.length;

    harness.controller.dispose();
    harness.controller.dispose();
    harness.controller.enableFromUserGesture();
    for (const callback of savedCallbacks) callback();
    await settle();

    expect(harness.controller.isEnabled).toBe(false);
    expect(harness.media.src).toBe("");
    expect(harness.media.load).toHaveBeenCalledTimes(2);
    expect(harness.media.remove).toHaveBeenCalledTimes(1);
    expect(harness.documentTarget.listenerCount).toBe(0);
    expect(harness.windowTarget.listenerCount).toBe(0);
    expect(harness.timers.callbacks.size).toBe(0);
    expect(harness.recover).toHaveBeenCalledTimes(recoveryCount);
  });
});
