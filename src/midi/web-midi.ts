import type { PerformanceState } from "../audio/dsp-core";

export type DecodedMidiMessage =
  | { type: "note-on"; channel: number; note: number; velocity: number }
  | { type: "note-off"; channel: number; note: number }
  | { type: "pitch-bend"; channel: number; normalized: number }
  | { type: "modulation"; channel: number; normalized: number }
  | { type: "all-sound-off"; channel: number }
  | { type: "all-notes-off"; channel: number }
  | { type: "reset-controllers"; channel: number }
  | null;

export interface MidiInputSummary {
  id: string;
  name: string;
  manufacturer: string;
}

export interface MidiPerformanceSources {
  ppcBendSemitones: number;
  ppcVibratoSemitones: number;
  midiBendNormalized: number;
  midiModNormalized: number;
}

export interface WebMidiHandlers {
  noteOn(source: string, note: number): void;
  noteOff(source: string): void;
  pitchBend(normalized: number): void;
  modulation(normalized: number): void;
  allSoundOff(inputId: string, channel: number): void;
  inputsChanged(inputs: readonly MidiInputSummary[]): void;
  error(message: string): void;
}

interface HeldMidiNote {
  inputId: string;
  channel: number;
  note: number;
}

interface ControllerLaneValue {
  inputId: string;
  channel: number;
  value: number;
  order: number;
}

interface OpeningMidiInput {
  input: MIDIInput;
  generation: number;
  rawOperation: RawMidiInputOperation;
  invalidated: boolean;
  timedOut: boolean;
  cancel: (() => void) | null;
  timeout: ReturnType<typeof setTimeout> | null;
}

interface PendingMidiAccessRequest {
  readonly id: number;
  abandoned: boolean;
}

interface RawMidiInputOperation {
  readonly id: number;
  invalidated?: boolean;
  readonly publicPromise?: Promise<void>;
}

interface RawMidiInputLease {
  readonly operationId: number;
  readonly operation: WeakRef<RawMidiInputOperation>;
}

interface LiveMidiInputOwner {
  readonly input: WeakRef<MIDIInput>;
  readonly session: WeakRef<WebMidiSession>;
}

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, value));

const validDataByte = (value: number | undefined): value is number =>
  value !== undefined && Number.isInteger(value) && value >= 0 && value <= 0x7f;

const MAX_REPEATED_NOTE_INSTANCES = 16;
const MAX_HELD_MIDI_NOTES = 256;
// Local MIDI ports normally open immediately. A generous upper bound keeps a
// broken driver from blocking all future device synchronization forever.
export const MIDI_INPUT_OPEN_TIMEOUT_MS = 8_000;
export const MIDI_INPUT_CLOSE_TIMEOUT_MS = 2_000;

// A browser/driver operation cannot be aborted once issued. These weak-keyed
// gates prevent retries (including retries from a replacement session) from
// stacking more native promises onto the same port while one is unresolved.
const rawOpeningInputs = new WeakMap<MIDIInput, RawMidiInputOperation>();
const rawClosingInputs = new WeakMap<MIDIInput, RawMidiInputOperation>();
// requestMIDIAccess() vends a new MIDIAccess (and therefore new MIDIPort
// wrappers) on each call. A port ID, rather than wrapper identity, is the Web
// MIDI equality key. Keep weak logical-port leases as well as weak wrapper
// gates so overlapping sessions cannot double-open or double-handle one
// physical input through distinct wrapper objects.
const rawOpeningInputIds = new Map<string, RawMidiInputLease>();
const rawClosingInputIds = new Map<string, RawMidiInputLease>();
const liveInputOwners = new Map<string, LiveMidiInputOwner>();
let rawInputOperationSequence = 0;
let rawMidiAccessRequestSequence = 0;
let pendingRawMidiAccessRequestId: number | null = null;

const rawInputOperation = (
  wrappers: WeakMap<MIDIInput, RawMidiInputOperation>,
  ids: Map<string, RawMidiInputLease>,
  input: MIDIInput,
): RawMidiInputOperation | undefined => {
  const wrapperOperation = wrappers.get(input);
  if (wrapperOperation) return wrapperOperation;
  const lease = ids.get(input.id);
  if (!lease) return undefined;
  const operation = lease.operation.deref();
  if (!operation) ids.delete(input.id);
  return operation;
};

const registerRawInputOperation = (
  wrappers: WeakMap<MIDIInput, RawMidiInputOperation>,
  ids: Map<string, RawMidiInputLease>,
  input: MIDIInput,
  operation: RawMidiInputOperation,
): void => {
  for (const [inputId, lease] of ids) {
    if (!lease.operation.deref()) ids.delete(inputId);
  }
  wrappers.set(input, operation);
  // The host promise reactions retain an active operation; the ID index does
  // not. Once a host drops an unreachable never-settling promise, later port
  // activity can prune the weak lease instead of leaking every transient ID.
  ids.set(input.id, {
    operationId: operation.id,
    operation: new WeakRef(operation),
  });
};

