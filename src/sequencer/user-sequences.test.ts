import { describe, expect, it, vi } from "vitest";
import {
  USER_SEQUENCE_NAME_MAX_LENGTH,
  USER_SEQUENCES_STORAGE_KEY,
  deleteUserSequence,
  deleteUserSequenceSafely,
  decodeNoteSequence,
  decodeUserSequence,
  encodeNoteSequence,
  findUserSequence,
  hasUserSequenceNamed,
  loadUserSequences,
  normalizeCapturedNoteSequence,
  readUserSequences,
  replaceUserSequence,
  replaceUserSequenceSafely,
  saveUserSequence,
  saveUserSequenceSafely,
  userSequenceNameKey,
  type NoteSequenceEvent,
  type SafeDeleteUserSequenceResult,
  type SafeReplaceUserSequenceResult,
  type SafeSaveUserSequenceResult,
  type UserNoteSequence,
  type UserSequenceLockManager,
  type UserSequenceStorage,
} from "./user-sequences";

const SIMPLE_EVENTS: readonly NoteSequenceEvent[] = [
  { deltaMs: 0, note: 60, on: true },
  { deltaMs: 500, note: 60, on: false },
];

const sequenceSnapshot = (name: string): UserNoteSequence => ({
  name,
  data: encodeNoteSequence(SIMPLE_EVENTS) as string,
  durationMs: 500,
  noteCount: 1,
  eventCount: 2,
});

