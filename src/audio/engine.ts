import workletUrl from "./odyssey-worklet.ts?worker&url";
import type { OdysseyMeter, PerformanceState } from "./dsp-core";
import { KeyedHostOperationGate } from "../host-operation";
import type { SynthParams } from "../synth/params";

export interface AudioEngineStatus {
  state: AudioContextState | "uninitialized";
  requestedSampleRate: number;
  actualSampleRate: number | null;
  error: string | null;
}

type MeterListener = (meter: OdysseyMeter) => void;
type StatusListener = (status: AudioEngineStatus) => void;
type ExternalInputListener = (connected: boolean) => void;

type ContextTransitionKind = "resume" | "suspend";

interface ContextTransition {
  readonly id: number;
  readonly context: AudioContext;
  readonly kind: ContextTransitionKind;
  readonly promise: Promise<void>;
}

interface PendingExternalPermission {
  readonly id: number;
  abandoned: boolean;
}

export const AUDIO_CONTEXT_TRANSITION_TIMEOUT_MS = 2_000;
export const AUDIO_CONTEXT_CLOSE_TIMEOUT_MS = 2_000;

// Media permission prompts are host-owned and cannot be aborted. Keep a
// module-wide gate so component remounts cannot stack prompts after the old
// engine has already returned an AbortError to its caller.
let rawExternalPermissionSequence = 0;
let pendingRawExternalPermissionId: number | null = null;

// AudioWorklet.addModule() is another browser-owned operation with no abort
// primitive. Keep at most one raw page-lifetime request so repeatedly
// cancelling startup cannot accumulate abandoned module loads and promise
// reactions. A retry is allowed once the raw request actually settles.
const audioWorkletModuleLoadGate = new KeyedHostOperationGate<string, void>();
const audioContextTransitionGate = new KeyedHostOperationGate<ContextTransitionKind, void>();

const cancellationError = (message: string): Error => {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
};

const disconnectNode = (node: AudioNode | null): void => {
  try {
    node?.disconnect();
  } catch {
    // A partially connected graph is already effectively disconnected.
  }
};

const stopStream = (stream: MediaStream | null): void => {
  for (const track of stream?.getTracks() ?? []) {
    try {
      track.stop();
    } catch {
      // A track that ended concurrently needs no further cleanup.
    }
  }
};

const contextIsClosed = (context: AudioContext): boolean => context.state === "closed";

const closeDetachedContext = (context: AudioContext): void => {
  context.onstatechange = null;
  if (contextIsClosed(context)) return;
  try {
    void context.close().catch(() => undefined);
  } catch {
    // The graph is already detached; a host that rejects close owns no app callbacks.
  }
};

const streamHasLiveAudio = (stream: MediaStream): boolean =>
  stream.active !== false && stream.getAudioTracks().some((track) => track.readyState === "live");

export class OdysseyAudioEngine {
  private context: AudioContext | null = null;
  private initializingContext: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private output: GainNode | null = null;
  private removeProcessorErrorListener: (() => void) | null = null;
  private externalStream: MediaStream | null = null;
  private externalSource: MediaStreamAudioSourceNode | null = null;
  private removeExternalListeners: (() => void) | null = null;
  private externalStartPromise: Promise<void> | null = null;
  private cancelExternalStart: (() => void) | null = null;
  private params: SynthParams | null = null;
  private performance: PerformanceState = { bendSemitones: 0, vibratoSemitones: 0 };
  private startPromise: Promise<void> | null = null;
  private disposePromise: Promise<void> | null = null;
  private cancelInitialization: (() => void) | null = null;
  private cancelPowerOperation: (() => void) | null = null;
  private readonly closingContexts = new Map<AudioContext, { id: number; promise: Promise<void> }>();
  private contextTransition: ContextTransition | null = null;
  private pendingExternalPermission: PendingExternalPermission | null = null;
  private powerSequence = 0;
  private lifecycleSequence = 0;
  private externalSequence = 0;
  private contextTransitionSequence = 0;
  private contextCloseSequence = 0;
  private shouldRun = false;
  private disposed = false;
  private externalInputConnected = false;
  private meterRequestOutstanding = false;
  private meterListener: MeterListener | null = null;
  private statusListener: StatusListener | null = null;
  private externalInputListener: ExternalInputListener | null = null;
  private status: AudioEngineStatus = {
    state: "uninitialized",
    requestedSampleRate: 44100,
    actualSampleRate: null,
    error: null,
  };

