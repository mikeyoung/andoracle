import { describe, expect, it, vi } from "vitest";
import {
  USER_SEQUENCES_STORAGE_KEY,
  decodeNoteSequence,
  decodeUserSequence,
  encodeNoteSequence,
  findUserSequence,
  hasUserSequenceNamed,
  loadUserSequences,
  normalizeCapturedNoteSequence,
  readUserSequences,
  saveUserSequence,
  saveUserSequenceSafely,
  type NoteSequenceEvent,
  type SafeSaveUserSequenceResult,
  type UserSequenceLockManager,
  type UserSequenceStorage,
} from "./user-sequences";

const SIMPLE_EVENTS: readonly NoteSequenceEvent[] = [
  { deltaMs: 0, note: 60, on: true },
  { deltaMs: 500, note: 60, on: false },
];

class MemoryStorage implements UserSequenceStorage {
  private readonly values = new Map<string, string>();
  writes = 0;

  constructor(initialValue?: string) {
    if (initialValue !== undefined) this.values.set(USER_SEQUENCES_STORAGE_KEY, initialValue);
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.writes += 1;
    this.values.set(key, value);
  }

  raw(): string | null {
    return this.getItem(USER_SEQUENCES_STORAGE_KEY);
  }
}

class IfAvailableLockManager implements UserSequenceLockManager {
  private held = false;

  async request<T>(
    _name: string,
    _options: { readonly mode: "exclusive"; readonly ifAvailable: true },
    callback: (lock: unknown | null) => T | PromiseLike<T>,
  ): Promise<T> {
    await Promise.resolve();
    if (this.held) return callback(null);
    this.held = true;
    try {
      return await callback({});
    } finally {
      this.held = false;
    }
  }
}

const encodeRawBytes = (bytes: readonly number[]): string => btoa(
  String.fromCharCode(...bytes),
).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");