const releaseRawInputOperation = (
  wrappers: WeakMap<MIDIInput, RawMidiInputOperation>,
  ids: Map<string, RawMidiInputLease>,
  input: MIDIInput | undefined,
  inputId: string,
  operationId: number,
): void => {
  if (input && wrappers.get(input)?.id === operationId) wrappers.delete(input);
  if (ids.get(inputId)?.operationId === operationId) ids.delete(inputId);
};

const liveInputOwner = (inputId: string): { input: MIDIInput; session: WebMidiSession } | null => {
  const lease = liveInputOwners.get(inputId);
  if (!lease) return null;
  const input = lease.input.deref();
  const session = lease.session.deref();
  if (!input || !session) {
    liveInputOwners.delete(inputId);
    return null;
  }
  return { input, session };
};

const registerLiveInputOwner = (input: MIDIInput, session: WebMidiSession): void => {
  for (const [inputId, lease] of liveInputOwners) {
    if (!lease.input.deref() || !lease.session.deref()) liveInputOwners.delete(inputId);
  }
  liveInputOwners.set(input.id, {
    input: new WeakRef(input),
    session: new WeakRef(session),
  });
};

const releaseLiveInputOwner = (input: MIDIInput, session: WebMidiSession): void => {
  const owner = liveInputOwner(input.id);
  if (owner?.input === input && owner.session === session) liveInputOwners.delete(input.id);
};

const midiCancellationError = (message: string): Error => {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
};

const closeMidiInput = (input: MIDIInput): Promise<void> => {
  input.onmidimessage = null;
  const existing = rawInputOperation(rawClosingInputs, rawClosingInputIds, input);
  if (existing?.publicPromise) return existing.publicPromise;
  const inputId = input.id;
  const id = ++rawInputOperationSequence;
  let settled = false;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  let resolvePublic: (() => void) | null = null;
  const publicPromise = new Promise<void>((resolve) => {
    resolvePublic = resolve;
  });
  const rawOperation: RawMidiInputOperation = { id, publicPromise };
  const finish = (): void => {
    if (settled) return;
    settled = true;
    if (timeout !== null) clearTimeout(timeout);
    timeout = null;
    resolvePublic?.();
    resolvePublic = null;
  };
  // Reserve the logical port before invoking the host. A conforming close()
  // queues statechange, but this ordering also makes synchronous host shims
  // and re-entrant teardown deterministic.
  registerRawInputOperation(rawClosingInputs, rawClosingInputIds, input, rawOperation);
  let rawClose: Promise<MIDIPort>;
  try {
    rawClose = Promise.resolve(input.close());
  } catch {
    releaseRawInputOperation(
      rawClosingInputs,
      rawClosingInputIds,
      input,
      inputId,
      id,
    );
    finish();
    return publicPromise;
  }
  const inputReference = new WeakRef(input);
  timeout = setTimeout(finish, MIDI_INPUT_CLOSE_TIMEOUT_MS);
  void rawClose.then(
    () => {
      releaseRawInputOperation(
        rawClosingInputs,
        rawClosingInputIds,
        inputReference.deref(),
        inputId,
        rawOperation.id,
      );
      finish();
    },
    () => {
      releaseRawInputOperation(
        rawClosingInputs,
        rawClosingInputIds,
        inputReference.deref(),
        inputId,
        rawOperation.id,
      );
      finish();
    },
  );
  return publicPromise;
};

export function decodeMidiMessage(data: ArrayLike<number> | null | undefined): DecodedMidiMessage {
  // Web MIDI delivers one complete message per event and never uses running
  // status. Every channel message handled below is exactly three bytes; do
  // not execute a valid-looking prefix from a malformed or bundled payload.
  if (!data || data.length !== 3) return null;
  const status = data[0];
  if (!Number.isInteger(status) || status < 0x80 || status >= 0xf0) return null;
  const command = status & 0xf0;
  const channel = status & 0x0f;

  if (command === 0x80 || command === 0x90) {
    const note = data[1];
    const velocity = data[2];
    if (!validDataByte(note) || !validDataByte(velocity)) return null;
    if (command === 0x80 || velocity === 0) return { type: "note-off", channel, note };
    return { type: "note-on", channel, note, velocity: velocity / 127 };
  }

  if (command === 0xe0) {
    const leastSignificant = data[1];
    const mostSignificant = data[2];
    if (!validDataByte(leastSignificant) || !validDataByte(mostSignificant)) return null;
    const raw = leastSignificant | (mostSignificant << 7);
    const normalized = raw < 8192 ? (raw - 8192) / 8192 : (raw - 8192) / 8191;
    return { type: "pitch-bend", channel, normalized };
  }

  if (command === 0xb0) {
    const controller = data[1];
    const value = data[2];
    if (!validDataByte(controller) || !validDataByte(value)) return null;
    if (controller === 1) return { type: "modulation", channel, normalized: value / 127 };
    if (controller === 120 && value === 0) return { type: "all-sound-off", channel };
    if (controller === 121 && value === 0) return { type: "reset-controllers", channel };
    if (
      controller === 126
      || (value === 0 && controller >= 123 && controller <= 127)
    ) return { type: "all-notes-off", channel };
  }

  return null;
}