  onMeter(listener: MeterListener): () => void {
    this.meterListener = listener;
    this.requestMeter();
    return () => {
      if (this.meterListener === listener) this.meterListener = null;
    };
  }

  onStatus(listener: StatusListener): () => void {
    this.statusListener = listener;
    listener({ ...this.status });
    return () => {
      if (this.statusListener === listener) this.statusListener = null;
    };
  }

  /** Reports live-input loss (for example, when an interface is unplugged). */
  onExternalInputState(listener: ExternalInputListener): () => void {
    this.externalInputListener = listener;
    listener(this.externalInputConnected);
    return () => {
      if (this.externalInputListener === listener) this.externalInputListener = null;
    };
  }

  private emitStatus(changes: Partial<AudioEngineStatus> = {}): void {
    this.status = { ...this.status, ...changes };
    this.statusListener?.({ ...this.status });
  }

  private emitExternalInputState(connected: boolean): void {
    if (connected === this.externalInputConnected) return;
    this.externalInputConnected = connected;
    this.externalInputListener?.(connected);
  }

  private requestMeter(): void {
    const context = this.context;
    const node = this.node;
    if (
      this.meterRequestOutstanding
      || !this.meterListener
      || !context
      || context.state !== "running"
      || !node
    ) return;
    try {
      node.port.postMessage({ type: "request-meter" });
      this.meterRequestOutstanding = true;
    } catch {
      this.meterRequestOutstanding = false;
    }
  }

  private clearExternalInput(expectedStream: MediaStream | null = null): void {
    if (expectedStream && this.externalStream !== expectedStream) return;
    const source = this.externalSource;
    const stream = this.externalStream;
    const removeListeners = this.removeExternalListeners;
    this.externalSource = null;
    this.externalStream = null;
    this.removeExternalListeners = null;
    removeListeners?.();
    disconnectNode(source);
    stopStream(stream);
    this.emitExternalInputState(false);
  }

  private clearGraph(context: AudioContext): void {
    if (this.context !== context) return;
    if (this.contextTransition?.context === context) this.contextTransition = null;
    this.disableExternalInput();
    const node = this.node;
    const output = this.output;
    const removeProcessorErrorListener = this.removeProcessorErrorListener;
    this.context = null;
    this.node = null;
    this.output = null;
    this.removeProcessorErrorListener = null;
    this.startPromise = null;
    this.meterRequestOutstanding = false;
    context.onstatechange = null;
    removeProcessorErrorListener?.();
    if (node) {
      node.port.onmessage = null;
      try {
        node.port.close();
      } catch {
        // Closing the context may already have closed its message port.
      }
    }
    disconnectNode(node);
    disconnectNode(output);
  }

  private handleProcessorError(context: AudioContext, node: AudioWorkletNode): void {
    if (this.disposed || this.context !== context || this.node !== node) return;
    const cancelPowerOperation = this.cancelPowerOperation;
    this.cancelPowerOperation = null;
    this.powerSequence += 1;
    cancelPowerOperation?.();
    this.shouldRun = false;
    this.retireContext(context);
    this.emitStatus({
      state: "closed",
      error: "The audio processor stopped unexpectedly. Press Power on to restart it.",
    });
  }

  private handleContextStateChange(context: AudioContext): void {
    if (this.disposed || this.context !== context) return;
    const state = context.state;
    if (state === "closed") {
      this.shouldRun = false;
      this.clearGraph(context);
    }
    this.emitStatus({ state });
    if (state === "running") this.requestMeter();
  }