describe("note-sequence compact codec", () => {
  it("matches a stable binary/base64url vector", () => {
    expect(encodeNoteSequence(SIMPLE_EVENTS)).toBe("ALz0Azw");
    expect(decodeNoteSequence("ALz0Azw")).toEqual({
      events: SIMPLE_EVENTS,
      durationMs: 500,
      noteCount: 1,
    });
  });

  it("round-trips simultaneous, overlapping, retriggered, and boundary MIDI notes", () => {
    const events: readonly NoteSequenceEvent[] = [
      { deltaMs: 0, note: 0, on: true },
      { deltaMs: 0, note: 127, on: true },
      { deltaMs: 127, note: 0, on: true },
      { deltaMs: 128, note: 0, on: false },
      { deltaMs: 16_384, note: 127, on: false },
      { deltaMs: 0, note: 0, on: false },
    ];

    const encoded = encodeNoteSequence(events);

    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(decodeNoteSequence(encoded as string)).toEqual({
      events,
      durationMs: 16_639,
      noteCount: 3,
    });
  });

  it("supports safe-integer timing far beyond browser timer and 32-bit limits", () => {
    const events: readonly NoteSequenceEvent[] = [
      { deltaMs: 0, note: 64, on: true },
      { deltaMs: Number.MAX_SAFE_INTEGER, note: 64, on: false },
    ];

    const encoded = encodeNoteSequence(events);

    expect(encoded).not.toBeNull();
    expect(decodeNoteSequence(encoded as string)).toEqual({
      events,
      durationMs: Number.MAX_SAFE_INTEGER,
      noteCount: 1,
    });
  });

  it("is substantially smaller than object JSON for ordinary playing", () => {
    const events: NoteSequenceEvent[] = [];
    for (let note = 36; note < 100; note += 1) {
      events.push({ deltaMs: note === 36 ? 0 : 25, note, on: true });
      events.push({ deltaMs: 125, note, on: false });
    }

    const encoded = encodeNoteSequence(events) as string;

    expect(encoded.length).toBeLessThan(JSON.stringify(events).length / 5);
    expect(decodeNoteSequence(encoded)?.events).toEqual(events);
  });

  it("handles a large take without argument spreading or fixed event limits", () => {
    const events: NoteSequenceEvent[] = [];
    for (let index = 0; index < 10_000; index += 1) {
      const note = index % 128;
      events.push({ deltaMs: index % 3, note, on: true });
      events.push({ deltaMs: 1, note, on: false });
    }

    const decoded = decodeNoteSequence(encodeNoteSequence(events) as string);

    expect(decoded?.events).toHaveLength(20_000);
    expect(decoded?.noteCount).toBe(10_000);
    expect(decoded?.durationMs).toBe(events.reduce((sum, event) => sum + event.deltaMs, 0));
  });

  it("round-trips a deterministic randomized campaign", () => {
    let state = 0x5eed1234;
    const random = (): number => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      return state;
    };

    for (let campaign = 0; campaign < 100; campaign += 1) {
      const events: NoteSequenceEvent[] = [];
      const active: number[] = [];
      for (let index = 0; index < 100; index += 1) {
        if (active.length === 0 || (active.length < 12 && random() % 3 !== 0)) {
          const note = random() % 128;
          active.push(note);
          events.push({ deltaMs: random() % 100_000, note, on: true });
        } else {
          const activeIndex = random() % active.length;
          const [note] = active.splice(activeIndex, 1);
          events.push({ deltaMs: random() % 100_000, note, on: false });
        }
      }
      while (active.length > 0) {
        const note = active.pop() as number;
        events.push({ deltaMs: random() % 100_000, note, on: false });
      }

      expect(decodeNoteSequence(encodeNoteSequence(events) as string)?.events).toEqual(events);
    }
  });

  it("derives trusted metadata and snapshots event objects", () => {
    const mutable = SIMPLE_EVENTS.map((event) => ({ ...event }));
    const normalized = normalizeCapturedNoteSequence({
      events: mutable,
      durationMs: 123_456,
      noteCount: 99,
    });

    mutable[0].note = 70;
    expect(normalized).toEqual({
      events: SIMPLE_EVENTS,
      durationMs: 500,
      noteCount: 1,
    });
  });

  it.each([
    { label: "empty", events: [] },
    { label: "negative delta", events: [{ deltaMs: -1, note: 60, on: true }] },
    { label: "fractional delta", events: [{ deltaMs: 0.5, note: 60, on: true }] },
    { label: "unsafe delta", events: [{ deltaMs: Number.MAX_SAFE_INTEGER + 1, note: 60, on: true }] },
    { label: "duration overflow", events: [
      { deltaMs: Number.MAX_SAFE_INTEGER, note: 60, on: true },
      { deltaMs: 1, note: 60, on: false },
    ] },
    { label: "negative note", events: [{ deltaMs: 0, note: -1, on: true }] },
    { label: "high note", events: [{ deltaMs: 0, note: 128, on: true }] },
    { label: "fractional note", events: [{ deltaMs: 0, note: 60.5, on: true }] },
    { label: "non-boolean action", events: [{ deltaMs: 0, note: 60, on: 1 }] },
    { label: "orphan note off", events: [{ deltaMs: 0, note: 60, on: false }] },
    { label: "stuck note", events: [{ deltaMs: 0, note: 60, on: true }] },
    { label: "wrong note released", events: [
      { deltaMs: 0, note: 60, on: true },
      { deltaMs: 1, note: 61, on: false },
    ] },
  ])("rejects an invalid $label take", ({ events }) => {
    expect(normalizeCapturedNoteSequence(events as readonly NoteSequenceEvent[])).toBeNull();
    expect(encodeNoteSequence(events as readonly NoteSequenceEvent[])).toBeNull();
  });

  it("rejects malformed and non-canonical base64url", () => {
    expect(decodeNoteSequence("")).toBeNull();
    expect(decodeNoteSequence("A")).toBeNull();
    expect(decodeNoteSequence("AA==")).toBeNull();
    expect(decodeNoteSequence("AA+/ ")).toBeNull();
    expect(decodeNoteSequence("AB")).toBeNull();
    expect(decodeNoteSequence("AAB")).toBeNull();
  });

  it("rejects truncated, overlong, overflowing, and actionless varints", () => {
    expect(decodeNoteSequence(encodeRawBytes([0x80]))).toBeNull();
    expect(decodeNoteSequence(encodeRawBytes([0x00]))).toBeNull();
    expect(decodeNoteSequence(encodeRawBytes([0x80, 0x00, 0xbc, 0x00, 0x3c]))).toBeNull();
    expect(decodeNoteSequence(encodeRawBytes([
      0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f, 0xbc,
    ]))).toBeNull();
  });

  it("rejects binary streams whose otherwise valid events are unbalanced", () => {
    expect(decodeNoteSequence(encodeRawBytes([0, 0xbc]))).toBeNull();
    expect(decodeNoteSequence(encodeRawBytes([0, 0x3c]))).toBeNull();
  });
});