const storedSequence = (storage: UserSequenceStorage, name: string): UserNoteSequence => {
  const sequence = findUserSequence(name, storage);
  if (!sequence) throw new Error(`Expected saved sequence ${name}.`);
  return sequence;
};

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

  it("accepts exactly 33 trimmed characters and rejects a longer name without writing", () => {
    const storage = new MemoryStorage();
    const boundaryName = "S".repeat(USER_SEQUENCE_NAME_MAX_LENGTH);

    expect(saveUserSequence(`  ${boundaryName}  `, SIMPLE_EVENTS, storage))
      .toMatchObject({ status: "saved", sequence: { name: boundaryName } });
    const beforeRejectedSave = storage.raw();

    expect(saveUserSequence(`${boundaryName}X`, SIMPLE_EVENTS, storage)).toMatchObject({
      status: "name-too-long",
      maxLength: 33,
      sequences: [{ name: boundaryName }],
    });
    expect(storage.writes).toBe(1);
    expect(storage.raw()).toBe(beforeRejectedSave);
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
    expect(duplicate.existingSequence).toEqual(duplicate.sequences[0]);
    expect(duplicate.existingSequence).not.toBe(duplicate.sequences[0]);
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

  it("migrates every distinct legacy long name without surrendering later valid identities", () => {
    const validData = encodeNoteSequence(SIMPLE_EVENTS);
    const fullWidthName = "Z".repeat(USER_SEQUENCE_NAME_MAX_LENGTH);
    const suffixTwoName = `${"Z".repeat(USER_SEQUENCE_NAME_MAX_LENGTH - 4)} (2)`;
    const longFirst = "Z".repeat(USER_SEQUENCE_NAME_MAX_LENGTH + 7);
    const longSecond = `${"Z".repeat(USER_SEQUENCE_NAME_MAX_LENGTH + 6)}Y`;
    const storage = new MemoryStorage(JSON.stringify({
      version: 1,
      sequences: [
        { name: longFirst, data: validData },
        { name: longSecond, data: validData },
        { name: longFirst.toLowerCase(), data: validData },
        // Exact, already-valid names keep priority even though they are later.
        { name: fullWidthName, data: validData },
        { name: suffixTwoName, data: validData },
      ],
    }));
    const originalValue = storage.raw();

    const firstRead = readUserSequences(storage);
    const secondRead = readUserSequences(storage);

    expect(firstRead).toEqual(secondRead);
    expect(firstRead.status).toBe("recovered");
    expect(firstRead.sequences.map((sequence) => sequence.name)).toEqual([
      `${"Z".repeat(USER_SEQUENCE_NAME_MAX_LENGTH - 4)} (3)`,
      `${"Z".repeat(USER_SEQUENCE_NAME_MAX_LENGTH - 4)} (4)`,
      fullWidthName,
      suffixTwoName,
    ]);
    expect(firstRead.sequences).toHaveLength(4);
    expect(new Set(firstRead.sequences.map((sequence) => userSequenceNameKey(sequence.name))).size)
      .toBe(4);
    for (const sequence of firstRead.sequences) {
      expect(sequence.name.length).toBeLessThanOrEqual(USER_SEQUENCE_NAME_MAX_LENGTH);
      expect(decodeUserSequence(sequence)?.events).toEqual(SIMPLE_EVENTS);
    }
    expect(storage.writes).toBe(0);
    expect(storage.raw()).toBe(originalValue);

    expect(saveUserSequence("Fresh", SIMPLE_EVENTS, storage).status).toBe("saved");
    expect(readUserSequences(storage)).toMatchObject({
      status: "ok",
      sequences: [...firstRead.sequences, { name: "Fresh" }],
    });
  });

  it("keeps first-record-wins Unicode duplicate recovery while shortening its display name", () => {
    const data = encodeNoteSequence(SIMPLE_EVENTS);
    const composed = `${"Q".repeat(29)}Café extension`;
    const decomposedEquivalent = `${"q".repeat(29)}CAFE\u0301 EXTENSION`;
    const storage = new MemoryStorage(JSON.stringify({
      version: 1,
      sequences: [
        { name: composed, data },
        { name: decomposedEquivalent, data },
      ],
    }));

    const result = readUserSequences(storage);

    expect(result.status).toBe("recovered");
    expect(result.sequences).toHaveLength(1);
    expect(result.sequences[0].name).toBe(`${"Q".repeat(29)}Café`);
    expect(result.sequences[0].name.length).toBe(USER_SEQUENCE_NAME_MAX_LENGTH);
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
    expect(deleteUserSequence(sequenceSnapshot("Do not delete"), storage)).toEqual({
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

  it("atomically replaces a canonically matched sequence in place and preserves its display name", () => {
    const replacementEvents: readonly NoteSequenceEvent[] = [
      { deltaMs: 0, note: 72, on: true },
      { deltaMs: 900, note: 72, on: false },
    ];
    const storage = new MemoryStorage();
    saveUserSequence("One", SIMPLE_EVENTS, storage);
    saveUserSequence("Caf\u00e9", SIMPLE_EVENTS, storage);
    saveUserSequence("Three", SIMPLE_EVENTS, storage);
    const duplicate = saveUserSequence(" CAFE\u0301 ", replacementEvents, storage);
    if (duplicate.status !== "duplicate-name") throw new Error("Expected a duplicate name.");

    const result = replaceUserSequence(
      { ...duplicate.existingSequence, name: "  CAFE\u0301  " },
      replacementEvents,
      storage,
    );

    expect(result.status).toBe("replaced");
    if (result.status !== "replaced") throw new Error("Expected the sequence to be replaced.");
    expect(result.sequence).toMatchObject({
      name: "Caf\u00e9",
      durationMs: 900,
      noteCount: 1,
      eventCount: 2,
    });
    expect(result.sequences.map((sequence) => sequence.name)).toEqual(["One", "Caf\u00e9", "Three"]);
    expect(decodeUserSequence(result.sequence)?.events).toEqual(replacementEvents);
    expect(loadUserSequences(storage).map((sequence) => sequence.name))
      .toEqual(["One", "Caf\u00e9", "Three"]);
    expect(storage.writes).toBe(4);
  });

  it("refuses empty, missing, invalid, and stale replacement attempts without overwriting", () => {
    const replacementEvents: readonly NoteSequenceEvent[] = [
      { deltaMs: 0, note: 67, on: true },
      { deltaMs: 750, note: 67, on: false },
    ];
    const storage = new MemoryStorage();
    saveUserSequence("Target", SIMPLE_EVENTS, storage);
    const original = storedSequence(storage, "Target");
    const beforeRejectedTargets = storage.raw();

    expect(replaceUserSequence({ ...original, name: " \n\t " }, replacementEvents, storage))
      .toMatchObject({ status: "empty-name" });
    expect(replaceUserSequence({ ...original, name: "Missing" }, replacementEvents, storage))
      .toMatchObject({ status: "not-found" });
    expect(replaceUserSequence(original, [{ deltaMs: 0, note: 60, on: true }], storage))
      .toMatchObject({ status: "invalid-sequence" });
    expect(storage.raw()).toBe(beforeRejectedTargets);

    const changedSnapshots: readonly UserNoteSequence[] = [
      { ...original, data: `${original.data}A` },
      { ...original, durationMs: original.durationMs + 1 },
      { ...original, noteCount: original.noteCount + 1 },
      { ...original, eventCount: original.eventCount + 1 },
    ];
    for (const changed of changedSnapshots) {
      expect(replaceUserSequence(changed, replacementEvents, storage)).toMatchObject({
        status: "stale-target",
        currentSequence: original,
        sequences: [original],
      });
    }
    expect(storage.writes).toBe(1);
    expect(findUserSequence("Target", storage)).toEqual(original);
  });

  it("rejects an old confirmation after replacement and never recreates a deleted target", () => {
    const firstReplacement: readonly NoteSequenceEvent[] = [
      { deltaMs: 0, note: 64, on: true },
      { deltaMs: 600, note: 64, on: false },
    ];
    const secondReplacement: readonly NoteSequenceEvent[] = [
      { deltaMs: 0, note: 76, on: true },
      { deltaMs: 1_200, note: 76, on: false },
    ];
    const storage = new MemoryStorage();
    saveUserSequence("Target", SIMPLE_EVENTS, storage);
    const original = storedSequence(storage, "Target");

    expect(replaceUserSequence(original, firstReplacement, storage).status).toBe("replaced");
    const writesBeforeStaleAttempt = storage.writes;
    expect(replaceUserSequence(original, secondReplacement, storage)).toMatchObject({
      status: "stale-target",
      currentSequence: { name: "Target", durationMs: 600 },
      sequences: [{ name: "Target", durationMs: 600 }],
    });
    expect(storage.writes).toBe(writesBeforeStaleAttempt);
    expect(decodeUserSequence(storedSequence(storage, "Target"))?.events).toEqual(firstReplacement);

    const current = storedSequence(storage, "Target");
    expect(deleteUserSequence(current, storage).status).toBe("deleted");
    const writesBeforeDeletedReplacement = storage.writes;
    expect(replaceUserSequence(current, secondReplacement, storage)).toEqual({
      status: "not-found",
      sequences: [],
    });
    expect(storage.writes).toBe(writesBeforeDeletedReplacement);
    expect(loadUserSequences(storage)).toEqual([]);
  });

  it("protects replacement transactions from storage failures and future schemas", () => {
    const readFailure: UserSequenceStorage = {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => undefined,
    };
    expect(replaceUserSequence(sequenceSnapshot("Target"), SIMPLE_EVENTS, readFailure)).toEqual({
      status: "storage-error",
      sequences: [],
    });

    const source = new MemoryStorage();
    saveUserSequence("Target", SIMPLE_EVENTS, source);
    const writeFailure: UserSequenceStorage = {
      getItem: (key) => source.getItem(key),
      setItem: () => { throw new Error("quota"); },
    };
    expect(replaceUserSequence(
      storedSequence(source, "Target"),
      [
        { deltaMs: 0, note: 72, on: true },
        { deltaMs: 900, note: 72, on: false },
      ],
      writeFailure,
    )).toMatchObject({ status: "storage-error", sequences: [{ name: "Target" }] });
    expect(decodeUserSequence(storedSequence(source, "Target"))?.events).toEqual(SIMPLE_EVENTS);

    const future = new MemoryStorage(JSON.stringify({ version: 2, sequences: [] }));
    const futureRaw = future.raw();
    expect(replaceUserSequence(sequenceSnapshot("Target"), SIMPLE_EVENTS, future)).toEqual({
      status: "unsupported-version",
      sequences: [],
    });
    expect(future.writes).toBe(0);
    expect(future.raw()).toBe(futureRaw);
  });

  it("does not accumulate duplicate entries through repeated confirmed replacements", () => {
    const storage = new MemoryStorage();
    const saved = saveUserSequence("Stable identity", SIMPLE_EVENTS, storage);
    if (saved.status !== "saved") throw new Error("Expected the initial sequence to save.");
    let expected = saved.sequence;

    for (let iteration = 0; iteration < 1_000; iteration += 1) {
      const replacementEvents: readonly NoteSequenceEvent[] = [
        { deltaMs: 0, note: iteration % 128, on: true },
        { deltaMs: iteration, note: iteration % 128, on: false },
      ];
      const result = replaceUserSequence(expected, replacementEvents, storage);
      if (result.status !== "replaced") throw new Error(`Replace churn failed at ${iteration}.`);
      expected = result.sequence;
    }

    expect(loadUserSequences(storage)).toHaveLength(1);
    expect(findUserSequence("stable identity", storage)).toEqual(expected);
    expect(storage.writes).toBe(1_001);
  });

  it("deletes exactly one canonically named sequence and preserves library order", () => {
    const storage = new MemoryStorage();
    saveUserSequence("First", SIMPLE_EVENTS, storage);
    saveUserSequence("Caf\u00e9", SIMPLE_EVENTS, storage);
    saveUserSequence("Last", SIMPLE_EVENTS, storage);

    const expected = { ...storedSequence(storage, "Caf\u00e9"), name: "  CAFE\u0301  " };
    const result = deleteUserSequence(expected, storage);

    expect(result).toMatchObject({
      status: "deleted",
      deletedName: "Caf\u00e9",
    });
    expect(result.sequences.map((sequence) => sequence.name)).toEqual(["First", "Last"]);
    expect(loadUserSequences(storage).map((sequence) => sequence.name)).toEqual(["First", "Last"]);
    expect(storage.writes).toBe(4);
  });

  it("rejects every stale snapshot field without writing", () => {
    const storage = new MemoryStorage();
    saveUserSequence("Guarded", SIMPLE_EVENTS, storage);
    const expected = storedSequence(storage, "Guarded");
    const changedSnapshots: readonly UserNoteSequence[] = [
      { ...expected, data: `${expected.data}A` },
      { ...expected, durationMs: expected.durationMs + 1 },
      { ...expected, noteCount: expected.noteCount + 1 },
      { ...expected, eventCount: expected.eventCount + 1 },
    ];

    for (const changed of changedSnapshots) {
      expect(deleteUserSequence(changed, storage)).toMatchObject({
        status: "stale-target",
        sequences: [{ name: "Guarded" }],
      });
    }
    expect(storage.writes).toBe(1);
    expect(findUserSequence("Guarded", storage)).toEqual(expected);
  });

  it("detects a same-name delete and replacement inside the write lock", async () => {
    const replacementEvents: readonly NoteSequenceEvent[] = [
      { deltaMs: 0, note: 72, on: true },
      { deltaMs: 900, note: 72, on: false },
    ];
    const storage = new MemoryStorage();
    saveUserSequence("Replace me", SIMPLE_EVENTS, storage);
    const expected = storedSequence(storage, "Replace me");
    const locks = new IfAvailableLockManager();

    const pending = deleteUserSequenceSafely(expected, storage, locks);
    expect(deleteUserSequence(expected, storage).status).toBe("deleted");
    expect(saveUserSequence("replace me", replacementEvents, storage).status).toBe("saved");

    await expect(pending).resolves.toMatchObject({
      status: "stale-target",
      sequences: [{ name: "replace me", durationMs: 900 }],
    });
    expect(storage.writes).toBe(3);
    expect(decodeUserSequence(storedSequence(storage, "Replace me"))?.events)
      .toEqual(replacementEvents);
  });

  it("snapshots the confirmed target before waiting for the host lock", async () => {
    const storage = new MemoryStorage();
    saveUserSequence("Immutable authority", SIMPLE_EVENTS, storage);
    const mutableExpected = { ...storedSequence(storage, "Immutable authority") };
    const locks = new IfAvailableLockManager();

    const pending = deleteUserSequenceSafely(mutableExpected, storage, locks);
    mutableExpected.data = "changed-after-confirmation";
    mutableExpected.durationMs = 999;
    mutableExpected.noteCount = 999;
    mutableExpected.eventCount = 999;

    await expect(pending).resolves.toMatchObject({
      status: "deleted",
      deletedName: "Immutable authority",
      sequences: [],
    });
  });

  it("revokes deletion authority before a delayed lock callback can run", async () => {
    const storage = new MemoryStorage();
    saveUserSequence("Cancelled authority", SIMPLE_EVENTS, storage);
    const expected = storedSequence(storage, "Cancelled authority");
    const locks = new IfAvailableLockManager();
    const controller = new AbortController();

    const pending = deleteUserSequenceSafely(expected, storage, locks, controller.signal);
    controller.abort();

    await expect(pending).resolves.toMatchObject({
      status: "busy",
      sequences: [{ name: "Cancelled authority" }],
    });
    expect(findUserSequence("Cancelled authority", storage)).toEqual(expected);
    expect(storage.writes).toBe(1);
  });

  it("never falls back to deleting after an aborted lock request rejects", async () => {
    const storage = new MemoryStorage();
    saveUserSequence("Cancelled rejection", SIMPLE_EVENTS, storage);
    const expected = storedSequence(storage, "Cancelled rejection");
    let rejectRequest!: (error: Error) => void;
    const request = new Promise<SafeDeleteUserSequenceResult>((_resolve, reject) => {
      rejectRequest = reject;
    });
    const locks: UserSequenceLockManager = {
      request: vi.fn(() => request),
    } as UserSequenceLockManager;
    const controller = new AbortController();

    const pending = deleteUserSequenceSafely(expected, storage, locks, controller.signal);
    controller.abort();
    rejectRequest(new Error("late host failure"));

    await expect(pending).resolves.toMatchObject({
      status: "busy",
      sequences: [{ name: "Cancelled rejection" }],
    });
    expect(findUserSequence("Cancelled rejection", storage)).toEqual(expected);
    expect(storage.writes).toBe(1);
  });

  it("quarantines an unresponsive aborted lock without bypassing it, then rehabilitates it", async () => {
    vi.useFakeTimers();
    try {
      const storage = new MemoryStorage();
      saveUserSequence("Keep after timeout", SIMPLE_EVENTS, storage);
      const expected = storedSequence(storage, "Keep after timeout");
      let releaseRequest!: () => void;
      let requestCount = 0;
      const locks: UserSequenceLockManager = {
        request<T>(
          _name: string,
          _options: { readonly mode: "exclusive"; readonly ifAvailable: true },
          callback: (lock: unknown | null) => T | PromiseLike<T>,
        ): Promise<T> {
          requestCount += 1;
          if (requestCount > 1) return Promise.resolve(callback({}));
          return new Promise<T>((resolve) => {
            releaseRequest = () => { void Promise.resolve(callback({})).then(resolve); };
          });
        },
      };
      const controller = new AbortController();

      const abandoned = deleteUserSequenceSafely(expected, storage, locks, controller.signal);
      controller.abort(new DOMException("timed out", "TimeoutError"));
      await vi.advanceTimersByTimeAsync(10_001);

      await expect(saveUserSequenceSafely("Unsafe bypass", SIMPLE_EVENTS, storage, locks))
        .resolves.toMatchObject({ status: "busy", sequences: [{ name: "Keep after timeout" }] });
      expect(requestCount).toBe(1);
      expect(storage.writes).toBe(1);
      releaseRequest();
      await expect(abandoned).resolves.toMatchObject({ status: "busy" });
      expect(vi.getTimerCount()).toBe(0);

      await expect(saveUserSequenceSafely("Recovered write", SIMPLE_EVENTS, storage, locks))
        .resolves.toMatchObject({ status: "saved", sequence: { name: "Recovered write" } });
      expect(requestCount).toBe(2);
      expect(loadUserSequences(storage).map((sequence) => sequence.name))
        .toEqual(["Keep after timeout", "Recovered write"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a slow lock serialized and usable when it settles before quarantine", async () => {
    vi.useFakeTimers();
    try {
      const storage = new MemoryStorage();
      saveUserSequence("Slow target", SIMPLE_EVENTS, storage);
      const expected = storedSequence(storage, "Slow target");
      let releaseRequest!: () => void;
      let requestCount = 0;
      const locks: UserSequenceLockManager = {
        request<T>(
          _name: string,
          _options: { readonly mode: "exclusive"; readonly ifAvailable: true },
          callback: (lock: unknown | null) => T | PromiseLike<T>,
        ): Promise<T> {
          requestCount += 1;
          if (requestCount > 1) return Promise.resolve(callback({}));
          return new Promise<T>((resolve) => {
            releaseRequest = () => { void Promise.resolve(callback({})).then(resolve); };
          });
        },
      };
      const controller = new AbortController();

      const abandoned = deleteUserSequenceSafely(expected, storage, locks, controller.signal);
      controller.abort();
      await vi.advanceTimersByTimeAsync(5_000);
      releaseRequest();
      await expect(abandoned).resolves.toMatchObject({ status: "busy" });
      expect(vi.getTimerCount()).toBe(0);

      await expect(saveUserSequenceSafely("Healthy next write", SIMPLE_EVENTS, storage, locks))
        .resolves.toMatchObject({ status: "saved", sequence: { name: "Healthy next write" } });
      expect(requestCount).toBe(2);
      expect(loadUserSequences(storage).map((sequence) => sequence.name))
        .toEqual(["Slow target", "Healthy next write"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a target deleted before lock acquisition without writing again", async () => {
    const storage = new MemoryStorage();
    saveUserSequence("Gone", SIMPLE_EVENTS, storage);
    const expected = storedSequence(storage, "Gone");
    const locks = new IfAvailableLockManager();

    const pending = deleteUserSequenceSafely(expected, storage, locks);
    expect(deleteUserSequence(expected, storage).status).toBe("deleted");

    await expect(pending).resolves.toEqual({ status: "not-found", sequences: [] });
    expect(storage.writes).toBe(2);
  });

  it("persists an empty versioned collection after deleting the final sequence", () => {
    const storage = new MemoryStorage();
    saveUserSequence("Only take", SIMPLE_EVENTS, storage);

    const expected = { ...storedSequence(storage, "Only take"), name: "only take" };
    expect(deleteUserSequence(expected, storage)).toMatchObject({
      status: "deleted",
      deletedName: "Only take",
      sequences: [],
    });
    expect(JSON.parse(storage.raw() as string)).toEqual({ version: 1, sequences: [] });
  });

  it("does not accumulate ghost entries through repeated save/delete churn", () => {
    const storage = new MemoryStorage();

    for (let iteration = 0; iteration < 1_000; iteration += 1) {
      const saved = saveUserSequence("Reusable take", SIMPLE_EVENTS, storage);
      if (saved.status !== "saved") throw new Error(`Save churn failed at ${iteration}.`);
      const deleted = deleteUserSequence(saved.sequence, storage);
      if (deleted.status !== "deleted") throw new Error(`Delete churn failed at ${iteration}.`);
    }

    expect(readUserSequences(storage)).toEqual({ status: "ok", sequences: [] });
    expect(JSON.parse(storage.raw() as string)).toEqual({ version: 1, sequences: [] });
    expect(storage.writes).toBe(2_000);
  });

  it("does not write for an empty or missing deletion target", () => {
    const storage = new MemoryStorage();
    saveUserSequence("Keep", SIMPLE_EVENTS, storage);
    const before = storage.raw();

    const keep = storedSequence(storage, "Keep");
    expect(deleteUserSequence({ ...keep, name: " \n\t " }, storage)).toMatchObject({
      status: "empty-name",
      sequences: [{ name: "Keep" }],
    });
    expect(deleteUserSequence({ ...keep, name: "Missing" }, storage)).toMatchObject({
      status: "not-found",
      sequences: [{ name: "Keep" }],
    });
    expect(storage.writes).toBe(1);
    expect(storage.raw()).toBe(before);
  });

  it("repairs recovered survivors as part of a successful deletion write", () => {
    const validData = encodeNoteSequence(SIMPLE_EVENTS);
    const storage = new MemoryStorage(JSON.stringify({
      version: 1,
      sequences: [
        { name: "  Remove me  ", data: validData, durationMs: 999 },
        { name: "  Survivor  ", data: validData, noteCount: 999 },
        { name: "Broken", data: "not-valid!" },
      ],
    }));

    const expected = storedSequence(storage, "Remove me");
    expect(deleteUserSequence(expected, storage)).toMatchObject({
      status: "deleted",
      deletedName: "Remove me",
      sequences: [{
        name: "Survivor",
        durationMs: 500,
        noteCount: 1,
        eventCount: 2,
      }],
    });
    expect(readUserSequences(storage)).toMatchObject({
      status: "ok",
      sequences: [{ name: "Survivor" }],
    });
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
    expect(deleteUserSequence(sequenceSnapshot("Take"), readFailure)).toEqual({
      status: "storage-error",
      sequences: [],
    });

    const deleteWriteFailure = new MemoryStorage();
    saveUserSequence("Take", SIMPLE_EVENTS, deleteWriteFailure);
    const failingDeleteStorage: UserSequenceStorage = {
      getItem: (key) => deleteWriteFailure.getItem(key),
      setItem: () => { throw new Error("quota"); },
    };
    expect(deleteUserSequence(storedSequence(deleteWriteFailure, "Take"), failingDeleteStorage)).toMatchObject({
      status: "storage-error",
      sequences: [{ name: "Take" }],
    });
    expect(findUserSequence("Take", deleteWriteFailure)).not.toBeNull();
  });

  it("serializes replacement with other sequence-library writes", async () => {
    const replacementEvents: readonly NoteSequenceEvent[] = [
      { deltaMs: 0, note: 72, on: true },
      { deltaMs: 900, note: 72, on: false },
    ];
    const storage = new MemoryStorage();
    saveUserSequence("Target", SIMPLE_EVENTS, storage);
    const target = storedSequence(storage, "Target");
    const locks = new IfAvailableLockManager();

    const replacing = replaceUserSequenceSafely(target, replacementEvents, storage, locks);
    const blockedSave = saveUserSequenceSafely("Concurrent", SIMPLE_EVENTS, storage, locks);

    await expect(blockedSave).resolves.toMatchObject({
      status: "busy",
      sequences: [{ name: "Target", durationMs: 500 }],
    });
    await expect(replacing).resolves.toMatchObject({
      status: "replaced",
      sequence: { name: "Target", durationMs: 900 },
    });
    expect(loadUserSequences(storage).map((sequence) => sequence.name)).toEqual(["Target"]);
    expect(decodeUserSequence(storedSequence(storage, "Target"))?.events).toEqual(replacementEvents);
    expect(storage.writes).toBe(2);
  });

  it("returns a fresh busy snapshot without replacing when another tab owns the lock", async () => {
    const storage = new MemoryStorage();
    saveUserSequence("Target", SIMPLE_EVENTS, storage);
    const unavailableLock: UserSequenceLockManager = {
      request: async (_name, _options, callback) => callback(null),
    };

    const result = await replaceUserSequenceSafely(
      storedSequence(storage, "Target"),
      [
        { deltaMs: 0, note: 72, on: true },
        { deltaMs: 900, note: 72, on: false },
      ],
      storage,
      unavailableLock,
    );

    expect(result).toMatchObject({
      status: "busy",
      sequences: [{ name: "Target", durationMs: 500 }],
    });
    expect(decodeUserSequence(storedSequence(storage, "Target"))?.events).toEqual(SIMPLE_EVENTS);
    expect(storage.writes).toBe(1);
  });

  it("revokes replacement authority before a delayed lock callback can write", async () => {
    const storage = new MemoryStorage();
    saveUserSequence("Target", SIMPLE_EVENTS, storage);
    const expected = storedSequence(storage, "Target");
    let releaseLock!: () => void;
    const locks: UserSequenceLockManager = {
      request<T>(
        _name: string,
        _options: { readonly mode: "exclusive"; readonly ifAvailable: true },
        callback: (lock: unknown | null) => T | PromiseLike<T>,
      ): Promise<T> {
        return new Promise<T>((resolve) => {
          releaseLock = () => { void Promise.resolve(callback({})).then(resolve); };
        });
      },
    };
    const controller = new AbortController();

    const pending = replaceUserSequenceSafely(
      expected,
      [
        { deltaMs: 0, note: 72, on: true },
        { deltaMs: 900, note: 72, on: false },
      ],
      storage,
      locks,
      controller.signal,
    );
    controller.abort(new DOMException("Confirmation cancelled.", "AbortError"));
    releaseLock();

    await expect(pending).resolves.toMatchObject({
      status: "busy",
      sequences: [{ name: "Target", durationMs: 500 }],
    });
    expect(findUserSequence("Target", storage)).toEqual(expected);
    expect(storage.writes).toBe(1);
  });

  it("detects a changed target and snapshots proposed events before a delayed replacement lock", async () => {
    const concurrentEvents: readonly NoteSequenceEvent[] = [
      { deltaMs: 0, note: 64, on: true },
      { deltaMs: 600, note: 64, on: false },
    ];
    const storage = new MemoryStorage();
    saveUserSequence("Target", SIMPLE_EVENTS, storage);
    const expected = storedSequence(storage, "Target");
    let releaseLock!: () => void;
    const locks: UserSequenceLockManager = {
      request<T>(
        _name: string,
        _options: { readonly mode: "exclusive"; readonly ifAvailable: true },
        callback: (lock: unknown | null) => T | PromiseLike<T>,
      ): Promise<T> {
        return new Promise<T>((resolve) => {
          releaseLock = () => { void Promise.resolve(callback({})).then(resolve); };
        });
      },
    };

    const pending = replaceUserSequenceSafely(
      expected,
      [
        { deltaMs: 0, note: 76, on: true },
        { deltaMs: 1_200, note: 76, on: false },
      ],
      storage,
      locks,
    );
    expect(replaceUserSequence(expected, concurrentEvents, storage).status).toBe("replaced");
    const writesBeforeDelayedLock = storage.writes;
    releaseLock();

    await expect(pending).resolves.toMatchObject({
      status: "stale-target",
      currentSequence: { name: "Target", durationMs: 600 },
    });
    expect(storage.writes).toBe(writesBeforeDelayedLock);
    expect(decodeUserSequence(storedSequence(storage, "Target"))?.events).toEqual(concurrentEvents);
  });

  it("snapshots the confirmed target and proposed performance before a delayed replacement lock", async () => {
    const storage = new MemoryStorage();
    saveUserSequence("Target", SIMPLE_EVENTS, storage);
    saveUserSequence("Other", SIMPLE_EVENTS, storage);
    const target = storedSequence(storage, "Target");
    const mutableExpected = { ...target };
    const mutableEvents = [
      { deltaMs: 0, note: 72, on: true },
      { deltaMs: 900, note: 72, on: false },
    ];
    let releaseLock!: () => void;
    const locks: UserSequenceLockManager = {
      request<T>(
        _name: string,
        _options: { readonly mode: "exclusive"; readonly ifAvailable: true },
        callback: (lock: unknown | null) => T | PromiseLike<T>,
      ): Promise<T> {
        return new Promise<T>((resolve) => {
          releaseLock = () => { void Promise.resolve(callback({})).then(resolve); };
        });
      },
    };

    const replacing: Promise<SafeReplaceUserSequenceResult> = replaceUserSequenceSafely(
      mutableExpected,
      mutableEvents,
      storage,
      locks,
    );
    mutableExpected.name = "Other";
    mutableExpected.data = storedSequence(storage, "Other").data;
    mutableExpected.durationMs = 999;
    mutableEvents[0].note = 84;
    mutableEvents[1].note = 84;
    mutableEvents[1].deltaMs = 1_800;
    releaseLock();

    await expect(replacing).resolves.toMatchObject({
      status: "replaced",
      sequence: { name: "Target", durationMs: 900, noteCount: 1, eventCount: 2 },
      sequences: [
        { name: "Target", durationMs: 900 },
        { name: "Other", durationMs: 500 },
      ],
    });
    expect(decodeUserSequence(storedSequence(storage, "Target"))?.events).toEqual([
      { deltaMs: 0, note: 72, on: true },
      { deltaMs: 900, note: 72, on: false },
    ]);
    expect(decodeUserSequence(storedSequence(storage, "Other"))?.events).toEqual(SIMPLE_EVENTS);
    expect(storage.writes).toBe(3);
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

  it("snapshots proposed events before a delayed save lock is acquired", async () => {
    const storage = new MemoryStorage();
    const mutableEvents: NoteSequenceEvent[] = [
      { deltaMs: 0, note: 60, on: true },
      { deltaMs: 500, note: 60, on: false },
    ];
    let releaseLock!: () => void;
    const locks: UserSequenceLockManager = {
      request<T>(
        _name: string,
        _options: { readonly mode: "exclusive"; readonly ifAvailable: true },
        callback: (lock: unknown | null) => T | PromiseLike<T>,
      ): Promise<T> {
        return new Promise<T>((resolve) => {
          releaseLock = () => { void Promise.resolve(callback({})).then(resolve); };
        });
      },
    };

    const saving = saveUserSequenceSafely("Snapshot", mutableEvents, storage, locks);
    mutableEvents[1] = { deltaMs: 900, note: 60, on: false };
    releaseLock();

    await expect(saving).resolves.toMatchObject({
      status: "saved",
      sequence: { name: "Snapshot", durationMs: 500 },
    });
    expect(decodeUserSequence(storedSequence(storage, "Snapshot"))?.durationMs).toBe(500);
  });

  it("releases an aborted delayed save immediately and denies its late callback", async () => {
    const storage = new MemoryStorage();
    let releaseLock!: () => void;
    let hostSettled!: () => void;
    const hostSettlement = new Promise<void>((resolve) => { hostSettled = resolve; });
    const locks: UserSequenceLockManager = {
      request<T>(
        _name: string,
        _options: { readonly mode: "exclusive"; readonly ifAvailable: true },
        callback: (lock: unknown | null) => T | PromiseLike<T>,
      ): Promise<T> {
        return new Promise<T>((resolve) => {
          releaseLock = () => {
            void Promise.resolve(callback({})).then((result) => {
              resolve(result);
              hostSettled();
            });
          };
        });
      },
    };
    const controller = new AbortController();

    const saving = saveUserSequenceSafely(
      "Cancelled",
      SIMPLE_EVENTS,
      storage,
      locks,
      controller.signal,
    );
    controller.abort(new DOMException("Dialog closed.", "AbortError"));

    await expect(saving).resolves.toEqual({ status: "busy", sequences: [] });
    expect(storage.writes).toBe(0);
    releaseLock();
    await hostSettlement;
    expect(storage.writes).toBe(0);
    expect(findUserSequence("Cancelled", storage)).toBeNull();
  });

  it("exposes storage truth when a lock host stalls after running the write callback", async () => {
    const storage = new MemoryStorage();
    let releaseHost!: () => void;
    const locks: UserSequenceLockManager = {
      request<T>(
        _name: string,
        _options: { readonly mode: "exclusive"; readonly ifAvailable: true },
        callback: (lock: unknown | null) => T | PromiseLike<T>,
      ): Promise<T> {
        const callbackResult = callback({});
        return new Promise<T>((resolve) => {
          releaseHost = () => resolve(callbackResult);
        });
      },
    };
    const controller = new AbortController();

    const saving = saveUserSequenceSafely(
      "Uncertain",
      SIMPLE_EVENTS,
      storage,
      locks,
      controller.signal,
    );
    expect(findUserSequence("Uncertain", storage)).not.toBeNull();
    controller.abort(new DOMException("UI deadline expired.", "AbortError"));

    await expect(saving).resolves.toMatchObject({ status: "busy" });
    expect(findUserSequence("Uncertain", storage)).not.toBeNull();
    releaseHost();
    await Promise.resolve();
  });

  it("exposes a completed delete when its lock host stalls before settling", async () => {
    const storage = new MemoryStorage();
    saveUserSequence("Uncertain delete", SIMPLE_EVENTS, storage);
    const target = storedSequence(storage, "Uncertain delete");
    let releaseHost!: () => void;
    const locks: UserSequenceLockManager = {
      request<T>(
        _name: string,
        _options: { readonly mode: "exclusive"; readonly ifAvailable: true },
        callback: (lock: unknown | null) => T | PromiseLike<T>,
      ): Promise<T> {
        const callbackResult = callback({});
        return new Promise<T>((resolve) => {
          releaseHost = () => resolve(callbackResult);
        });
      },
    };
    const controller = new AbortController();

    const deleting = deleteUserSequenceSafely(target, storage, locks, controller.signal);
    expect(findUserSequence(target.name, storage)).toBeNull();
    controller.abort(new DOMException("UI deadline expired.", "AbortError"));

    await expect(deleting).resolves.toEqual({ status: "busy", sequences: [] });
    expect(findUserSequence(target.name, storage)).toBeNull();
    releaseHost();
    await Promise.resolve();
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

  it("serializes delete with save so neither operation can lose the other's update", async () => {
    const deleteFirstStorage = new MemoryStorage();
    saveUserSequence("Existing", SIMPLE_EVENTS, deleteFirstStorage);
    const deleteFirstLocks = new IfAvailableLockManager();
    const deleteFirstTarget = storedSequence(deleteFirstStorage, "Existing");

    const [deleted, blockedSave] = await Promise.all([
      deleteUserSequenceSafely(deleteFirstTarget, deleteFirstStorage, deleteFirstLocks),
      saveUserSequenceSafely("New", SIMPLE_EVENTS, deleteFirstStorage, deleteFirstLocks),
    ]);
    expect(deleted.status).toBe("deleted");
    expect(blockedSave.status).toBe("busy");
    expect((await saveUserSequenceSafely(
      "New",
      SIMPLE_EVENTS,
      deleteFirstStorage,
      deleteFirstLocks,
    )).status).toBe("saved");
    expect(loadUserSequences(deleteFirstStorage).map((sequence) => sequence.name)).toEqual(["New"]);

    const saveFirstStorage = new MemoryStorage();
    saveUserSequence("Existing", SIMPLE_EVENTS, saveFirstStorage);
    const saveFirstLocks = new IfAvailableLockManager();
    const saveFirstTarget = storedSequence(saveFirstStorage, "Existing");
    const [saved, blockedDelete] = await Promise.all([
      saveUserSequenceSafely("New", SIMPLE_EVENTS, saveFirstStorage, saveFirstLocks),
      deleteUserSequenceSafely(saveFirstTarget, saveFirstStorage, saveFirstLocks),
    ]);
    expect(saved.status).toBe("saved");
    expect(blockedDelete.status).toBe("busy");
    expect((await deleteUserSequenceSafely(
      saveFirstTarget,
      saveFirstStorage,
      saveFirstLocks,
    )).status).toBe("deleted");
    expect(loadUserSequences(saveFirstStorage).map((sequence) => sequence.name)).toEqual(["New"]);
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
    await expect(deleteUserSequenceSafely(sequenceSnapshot("Wait"), storage, locks)).resolves.toEqual({
      status: "busy",
      sequences: [],
    });
    expect(storage.writes).toBe(0);
  });

  it("bounds save and delete retries behind one never-settling write request", async () => {
    const storage = new MemoryStorage();
    saveUserSequence("Keep", SIMPLE_EVENTS, storage);
    const neverSettles = new Promise<SafeDeleteUserSequenceResult>(() => undefined);
    const request = vi.fn(() => neverSettles);
    const locks: UserSequenceLockManager = { request } as UserSequenceLockManager;
    const keep = storedSequence(storage, "Keep");

    void deleteUserSequenceSafely(keep, storage, locks);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await expect(deleteUserSequenceSafely(keep, storage, locks))
        .resolves.toMatchObject({ status: "busy", sequences: [{ name: "Keep" }] });
      await expect(saveUserSequenceSafely(`Retry ${attempt}`, SIMPLE_EVENTS, storage, locks))
        .resolves.toMatchObject({ status: "busy", sequences: [{ name: "Keep" }] });
    }

    expect(request).toHaveBeenCalledTimes(1);
    expect(storage.writes).toBe(1);
  });

  it("allows a fresh delete after its raw lock request settles", async () => {
    const storage = new MemoryStorage();
    saveUserSequence("Take", SIMPLE_EVENTS, storage);
    let resolveFirst!: (result: SafeDeleteUserSequenceResult) => void;
    const first = new Promise<SafeDeleteUserSequenceResult>((resolve) => {
      resolveFirst = resolve;
    });
    const request = vi.fn()
      .mockReturnValueOnce(first)
      .mockImplementationOnce((_name, _options, callback) => Promise.resolve(callback({})));
    const locks: UserSequenceLockManager = { request } as UserSequenceLockManager;
    const take = storedSequence(storage, "Take");

    const pending = deleteUserSequenceSafely(take, storage, locks);
    await expect(deleteUserSequenceSafely(take, storage, locks))
      .resolves.toMatchObject({ status: "busy" });
    resolveFirst({ status: "busy", sequences: loadUserSequences(storage) });
    await expect(pending).resolves.toMatchObject({ status: "busy" });

    await expect(deleteUserSequenceSafely(take, storage, locks)).resolves.toMatchObject({
      status: "deleted",
      deletedName: "Take",
      sequences: [],
    });
    expect(request).toHaveBeenCalledTimes(2);
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

  it("fails closed without writing when a lock manager throws or rejects", async () => {
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
    )).resolves.toEqual({ status: "busy", sequences: [] });
    await expect(saveUserSequenceSafely(
      "Rejected",
      SIMPLE_EVENTS,
      new MemoryStorage(),
      rejected,
    )).resolves.toEqual({ status: "busy", sequences: [] });
  });

  it("fails closed without deleting when a lock manager throws or rejects", async () => {
    const thrown: UserSequenceLockManager = {
      request: () => { throw new Error("unavailable"); },
    };
    const rejected: UserSequenceLockManager = {
      request: () => Promise.reject(new Error("unavailable")),
    };
    const thrownStorage = new MemoryStorage();
    const rejectedStorage = new MemoryStorage();
    saveUserSequence("Thrown", SIMPLE_EVENTS, thrownStorage);
    saveUserSequence("Rejected", SIMPLE_EVENTS, rejectedStorage);

    await expect(deleteUserSequenceSafely(
      storedSequence(thrownStorage, "Thrown"),
      thrownStorage,
      thrown,
    )).resolves.toMatchObject({ status: "busy", sequences: [{ name: "Thrown" }] });
    await expect(deleteUserSequenceSafely(
      storedSequence(rejectedStorage, "Rejected"),
      rejectedStorage,
      rejected,
    )).resolves.toMatchObject({ status: "busy", sequences: [{ name: "Rejected" }] });
    expect(loadUserSequences(thrownStorage).map((sequence) => sequence.name)).toEqual(["Thrown"]);
    expect(loadUserSequences(rejectedStorage).map((sequence) => sequence.name)).toEqual(["Rejected"]);
  });
});