  private closeContext(context: AudioContext): Promise<void> {
    context.onstatechange = null;
    const existing = this.closingContexts.get(context);
    if (existing) return existing.promise;
    if (contextIsClosed(context)) {
      return Promise.resolve();
    }

    let rawClose: Promise<void>;
    try {
      rawClose = Promise.resolve(context.close());
    } catch {
      return Promise.resolve();
    }

    const id = ++this.contextCloseSequence;
    const owner = new WeakRef(this);
    const contextReference = new WeakRef(context);
    let finished = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const closing = new Promise<void>((resolve) => {
      const finish = (): void => {
        if (finished) return;
        finished = true;
        if (timeout !== null) clearTimeout(timeout);
        timeout = null;
        resolve();
      };
      timeout = setTimeout(finish, AUDIO_CONTEXT_CLOSE_TIMEOUT_MS);
      void rawClose.then(
        () => {
          const engine = owner.deref();
          const closedContext = contextReference.deref();
          if (closedContext && engine?.closingContexts.get(closedContext)?.id === id) {
            engine.closingContexts.delete(closedContext);
          }
          finish();
        },
        () => {
          const engine = owner.deref();
          const closedContext = contextReference.deref();
          if (closedContext && engine?.closingContexts.get(closedContext)?.id === id) {
            engine.closingContexts.delete(closedContext);
          }
          finish();
        },
      );
    });
    this.closingContexts.set(context, { id, promise: closing });
    return closing;
  }

  private retireContext(context: AudioContext): void {
    if (this.contextTransition?.context === context) this.contextTransition = null;
    this.clearGraph(context);
    void this.closeContext(context);
  }

  private transitionContext(context: AudioContext, kind: ContextTransitionKind): Promise<void> {
    const existing = this.contextTransition;
    if (existing) {
      if (existing.context === context && existing.kind === kind) return existing.promise;
      return Promise.reject(cancellationError("An earlier audio-context transition is still pending."));
    }

    const hostTransition = audioContextTransitionGate.run(
      kind,
      () => kind === "resume" ? context.resume() : context.suspend(),
    );
    if (hostTransition.status === "busy") {
      return Promise.reject(
        new Error("A previous audio context transition is still finishing. Try again shortly."),
      );
    }
    const rawTransition = hostTransition.promise;

    const id = ++this.contextTransitionSequence;
    const owner = new WeakRef(this);
    const contextReference = new WeakRef(context);
    let finished = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const transition = new Promise<void>((resolve, reject) => {
      const finish = (error?: unknown): void => {
        if (finished) return;
        finished = true;
        if (timeout !== null) clearTimeout(timeout);
        timeout = null;
        if (error === undefined) resolve();
        else reject(error);
      };
      timeout = setTimeout(() => {
        const error = new Error(`The audio context did not ${kind} in time.`);
        error.name = "TimeoutError";
        finish(error);
      }, AUDIO_CONTEXT_TRANSITION_TIMEOUT_MS);
      void rawTransition.then(
        () => {
          const engine = owner.deref();
          const transitionedContext = contextReference.deref();
          if (!transitionedContext) {
            finish();
            return;
          }
          if (!engine) {
            closeDetachedContext(transitionedContext);
          } else if (engine.disposed || engine.context !== transitionedContext) {
            void engine.closeContext(transitionedContext);
          } else {
            if (engine.contextTransition?.id === id) engine.contextTransition = null;
            const transitionWantsRunning = kind === "resume";
            if (engine.shouldRun !== transitionWantsRunning) engine.retireContext(transitionedContext);
          }
          finish();
        },
        (error) => {
          const engine = owner.deref();
          if (engine?.contextTransition?.id === id) engine.contextTransition = null;
          finish(error);
        },
      );
    });
    this.contextTransition = { id, context, kind, promise: transition };
    return transition;
  }

