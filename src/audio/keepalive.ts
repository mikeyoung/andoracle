import { KeyedHostOperationGate } from "../host-operation";

export const AUDIO_KEEPALIVE_WATCHDOG_MS = 8_000;
export const AUDIO_KEEPALIVE_MEDIA_RETRY_MS = 250;
export const AUDIO_KEEPALIVE_STABLE_PLAYBACK_MS = 5_000;
export const AUDIO_KEEPALIVE_RECOVERY_RETRY_BASE_MS = 500;
export const AUDIO_KEEPALIVE_RECOVERY_RETRY_MAX_MS = 8_000;

export interface AudioKeepAliveMediaElement {
  src: string;
  loop: boolean;
  preload: string;
  muted: boolean;
  volume: number;
  currentTime: number;
  readonly paused: boolean;
  play(): Promise<void> | void;
  pause(): void;
  load(): void;
  remove?(): void;
  addEventListener(type: "pause" | "playing", listener: () => void): void;
  removeEventListener(type: "pause" | "playing", listener: () => void): void;
}

export interface AudioKeepAliveEventTarget {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

export interface AudioKeepAliveDocument extends AudioKeepAliveEventTarget {
  readonly hidden: boolean;
}

export interface AudioKeepAliveWakeLockSentinel extends AudioKeepAliveEventTarget {
  readonly released?: boolean;
  release(): Promise<void>;
}

export interface AudioKeepAliveNavigator {
  readonly wakeLock?: {
    request(type: "screen"): Promise<AudioKeepAliveWakeLockSentinel>;
  };
  readonly audioSession?: {
    type: string;
  };
  readonly mediaSession?: {
    playbackState: MediaSessionPlaybackState;
  };
}

export interface AudioKeepAliveTimerApi {
  setInterval(callback: () => void, delayMs: number): number;
  clearInterval(handle: number): void;
  setTimeout(callback: () => void, delayMs: number): number;
  clearTimeout(handle: number): void;
}

export interface AudioKeepAliveEnvironment {
  readonly document: AudioKeepAliveDocument;
  readonly window: AudioKeepAliveEventTarget;
  readonly navigator: AudioKeepAliveNavigator;
  readonly timers: AudioKeepAliveTimerApi;
  createMediaElement(): AudioKeepAliveMediaElement;
}

export interface AudioKeepAliveOptions {
  readonly sourceUrl: string;
  readonly ensureAudioReady: () => void | Promise<void>;
  /** Synchronous fast path used by watchdog and global input listeners. */
  readonly isAudioReady?: () => boolean;
  readonly environment?: AudioKeepAliveEnvironment;
  readonly watchdogMs?: number;
}

const browserEnvironment = (): AudioKeepAliveEnvironment => ({
  document,
  window,
  navigator: navigator as Navigator & AudioKeepAliveNavigator,
  timers: {
    setInterval: (callback, delayMs) => window.setInterval(callback, delayMs),
    clearInterval: (handle) => window.clearInterval(handle),
    setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
    clearTimeout: (handle) => window.clearTimeout(handle),
  },
  createMediaElement: () => {
    const media = new Audio();
    media.setAttribute("aria-hidden", "true");
    media.tabIndex = -1;
    // Match the proven Miviam arrangement: a real document-owned media
    // element, unmuted but containing digital silence, outside AudioContext.
    document.body.append(media);
    return media;
  },
});

interface AudioKeepAliveHostOperations {
  readonly mediaPlay: KeyedHostOperationGate<"play", void>;
  readonly wakeRequest: KeyedHostOperationGate<"request", AudioKeepAliveWakeLockSentinel>;
  readonly wakeRelease: KeyedHostOperationGate<"release", void>;
  mediaRetry: WeakRef<() => void> | null;
  wakeRetry: WeakRef<() => void> | null;
}

const hostOperationsByDocument = new WeakMap<
  AudioKeepAliveDocument,
  AudioKeepAliveHostOperations
>();

const getHostOperations = (
  documentTarget: AudioKeepAliveDocument,
): AudioKeepAliveHostOperations => {
  const existing = hostOperationsByDocument.get(documentTarget);
  if (existing) return existing;
  const created: AudioKeepAliveHostOperations = {
    mediaPlay: new KeyedHostOperationGate(),
    wakeRequest: new KeyedHostOperationGate(),
    wakeRelease: new KeyedHostOperationGate(),
    mediaRetry: null,
    wakeRetry: null,
  };
  hostOperationsByDocument.set(documentTarget, created);
  return created;
};

const releaseWakeSentinel = (
  operations: AudioKeepAliveHostOperations,
  sentinel: AudioKeepAliveWakeLockSentinel,
): void => {
  // Wake Lock has no cancellation primitive. Keep at most one raw release
  // operation alive for the document, even if React remounts the controller.
  const operation = operations.wakeRelease.run("release", () => sentinel.release());
  if (operation.status === "busy") return;
  const notifyRetryOwner = (): void => {
    const retryOwner = operations.wakeRetry?.deref();
    operations.wakeRetry = null;
    retryOwner?.();
  };
  void operation.promise.then(notifyRetryOwner, notifyRetryOwner);
};

/**
 * Keeps the browser's playback session and Web Audio graph recoverable while
 * the physical-style Power switch remains on. Every owned listener, timer,
 * media element, and wake-lock sentinel is released on disable/dispose.
 */
export class AudioKeepAliveController {
  private readonly environment: AudioKeepAliveEnvironment;
  private readonly hostOperations: AudioKeepAliveHostOperations;
  private readonly media: AudioKeepAliveMediaElement;
  private ensureAudioReady: (() => void | Promise<void>) | null;
  private isAudioReady: (() => boolean) | null;
  private readonly watchdogMs: number;
  private enabled = false;
  private disposed = false;
  private generation = 0;
  private listenersAttached = false;
  private watchdog: number | null = null;
  private mediaRetryTimer: number | null = null;
  private mediaStableTimer: number | null = null;
  private mediaPauseRetryUsed = false;
  private recoveryPromise: Promise<void> | null = null;
  private recoveryRetryTimer: number | null = null;
  private nextRecoveryRetryMs = AUDIO_KEEPALIVE_RECOVERY_RETRY_BASE_MS;
  private mediaPlayPromise: Promise<void> | null = null;
  private wakeRequestPromise: Promise<void> | null = null;
  private wakeSentinel: AudioKeepAliveWakeLockSentinel | null = null;
  private wakeRetryBlocked = false;
  private captureActive = false;