export function combinePerformanceSources(
  sources: MidiPerformanceSources,
  bendRange: number,
  vibratoRange: number,
): PerformanceState {
  return {
    bendSemitones: clamp(
      sources.ppcBendSemitones + sources.midiBendNormalized * bendRange,
      -24,
      24,
    ),
    vibratoSemitones: clamp(
      Math.max(sources.ppcVibratoSemitones, sources.midiModNormalized * vibratoRange),
      0,
      12,
    ),
  };
}

export function getWebMidiAvailability(): { supported: boolean; reason: string | null } {
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    return { supported: false, reason: "Web MIDI is unavailable in this environment." };
  }
  if (!window.isSecureContext) {
    return { supported: false, reason: "MIDI requires HTTPS or a localhost address." };
  }
  if (typeof navigator.requestMIDIAccess !== "function") {
    return { supported: false, reason: "Web MIDI is not available in this browser." };
  }
  return { supported: true, reason: null };
}

const inputSummary = (input: MIDIInput): MidiInputSummary => ({
  id: input.id,
  name: input.name?.trim() || "MIDI input",
  manufacturer: input.manufacturer?.trim() || "",
});

const NOOP_WEB_MIDI_HANDLERS: WebMidiHandlers = {
  noteOn: () => undefined,
  noteOff: () => undefined,
  pitchBend: () => undefined,
  modulation: () => undefined,
  allSoundOff: () => undefined,
  inputsChanged: () => undefined,
  error: () => undefined,
};

export class WebMidiSession {
  private access: MIDIAccess | null = null;
  private handlers: WebMidiHandlers;
  private readonly inputs = new Map<string, MIDIInput>();
  private readonly openingInputs = new Map<string, OpeningMidiInput>();
  private readonly heldNotes = new Map<string, HeldMidiNote>();
  private readonly noteStacks = new Map<string, string[]>();
  private readonly bends = new Map<string, ControllerLaneValue>();
  private readonly modulations = new Map<string, ControllerLaneValue>();
  private readonly closingInputPromises = new Set<Promise<void>>();
  private serial = 0;
  private controllerOrder = 0;
  private generation = 0;
  private disposed = false;
  private syncRequested = false;
  private syncPromise: Promise<readonly MidiInputSummary[]> | null = null;
  private connectPromise: Promise<readonly MidiInputSummary[]> | null = null;
  private cancelConnect: (() => void) | null = null;
  private pendingAccessRequest: PendingMidiAccessRequest | null = null;
  private refreshPromise: Promise<readonly MidiInputSummary[]> | null = null;
  private cancelRefresh: (() => void) | null = null;
  private publishedSyncSignature: string | null = null;
  private teardownPromise: Promise<void> | null = null;
  private disposePromise: Promise<void> | null = null;

  constructor(handlers: WebMidiHandlers) {
    this.handlers = handlers;
  }

  setHandlers(handlers: WebMidiHandlers): void {
    if (this.disposed) return;
    this.handlers = handlers;
  }

  private publishSyncResult(
    inputs: readonly MidiInputSummary[],
    openingErrors: readonly string[],
  ): void {
    // Include failures in the observed state. If a broken port disappears
    // while the usable input list stays the same, consumers still receive one
    // healthy result with which to clear the stale error. Identical healthy
    // refreshes and the statechange queued by open() remain deduplicated.
    const signature = JSON.stringify([inputs, [...openingErrors].sort()]);
    if (signature === this.publishedSyncSignature) return;
    this.publishedSyncSignature = signature;
    this.handlers.inputsChanged(inputs);
  }

  private baseNoteKey(inputId: string, channel: number, note: number): string {
    return `${inputId}\u0000${channel}\u0000${note}`;
  }

  private controllerLane(inputId: string, channel: number): string {
    return `${inputId}\u0000${channel}`;
  }

  private emitLatestController(
    values: ReadonlyMap<string, ControllerLaneValue>,
    emit: (value: number) => void,
  ): void {
    let latest: ControllerLaneValue | undefined;
    for (const value of values.values()) {
      if (!latest || value.order > latest.order) latest = value;
    }
    emit(latest?.value ?? 0);
  }