  private async initialize(sequence: number): Promise<void> {
    if (this.context && this.node && this.output && this.context.state !== "closed") return;
    if (this.closingContexts.size > 0) await Promise.resolve();
    if (this.closingContexts.size > 0) {
      throw new Error("The previous audio context is still shutting down. Try again after it closes.");
    }
    if (audioWorkletModuleLoadGate.isPending) {
      throw new Error("A previous audio processor load is still finishing. Try again shortly.");
    }
    if (audioContextTransitionGate.isPending) {
      throw new Error("A previous audio context transition is still finishing. Try again shortly.");
    }
    const AudioContextConstructor = window.AudioContext
      ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextConstructor) throw new Error("This browser does not provide the Web Audio API.");

    const context = new AudioContextConstructor({
      sampleRate: 44100,
      latencyHint: "interactive",
    });
    this.initializingContext = context;
    let cancelModuleLoad: (() => void) | null = null;
    const moduleLoadCancelled = new Promise<never>((_resolve, reject) => {
      cancelModuleLoad = () => reject(cancellationError("Audio engine initialization was cancelled."));
    });
    const cancelInitialization = (): void => cancelModuleLoad?.();
    this.cancelInitialization = cancelInitialization;
    let node: AudioWorkletNode | null = null;
    let output: GainNode | null = null;
    let removeProcessorErrorListener: (() => void) | null = null;
    let committed = false;

    try {
      if (context.sampleRate !== 44100) {
        throw new Error(
          `A 44,100 Hz audio context is required; this device opened at ${context.sampleRate.toLocaleString()} Hz.`,
        );
      }
      const moduleLoad = audioWorkletModuleLoadGate.run(
        workletUrl,
        () => context.audioWorklet.addModule(workletUrl),
      );
      if (moduleLoad.status === "busy") {
        throw new Error("A previous audio processor load is still finishing. Try again shortly.");
      }
      // Racing here (rather than only racing the public powerOn call) lets this
      // async frame release the engine and graph if the browser's module load
      // promise never settles. The page-wide gate owns the one raw loser.
      await Promise.race([
        moduleLoad.promise,
        moduleLoadCancelled,
      ]);
      if (this.disposed || sequence !== this.lifecycleSequence || contextIsClosed(context)) {
        throw cancellationError("Audio engine initialization was cancelled.");
      }

      node = new AudioWorkletNode(context, "andoracle-synth", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        channelCount: 2,
        channelCountMode: "explicit",
        channelInterpretation: "speakers",
      });
      output = context.createGain();
      output.gain.value = 0;
      node.connect(output);
      output.connect(context.destination);
      const processorError = (): void => this.handleProcessorError(context, node!);
      node.addEventListener("processorerror", processorError);
      removeProcessorErrorListener = () => node?.removeEventListener("processorerror", processorError);
      node.port.onmessage = (event: MessageEvent<{ type: string; meter?: OdysseyMeter }>) => {
        if (this.node !== node) return;
        if (event.data.type !== "meter") return;
        this.meterRequestOutstanding = false;
        if (context.state !== "running") return;
        if (event.data.meter) this.meterListener?.(event.data.meter);
        this.requestMeter();
      };