describe("user sequence storage", () => {
  it("saves a trimmed name and a compact versioned snapshot", () => {
    const storage = new MemoryStorage();

    const result = saveUserSequence(" \u00a0Night Run\t", {
      events: SIMPLE_EVENTS,
      durationMs: 999,
      noteCount: 999,
    }, storage);

    expect(result.status).toBe("saved");
    if (result.status !== "saved") throw new Error("Expected a saved sequence.");
    expect(result.sequence).toEqual({
      name: "Night Run",
      data: encodeNoteSequence(SIMPLE_EVENTS),
      durationMs: 500,
      noteCount: 1,
      eventCount: 2,
    });
    expect(decodeUserSequence(result.sequence)?.events).toEqual(SIMPLE_EVENTS);
    const serialized = JSON.parse(storage.raw() as string) as Record<string, unknown>;
    expect(serialized.version).toBe(1);
    expect(storage.raw()).not.toContain("deltaMs");
    expect(readUserSequences(storage)).toEqual({
      status: "ok",
      sequences: [result.sequence],
    });
  });

  it("rejects empty trimmed names without writing", () => {
    const storage = new MemoryStorage();

    expect(saveUserSequence(" \n\t ", SIMPLE_EVENTS, storage)).toEqual({
      status: "empty-name",
      sequences: [],
    });
    expect(storage.writes).toBe(0);
    expect(storage.raw()).toBeNull();
  });

  it("rejects duplicate names case-insensitively without overwriting", () => {
    const storage = new MemoryStorage();
    expect(saveUserSequence("Verse", SIMPLE_EVENTS, storage).status).toBe("saved");
    const before = storage.raw();

    const duplicate = saveUserSequence("  vErSe  ", [
      { deltaMs: 0, note: 72, on: true },
      { deltaMs: 900, note: 72, on: false },
    ], storage);

    expect(duplicate.status).toBe("duplicate-name");
    if (duplicate.status !== "duplicate-name") throw new Error("Expected duplicate name.");
    expect(duplicate.existingName).toBe("Verse");
    expect(storage.writes).toBe(1);
    expect(storage.raw()).toBe(before);
    const found = findUserSequence("verse", storage);
    expect(found && decodeUserSequence(found)?.events).toEqual(SIMPLE_EVENTS);
  });

  it("matches canonically equivalent and expanding Unicode names", () => {
    const storage = new MemoryStorage();
    expect(saveUserSequence("Café", SIMPLE_EVENTS, storage).status).toBe("saved");
    expect(saveUserSequence(" CAFE\u0301 ", SIMPLE_EVENTS, storage).status).toBe("duplicate-name");
    expect(saveUserSequence("Straße", SIMPLE_EVENTS, storage).status).toBe("saved");
    expect(saveUserSequence("STRASSE", SIMPLE_EVENTS, storage).status).toBe("duplicate-name");
    expect(saveUserSequence("Σ", SIMPLE_EVENTS, storage).status).toBe("saved");
    expect(saveUserSequence("ς", SIMPLE_EVENTS, storage).status).toBe("duplicate-name");
    expect(storage.writes).toBe(3);
  });

  it("preserves internal whitespace and appends distinct names in order", () => {
    const storage = new MemoryStorage();
    saveUserSequence("  Wide  Run  ", SIMPLE_EVENTS, storage);
    saveUserSequence("Second", SIMPLE_EVENTS, storage);

    expect(loadUserSequences(storage).map((sequence) => sequence.name)).toEqual([
      "Wide  Run",
      "Second",
    ]);
  });

  it("stores an immutable snapshot rather than retaining caller objects", () => {
    const storage = new MemoryStorage();
    const mutable = SIMPLE_EVENTS.map((event) => ({ ...event }));
    const result = saveUserSequence("Snapshot", mutable, storage);
    mutable[0].note = 99;
    mutable.push({ deltaMs: 0, note: 99, on: true });

    expect(result.status).toBe("saved");
    const found = findUserSequence("Snapshot", storage);
    expect(found && decodeUserSequence(found)?.events).toEqual(SIMPLE_EVENTS);
  });

  it("keeps library entries compact and lazily decodes only a requested take", () => {
    const storage = new MemoryStorage();
    const saved = saveUserSequence("Compact", SIMPLE_EVENTS, storage);
    if (saved.status !== "saved") throw new Error("Expected a saved sequence.");
    const [entry] = loadUserSequences(storage);

    expect(Object.hasOwn(entry, "events")).toBe(false);
    expect(entry).toMatchObject({
      name: "Compact",
      durationMs: 500,
      noteCount: 1,
      eventCount: 2,
    });
    expect(decodeUserSequence(entry)).toEqual({
      events: SIMPLE_EVENTS,
      durationMs: 500,
      noteCount: 1,
    });
  });

  it("rejects lazy decoding when compact data and trusted metadata disagree", () => {
    const storage = new MemoryStorage();
    const saved = saveUserSequence("Trusted", SIMPLE_EVENTS, storage);
    if (saved.status !== "saved") throw new Error("Expected a saved sequence.");
    const sequence = saved.sequence;

    expect(decodeUserSequence({ ...sequence, durationMs: 501 })).toBeNull();
    expect(decodeUserSequence({ ...sequence, noteCount: 2 })).toBeNull();
    expect(decodeUserSequence({ ...sequence, eventCount: 3 })).toBeNull();
    expect(decodeUserSequence({ ...sequence, data: "invalid!" })).toBeNull();
  });

  it("repairs metadata without retaining events and preserves old encoded strings on append", () => {
    const originalData = encodeNoteSequence(SIMPLE_EVENTS) as string;
    const storage = new MemoryStorage(JSON.stringify({
      version: 1,
      sequences: [{
        name: "Existing",
        data: originalData,
        durationMs: 999,
        noteCount: 99,
        eventCount: 999,
      }],
    }));

    expect(readUserSequences(storage)).toEqual({
      status: "recovered",
      sequences: [{
        name: "Existing",
        data: originalData,
        durationMs: 500,
        noteCount: 1,
        eventCount: 2,
      }],
    });
    expect(storage.writes).toBe(0);

    expect(saveUserSequence("New", SIMPLE_EVENTS, storage).status).toBe("saved");
    const persisted = JSON.parse(storage.raw() as string) as {
      sequences: Array<Record<string, unknown>>;
    };
    expect(persisted.sequences[0]).toEqual({
      name: "Existing",
      data: originalData,
      durationMs: 500,
      noteCount: 1,
      eventCount: 2,
    });
    expect(persisted.sequences[0]).not.toHaveProperty("events");
  });

  it("rejects invalid or empty note data without writing", () => {
    const storage = new MemoryStorage();
    expect(saveUserSequence("Empty", [], storage)).toEqual({
      status: "invalid-sequence",
      sequences: [],
    });
    expect(saveUserSequence("Stuck", [{ deltaMs: 0, note: 60, on: true }], storage)).toEqual({
      status: "invalid-sequence",
      sequences: [],
    });
    expect(storage.writes).toBe(0);
  });

  it("recovers valid records, drops corrupt records, and keeps the first duplicate", () => {
    const validData = encodeNoteSequence(SIMPLE_EVENTS);
    const storage = new MemoryStorage(JSON.stringify({
      version: 1,
      sequences: [
        { name: "  Lead In  ", data: validData },
        { name: "lead in", data: validData },
        { name: "   ", data: validData },
        { name: "Broken data", data: "!not-base64!" },
        { name: "Stuck note", data: encodeRawBytes([0, 0xbc]) },
        { name: "Missing data" },
        null,
      ],
    }));
    const original = storage.raw();

    const result = readUserSequences(storage);

    expect(result).toEqual({
      status: "recovered",
      sequences: [{
        name: "Lead In",
        data: validData,
        durationMs: 500,
        noteCount: 1,
        eventCount: 2,
      }],
    });
    expect(storage.writes).toBe(0);
    expect(storage.raw()).toBe(original);
  });

  it("returns an empty recovered collection for malformed serialized data", () => {
    const storage = new MemoryStorage("{ not json");

    expect(readUserSequences(storage)).toEqual({ status: "recovered", sequences: [] });
    expect(loadUserSequences(storage)).toEqual([]);
    expect(storage.writes).toBe(0);
  });

  it("can save a clean collection after recovering old or malformed data", () => {
    const storage = new MemoryStorage(JSON.stringify({ sequences: "invalid" }));

    expect(saveUserSequence("Recovery", SIMPLE_EVENTS, storage).status).toBe("saved");
    expect(readUserSequences(storage)).toMatchObject({
      status: "ok",
      sequences: [{ name: "Recovery" }],
    });
  });

  it("protects an unsupported future schema from reads and overwrites", () => {
    const storage = new MemoryStorage(JSON.stringify({ version: 2, sequences: [] }));
    const before = storage.raw();

    expect(readUserSequences(storage)).toEqual({
      status: "unsupported-version",
      sequences: [],
    });
    expect(saveUserSequence("Do not overwrite", SIMPLE_EVENTS, storage)).toEqual({
      status: "unsupported-version",
      sequences: [],
    });
    expect(storage.writes).toBe(0);
    expect(storage.raw()).toBe(before);
  });

  it("finds and checks names with the library's canonical rules", () => {
    const storage = new MemoryStorage();
    saveUserSequence("Slow  Line", SIMPLE_EVENTS, storage);
    saveUserSequence("Café", SIMPLE_EVENTS, storage);
    const sequences = loadUserSequences(storage);

    expect(findUserSequence(" slow  line ", storage)?.durationMs).toBe(500);
    expect(findUserSequence("Slow Line", storage)).toBeNull();
    expect(findUserSequence("   ", storage)).toBeNull();
    expect(hasUserSequenceNamed(sequences, " CAFE\u0301 ")).toBe(true);
    expect(hasUserSequenceNamed(sequences, "missing")).toBe(false);
  });

  it("distinguishes read and write storage failures", () => {
    const readFailure: UserSequenceStorage = {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => undefined,
    };
    const writeFailure: UserSequenceStorage = {
      getItem: () => null,
      setItem: () => { throw new Error("quota"); },
    };

    expect(readUserSequences(readFailure)).toEqual({ status: "storage-error", sequences: [] });
    expect(saveUserSequence("Take", SIMPLE_EVENTS, readFailure)).toEqual({
      status: "storage-error",
      sequences: [],
    });
    expect(saveUserSequence("Take", SIMPLE_EVENTS, writeFailure)).toEqual({
      status: "storage-error",
      sequences: [],
    });
  });

  it("allows only one simultaneous same-name save into the write transaction", async () => {
    const storage = new MemoryStorage();
    const locks = new IfAvailableLockManager();

    const [first, second] = await Promise.all([
      saveUserSequenceSafely("Concurrent", SIMPLE_EVENTS, storage, locks),
      saveUserSequenceSafely(" concurrent ", SIMPLE_EVENTS, storage, locks),
    ]);

    expect(first.status).toBe("saved");
    expect(second.status).toBe("busy");
    expect(storage.writes).toBe(1);
  });

  it("asks a simultaneous distinct-name save to retry instead of losing a take", async () => {
    const storage = new MemoryStorage();
    const locks = new IfAvailableLockManager();

    const results = await Promise.all([
      saveUserSequenceSafely("One", SIMPLE_EVENTS, storage, locks),
      saveUserSequenceSafely("Two", SIMPLE_EVENTS, storage, locks),
    ]);

    expect(results.map((result) => result.status)).toEqual(["saved", "busy"]);
    expect((await saveUserSequenceSafely("Two", SIMPLE_EVENTS, storage, locks)).status)
      .toBe("saved");
    expect(loadUserSequences(storage).map((sequence) => sequence.name)).toEqual(["One", "Two"]);
  });

  it("returns busy without writing when another tab owns the lock", async () => {
    const storage = new MemoryStorage();
    const locks: UserSequenceLockManager = {
      request: async (_name, _options, callback) => callback(null),
    };

    await expect(saveUserSequenceSafely("Wait", SIMPLE_EVENTS, storage, locks)).resolves.toEqual({
      status: "busy",
      sequences: [],
    });
    expect(storage.writes).toBe(0);
  });

  it("bounds repeated saves behind one never-settling host lock request", async () => {
    const storage = new MemoryStorage();
    const neverSettles = new Promise<SafeSaveUserSequenceResult>(() => undefined);
    const request = vi.fn(() => neverSettles);
    const locks: UserSequenceLockManager = { request } as UserSequenceLockManager;

    void saveUserSequenceSafely("First", SIMPLE_EVENTS, storage, locks);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await expect(saveUserSequenceSafely(`Retry ${attempt}`, SIMPLE_EVENTS, storage, locks))
        .resolves.toEqual({ status: "busy", sequences: [] });
    }

    expect(request).toHaveBeenCalledTimes(1);
    expect(storage.writes).toBe(0);
  });

  it("allows a fresh request after the raw lock promise settles", async () => {
    const storage = new MemoryStorage();
    let resolveFirst!: (result: SafeSaveUserSequenceResult) => void;
    const first = new Promise<SafeSaveUserSequenceResult>((resolve) => {
      resolveFirst = resolve;
    });
    const request = vi.fn()
      .mockReturnValueOnce(first)
      .mockImplementationOnce((_name, _options, callback) => Promise.resolve(callback({})));
    const locks: UserSequenceLockManager = { request } as UserSequenceLockManager;

    const pending = saveUserSequenceSafely("First", SIMPLE_EVENTS, storage, locks);
    await expect(saveUserSequenceSafely("Blocked", SIMPLE_EVENTS, storage, locks))
      .resolves.toMatchObject({ status: "busy" });
    resolveFirst({ status: "busy", sequences: [] });
    await expect(pending).resolves.toMatchObject({ status: "busy" });

    await expect(saveUserSequenceSafely("Retry", SIMPLE_EVENTS, storage, locks))
      .resolves.toMatchObject({ status: "saved", sequence: { name: "Retry" } });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("falls back to single-tab saving when a lock manager throws or rejects", async () => {
    const thrown: UserSequenceLockManager = {
      request: () => { throw new Error("unavailable"); },
    };
    const rejected: UserSequenceLockManager = {
      request: () => Promise.reject(new Error("unavailable")),
    };

    await expect(saveUserSequenceSafely(
      "Thrown",
      SIMPLE_EVENTS,
      new MemoryStorage(),
      thrown,
    )).resolves.toMatchObject({ status: "saved" });
    await expect(saveUserSequenceSafely(
      "Rejected",
      SIMPLE_EVENTS,
      new MemoryStorage(),
      rejected,
    )).resolves.toMatchObject({ status: "saved" });
  });
});
