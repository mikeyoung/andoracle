import type { CapturedNoteSequence, NoteSequenceEvent } from "./user-sequences";

/** A one-minute rest is the only automatic recording limit. */
export const SEQUENCE_IDLE_STOP_MS = 60_000;

const PLAYBACK_TIMER_SLICE_MS = 60_000;
const PLAYBACK_BATCH_SIZE = 512;
export const SEQUENCE_SOURCE_PREFIX = "sequence:";

export interface MonotonicClock {
  now(): number;
}

export interface SequenceTimerApi {
  setTimeout(callback: () => void, delayMs: number): number;
  clearTimeout(handle: number): void;
}

const browserClock: MonotonicClock = {
  now: () => performance.now(),
};

const browserTimers: SequenceTimerApi = {
  setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
  clearTimeout: (handle) => window.clearTimeout(handle),
};

const validNote = (note: number): boolean => Number.isInteger(note) && note >= 0 && note <= 127;

/**
 * Captures accepted keyboard-source transitions. It deliberately stores no
 * controller, pedal, parameter, patch, or source-device data.
 */
export class NoteSequenceRecorder {
  private readonly heldSources = new Map<string, number>();
  private events: NoteSequenceEvent[] = [];
  private firstEventAt: number | null = null;
  private lastEventAtMs = 0;
  private noteCount = 0;
  private idleTimer: number | null = null;
  private timerGeneration = 0;
  private recording = false;

  constructor(
    private readonly onIdleStop: () => void,
    private readonly clock: MonotonicClock = browserClock,
    private readonly timers: SequenceTimerApi = browserTimers,
  ) {}

  get isRecording(): boolean {
    return this.recording;
  }

  get heldCount(): number {
    return this.heldSources.size;
  }

  start(seedNotes: Iterable<readonly [string, number]> = []): void {
    this.reset();
    this.recording = true;
    const now = this.clock.now();
    for (const [source, note] of seedNotes) this.acceptNoteOn(source, note, now);
    this.updateIdleTimer();
  }

  noteOn(source: string, note: number): boolean {
    if (!this.recording || !source || !validNote(note)) return false;
    return this.acceptNoteOn(source, note, this.clock.now());
  }

  noteOff(source: string): boolean {
    if (!this.recording || !source) return false;
    const note = this.heldSources.get(source);
    if (note === undefined) return false;
    this.heldSources.delete(source);
    this.append(false, note, this.clock.now());
    this.updateIdleTimer();
    return true;
  }

  /** Records releases for sources cleared by blur, panic, or another bulk path. */
  releaseMatching(predicate: (source: string, note: number) => boolean): number {
    if (!this.recording) return 0;
    const now = this.clock.now();
    let released = 0;
    for (const [source, note] of [...this.heldSources]) {
      if (!predicate(source, note)) continue;
      this.heldSources.delete(source);
      this.append(false, note, now);
      released += 1;
    }
    if (released > 0) this.updateIdleTimer();
    return released;
  }

  /** Finalizes a balanced take; the minute used to detect silence is not stored. */
  finish(): CapturedNoteSequence {
    if (!this.recording) return { events: [], durationMs: 0, noteCount: 0 };
    this.clearIdleTimer();
    const now = this.clock.now();
    for (const note of this.heldSources.values()) this.append(false, note, now);
    this.heldSources.clear();
    this.recording = false;
    const captured = {
      events: this.events,
      durationMs: this.lastEventAtMs,
      noteCount: this.noteCount,
    };
    // Transfer the sole event-array ownership to the caller. Discarding the
    // review modal can now release a long take without the recorder retaining
    // a duplicate until another recording starts.
    this.events = [];
    this.firstEventAt = null;
    this.lastEventAtMs = 0;
    this.noteCount = 0;
    return captured;
  }

  discard(): void {
    this.reset();
  }

  dispose(): void {
    this.reset();
  }

  private acceptNoteOn(source: string, note: number, now: number): boolean {
    if (!source || !validNote(note)) return false;
    const previous = this.heldSources.get(source);
    if (previous === note) return false;
    if (previous !== undefined) this.append(false, previous, now);
    this.heldSources.set(source, note);
    this.append(true, note, now);
    this.noteCount += 1;
    this.updateIdleTimer();
    return true;
  }

  private append(on: boolean, note: number, now: number): void {
    if (this.firstEventAt === null) this.firstEventAt = now;
    const absoluteMs = Math.max(
      this.lastEventAtMs,
      Math.round(Math.max(0, now - this.firstEventAt)),
    );
    this.events.push({
      deltaMs: absoluteMs - this.lastEventAtMs,
      note,
      on,
    });
    this.lastEventAtMs = absoluteMs;
  }

  private updateIdleTimer(): void {
    this.clearIdleTimer();
    if (!this.recording || this.heldSources.size > 0) return;
    const generation = this.timerGeneration;
    this.idleTimer = this.timers.setTimeout(() => {
      this.idleTimer = null;
      if (!this.recording || generation !== this.timerGeneration || this.heldSources.size > 0) return;
      this.onIdleStop();
    }, SEQUENCE_IDLE_STOP_MS);
  }

  private clearIdleTimer(): void {
    this.timerGeneration += 1;
    if (this.idleTimer === null) return;
    this.timers.clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private reset(): void {
    this.clearIdleTimer();
    this.recording = false;
    this.heldSources.clear();
    this.events = [];
    this.firstEventAt = null;
    this.lastEventAtMs = 0;
    this.noteCount = 0;
  }
}

export interface NoteSequencePlayerHandlers {
  noteOn(source: string, note: number): void;
  noteOff(source: string): void;
  finished(reason: "ended" | "stopped"): void;
}

/** One-timer, drift-corrected playback routed through App's normal note ownership. */
export class NoteSequencePlayer {
  private events: readonly NoteSequenceEvent[] = [];
  private readonly sourcesByNote = new Map<number, string[]>();
  private timer: number | null = null;
  private startedAt = 0;
  private cursor = 0;
  private nextDueMs = 0;
  private generation = 0;
  private playing = false;
  private paused = false;
  private pausedElapsedMs = 0;
  private sourcesAudible = false;
  private sourceSerial = 0;