      if (this.disposed || sequence !== this.lifecycleSequence || contextIsClosed(context)) {
        throw cancellationError("Audio engine initialization was cancelled.");
      }
      this.context = context;
      this.node = node;
      this.output = output;
      this.removeProcessorErrorListener = removeProcessorErrorListener;
      this.initializingContext = null;
      context.onstatechange = () => this.handleContextStateChange(context);
      committed = true;
      this.emitStatus({
        state: context.state,
        actualSampleRate: context.sampleRate,
        error: null,
      });
    } catch (error) {
      removeProcessorErrorListener?.();
      if (node) {
        node.port.onmessage = null;
        try {
          node.port.close();
        } catch {
          // The port can already be closed after a construction/connect failure.
        }
      }
      disconnectNode(node);
      disconnectNode(output);
      await this.closeContext(context);
      if (this.initializingContext === context) this.initializingContext = null;
      if (!this.disposed && sequence === this.lifecycleSequence) {
        this.emitStatus({
          state: "closed",
          actualSampleRate: context.sampleRate,
        });
      }
      throw error;
    } finally {
      if (this.cancelInitialization === cancelInitialization) this.cancelInitialization = null;
      if (!committed && this.initializingContext === context) this.initializingContext = null;
    }
  }

  private initialization(): Promise<void> {
    const existingContext = this.context;
    if (existingContext && contextIsClosed(existingContext)) this.clearGraph(existingContext);
    if (this.context && this.node && this.output && this.context.state !== "closed") {
      return Promise.resolve();
    }
    if (this.startPromise) return this.startPromise;
    const sequence = this.lifecycleSequence;
    let start: Promise<void>;
    start = this.initialize(sequence).finally(() => {
      if (this.startPromise === start) this.startPromise = null;
    });
    this.startPromise = start;
    return start;
  }

  async powerOn(params: SynthParams): Promise<void> {
    if (this.disposed) throw new Error("The audio engine is no longer available.");
    this.shouldRun = true;
    this.params = params;
    const cancelPrevious = this.cancelPowerOperation;
    const sequence = ++this.powerSequence;
    let cancelCurrent: (() => void) | null = null;
    const cancelled = new Promise<never>((_resolve, reject) => {
      cancelCurrent = () => reject(cancellationError("Audio engine startup was superseded."));
    });
    this.cancelPowerOperation = () => cancelCurrent?.();
    cancelPrevious?.();
    try {
      const pendingTransition = this.contextTransition;
      if (pendingTransition?.kind === "suspend") {
        this.retireContext(pendingTransition.context);
      }
      await Promise.race([this.initialization(), cancelled]);
      const context = this.context;
      const output = this.output;
      if (this.disposed) throw cancellationError("Audio engine startup was cancelled.");
      if (sequence !== this.powerSequence) throw cancellationError("Audio engine startup was superseded.");
      if (!context || !output || contextIsClosed(context)) {
        if (context && contextIsClosed(context)) this.clearGraph(context);
        throw new Error("The audio context closed before it could start.");
      }
      await Promise.race([this.transitionContext(context, "resume"), cancelled]);
      if (this.disposed) throw cancellationError("Audio engine startup was cancelled.");
      if (sequence !== this.powerSequence || this.context !== context || this.output !== output) {
        throw cancellationError("Audio engine startup was superseded.");
      }
      if (contextIsClosed(context)) {
        this.clearGraph(context);
        throw new Error("The audio context closed before it could start.");
      }
      if (context.state !== "running") {
        const error = new Error(`The audio context reported ${context.state} after resume.`);
        error.name = "InvalidStateError";
        throw error;
      }
      const now = context.currentTime;
      output.gain.cancelScheduledValues(now);
      output.gain.setValueAtTime(output.gain.value, now);
      output.gain.linearRampToValueAtTime(1, now + 0.035);
      this.node?.port.postMessage({ type: "all-notes-off" });
      this.node?.port.postMessage({ type: "params", params: this.params });
      this.node?.port.postMessage({ type: "performance", performance: this.performance });
      this.emitStatus({ state: context.state, error: null });
      this.requestMeter();
    } catch (error) {
      if (
        !this.disposed
        && sequence === this.powerSequence
        && (!(error instanceof Error) || error.name !== "AbortError")
      ) {
        this.shouldRun = false;
      }
      if (
        !this.disposed
        && sequence === this.powerSequence
        && error instanceof Error
        && ["TimeoutError", "InvalidStateError"].includes(error.name)
      ) {
        this.shouldRun = false;
        const context = this.context;
        if (context) this.retireContext(context);
      }
      if (!this.disposed && (!(error instanceof Error) || error.name !== "AbortError")) {
        const message = error instanceof Error ? error.message : "Audio engine could not start.";
        this.emitStatus({ error: message });
      }
      throw error;
    } finally {
      if (sequence === this.powerSequence) this.cancelPowerOperation = null;
    }
  }

  async powerOff(): Promise<void> {
    this.shouldRun = false;
    const cancelPrevious = this.cancelPowerOperation;
    const sequence = ++this.powerSequence;
    let cancelCurrent: (() => void) | null = null;
    const cancelled = new Promise<never>((_resolve, reject) => {
      cancelCurrent = () => reject(cancellationError("Audio engine shutdown was superseded."));
    });
    this.cancelPowerOperation = () => cancelCurrent?.();
    cancelPrevious?.();
    this.disableExternalInput();
    try {
      const pendingContext = this.initializingContext;
      if (pendingContext && (!this.context || !this.output)) {
        this.lifecycleSequence += 1;
        const cancelInitialization = this.cancelInitialization;
        this.cancelInitialization = null;
        this.initializingContext = null;
        this.startPromise = null;
        cancelInitialization?.();
        await Promise.race([this.closeContext(pendingContext), cancelled]);
      }
      if (this.disposed || sequence !== this.powerSequence) {
        throw cancellationError("Audio engine shutdown was superseded.");
      }
      const context = this.context;
      const output = this.output;
      if (!context || !output) return;
      if (contextIsClosed(context)) {
        this.clearGraph(context);
        this.emitStatus({ state: "closed" });
        return;
      }
      if (this.contextTransition?.context === context) {
        this.retireContext(context);
        this.emitStatus({ state: "closed" });
        return;
      }
      const now = context.currentTime;
      output.gain.cancelScheduledValues(now);
      output.gain.setValueAtTime(output.gain.value, now);
      output.gain.linearRampToValueAtTime(0, now + 0.025);
      let rampTimer: ReturnType<typeof setTimeout> | null = null;
      const rampDelay = new Promise<void>((resolve) => {
        rampTimer = setTimeout(resolve, 40);
      });
      try {
        await Promise.race([rampDelay, cancelled]);
      } finally {
        if (rampTimer !== null) clearTimeout(rampTimer);
      }
      if (this.disposed || sequence !== this.powerSequence || this.context !== context) {
        throw cancellationError("Audio engine shutdown was superseded.");
      }
      if (contextIsClosed(context)) return;
      await Promise.race([this.transitionContext(context, "suspend"), cancelled]);
      if (this.disposed || sequence !== this.powerSequence || this.context !== context) {
        throw cancellationError("Audio engine shutdown was superseded.");
      }
      this.emitStatus({ state: context.state });
    } catch (error) {
      if (!this.disposed && sequence === this.powerSequence) {
        const context = this.context;
        if (context) this.retireContext(context);
        if (!(error instanceof Error) || error.name !== "AbortError") {
          const message = error instanceof Error ? error.message : "The audio context could not suspend.";
          this.emitStatus({ state: "closed", error: message });
        }
      }
      throw error;
    } finally {
      if (sequence === this.powerSequence) this.cancelPowerOperation = null;
    }
  }

  private attachExternalInput(
    sequence: number,
    context: AudioContext,
    node: AudioWorkletNode,
    stream: MediaStream,
  ): void {
    let source: MediaStreamAudioSourceNode | null = null;
    let removeListeners: (() => void) | null = null;
    let committed = false;
    try {
      if (
        this.disposed
        || sequence !== this.externalSequence
        || this.context !== context
        || this.node !== node
      ) {
        throw cancellationError("Live audio input connection was cancelled.");
      }

      source = context.createMediaStreamSource(stream);
      const ended = (): void => {
        if (this.externalStream !== stream) return;
        this.externalSequence += 1;
        const cancel = this.cancelExternalStart;
        this.cancelExternalStart = null;
        this.externalStartPromise = null;
        cancel?.();
        this.clearExternalInput(stream);
      };
      const tracks = stream.getTracks();
      let listeningToStream = false;
      const listeningTracks: MediaStreamTrack[] = [];
      removeListeners = () => {
        if (listeningToStream) {
          try {
            stream.removeEventListener("inactive", ended);
          } catch {
            // A host object that became invalid cannot deliver another event.
          }
          listeningToStream = false;
        }
        for (const track of listeningTracks.splice(0)) {
          try {
            track.removeEventListener("ended", ended);
          } catch {
            // Track teardown continues even if one host listener rejects removal.
          }
        }
      };
      stream.addEventListener("inactive", ended);
      listeningToStream = true;
      for (const track of tracks) {
        track.addEventListener("ended", ended);
        listeningTracks.push(track);
      }
      source.connect(node, 0, 0);

      if (
        this.disposed
        || sequence !== this.externalSequence
        || this.context !== context
        || this.node !== node
        || !streamHasLiveAudio(stream)
      ) {
        throw cancellationError("Live audio input connection was cancelled.");
      }
      this.externalStream = stream;
      this.externalSource = source;
      this.removeExternalListeners = removeListeners;
      committed = true;
      this.emitExternalInputState(true);
      if (
        this.disposed
        || sequence !== this.externalSequence
        || this.context !== context
        || this.node !== node
        || this.externalStream !== stream
        || !streamHasLiveAudio(stream)
      ) {
        throw cancellationError("Live audio input connection was cancelled.");
      }
      // MIDI CC120 latches the shared DSP silent until a new sound source
      // arrives. A freshly attached external stream is such a source.
      node.port.postMessage({ type: "resume-sound" });
    } catch (error) {
      if (committed) {
        this.clearExternalInput(stream);
      } else {
        removeListeners?.();
        disconnectNode(source);
        stopStream(stream);
      }
      throw error;
    }
  }

  async enableExternalInput(): Promise<void> {
    if (this.disposed) throw new Error("The audio engine is no longer available.");
    const context = this.context;
    const node = this.node;
    if (!context || !node || context.state !== "running") {
      throw new Error("Power on the audio engine before connecting live input.");
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("Live audio input is unavailable in this browser.");
    }
    if (this.externalStream && this.externalSource && streamHasLiveAudio(this.externalStream)) return;
    if (this.externalStream || this.externalSource) this.clearExternalInput();
    if (this.externalStartPromise) return this.externalStartPromise;
    if (this.pendingExternalPermission || pendingRawExternalPermissionId !== null) {
      throw new Error("A previous live-input permission request is still pending in the browser.");
    }

    const sequence = ++this.externalSequence;
    const cancellationToken = { cancelled: false };
    let cancelAcquisition: (() => void) | null = null;
    const cancelled = new Promise<never>((_resolve, reject) => {
      cancelAcquisition = () => reject(cancellationError("Live audio input connection was cancelled."));
    });
    let permission: Promise<MediaStream>;
    try {
      permission = Promise.resolve(navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      }));
    } catch (error) {
      throw error;
    }
    const permissionId = ++rawExternalPermissionSequence;
    const pendingPermission: PendingExternalPermission = {
      id: permissionId,
      abandoned: false,
    };
    this.pendingExternalPermission = pendingPermission;
    pendingRawExternalPermissionId = permissionId;
    // A cancelled host permission prompt cannot be aborted. Keep exactly one
    // raw request until it settles, and retain the engine only weakly.
    const owner = new WeakRef(this);
    void permission.then(
      (stream) => {
        const engine = owner.deref();
        if (pendingPermission.abandoned || !engine || engine.disposed) stopStream(stream);
        if (pendingRawExternalPermissionId === permissionId) pendingRawExternalPermissionId = null;
        if (engine?.pendingExternalPermission?.id === permissionId) {
          engine.pendingExternalPermission = null;
        }
      },
      () => {
        const engine = owner.deref();
        if (pendingRawExternalPermissionId === permissionId) pendingRawExternalPermissionId = null;
        if (engine?.pendingExternalPermission?.id === permissionId) {
          engine.pendingExternalPermission = null;
        }
      },
    );
    let acquisition: Promise<void>;
    acquisition = Promise.race([
      permission,
      cancelled,
    ]).then((stream) => {
      if (cancellationToken.cancelled) {
        stopStream(stream);
        throw cancellationError("Live audio input connection was cancelled.");
      }
      this.attachExternalInput(sequence, context, node, stream);
    }).finally(() => {
      if (this.externalStartPromise !== acquisition) return;
      this.externalStartPromise = null;
      this.cancelExternalStart = null;
    });
    this.externalStartPromise = acquisition;
    this.cancelExternalStart = () => {
      cancellationToken.cancelled = true;
      pendingPermission.abandoned = true;
      cancelAcquisition?.();
    };
    return acquisition;
  }

  disableExternalInput(): void {
    this.externalSequence += 1;
    const cancel = this.cancelExternalStart;
    this.cancelExternalStart = null;
    this.externalStartPromise = null;
    cancel?.();
    this.clearExternalInput();
  }

  setParams(params: Partial<SynthParams>): void {
    if (this.params) this.params = { ...this.params, ...params };
    if (this.context?.state === "running") this.node?.port.postMessage({ type: "params", params });
  }

  noteOn(note: number): void {
    if (this.context?.state === "running") this.node?.port.postMessage({ type: "note-on", note });
  }

  noteOff(note: number): void {
    if (this.context?.state === "running") this.node?.port.postMessage({ type: "note-off", note });
  }

  keyboardTrigger(): void {
    if (this.context?.state === "running") this.node?.port.postMessage({ type: "keyboard-trigger" });
  }

  allNotesOff(): void {
    if (this.context?.state === "running") this.node?.port.postMessage({ type: "all-notes-off" });
  }

  allSoundOff(): void {
    if (this.context?.state === "running") this.node?.port.postMessage({ type: "all-sound-off" });
  }

  setPerformance(performance: Partial<PerformanceState>): void {
    this.performance = { ...this.performance, ...performance };
    if (this.context?.state === "running") {
      this.node?.port.postMessage({ type: "performance", performance });
    }
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    this.shouldRun = false;
    this.lifecycleSequence += 1;
    const cancelInitialization = this.cancelInitialization;
    this.cancelInitialization = null;
    cancelInitialization?.();
    const cancelPowerOperation = this.cancelPowerOperation;
    this.cancelPowerOperation = null;
    this.powerSequence += 1;
    cancelPowerOperation?.();
    this.disableExternalInput();
    if (this.pendingExternalPermission) this.pendingExternalPermission.abandoned = true;

    const context = this.context;
    const initializingContext = this.initializingContext;
    const node = this.node;
    const output = this.output;
    const removeProcessorErrorListener = this.removeProcessorErrorListener;
    this.context = null;
    this.initializingContext = null;
    this.node = null;
    this.output = null;
    this.removeProcessorErrorListener = null;
    this.contextTransition = null;
    this.startPromise = null;
    this.params = null;
    this.performance = { bendSemitones: 0, vibratoSemitones: 0 };
    this.meterRequestOutstanding = false;
    if (context) context.onstatechange = null;
    if (initializingContext) initializingContext.onstatechange = null;
    removeProcessorErrorListener?.();
    if (node) {
      node.port.onmessage = null;
      try {
        node.port.close();
      } catch {
        // Closing the context may already have closed its message port.
      }
    }
    disconnectNode(node);
    disconnectNode(output);
    this.meterListener = null;
    this.statusListener = null;
    this.externalInputListener = null;
    this.status = { ...this.status, state: "closed" };

    const contexts = [...new Set([context, initializingContext, ...this.closingContexts.keys()].filter(
      (candidate): candidate is AudioContext => candidate !== null,
    ))];
    // Keep unresolved raw-close ownership records on the disposed instance.
    // They are bounded by the number of contexts this engine created and keep
    // a late resume/suspend completion from issuing a duplicate close(). The
    // whole map remains collectible with the disposed engine.
    this.disposePromise = Promise.allSettled(contexts.map((candidate) => this.closeContext(candidate)))
      .then(() => undefined);
    return this.disposePromise;
  }
}
