import { describe, expect, it, vi } from "vitest";
import {
  NoteSequencePlayer,
  NoteSequenceRecorder,
  SEQUENCE_IDLE_STOP_MS,
  type MonotonicClock,
  type SequenceTimerApi,
} from "./transport";
import type { CapturedNoteSequence, NoteSequenceEvent } from "./user-sequences";

class FakeTime implements MonotonicClock, SequenceTimerApi {
  time = 0;
  private serial = 0;
  readonly tasks = new Map<number, { at: number; callback: () => void; delay: number }>();

  now(): number {
    return this.time;
  }

  setTimeout(callback: () => void, delayMs: number): number {
    const id = ++this.serial;
    this.tasks.set(id, { at: this.time + delayMs, callback, delay: delayMs });
    return id;
  }

  clearTimeout(handle: number): void {
    this.tasks.delete(handle);
  }

  advance(ms: number): void {
    const target = this.time + ms;
    for (;;) {
      const next = [...this.tasks.entries()]
        .filter(([, task]) => task.at <= target)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next) break;
      const [id, task] = next;
      this.tasks.delete(id);
      this.time = task.at;
      task.callback();
    }
    this.time = target;
  }

  nextDelay(): number | null {
    return [...this.tasks.values()].sort((a, b) => a.at - b.at)[0]?.delay ?? null;
  }
}

const take = (events: readonly NoteSequenceEvent[]): CapturedNoteSequence => ({
  events,
  durationMs: events.reduce((total, event) => total + event.deltaMs, 0),
  noteCount: events.filter((event) => event.on).length,
});