  private readonly retryMediaAfterHostOperation = (): void => {
    this.tryPlayMedia();
  };

  private readonly retryWakeAfterHostOperation = (): void => {
    this.requestWakeLock();
  };

  constructor(options: AudioKeepAliveOptions) {
    if (!options.sourceUrl) throw new Error("Audio keepalive requires a source URL.");
    this.environment = options.environment ?? browserEnvironment();
    this.hostOperations = getHostOperations(this.environment.document);
    this.ensureAudioReady = options.ensureAudioReady;
    this.isAudioReady = options.isAudioReady ?? null;
    this.watchdogMs = options.watchdogMs ?? AUDIO_KEEPALIVE_WATCHDOG_MS;
    if (!Number.isFinite(this.watchdogMs) || this.watchdogMs <= 0) {
      throw new Error("Audio keepalive watchdog interval must be positive.");
    }
    this.media = this.environment.createMediaElement();
    this.media.src = options.sourceUrl;
    this.media.loop = true;
    this.media.preload = "auto";
    // Do not use muted=true or volume=0: iOS may classify those as inaudible
    // and decline to maintain a background playback session.
    this.media.muted = false;
    this.media.volume = 1;
    try {
      this.media.load();
    } catch {
      // Loading is best effort; play() will make the definitive attempt.
    }
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  /** Call synchronously from the same user gesture that turns Power on. */
  enableFromUserGesture(): void {
    if (this.disposed) return;
    if (!this.enabled) {
      this.enabled = true;
      this.generation += 1;
      this.wakeRetryBlocked = false;
      this.resetRecoveryRetry();
      this.attachListeners();
      this.watchdog = this.environment.timers.setInterval(
        this.handleWatchdog,
        this.watchdogMs,
      );
      this.setAudioSessionType(this.captureActive ? "play-and-record" : "playback");
    }
    this.restoreFromForeground(true);
  }

  /** Retry only the AudioContext side after an observed involuntary state change. */
  notifyAudioInterruption(): void {
    if (!this.enabled || this.disposed) return;
    this.requestAudioRecovery();
  }

  /** Keep Safari's audio-session category compatible with live input. */
  setCaptureActive(active: boolean): void {
    if (this.disposed || this.captureActive === active) return;
    this.captureActive = active;
    if (this.enabled) {
      this.setAudioSessionType(active ? "play-and-record" : "playback");
    }
  }

  disable(): void {
    if (this.disposed || !this.enabled) return;
    this.enabled = false;
    this.generation += 1;
    this.detachListeners();
    if (this.watchdog !== null) {
      this.environment.timers.clearInterval(this.watchdog);
      this.watchdog = null;
    }
    this.resetMediaPauseRetry();
    this.resetRecoveryRetry();
    this.releaseWakeLock();
    try {
      this.media.pause();
      this.media.currentTime = 0;
    } catch {
      // The browser already released or invalidated this media element.
    }
    this.setMediaSessionPlayback("none");
    this.setAudioSessionType("auto");
    this.captureActive = false;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disable();
    this.disposed = true;
    this.generation += 1;
    this.ensureAudioReady = null;
    this.isAudioReady = null;
    // A never-settling browser promise must not keep this controller alive.
    this.recoveryPromise = null;
    try {
      this.media.src = "";
      this.media.load();
    } catch {
      // Resource release is best effort for partially torn-down documents.
    }
    try {
      this.media.remove?.();
    } catch {
      // A detached media element already has no document lifecycle to retain.
    }
  }

  private readonly handleVisibilityChange = (): void => {
    if (!this.enabled || this.disposed) return;
    if (this.environment.document.hidden) {
      this.releaseWakeLock();
      return;
    }
    this.wakeRetryBlocked = false;
    this.restoreFromForeground(false);
  };

  private readonly handleForeground = (): void => {
    if (!this.enabled || this.disposed || this.environment.document.hidden) return;
    this.wakeRetryBlocked = false;
    this.restoreFromForeground(false);
  };

  private readonly handleUserGesture = (): void => {
    if (!this.enabled || this.disposed) return;
    this.wakeRetryBlocked = false;
    this.resetMediaPauseRetry();
    this.resetRecoveryRetry();
    this.tryPlayMedia();
    this.requestAudioRecovery();
    if (!this.environment.document.hidden) this.requestWakeLock();
  };

  private readonly handleMediaPause = (): void => {
    if (!this.enabled || this.disposed) return;
    this.clearMediaStableTimer();
    this.setMediaSessionPlayback("paused");
    this.scheduleMediaPauseRetry();
  };

  private readonly handleMediaPlaying = (): void => {
    if (!this.enabled || this.disposed) return;
    this.setMediaSessionPlayback("playing");
    this.scheduleStablePlaybackReset();
  };

  private readonly handleWatchdog = (): void => {
    if (!this.enabled || this.disposed) return;
    // Do not replay a host-paused media element indefinitely. At most one
    // delayed retry is allowed until playback remains stable or the user
    // foregrounds/interacts with Andoracle again.
    if (this.media.paused) this.scheduleMediaPauseRetry();
    this.requestAudioRecovery();
  };

  private attachListeners(): void {
    if (this.listenersAttached) return;
    this.listenersAttached = true;
    this.environment.document.addEventListener("visibilitychange", this.handleVisibilityChange);
    this.environment.document.addEventListener("resume", this.handleForeground);
    this.environment.window.addEventListener("pageshow", this.handleForeground);
    this.environment.window.addEventListener("focus", this.handleForeground);
    this.environment.window.addEventListener("pointerdown", this.handleUserGesture);
    this.environment.window.addEventListener("keydown", this.handleUserGesture);
    this.media.addEventListener("pause", this.handleMediaPause);
    this.media.addEventListener("playing", this.handleMediaPlaying);
  }

  private detachListeners(): void {
    if (!this.listenersAttached) return;
    this.listenersAttached = false;
    this.environment.document.removeEventListener("visibilitychange", this.handleVisibilityChange);
    this.environment.document.removeEventListener("resume", this.handleForeground);
    this.environment.window.removeEventListener("pageshow", this.handleForeground);
    this.environment.window.removeEventListener("focus", this.handleForeground);
    this.environment.window.removeEventListener("pointerdown", this.handleUserGesture);
    this.environment.window.removeEventListener("keydown", this.handleUserGesture);
    this.media.removeEventListener("pause", this.handleMediaPause);
    this.media.removeEventListener("playing", this.handleMediaPlaying);
  }

  private restoreFromForeground(userGesture: boolean): void {
    if (userGesture) this.wakeRetryBlocked = false;
    this.resetMediaPauseRetry();
    this.resetRecoveryRetry();
    this.tryPlayMedia();
    this.requestAudioRecovery();
    if (!this.environment.document.hidden) this.requestWakeLock();
  }

  private scheduleMediaPauseRetry(): void {
    if (
      !this.enabled
      || this.disposed
      || !this.media.paused
      || this.mediaPauseRetryUsed
      || this.mediaRetryTimer !== null
    ) return;
    this.mediaPauseRetryUsed = true;
    const generation = this.generation;
    this.mediaRetryTimer = this.environment.timers.setTimeout(() => {
      this.mediaRetryTimer = null;
      if (!this.enabled || this.disposed || this.generation !== generation || !this.media.paused) return;
      this.tryPlayMedia();
    }, AUDIO_KEEPALIVE_MEDIA_RETRY_MS);
  }

  private scheduleStablePlaybackReset(): void {
    this.clearMediaStableTimer();
    if (!this.mediaPauseRetryUsed || this.media.paused) return;
    const generation = this.generation;
    this.mediaStableTimer = this.environment.timers.setTimeout(() => {
      this.mediaStableTimer = null;
      if (!this.enabled || this.disposed || this.generation !== generation || this.media.paused) return;
      this.mediaPauseRetryUsed = false;
    }, AUDIO_KEEPALIVE_STABLE_PLAYBACK_MS);
  }

  private clearMediaStableTimer(): void {
    if (this.mediaStableTimer === null) return;
    this.environment.timers.clearTimeout(this.mediaStableTimer);
    this.mediaStableTimer = null;
  }

  private resetMediaPauseRetry(): void {
    this.mediaPauseRetryUsed = false;
    this.clearMediaStableTimer();
    if (this.mediaRetryTimer === null) return;
    this.environment.timers.clearTimeout(this.mediaRetryTimer);
    this.mediaRetryTimer = null;
  }

  private requestAudioRecovery(): void {
    const recover = this.ensureAudioReady;
    if (
      !this.enabled
      || this.disposed
      || !recover
    ) return;
    try {
      if (this.isAudioReady?.()) {
        // A healthy powered synth receives every page pointer/key event. Do
        // not allocate an already-resolved recovery promise or cross into the
        // engine on those hot paths.
        this.resetRecoveryRetry();
        return;
      }
    } catch {
      // A readiness hint is only an optimization. Fall through to the checked
      // asynchronous recovery path if a host-backed predicate fails.
    }
    if (this.recoveryPromise || this.recoveryRetryTimer !== null) return;
    const generation = this.generation;
    const owner = new WeakRef(this);
    let raw: void | Promise<void>;
    try {
      raw = recover();
    } catch {
      this.scheduleRecoveryRetry();
      return;
    }
    let tracked: Promise<void>;
    tracked = Promise.resolve(raw).then(
      () => {
        const controller = owner.deref();
        if (
          controller?.enabled
          && !controller.disposed
          && controller.generation === generation
        ) controller.resetRecoveryRetry();
      },
      () => {
        const controller = owner.deref();
        if (
          controller?.enabled
          && !controller.disposed
          && controller.generation === generation
        ) controller.scheduleRecoveryRetry();
      },
    ).finally(() => {
      const controller = owner.deref();
      if (controller?.recoveryPromise === tracked) controller.recoveryPromise = null;
      if (!controller || controller.disposed || !controller.enabled) return;
      if (controller.generation !== generation) controller.requestAudioRecovery();
    });
    this.recoveryPromise = tracked;
  }

  private scheduleRecoveryRetry(): void {
    if (!this.enabled || this.disposed || this.recoveryRetryTimer !== null) return;
    const generation = this.generation;
    const delayMs = this.nextRecoveryRetryMs;
    this.nextRecoveryRetryMs = Math.min(
      AUDIO_KEEPALIVE_RECOVERY_RETRY_MAX_MS,
      delayMs * 2,
    );
    this.recoveryRetryTimer = this.environment.timers.setTimeout(() => {
      this.recoveryRetryTimer = null;
      if (!this.enabled || this.disposed || this.generation !== generation) return;
      this.requestAudioRecovery();
    }, delayMs);
  }

  private resetRecoveryRetry(): void {
    this.nextRecoveryRetryMs = AUDIO_KEEPALIVE_RECOVERY_RETRY_BASE_MS;
    if (this.recoveryRetryTimer === null) return;
    this.environment.timers.clearTimeout(this.recoveryRetryTimer);
    this.recoveryRetryTimer = null;
  }

  private tryPlayMedia(): void {
    if (!this.enabled || this.disposed || this.mediaPlayPromise) return;
    if (!this.media.paused) {
      this.setMediaSessionPlayback("playing");
      return;
    }
    const generation = this.generation;
    const owner = new WeakRef(this);
    const hostOperations = this.hostOperations;
    const operation = hostOperations.mediaPlay.run("play", () => this.media.play());
    if (operation.status === "busy") {
      hostOperations.mediaRetry = new WeakRef(this.retryMediaAfterHostOperation);
      return;
    }
    const media = new WeakRef(this.media);
    let tracked: Promise<void>;
    tracked = operation.promise.then(
      () => {
        const controller = owner.deref();
        if (!controller || !controller.enabled || controller.disposed) {
          try {
            media.deref()?.pause();
          } catch {
            // A late play completion after disable must remain stopped.
          }
          return;
        }
        controller.setMediaSessionPlayback("playing");
      },
      () => {
        const controller = owner.deref();
        if (controller?.enabled && !controller.disposed) {
          controller.setMediaSessionPlayback("paused");
        }
      },
    ).finally(() => {
      const controller = owner.deref();
      if (controller?.mediaPlayPromise === tracked) controller.mediaPlayPromise = null;
      if (
        controller
        && controller.enabled
        && !controller.disposed
        && controller.generation !== generation
        && controller.media.paused
      ) {
        controller.tryPlayMedia();
      }
      const retry = hostOperations.mediaRetry?.deref();
      hostOperations.mediaRetry = null;
      retry?.();
    });
    this.mediaPlayPromise = tracked;
  }

  private requestWakeLock(): void {
    const wakeLock = this.environment.navigator.wakeLock;
    const existingSentinel = this.wakeSentinel;
    if (existingSentinel?.released) {
      existingSentinel.removeEventListener("release", this.handleWakeLockRelease);
      this.wakeSentinel = null;
    }
    if (
      !wakeLock
      || !this.enabled
      || this.disposed
      || this.environment.document.hidden
      || this.wakeRetryBlocked
      || this.wakeSentinel !== null
    ) return;
    if (this.wakeRequestPromise || this.hostOperations.wakeRelease.isPending) {
      this.hostOperations.wakeRetry = new WeakRef(this.retryWakeAfterHostOperation);
      return;
    }

    const generation = this.generation;
    const owner = new WeakRef(this);
    const hostOperations = this.hostOperations;
    const operation = hostOperations.wakeRequest.run("request", () => wakeLock.request("screen"));
    if (operation.status === "busy") {
      hostOperations.wakeRetry = new WeakRef(this.retryWakeAfterHostOperation);
      return;
    }
    let tracked: Promise<void>;
    tracked = operation.promise.then(
      (sentinel) => {
        const controller = owner.deref();
        if (
          !controller
          || controller.disposed
          || !controller.enabled
          || controller.generation !== generation
          || controller.environment.document.hidden
        ) {
          releaseWakeSentinel(hostOperations, sentinel);
          return;
        }
        controller.attachWakeLock(sentinel);
      },
      () => {
        const controller = owner.deref();
        if (controller?.enabled && !controller.disposed && controller.generation === generation) {
          controller.wakeRetryBlocked = true;
        }
      },
    ).finally(() => {
      const controller = owner.deref();
      if (controller?.wakeRequestPromise === tracked) controller.wakeRequestPromise = null;
      if (
        controller
        && controller.enabled
        && !controller.disposed
        && controller.generation !== generation
        && !controller.environment.document.hidden
      ) {
        controller.requestWakeLock();
      }
      const retry = hostOperations.wakeRetry?.deref();
      hostOperations.wakeRetry = null;
      retry?.();
    });
    this.wakeRequestPromise = tracked;
  }

  private attachWakeLock(sentinel: AudioKeepAliveWakeLockSentinel): void {
    if (this.wakeSentinel === sentinel) return;
    this.releaseWakeLock();
    this.wakeSentinel = sentinel;
    sentinel.addEventListener("release", this.handleWakeLockRelease);
  }

  private readonly handleWakeLockRelease = (): void => {
    const sentinel = this.wakeSentinel;
    if (!sentinel) return;
    sentinel.removeEventListener("release", this.handleWakeLockRelease);
    this.wakeSentinel = null;
    // Wait for a visibility/focus/user event before asking again. Immediate
    // reacquisition can spin when the OS released the lock for power policy.
    this.wakeRetryBlocked = true;
  };

  private releaseWakeLock(): void {
    const sentinel = this.wakeSentinel;
    if (!sentinel) return;
    this.wakeSentinel = null;
    sentinel.removeEventListener("release", this.handleWakeLockRelease);
    releaseWakeSentinel(this.hostOperations, sentinel);
  }

  private setAudioSessionType(type: "auto" | "playback" | "play-and-record"): void {
    const session = this.environment.navigator.audioSession;
    if (!session) return;
    try {
      if (session.type === type) return;
      session.type = type;
    } catch {
      // Audio Session is experimental and can reject an otherwise valid mode.
    }
  }

  private setMediaSessionPlayback(state: MediaSessionPlaybackState): void {
    const session = this.environment.navigator.mediaSession;
    if (!session) return;
    try {
      if (session.playbackState === state) return;
      session.playbackState = state;
    } catch {
      // Media Session state is advisory and must never block actual audio.
    }
  }
}