  private setController(
    values: Map<string, ControllerLaneValue>,
    inputId: string,
    channel: number,
    value: number,
    emit: (normalized: number) => void,
  ): void {
    const lane = this.controllerLane(inputId, channel);
    const order = ++this.controllerOrder;
    const current = values.get(lane);
    if (current) {
      // Wheel reports can arrive hundreds of times per second. Each lane owns
      // its record, so reuse it while still advancing recency for unplug
      // fallback semantics.
      current.value = value;
      current.order = order;
    } else {
      values.set(lane, { inputId, channel, value, order });
    }
    emit(value);
  }

  private removeInputControllers(inputId: string): void {
    let bendRemoved = false;
    let modulationRemoved = false;
    for (const [lane, value] of this.bends) {
      if (value.inputId !== inputId) continue;
      this.bends.delete(lane);
      bendRemoved = true;
    }
    for (const [lane, value] of this.modulations) {
      if (value.inputId !== inputId) continue;
      this.modulations.delete(lane);
      modulationRemoved = true;
    }
    if (bendRemoved) this.emitLatestController(this.bends, this.handlers.pitchBend);
    if (modulationRemoved) this.emitLatestController(this.modulations, this.handlers.modulation);
  }

  private releaseSource(source: string): void {
    const held = this.heldNotes.get(source);
    if (!held) return;
    this.heldNotes.delete(source);
    const key = this.baseNoteKey(held.inputId, held.channel, held.note);
    const stack = this.noteStacks.get(key);
    if (stack) {
      const index = stack.indexOf(source);
      if (index >= 0) stack.splice(index, 1);
      if (stack.length === 0) this.noteStacks.delete(key);
    }
    this.handlers.noteOff(source);
  }

  private releaseMatching(predicate: (held: HeldMidiNote) => boolean): void {
    const sources: string[] = [];
    for (const [source, held] of this.heldNotes) {
      if (predicate(held)) sources.push(source);
    }
    for (const source of sources) this.releaseSource(source);
  }

  private makeRoomForNote(key: string): void {
    let stack = this.noteStacks.get(key);
    while (stack && stack.length >= MAX_REPEATED_NOTE_INSTANCES) {
      this.releaseSource(stack[0]);
      stack = this.noteStacks.get(key);
    }
    while (this.heldNotes.size >= MAX_HELD_MIDI_NOTES) {
      const oldest = this.heldNotes.keys().next().value as string | undefined;
      if (!oldest) break;
      this.releaseSource(oldest);
    }
  }

  private handleMessage(input: MIDIInput, event: MIDIMessageEvent): void {
    const message = decodeMidiMessage(event.data);
    if (!message) return;
    switch (message.type) {
      case "note-on": {
        const key = this.baseNoteKey(input.id, message.channel, message.note);
        this.makeRoomForNote(key);
        const source = `midi:${encodeURIComponent(input.id)}:${message.channel}:${message.note}:${this.serial}`;
        this.serial += 1;
        const stack = this.noteStacks.get(key) ?? [];
        stack.push(source);
        this.noteStacks.set(key, stack);
        this.heldNotes.set(source, { inputId: input.id, channel: message.channel, note: message.note });
        this.handlers.noteOn(source, message.note);
        break;
      }
      case "note-off": {
        const key = this.baseNoteKey(input.id, message.channel, message.note);
        const stack = this.noteStacks.get(key);
        if (!stack || stack.length === 0) return;
        const source = stack[0];
        if (!source) return;
        this.releaseSource(source);
        break;
      }
      case "pitch-bend":
        this.setController(
          this.bends,
          input.id,
          message.channel,
          message.normalized,
          this.handlers.pitchBend,
        );
        break;
      case "modulation":
        this.setController(
          this.modulations,
          input.id,
          message.channel,
          message.normalized,
          this.handlers.modulation,
        );
        break;
      case "all-sound-off":
        this.releaseMatching((held) => held.inputId === input.id && held.channel === message.channel);
        this.handlers.allSoundOff(input.id, message.channel);
        break;
      case "all-notes-off":
        this.releaseMatching((held) => held.inputId === input.id && held.channel === message.channel);
        break;
      case "reset-controllers":
        this.setController(this.bends, input.id, message.channel, 0, this.handlers.pitchBend);
        this.setController(this.modulations, input.id, message.channel, 0, this.handlers.modulation);
        break;
    }
  }