describe("NoteSequenceRecorder", () => {
  it("auto-stops an untouched recording after exactly one minute", () => {
    const time = new FakeTime();
    const idle = vi.fn();
    const recorder = new NoteSequenceRecorder(idle, time, time);
    recorder.start();
    time.advance(SEQUENCE_IDLE_STOP_MS - 1);
    expect(idle).not.toHaveBeenCalled();
    time.advance(1);
    expect(idle).toHaveBeenCalledOnce();
  });

  it("does not call the idle callback again unless the owner finalizes or restarts", () => {
    const time = new FakeTime();
    const idle = vi.fn();
    const recorder = new NoteSequenceRecorder(idle, time, time);
    recorder.start();
    time.advance(SEQUENCE_IDLE_STOP_MS * 3);
    expect(idle).toHaveBeenCalledOnce();
    expect(time.tasks.size).toBe(0);
  });

  it("allows a held note to continue beyond one minute and starts the rest timer on release", () => {
    const time = new FakeTime();
    const idle = vi.fn();
    const recorder = new NoteSequenceRecorder(idle, time, time);
    recorder.start();
    recorder.noteOn("midi:one", 60);
    time.advance(SEQUENCE_IDLE_STOP_MS * 2);
    expect(idle).not.toHaveBeenCalled();
    recorder.noteOff("midi:one");
    time.advance(SEQUENCE_IDLE_STOP_MS - 1);
    expect(idle).not.toHaveBeenCalled();
    time.advance(1);
    expect(idle).toHaveBeenCalledOnce();
  });

  it("resets inactivity after a new phrase at the edge of the deadline", () => {
    const time = new FakeTime();
    const idle = vi.fn();
    const recorder = new NoteSequenceRecorder(idle, time, time);
    recorder.start();
    time.advance(SEQUENCE_IDLE_STOP_MS - 1);
    recorder.noteOn("computer:A", 60);
    recorder.noteOff("computer:A");
    time.advance(SEQUENCE_IDLE_STOP_MS - 1);
    expect(idle).not.toHaveBeenCalled();
    time.advance(1);
    expect(idle).toHaveBeenCalledOnce();
  });

  it("trims leading silence and the inactivity-detection tail", () => {
    const time = new FakeTime();
    let result: CapturedNoteSequence | null = null;
    const recorder = new NoteSequenceRecorder(() => { result = recorder.finish(); }, time, time);
    recorder.start();
    time.advance(12_345);
    recorder.noteOn("pointer:1", 64);
    time.advance(250);
    recorder.noteOff("pointer:1");
    time.advance(SEQUENCE_IDLE_STOP_MS);
    expect(result).toEqual({
      events: [
        { deltaMs: 0, note: 64, on: true },
        { deltaMs: 250, note: 64, on: false },
      ],
      durationMs: 250,
      noteCount: 1,
    });
  });

  it("ignores duplicate ownership from the same source", () => {
    const time = new FakeTime();
    const recorder = new NoteSequenceRecorder(() => undefined, time, time);
    recorder.start();
    expect(recorder.noteOn("key", 60)).toBe(true);
    expect(recorder.noteOn("key", 60)).toBe(false);
    recorder.noteOff("key");
    expect(recorder.finish().events).toHaveLength(2);
  });

  it("records a same-source pitch change as off then on at the same time", () => {
    const time = new FakeTime();
    const recorder = new NoteSequenceRecorder(() => undefined, time, time);
    recorder.start();
    recorder.noteOn("pointer:2", 60);
    time.advance(90);
    recorder.noteOn("pointer:2", 62);
    time.advance(10);
    recorder.noteOff("pointer:2");
    expect(recorder.finish().events).toEqual([
      { deltaMs: 0, note: 60, on: true },
      { deltaMs: 90, note: 60, on: false },
      { deltaMs: 0, note: 62, on: true },
      { deltaMs: 10, note: 62, on: false },
    ]);
  });

  it("preserves two attacks and releases at the same pitch", () => {
    const time = new FakeTime();
    const recorder = new NoteSequenceRecorder(() => undefined, time, time);
    recorder.start();
    recorder.noteOn("one", 60);
    recorder.noteOn("two", 60);
    recorder.noteOff("two");
    recorder.noteOff("one");
    const result = recorder.finish();
    expect(result.noteCount).toBe(2);
    expect(result.events.map((event) => event.on)).toEqual([true, true, false, false]);
  });

  it("snapshots already-held keyboard notes at time zero", () => {
    const time = new FakeTime();
    const recorder = new NoteSequenceRecorder(() => undefined, time, time);
    recorder.start([["computer:KeyA", 48], ["midi:x", 67]]);
    time.advance(20);
    const result = recorder.finish();
    expect(result.events).toEqual([
      { deltaMs: 0, note: 48, on: true },
      { deltaMs: 0, note: 67, on: true },
      { deltaMs: 20, note: 48, on: false },
      { deltaMs: 0, note: 67, on: false },
    ]);
  });

  it("balances held notes on manual finish without changing external ownership", () => {
    const time = new FakeTime();
    const recorder = new NoteSequenceRecorder(() => undefined, time, time);
    recorder.start();
    recorder.noteOn("live", 72);
    time.advance(500);
    const result = recorder.finish();
    expect(result.events.at(-1)).toEqual({ deltaMs: 500, note: 72, on: false });
    expect(recorder.heldCount).toBe(0);
  });

  it("bulk-releases only matching recorded sources", () => {
    const time = new FakeTime();
    const recorder = new NoteSequenceRecorder(() => undefined, time, time);
    recorder.start();
    recorder.noteOn("computer:A", 48);
    recorder.noteOn("midi:A", 60);
    expect(recorder.releaseMatching((source) => source.startsWith("computer:"))).toBe(1);
    expect(recorder.heldCount).toBe(1);
    expect(recorder.finish().events.map(({ note, on }) => [note, on])).toEqual([
      [48, true], [60, true], [48, false], [60, false],
    ]);
  });

  it("rejects invalid notes and unknown releases", () => {
    const time = new FakeTime();
    const recorder = new NoteSequenceRecorder(() => undefined, time, time);
    recorder.start();
    expect(recorder.noteOn("bad", -1)).toBe(false);
    expect(recorder.noteOn("bad", 128)).toBe(false);
    expect(recorder.noteOn("bad", 60.5)).toBe(false);
    expect(recorder.noteOff("unknown")).toBe(false);
    expect(recorder.finish().noteCount).toBe(0);
  });

  it("dispose cancels the idle timer and clears the take", () => {
    const time = new FakeTime();
    const idle = vi.fn();
    const recorder = new NoteSequenceRecorder(idle, time, time);
    recorder.start();
    recorder.noteOn("a", 60);
    recorder.dispose();
    time.advance(SEQUENCE_IDLE_STOP_MS * 2);
    expect(idle).not.toHaveBeenCalled();
    expect(recorder.isRecording).toBe(false);
    expect(recorder.finish().events).toEqual([]);
  });
});