  constructor(
    private readonly handlers: NoteSequencePlayerHandlers,
    private readonly clock: MonotonicClock = browserClock,
    private readonly timers: SequenceTimerApi = browserTimers,
  ) {}

  get isPlaying(): boolean {
    return this.playing;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  get isActive(): boolean {
    return this.playing || this.paused;
  }

  play(sequence: Pick<CapturedNoteSequence, "events">): boolean {
    this.stop(false);
    if (sequence.events.length === 0) return false;
    this.events = sequence.events;
    this.cursor = 0;
    this.nextDueMs = sequence.events[0]?.deltaMs ?? 0;
    this.startedAt = this.clock.now();
    this.pausedElapsedMs = 0;
    this.paused = false;
    this.playing = true;
    this.sourcesAudible = true;
    const generation = ++this.generation;
    this.tick(generation);
    return true;
  }

  /** Freezes the sequence clock and silences sequence-owned notes. */
  pause(): boolean {
    if (!this.playing) return false;
    this.pausedElapsedMs = Math.max(0, this.clock.now() - this.startedAt);
    this.playing = false;
    this.paused = true;
    this.generation += 1;
    this.clearTimer();
    // Keep logical FIFO ownership so held notes can be chased on resume and
    // their eventual recorded note-offs still release the correct source.
    this.silenceSources();
    return true;
  }

  /** Continues from the frozen playhead and retriggers notes held at pause. */
  resume(): boolean {
    if (!this.paused || this.events.length === 0) return false;
    this.startedAt = this.clock.now() - this.pausedElapsedMs;
    this.paused = false;
    this.playing = true;
    const generation = ++this.generation;
    this.restoreSources();
    if (!this.playing || generation !== this.generation) return false;
    this.tick(generation);
    return true;
  }

  stop(notify = true): void {
    const wasActive = this.isActive;
    this.playing = false;
    this.paused = false;
    this.generation += 1;
    this.clearTimer();
    this.releaseAllSources();
    this.events = [];
    this.cursor = 0;
    this.nextDueMs = 0;
    this.pausedElapsedMs = 0;
    if (notify && wasActive) this.handlers.finished("stopped");
  }

  dispose(): void {
    this.stop(false);
  }

  private tick(generation: number): void {
    this.timer = null;
    if (!this.playing || generation !== this.generation) return;
    const elapsedMs = Math.max(0, this.clock.now() - this.startedAt);
    let processed = 0;

    while (
      this.cursor < this.events.length
      && this.nextDueMs <= elapsedMs
      && processed < PLAYBACK_BATCH_SIZE
    ) {
      const event = this.events[this.cursor];
      if (!event) break;
      this.cursor += 1;
      processed += 1;
      const next = this.events[this.cursor];
      if (next) this.nextDueMs += next.deltaMs;
      // Advance the cursor before invoking application callbacks so a
      // re-entrant Pause cannot replay the same event after resume.
      this.dispatch(event);
      if (!this.playing || generation !== this.generation) return;
    }

    if (this.cursor >= this.events.length) {
      this.playing = false;
      this.paused = false;
      this.releaseAllSources();
      this.events = [];
      this.cursor = 0;
      this.nextDueMs = 0;
      this.pausedElapsedMs = 0;
      this.handlers.finished("ended");
      return;
    }

    const stillOverdue = this.nextDueMs <= Math.max(0, this.clock.now() - this.startedAt);
    const delay = stillOverdue
      ? 0
      : Math.min(
          PLAYBACK_TIMER_SLICE_MS,
          Math.max(0, this.nextDueMs - (this.clock.now() - this.startedAt)),
        );
    this.timer = this.timers.setTimeout(() => this.tick(generation), delay);
  }

  private dispatch(event: NoteSequenceEvent): void {
    if (event.on) {
      const source = `${SEQUENCE_SOURCE_PREFIX}${this.generation}:${this.sourceSerial}`;
      this.sourceSerial += 1;
      const sources = this.sourcesByNote.get(event.note) ?? [];
      sources.push(source);
      this.sourcesByNote.set(event.note, sources);
      this.handlers.noteOn(source, event.note);
      return;
    }

    const sources = this.sourcesByNote.get(event.note);
    const source = sources?.shift();
    if (!sources || !source) return;
    if (sources.length === 0) this.sourcesByNote.delete(event.note);
    if (this.sourcesAudible) this.handlers.noteOff(source);
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    this.timers.clearTimeout(this.timer);
    this.timer = null;
  }

  private silenceSources(): void {
    if (!this.sourcesAudible) return;
    for (const sources of this.sourcesByNote.values()) {
      for (const source of sources) this.handlers.noteOff(source);
    }
    this.sourcesAudible = false;
  }

  private restoreSources(): void {
    if (this.sourcesAudible) return;
    // Mark restoration audible before callbacks so even a deliberately
    // re-entrant Pause can release the first restored note safely.
    this.sourcesAudible = true;
    for (const [note, sources] of this.sourcesByNote) {
      for (const source of sources) {
        this.handlers.noteOn(source, note);
        if (!this.playing || this.paused || !this.sourcesAudible) return;
      }
    }
  }

  private releaseAllSources(): void {
    this.silenceSources();
    this.sourcesByNote.clear();
  }
}