  /**
   * Revoke every app-owned aspect of an input synchronously. Native close()
   * can take seconds (or never settle), but a disconnected controller must not
   * keep notes, wheels, or a live message callback during that host wait.
   */
  private revokeInput(inputId: string): MIDIInput | null {
    const input = this.inputs.get(inputId);
    if (!input) return null;
    input.onmidimessage = null;
    this.inputs.delete(inputId);
    releaseLiveInputOwner(input, this);
    this.releaseMatching((held) => held.inputId === inputId);
    this.removeInputControllers(inputId);
    return input;
  }

  private closeRevokedInput(input: MIDIInput): Promise<void> {
    const closing = closeMidiInput(input);
    if (this.closingInputPromises.has(closing)) return closing;
    this.closingInputPromises.add(closing);
    void closing.then(
      () => this.closingInputPromises.delete(closing),
      () => this.closingInputPromises.delete(closing),
    );
    return closing;
  }

  private async detachInput(inputId: string): Promise<void> {
    const input = this.revokeInput(inputId);
    if (!input) return;
    await this.closeRevokedInput(input);
  }

  private handleStateChange = (): void => {
    const access = this.access;
    // Do not serialize emergency ownership release behind an unrelated
    // driver's pending open(). syncInputsOnce() can remain blocked for its
    // bounded open timeout, while note-off and controller reset must happen as
    // soon as the browser reports this input gone or no longer open.
    for (const [inputId, input] of [...this.inputs]) {
      const current = access?.inputs.get(inputId);
      if (
        current === input
        && input.state === "connected"
        && input.connection === "open"
      ) continue;
      const revoked = this.revokeInput(inputId);
      if (revoked) void this.closeRevokedInput(revoked);
    }
    for (const [inputId, opening] of this.openingInputs) {
      const current = access?.inputs.get(inputId);
      if (current !== opening.input || opening.input.state !== "connected") {
        opening.invalidated = true;
        opening.rawOperation.invalidated = true;
        opening.cancel?.();
      }
    }
    // A port can leave open() pending while the browser emits many topology
    // events. Keep the refresh request coalesced without attaching an
    // unbounded chain of catch reactions to the same pending promise.
    if (this.syncPromise) {
      this.syncRequested = true;
      return;
    }
    void this.syncInputs().catch((error: unknown) => {
      if (this.disposed) return;
      const detail = error instanceof Error ? error.message : "MIDI inputs could not be refreshed.";
      this.handlers.error(detail);
    });
  };

  private async closeIfUnowned(input: MIDIInput, rawOperation: RawMidiInputOperation): Promise<void> {
    if (this.inputs.get(input.id) === input) return;
    // Do not clear or close the exact wrapper another session owns. A distinct
    // wrapper with the same logical ID still owns its own explicit open and
    // must be closed to release that reference without touching the live
    // wrapper's message handler.
    if (liveInputOwner(input.id)?.input === input) return;
    const currentOpening = this.openingInputs.get(input.id);
    if (
      currentOpening
      && currentOpening.rawOperation !== rawOperation
      && currentOpening.input === input
    ) return;
    await closeMidiInput(input);
  }