describe("NoteSequencePlayer", () => {
  const setup = () => {
    const time = new FakeTime();
    const calls: string[] = [];
    const player = new NoteSequencePlayer({
      noteOn: (source, note) => calls.push(`on:${source}:${note}`),
      noteOff: (source) => calls.push(`off:${source}`),
      finished: (reason) => calls.push(`finished:${reason}`),
    }, time, time);
    return { time, calls, player };
  };

  it("plays the first attack immediately and follows delta timing", () => {
    const { time, calls, player } = setup();
    expect(player.play(take([
      { deltaMs: 0, note: 60, on: true },
      { deltaMs: 250, note: 60, on: false },
    ]))).toBe(true);
    expect(calls[0]).toMatch(/^on:sequence:/);
    time.advance(249);
    expect(calls).toHaveLength(1);
    time.advance(1);
    expect(calls.at(-1)).toBe("finished:ended");
    expect(calls.filter((call) => call.startsWith("off:"))).toHaveLength(1);
  });

  it("keeps at most one pending timer", () => {
    const { time, player } = setup();
    player.play(take([
      { deltaMs: 10, note: 60, on: true },
      { deltaMs: 10, note: 60, on: false },
      { deltaMs: 10, note: 62, on: true },
      { deltaMs: 10, note: 62, on: false },
    ]));
    expect(time.tasks.size).toBe(1);
    time.advance(10);
    expect(time.tasks.size).toBe(1);
    time.advance(30);
    expect(time.tasks.size).toBe(0);
  });

  it("preserves stable ordering for simultaneous events", () => {
    const { calls, player } = setup();
    player.play(take([
      { deltaMs: 0, note: 60, on: true },
      { deltaMs: 0, note: 64, on: true },
      { deltaMs: 0, note: 60, on: false },
      { deltaMs: 0, note: 64, on: false },
    ]));
    expect(calls.map((call) => call.split(":")[0])).toEqual([
      "on", "on", "off", "off", "finished",
    ]);
  });

  it("uses absolute time so callback lateness does not accumulate drift", () => {
    const { time, calls, player } = setup();
    player.play(take([
      { deltaMs: 100, note: 60, on: true },
      { deltaMs: 100, note: 60, on: false },
    ]));
    const pending = [...time.tasks.entries()][0];
    expect(pending).toBeDefined();
    if (!pending) throw new Error("Expected a playback timer.");
    time.tasks.delete(pending[0]);
    time.time = 175;
    pending[1].callback();
    expect(calls.filter((call) => call.startsWith("on:"))).toHaveLength(1);
    expect(time.nextDelay()).toBe(25);
  });

  it("uses distinct FIFO ownership for repeated notes", () => {
    const { calls, player } = setup();
    player.play(take([
      { deltaMs: 0, note: 60, on: true },
      { deltaMs: 0, note: 60, on: true },
      { deltaMs: 0, note: 60, on: false },
      { deltaMs: 0, note: 60, on: false },
    ]));
    const ons = calls.filter((call) => call.startsWith("on:"));
    const offs = calls.filter((call) => call.startsWith("off:"));
    expect(new Set(ons.map((call) => call.split(":").slice(1, -1).join(":"))).size).toBe(2);
    expect(offs).toHaveLength(2);
  });

  it("stop cancels its timer and releases every active playback source", () => {
    const { time, calls, player } = setup();
    player.play(take([
      { deltaMs: 0, note: 60, on: true },
      { deltaMs: 500, note: 60, on: false },
    ]));
    player.stop();
    expect(calls.filter((call) => call.startsWith("off:"))).toHaveLength(1);
    expect(calls.at(-1)).toBe("finished:stopped");
    expect(time.tasks.size).toBe(0);
    time.advance(1_000);
    expect(calls.at(-1)).toBe("finished:stopped");
  });

  it("replacement playback releases old sources before starting the new take", () => {
    const { calls, player } = setup();
    player.play(take([
      { deltaMs: 0, note: 60, on: true },
      { deltaMs: 1_000, note: 60, on: false },
    ]));
    player.play(take([
      { deltaMs: 0, note: 72, on: true },
      { deltaMs: 10, note: 72, on: false },
    ]));
    expect(calls[1]).toMatch(/^off:sequence:/);
    expect(calls[2]).toMatch(/^on:sequence:.*:72$/);
  });

  it("slices delays longer than the browser timer maximum without limiting duration", () => {
    const { time, player } = setup();
    player.play(take([
      { deltaMs: Number.MAX_SAFE_INTEGER - 1, note: 60, on: true },
      { deltaMs: 1, note: 60, on: false },
    ]));
    expect(time.nextDelay()).toBe(60_000);
    expect(player.isPlaying).toBe(true);
  });

  it("bounds a same-time backlog and continues it with the same single timer", () => {
    const { time, calls, player } = setup();
    const events: NoteSequenceEvent[] = [];
    for (let index = 0; index < 600; index += 1) {
      events.push({ deltaMs: 0, note: index % 2 ? 60 : 61, on: index < 300 });
    }
    player.play(take(events));
    expect(calls.length).toBe(512);
    expect(time.tasks.size).toBe(1);
    time.advance(0);
    expect(calls.at(-1)).toBe("finished:ended");
  });

  it("defensively ignores an orphan off event", () => {
    const { calls, player } = setup();
    player.play(take([{ deltaMs: 0, note: 60, on: false }]));
    expect(calls).toEqual(["finished:ended"]);
  });

  it("returns false for an empty take without allocating resources", () => {
    const { time, calls, player } = setup();
    expect(player.play(take([]))).toBe(false);
    expect(player.isPlaying).toBe(false);
    expect(time.tasks.size).toBe(0);
    expect(calls).toEqual([]);
  });

  it("dispose is silent, idempotent, and prevents stale callbacks", () => {
    const { time, calls, player } = setup();
    player.play(take([
      { deltaMs: 0, note: 60, on: true },
      { deltaMs: 100, note: 60, on: false },
    ]));
    player.dispose();
    player.dispose();
    time.advance(200);
    expect(calls.filter((call) => call.startsWith("off:"))).toHaveLength(1);
    expect(calls.some((call) => call.startsWith("finished:"))).toBe(false);
  });

  it("leaves no timers or owned notes after repeated record/play teardown cycles", () => {
    const time = new FakeTime();
    const activeSources = new Set<string>();
    const recorder = new NoteSequenceRecorder(() => undefined, time, time);
    const player = new NoteSequencePlayer({
      noteOn: (source) => activeSources.add(source),
      noteOff: (source) => activeSources.delete(source),
      finished: () => undefined,
    }, time, time);

    for (let cycle = 0; cycle < 1_000; cycle += 1) {
      recorder.start();
      recorder.noteOn(`key:${cycle}`, 36 + cycle % 37);
      time.advance(1);
      recorder.noteOff(`key:${cycle}`);
      const recording = recorder.finish();
      player.play(recording);
      player.stop(false);
      expect(time.tasks.size).toBe(0);
      expect(activeSources.size).toBe(0);
    }

    recorder.dispose();
    player.dispose();
    expect(time.tasks.size).toBe(0);
    expect(activeSources.size).toBe(0);
  });
});