  private async syncInputsOnce(): Promise<readonly MidiInputSummary[]> {
    const access = this.access;
    if (!access || this.disposed) return [];
    const syncGeneration = this.generation;
    const previouslyStartedCloses = [...this.closingInputPromises];
    if (previouslyStartedCloses.length > 0) {
      await Promise.allSettled(previouslyStartedCloses);
    }
    if (this.disposed || this.generation !== syncGeneration || this.access !== access) return [];
    const available = [...access.inputs.values()].filter((input) => input.state === "connected");
    const availableById = new Map(available.map((input) => [input.id, input]));

    const closing: Promise<void>[] = [];
    for (const inputId of [...this.inputs.keys()]) {
      const input = this.inputs.get(inputId);
      const current = availableById.get(inputId);
      if (input && current === input && input.connection === "open") continue;
      closing.push(this.detachInput(inputId));
    }
    await Promise.allSettled(closing);
    if (this.disposed || this.generation !== syncGeneration || this.access !== access) return [];

    const opening: Promise<void>[] = [];
    const openingErrors: string[] = [];
    for (const input of available) {
      const owner = liveInputOwner(input.id);
      if (
        this.inputs.has(input.id)
        || this.openingInputs.has(input.id)
        || (owner !== null && owner.session !== this)
        || rawInputOperation(rawOpeningInputs, rawOpeningInputIds, input)
        || rawInputOperation(rawClosingInputs, rawClosingInputIds, input)
      ) continue;
      let rejectCancellation: ((error: Error) => void) | null = null;
      const rawOperation: RawMidiInputOperation = {
        id: ++rawInputOperationSequence,
        invalidated: false,
      };
      const attempt: OpeningMidiInput = {
        input,
        generation: syncGeneration,
        rawOperation,
        invalidated: false,
        timedOut: false,
        cancel: null,
        timeout: null,
      };
      const cancelled = new Promise<never>((_resolve, reject) => {
        rejectCancellation = reject;
      });
      attempt.cancel = () => {
        attempt.invalidated = true;
        rawOperation.invalidated = true;
        const reject = rejectCancellation;
        rejectCancellation = null;
        reject?.(midiCancellationError("MIDI port opening was cancelled."));
      };
      const timedOut = new Promise<never>((_resolve, reject) => {
        attempt.timeout = setTimeout(() => {
          attempt.timedOut = true;
          attempt.invalidated = true;
          rawOperation.invalidated = true;
          rejectCancellation = null;
          reject(new Error(
            `${input.name?.trim() || "MIDI input"} did not open within ${MIDI_INPUT_OPEN_TIMEOUT_MS / 1000} seconds.`,
          ));
        }, MIDI_INPUT_OPEN_TIMEOUT_MS);
      });
      this.openingInputs.set(input.id, attempt);
      registerRawInputOperation(rawOpeningInputs, rawOpeningInputIds, input, rawOperation);
      let rawOpen: Promise<MIDIPort>;
      try {
        rawOpen = Promise.resolve(input.open());
      } catch (error) {
        rawOpen = Promise.reject(error);
      }
      // Promise reactions cannot be detached from a host promise. Keep only a
      // weak session reference so an open() that never settles cannot retain
      // the whole synth, but still close an unowned port that settles late.
      const session = new WeakRef(this);
      const inputReference = new WeakRef(input);
      const inputId = input.id;
      let rawSettled = false;
      void rawOpen.then(
        () => {
          rawSettled = true;
          const port = inputReference.deref();
          if (!rawOperation.invalidated || !port) return;
          releaseRawInputOperation(
            rawOpeningInputs,
            rawOpeningInputIds,
            port,
            inputId,
            rawOperation.id,
          );
          const owner = session.deref();
          if (owner) {
            void owner.closeIfUnowned(port, rawOperation);
            return;
          }
          void closeMidiInput(port);
        },
        () => {
          rawSettled = true;
          releaseRawInputOperation(
            rawOpeningInputs,
            rawOpeningInputIds,
            inputReference.deref(),
            inputId,
            rawOperation.id,
          );
        },
      );
      opening.push(Promise.race([rawOpen, cancelled, timedOut])
        .then(async () => {
          if (
            this.disposed
            || this.generation !== syncGeneration
            || this.access !== access
            || this.openingInputs.get(input.id) !== attempt
            || attempt.invalidated
            || access.inputs.get(input.id) !== input
            || input.state !== "connected"
          ) {
            await this.closeIfUnowned(input, rawOperation);
            return;
          }
          if (input.connection !== "open") {
            // A non-conforming driver can resolve open() without transitioning
            // the port. Do not leave that half-open host resource behind or
            // let repeated refreshes accumulate driver-owned handles.
            await this.closeIfUnowned(input, rawOperation);
            throw new Error(`${input.name?.trim() || "MIDI input"} did not enter the open state.`);
          }
          const owner = liveInputOwner(input.id);
          if (owner && (owner.session !== this || owner.input !== input)) {
            await closeMidiInput(input);
            return;
          }
          this.inputs.set(input.id, input);
          registerLiveInputOwner(input, this);
          const sessionReference = new WeakRef(this);
          const inputReference = new WeakRef(input);
          const messageHandler = (event: MIDIMessageEvent): void => {
            const session = sessionReference.deref();
            const port = inputReference.deref();
            if (!session || !port) return;
            const currentOwner = liveInputOwner(port.id);
            if (
              session.disposed
              || session.generation !== syncGeneration
              || session.inputs.get(port.id) !== port
              || port.onmidimessage !== messageHandler
              || currentOwner?.session !== session
              || currentOwner.input !== port
            ) return;
            session.handleMessage(port, event);
          };
          input.onmidimessage = messageHandler;
        })
        .catch((error: unknown) => {
          if (
            this.disposed
            || this.generation !== syncGeneration
            || this.access !== access
            || this.openingInputs.get(input.id) !== attempt
          ) return;
          input.onmidimessage = null;
          this.inputs.delete(input.id);
          releaseLiveInputOwner(input, this);
          if (error instanceof Error && error.name === "AbortError") return;
          if (attempt.timedOut || input.connection !== "closed") void closeMidiInput(input);
          const detail = error instanceof Error ? error.message : "The MIDI port could not be opened.";
          openingErrors.push(detail);
        })
        .finally(() => {
          if (attempt.timeout !== null) clearTimeout(attempt.timeout);
          attempt.timeout = null;
          attempt.cancel = null;
          rejectCancellation = null;
          if (this.openingInputs.get(input.id) === attempt) this.openingInputs.delete(input.id);
          if (rawSettled) {
            releaseRawInputOperation(
              rawOpeningInputs,
              rawOpeningInputIds,
              inputReference.deref(),
              inputId,
              rawOperation.id,
            );
          }
        }));
    }

    await Promise.allSettled(opening);
    if (this.disposed || this.generation !== syncGeneration || this.access !== access) return [];

    const summaries = available
      .filter((input) => this.inputs.get(input.id) === input && input.connection === "open")
      .map(inputSummary);
    // Publish topology before errors so a partial success cannot clear the
    // failure message in consumers that reset stale errors on input changes.
    this.publishSyncResult(summaries, openingErrors);
    for (const detail of openingErrors) this.handlers.error(detail);
    return summaries;
  }

  private syncInputs(): Promise<readonly MidiInputSummary[]> {
    this.syncRequested = true;
    if (this.syncPromise) return this.syncPromise;
    const syncGeneration = this.generation;
    let syncing: Promise<readonly MidiInputSummary[]>;
    syncing = (async () => {
      let summaries: readonly MidiInputSummary[] = [];
      do {
        this.syncRequested = false;
        summaries = await this.syncInputsOnce();
      } while (
        this.syncRequested
        && !this.disposed
        && this.generation === syncGeneration
      );
      return summaries;
    })().finally(() => {
      if (this.syncPromise === syncing) this.syncPromise = null;
    });
    this.syncPromise = syncing;
    return syncing;
  }

  connect(): Promise<readonly MidiInputSummary[]> {
    const availability = getWebMidiAvailability();
    if (!availability.supported) {
      return Promise.reject(new Error(availability.reason ?? "Web MIDI is unavailable."));
    }
    if (this.disposed) return Promise.reject(new Error("The MIDI session is no longer available."));
    if (this.teardownPromise) {
      return Promise.reject(midiCancellationError("MIDI inputs are still disconnecting."));
    }
    if (this.connectPromise) return this.connectPromise;
    if (this.access) return this.refresh();
    if (this.pendingAccessRequest || pendingRawMidiAccessRequestId !== null) {
      return Promise.reject(new Error(
        "A previous MIDI permission request is still pending in the browser.",
      ));
    }

    const connectGeneration = ++this.generation;
    let cancelPermission: (() => void) | null = null;
    const cancelled = new Promise<never>((_resolve, reject) => {
      cancelPermission = () => {
        reject(midiCancellationError("MIDI connection was cancelled."));
      };
    });
    let accessRequest: Promise<MIDIAccess>;
    try {
      accessRequest = Promise.resolve(navigator.requestMIDIAccess({ sysex: false }));
    } catch (error) {
      accessRequest = Promise.reject(error);
    }
    const pendingRequest: PendingMidiAccessRequest = {
      id: ++rawMidiAccessRequestSequence,
      abandoned: false,
    };
    this.pendingAccessRequest = pendingRequest;
    pendingRawMidiAccessRequestId = pendingRequest.id;
    // Do not attach the session itself to a permission promise that the host
    // may leave unresolved. A late grant sees only a weak owner reference;
    // without message handlers it has not implicitly opened any input ports.
    const session = new WeakRef(this);
    void accessRequest.then(
      () => {
        const owner = session.deref();
        if (pendingRawMidiAccessRequestId === pendingRequest.id) {
          pendingRawMidiAccessRequestId = null;
        }
        if (owner?.pendingAccessRequest?.id === pendingRequest.id) {
          owner.pendingAccessRequest = null;
        }
      },
      () => {
        const owner = session.deref();
        if (pendingRawMidiAccessRequestId === pendingRequest.id) {
          pendingRawMidiAccessRequestId = null;
        }
        if (owner?.pendingAccessRequest?.id === pendingRequest.id) {
          owner.pendingAccessRequest = null;
        }
      },
    );
    const permission = Promise.race([accessRequest, cancelled]).then((access) => {
      if (this.disposed || this.generation !== connectGeneration) {
        throw midiCancellationError("MIDI connection was cancelled.");
      }
      this.access = access;
      access.addEventListener("statechange", this.handleStateChange);
      return this.syncInputs();
    });
    let connecting: Promise<readonly MidiInputSummary[]>;
    // Permission can settle before individual input.open() calls do. Keep the
    // complete connect transaction cancellable so disconnect never turns a
    // cancelled connection into a successful empty device list.
    connecting = Promise.race([permission, cancelled]).finally(() => {
      if (this.connectPromise !== connecting) return;
      this.connectPromise = null;
      this.cancelConnect = null;
    });
    this.connectPromise = connecting;
    this.cancelConnect = () => {
      pendingRequest.abandoned = true;
      cancelPermission?.();
    };
    return connecting;
  }

  refresh(): Promise<readonly MidiInputSummary[]> {
    if (this.disposed) return Promise.reject(new Error("The MIDI session is no longer available."));
    if (this.teardownPromise) {
      return Promise.reject(midiCancellationError("MIDI inputs are still disconnecting."));
    }
    if (this.refreshPromise) return this.refreshPromise;
    let cancelRefresh: (() => void) | null = null;
    const cancelled = new Promise<never>((_resolve, reject) => {
      cancelRefresh = () => {
        reject(midiCancellationError("MIDI refresh was cancelled."));
      };
    });
    let refreshing: Promise<readonly MidiInputSummary[]>;
    refreshing = Promise.race([this.syncInputs(), cancelled]).finally(() => {
      if (this.refreshPromise !== refreshing) return;
      this.refreshPromise = null;
      this.cancelRefresh = null;
    });
    this.refreshPromise = refreshing;
    this.cancelRefresh = () => cancelRefresh?.();
    return refreshing;
  }

  forgetHeldNotes(): void {
    this.heldNotes.clear();
    this.noteStacks.clear();
    this.bends.clear();
    this.modulations.clear();
  }

  private async performTeardown(silent: boolean, disposing: boolean): Promise<void> {
    this.generation += 1;
    const activeSync = this.syncPromise;
    const cancelConnect = this.cancelConnect;
    this.cancelConnect = null;
    this.connectPromise = null;
    cancelConnect?.();
    const cancelRefresh = this.cancelRefresh;
    this.cancelRefresh = null;
    this.refreshPromise = null;
    cancelRefresh?.();
    this.syncRequested = false;
    this.syncPromise = null;
    const access = this.access;
    access?.removeEventListener("statechange", this.handleStateChange);
    this.access = null;
    const inputs = [...new Set([
      ...this.inputs.values(),
      ...[...this.openingInputs.values()].map(({ input }) => input),
    ])];
    for (const opening of this.openingInputs.values()) {
      opening.invalidated = true;
      opening.cancel?.();
    }
    const ownedInputs = inputs.filter((input) => {
      const owner = liveInputOwner(input.id);
      if (owner?.input === input && owner.session !== this) return false;
      if (owner?.input === input) releaseLiveInputOwner(input, this);
      return true;
    });
    for (const input of ownedInputs) {
      input.onmidimessage = null;
      if (!disposing && !silent) this.releaseMatching((held) => held.inputId === input.id);
    }
    this.inputs.clear();
    this.openingInputs.clear();
    this.noteStacks.clear();
    this.heldNotes.clear();
    this.bends.clear();
    this.modulations.clear();
    this.publishedSyncSignature = null;
    if (!disposing && !silent) {
      this.handlers.pitchBend(0);
      this.handlers.modulation(0);
      this.handlers.inputsChanged([]);
    }
    const settling = new Set<Promise<unknown>>(this.closingInputPromises);
    for (const input of ownedInputs) settling.add(this.closeRevokedInput(input));
    // A topology sync may already have removed its input from this.inputs
    // before awaiting close(). Waiting for that sync keeps disconnect/dispose
    // from reporting completion while its host resource is still in flight.
    if (activeSync) settling.add(activeSync);
    await Promise.allSettled(settling);
  }

  private beginTeardown(silent: boolean, disposing: boolean): Promise<void> {
    let resolveTeardown: (() => void) | null = null;
    let rejectTeardown: ((error: unknown) => void) | null = null;
    const teardown = new Promise<void>((resolve, reject) => {
      resolveTeardown = resolve;
      rejectTeardown = reject;
    });
    this.teardownPromise = teardown;
    if (disposing) this.disposePromise = teardown;
    void this.performTeardown(silent, disposing).then(
      () => {
        if (this.teardownPromise === teardown) this.teardownPromise = null;
        resolveTeardown?.();
        resolveTeardown = null;
        rejectTeardown = null;
      },
      (error: unknown) => {
        if (this.teardownPromise === teardown) this.teardownPromise = null;
        rejectTeardown?.(error);
        resolveTeardown = null;
        rejectTeardown = null;
      },
    );
    return teardown;
  }

  disconnect(silent = false): Promise<void> {
    if (this.disposed) return this.disposePromise ?? this.teardownPromise ?? Promise.resolve();
    if (this.teardownPromise) return this.teardownPromise;
    return this.beginTeardown(silent, false);
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    // Drop callbacks immediately even if an earlier disconnect is still
    // waiting for a host close promise.
    this.handlers = NOOP_WEB_MIDI_HANDLERS;
    if (this.teardownPromise) {
      this.generation += 1;
      this.disposePromise = this.teardownPromise;
      return this.disposePromise;
    }
    return this.beginTeardown(true, true);
  }
}
