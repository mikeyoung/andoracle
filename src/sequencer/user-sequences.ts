import {
  USER_LIBRARY_NAME_MAX_LENGTH,
  allocateUserLibraryName,
  isUserLibraryNameWithinLimit,
} from "../user-library-name";

/** Storage key for the versioned collection of note-only performances. */
export const USER_SEQUENCES_STORAGE_KEY = "andoracle:user-sequences:v1";

const USER_SEQUENCES_STORAGE_VERSION = 1;
/** User sequence names are bounded so they remain readable throughout the UI. */
export const USER_SEQUENCE_NAME_MAX_LENGTH = USER_LIBRARY_NAME_MAX_LENGTH;
const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** A note transition measured from the preceding transition. */
export interface NoteSequenceEvent {
  readonly deltaMs: number;
  readonly note: number;
  readonly on: boolean;
}

/** A validated, balanced note-only performance. */
export interface CapturedNoteSequence {
  readonly events: readonly NoteSequenceEvent[];
  readonly durationMs: number;
  readonly noteCount: number;
}

/**
 * A locally saved performance. The event stream stays compact in application
 * state; use decodeUserSequence only when this particular take will play.
 */
export interface UserNoteSequence {
  readonly name: string;
  readonly data: string;
  readonly durationMs: number;
  readonly noteCount: number;
  readonly eventCount: number;
}

/** The part of Web Storage used by this module, kept narrow for testability. */
export interface UserSequenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface UserSequenceLockManager {
  request<T>(
    name: string,
    options: { readonly mode: "exclusive"; readonly ifAvailable: true },
    callback: (lock: unknown | null) => T | PromiseLike<T>,
  ): Promise<T>;
}

export type ReadUserSequencesResult =
  | {
      readonly status: "ok" | "recovered";
      readonly sequences: readonly UserNoteSequence[];
    }
  | {
      readonly status: "storage-error" | "unsupported-version";
      readonly sequences: readonly [];
    };

export type SaveUserSequenceResult =
  | {
      readonly status: "saved";
      readonly sequence: UserNoteSequence;
      readonly sequences: readonly UserNoteSequence[];
    }
  | {
      readonly status: "empty-name" | "invalid-sequence" | "storage-error" | "unsupported-version";
      readonly sequences: readonly UserNoteSequence[];
    }
  | {
      readonly status: "name-too-long";
      readonly maxLength: typeof USER_SEQUENCE_NAME_MAX_LENGTH;
      readonly sequences: readonly UserNoteSequence[];
    }
  | {
      readonly status: "duplicate-name";
      readonly existingName: string;
      /** Immutable snapshot that a later, explicit replace confirmation can target safely. */
      readonly existingSequence: UserNoteSequence;
      readonly sequences: readonly UserNoteSequence[];
    };

export type SafeSaveUserSequenceResult = SaveUserSequenceResult | {
  /** Another tab currently owns the short sequence-library write lock. */
  readonly status: "busy";
  readonly sequences: readonly UserNoteSequence[];
};

export type ReplaceUserSequenceResult =
  | {
      readonly status: "replaced";
      readonly sequence: UserNoteSequence;
      readonly sequences: readonly UserNoteSequence[];
    }
  | {
      readonly status: "empty-name" | "invalid-sequence" | "not-found" | "storage-error" | "unsupported-version";
      readonly sequences: readonly UserNoteSequence[];
    }
  | {
      /** The stored sequence changed after the user was asked to confirm replacement. */
      readonly status: "stale-target";
      readonly currentSequence: UserNoteSequence;
      readonly sequences: readonly UserNoteSequence[];
    };

export type SafeReplaceUserSequenceResult = ReplaceUserSequenceResult | {
  /** Another tab currently owns the short sequence-library write lock. */
  readonly status: "busy";
  readonly sequences: readonly UserNoteSequence[];
};

export type DeleteUserSequenceResult =
  | {
      readonly status: "deleted";
      /** The normalized, persisted spelling of the sequence that was removed. */
      readonly deletedName: string;
      readonly sequences: readonly UserNoteSequence[];
    }
  | {
      readonly status: "empty-name" | "not-found" | "stale-target" | "storage-error" | "unsupported-version";
      readonly sequences: readonly UserNoteSequence[];
    };

export type SafeDeleteUserSequenceResult = DeleteUserSequenceResult | {
  /** Another tab or operation currently owns the short library write lock. */
  readonly status: "busy";
  readonly sequences: readonly UserNoteSequence[];
};

interface StoredUserSequence {
  readonly name: string;
  /** Base64url-encoded pairs of unsigned-varint delta and one-byte note action. */
  readonly data: string;
  readonly durationMs: number;
  readonly noteCount: number;
  readonly eventCount: number;
}

interface StoredUserSequenceCollection {
  readonly version: typeof USER_SEQUENCES_STORAGE_VERSION;
  readonly sequences: readonly StoredUserSequence[];
}

interface ParsedCollection {
  readonly sequences: UserNoteSequence[];
  readonly recovered: boolean;
  readonly unsupportedVersion: boolean;
}

interface ValidStoredSequence {
  readonly name: string;
  readonly nameKey: string;
  readonly data: string;
  readonly inspected: InspectedNoteSequence;
  readonly requiresLengthMigration: boolean;
}

type SequenceInput = CapturedNoteSequence | readonly NoteSequenceEvent[];

// Gate saves and deletes by lock-manager identity. An aborted delete drops its
// captured write closure immediately. A host that still does not settle is
// quarantined so it cannot retain more targets; writes remain busy rather than
// bypassing cross-tab serialization and risking a lost update.
const pendingLockWrites = new WeakMap<UserSequenceLockManager, Promise<unknown>>();
const retiredLockManagers = new WeakSet<UserSequenceLockManager>();
const ABORTED_LOCK_REQUEST_MAX_AGE_MS = 10_000;

// Keep the fresh busy reader in a lexical environment that never contains a
// sequence snapshot. A broken host may retain one retired callback, but not
// the potentially large note-data string whose write authority was revoked.
const createUserSequenceBusyReader = (storage: UserSequenceStorage | null) => () => ({
  status: "busy" as const,
  sequences: readUserSequences(storage).sequences,
});

const isObjectRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Returns the exact name that will be displayed and persisted. */
export const normalizeUserSequenceName = (name: string): string => name.trim();

/** Matches the patch library's locale-independent duplicate-name rules. */
export const userSequenceNameKey = (name: string): string => normalizeUserSequenceName(name)
  .normalize("NFC")
  .toUpperCase()
  .toLowerCase()
  .normalize("NFC");

/** Uses canonical duplicate-name rules to retain a UI selection. */
export const hasUserSequenceNamed = (
  sequences: readonly UserNoteSequence[],
  name: string,
): boolean => {
  const nameKey = userSequenceNameKey(name);
  return Boolean(nameKey)
    && sequences.some((sequence) => userSequenceNameKey(sequence.name) === nameKey);
};

const defaultStorage = (): UserSequenceStorage | null => {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
};

const defaultLockManager = (): UserSequenceLockManager | null => {
  try {
    if (typeof navigator === "undefined" || !("locks" in navigator)) return null;
    return navigator.locks as unknown as UserSequenceLockManager;
  } catch {
    return null;
  }
};

const eventsFromInput = (input: SequenceInput): readonly NoteSequenceEvent[] | null => {
  if (Array.isArray(input)) return input as readonly NoteSequenceEvent[];
  if (!isObjectRecord(input)) return null;
  return Array.isArray(input.events)
    ? input.events as readonly NoteSequenceEvent[]
    : null;
};

/**
 * Validates and snapshots a take. Note counts may overlap, but every note-off
 * must own a preceding note-on and every note must be released by the end.
 */
export const normalizeCapturedNoteSequence = (
  input: SequenceInput,
): CapturedNoteSequence | null => {
  const sourceEvents = eventsFromInput(input);
  if (!sourceEvents || sourceEvents.length === 0) return null;

  const heldCounts = Array.from({ length: 128 }, () => 0);
  const events: NoteSequenceEvent[] = [];
  let durationMs = 0;
  let noteCount = 0;

  for (const candidate of sourceEvents) {
    if (
      !isObjectRecord(candidate)
      || !Number.isSafeInteger(candidate.deltaMs)
      || candidate.deltaMs < 0
      || !Number.isInteger(candidate.note)
      || candidate.note < 0
      || candidate.note > 127
      || typeof candidate.on !== "boolean"
    ) {
      return null;
    }

    if (candidate.deltaMs > Number.MAX_SAFE_INTEGER - durationMs) return null;
    durationMs += candidate.deltaMs;

    if (candidate.on) {
      if (heldCounts[candidate.note] === Number.MAX_SAFE_INTEGER) return null;
      heldCounts[candidate.note] += 1;
      noteCount += 1;
    } else {
      if (heldCounts[candidate.note] === 0) return null;
      heldCounts[candidate.note] -= 1;
    }

    events.push({
      deltaMs: candidate.deltaMs === 0 ? 0 : candidate.deltaMs,
      note: candidate.note,
      on: candidate.on,
    });
  }

  if (noteCount === 0 || heldCounts.some((count) => count !== 0)) return null;
  return { events, durationMs, noteCount };
};

const appendUnsignedVarint = (bytes: number[], value: number): void => {
  let remainder = value;
  while (remainder >= 128) {
    const quotient = Math.floor(remainder / 128);
    bytes.push((remainder - quotient * 128) + 128);
    remainder = quotient;
  }
  bytes.push(remainder);
};

const readUnsignedVarint = (
  bytes: Uint8Array,
  start: number,
): readonly [value: number, next: number] | null => {
  let value = 0;
  let factor = 1;

  for (let index = start; index < bytes.length; index += 1) {
    const byte = bytes[index];
    const digit = byte % 128;
    if (digit > Math.floor((Number.MAX_SAFE_INTEGER - value) / factor)) return null;
    value += digit * factor;

    if (byte < 128) {
      // A zero most-significant group makes the varint needlessly ambiguous.
      if (index > start && digit === 0) return null;
      return [value, index + 1];
    }
    if (factor > Math.floor(Number.MAX_SAFE_INTEGER / 128)) return null;
    factor *= 128;
  }
  return null;
};

const encodeBase64Url = (bytes: readonly number[]): string => {
  const chunks: string[] = [];
  let chunk = "";

  for (let index = 0; index < bytes.length; index += 3) {
    const remaining = bytes.length - index;
    const first = bytes[index];
    const second = remaining > 1 ? bytes[index + 1] : 0;
    const third = remaining > 2 ? bytes[index + 2] : 0;
    const packed = first * 65_536 + second * 256 + third;

    chunk += BASE64URL_ALPHABET[Math.floor(packed / 262_144) % 64];
    chunk += BASE64URL_ALPHABET[Math.floor(packed / 4_096) % 64];
    if (remaining > 1) chunk += BASE64URL_ALPHABET[Math.floor(packed / 64) % 64];
    if (remaining > 2) chunk += BASE64URL_ALPHABET[packed % 64];

    if (chunk.length >= 8_192) {
      chunks.push(chunk);
      chunk = "";
    }
  }
  if (chunk) chunks.push(chunk);
  return chunks.join("");
};

const base64UrlValues = (() => {
  const values = new Uint8Array(128);
  values.fill(255);
  for (let index = 0; index < BASE64URL_ALPHABET.length; index += 1) {
    values[BASE64URL_ALPHABET.charCodeAt(index)] = index;
  }
  return values;
})();

const decodeBase64Url = (encoded: string): Uint8Array | null => {
  if (!/^[A-Za-z0-9_-]*$/.test(encoded) || encoded.length % 4 === 1) return null;
  const remainder = encoded.length % 4;
  const outputLength = Math.floor(encoded.length * 6 / 8);
  const output = new Uint8Array(outputLength);
  let outputIndex = 0;
  let index = 0;

  while (index + 4 <= encoded.length) {
    const first = base64UrlValues[encoded.charCodeAt(index)];
    const second = base64UrlValues[encoded.charCodeAt(index + 1)];
    const third = base64UrlValues[encoded.charCodeAt(index + 2)];
    const fourth = base64UrlValues[encoded.charCodeAt(index + 3)];
    const packed = first * 262_144 + second * 4_096 + third * 64 + fourth;
    output[outputIndex] = Math.floor(packed / 65_536);
    output[outputIndex + 1] = Math.floor(packed / 256) % 256;
    output[outputIndex + 2] = packed % 256;
    outputIndex += 3;
    index += 4;
  }

  if (remainder === 2) {
    const first = base64UrlValues[encoded.charCodeAt(index)];
    const second = base64UrlValues[encoded.charCodeAt(index + 1)];
    // Unused low bits must be zero for one canonical encoding per byte stream.
    if (second % 16 !== 0) return null;
    output[outputIndex] = first * 4 + Math.floor(second / 16);
  } else if (remainder === 3) {
    const first = base64UrlValues[encoded.charCodeAt(index)];
    const second = base64UrlValues[encoded.charCodeAt(index + 1)];
    const third = base64UrlValues[encoded.charCodeAt(index + 2)];
    if (third % 4 !== 0) return null;
    output[outputIndex] = first * 4 + Math.floor(second / 16);
    output[outputIndex + 1] = (second % 16) * 16 + Math.floor(third / 4);
  }

  return output;
};

/**
 * Encodes validated note events compactly. Typical events occupy two or three
 * bytes before base64url: an unsigned-varint millisecond delta and one action
 * byte whose high bit is note-on and whose low seven bits are the MIDI note.
 */
const encodeValidatedEvents = (events: readonly NoteSequenceEvent[]): string => {
  const bytes: number[] = [];
  for (const event of events) {
    appendUnsignedVarint(bytes, event.deltaMs);
    bytes.push(event.note + (event.on ? 128 : 0));
  }
  return encodeBase64Url(bytes);
};

export const encodeNoteSequence = (input: SequenceInput): string | null => {
  const captured = normalizeCapturedNoteSequence(input);
  return captured ? encodeValidatedEvents(captured.events) : null;
};

interface InspectedNoteSequence {
  readonly durationMs: number;
  readonly noteCount: number;
  readonly eventCount: number;
  readonly events?: readonly NoteSequenceEvent[];
}

/**
 * Validates a compact stream and derives trusted metadata. Library scans leave
 * `collectEvents` false, so saved takes never expand into per-event JS objects.
 */
const inspectNoteSequence = (
  encoded: string,
  collectEvents: boolean,
): InspectedNoteSequence | null => {
  const bytes = decodeBase64Url(encoded);
  if (!bytes || bytes.length === 0) return null;

  const events: NoteSequenceEvent[] | null = collectEvents ? [] : null;
  const heldCounts = Array.from({ length: 128 }, () => 0);
  let cursor = 0;
  let durationMs = 0;
  let noteCount = 0;
  let eventCount = 0;
  while (cursor < bytes.length) {
    const decodedDelta = readUnsignedVarint(bytes, cursor);
    if (!decodedDelta) return null;
    const [deltaMs, next] = decodedDelta;
    if (next >= bytes.length) return null;
    const action = bytes[next];
    const note = action % 128;
    const on = action >= 128;
    if (deltaMs > Number.MAX_SAFE_INTEGER - durationMs) return null;
    durationMs += deltaMs;
    eventCount += 1;

    if (on) {
      if (heldCounts[note] === Number.MAX_SAFE_INTEGER || noteCount === Number.MAX_SAFE_INTEGER) {
        return null;
      }
      heldCounts[note] += 1;
      noteCount += 1;
    } else {
      if (heldCounts[note] === 0) return null;
      heldCounts[note] -= 1;
    }

    events?.push({ deltaMs, note, on });
    cursor = next + 1;
  }

  if (noteCount === 0 || heldCounts.some((count) => count !== 0)) return null;
  return {
    durationMs,
    noteCount,
    eventCount,
    ...(events ? { events } : {}),
  };
};

/** Decodes, validates, and derives summary metadata for one compact take. */
export const decodeNoteSequence = (encoded: string): CapturedNoteSequence | null => {
  const inspected = inspectNoteSequence(encoded, true);
  if (!inspected?.events) return null;
  return {
    events: inspected.events,
    durationMs: inspected.durationMs,
    noteCount: inspected.noteCount,
  };
};

/**
 * Lazily expands one saved sequence for playback and verifies that its compact
 * stream still agrees with the trusted library metadata.
 */
export const decodeUserSequence = (
  sequence: UserNoteSequence,
): CapturedNoteSequence | null => {
  const inspected = inspectNoteSequence(sequence.data, true);
  if (
    !inspected?.events
    || inspected.durationMs !== sequence.durationMs
    || inspected.noteCount !== sequence.noteCount
    || inspected.eventCount !== sequence.eventCount
  ) {
    return null;
  }
  return {
    events: inspected.events,
    durationMs: inspected.durationMs,
    noteCount: inspected.noteCount,
  };
};

const parseCollection = (raw: string): ParsedCollection => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { sequences: [], recovered: true, unsupportedVersion: false };
  }

  if (
    isObjectRecord(parsed)
    && typeof parsed.version === "number"
    && Number.isInteger(parsed.version)
    && parsed.version > USER_SEQUENCES_STORAGE_VERSION
  ) {
    return { sequences: [], recovered: false, unsupportedVersion: true };
  }
  if (
    !isObjectRecord(parsed)
    || parsed.version !== USER_SEQUENCES_STORAGE_VERSION
    || !Array.isArray(parsed.sequences)
  ) {
    return { sequences: [], recovered: true, unsupportedVersion: false };
  }

  const validStoredSequences: ValidStoredSequence[] = [];
  let recovered = false;

  for (const storedSequence of parsed.sequences) {
    if (
      !isObjectRecord(storedSequence)
      || typeof storedSequence.name !== "string"
      || typeof storedSequence.data !== "string"
    ) {
      recovered = true;
      continue;
    }

    const name = normalizeUserSequenceName(storedSequence.name);
    const nameKey = userSequenceNameKey(name);
    const inspected = inspectNoteSequence(storedSequence.data, false);
    if (!name || !inspected) {
      recovered = true;
      continue;
    }

    const requiresLengthMigration = !isUserLibraryNameWithinLimit(name);
    validStoredSequences.push({
      name,
      data: storedSequence.data,
      nameKey,
      inspected,
      requiresLengthMigration,
    });
    if (
      name !== storedSequence.name
      || requiresLengthMigration
      || storedSequence.durationMs !== inspected.durationMs
      || storedSequence.noteCount !== inspected.noteCount
      || storedSequence.eventCount !== inspected.eventCount
    ) {
      recovered = true;
    }
  }

  // Protect every already-valid short identity before allocating names for
  // historical long entries, regardless of their position in storage.
  const allocatedNameKeys = new Set(
    validStoredSequences
      .filter((sequence) => !sequence.requiresLengthMigration)
      .map((sequence) => sequence.nameKey),
  );
  const seenStoredNameKeys = new Set<string>();
  const sequences: UserNoteSequence[] = [];

  for (const storedSequence of validStoredSequences) {
    // Canonically equivalent source names retain the library's established
    // first-record-wins recovery rule; only truncation collisions get suffixes.
    if (seenStoredNameKeys.has(storedSequence.nameKey)) {
      recovered = true;
      continue;
    }
    seenStoredNameKeys.add(storedSequence.nameKey);

    const name = storedSequence.requiresLengthMigration
      ? allocateUserLibraryName(
        storedSequence.name,
        allocatedNameKeys,
        userSequenceNameKey,
      )
      : storedSequence.name;
    allocatedNameKeys.add(userSequenceNameKey(name));
    sequences.push({
      name,
      data: storedSequence.data,
      durationMs: storedSequence.inspected.durationMs,
      noteCount: storedSequence.inspected.noteCount,
      eventCount: storedSequence.inspected.eventCount,
    });
  }

  return { sequences, recovered, unsupportedVersion: false };
};

/** Reads and validates the complete local sequence library without rewriting it. */
export const readUserSequences = (
  storage: UserSequenceStorage | null = defaultStorage(),
): ReadUserSequencesResult => {
  if (!storage) return { status: "storage-error", sequences: [] };
  try {
    const raw = storage.getItem(USER_SEQUENCES_STORAGE_KEY);
    if (raw === null) return { status: "ok", sequences: [] };
    const collection = parseCollection(raw);
    if (collection.unsupportedVersion) {
      return { status: "unsupported-version", sequences: [] };
    }
    return {
      status: collection.recovered ? "recovered" : "ok",
      sequences: collection.sequences,
    };
  } catch {
    return { status: "storage-error", sequences: [] };
  }
};

/** Convenience array-only reader for callers that do not need diagnostics. */
export const loadUserSequences = (
  storage: UserSequenceStorage | null = defaultStorage(),
): readonly UserNoteSequence[] => readUserSequences(storage).sequences;

/** Looks up a take using the same normalized name rules as save. */
export const findUserSequence = (
  name: string,
  storage: UserSequenceStorage | null = defaultStorage(),
): UserNoteSequence | null => {
  const nameKey = userSequenceNameKey(name);
  if (!nameKey) return null;
  return loadUserSequences(storage)
    .find((sequence) => userSequenceNameKey(sequence.name) === nameKey) ?? null;
};

const serializeUserSequences = (
  sequences: readonly UserNoteSequence[],
): string => JSON.stringify({
  version: USER_SEQUENCES_STORAGE_VERSION,
  sequences: sequences.map((sequence): StoredUserSequence => ({
    name: sequence.name,
    data: sequence.data,
    durationMs: sequence.durationMs,
    noteCount: sequence.noteCount,
    eventCount: sequence.eventCount,
  })),
} satisfies StoredUserSequenceCollection);

const snapshotUserSequence = (sequence: UserNoteSequence): UserNoteSequence => ({
  name: sequence.name,
  data: sequence.data,
  durationMs: sequence.durationMs,
  noteCount: sequence.noteCount,
  eventCount: sequence.eventCount,
});

const matchesUserSequenceSnapshot = (
  stored: UserNoteSequence,
  expected: UserNoteSequence,
): boolean => userSequenceNameKey(stored.name) === userSequenceNameKey(expected.name)
  && stored.data === expected.data
  && Object.is(stored.durationMs, expected.durationMs)
  && Object.is(stored.noteCount, expected.noteCount)
  && Object.is(stored.eventCount, expected.eventCount);

/** Adds a new named sequence without ever overwriting an existing name. */
export const saveUserSequence = (
  name: string,
  input: SequenceInput,
  storage: UserSequenceStorage | null = defaultStorage(),
): SaveUserSequenceResult => {
  const readResult = readUserSequences(storage);
  const sequences = readResult.sequences;
  if (readResult.status === "storage-error" || !storage) {
    return { status: "storage-error", sequences };
  }
  if (readResult.status === "unsupported-version") {
    return { status: "unsupported-version", sequences };
  }

  const normalizedName = normalizeUserSequenceName(name);
  if (!normalizedName) return { status: "empty-name", sequences };
  if (!isUserLibraryNameWithinLimit(normalizedName)) {
    return {
      status: "name-too-long",
      maxLength: USER_SEQUENCE_NAME_MAX_LENGTH,
      sequences,
    };
  }
  const nameKey = userSequenceNameKey(normalizedName);
  const duplicate = sequences.find(
    (sequence) => userSequenceNameKey(sequence.name) === nameKey,
  );
  if (duplicate) {
    return {
      status: "duplicate-name",
      existingName: duplicate.name,
      existingSequence: snapshotUserSequence(duplicate),
      sequences,
    };
  }

  const captured = normalizeCapturedNoteSequence(input);
  if (!captured) return { status: "invalid-sequence", sequences };
  const data = encodeValidatedEvents(captured.events);

  const sequence: UserNoteSequence = {
    name: normalizedName,
    data,
    durationMs: captured.durationMs,
    noteCount: captured.noteCount,
    eventCount: captured.events.length,
  };
  const nextSequences = [...sequences, sequence];

  try {
    storage.setItem(USER_SEQUENCES_STORAGE_KEY, serializeUserSequences(nextSequences));
    return { status: "saved", sequence, sequences: nextSequences };
  } catch {
    return { status: "storage-error", sequences };
  }
};

/**
 * Replaces one saved take only when it still exactly matches the snapshot the
 * user confirmed. The persisted display name and collection position remain
 * stable even when the submitted name uses different case or Unicode form.
 */
export const replaceUserSequence = (
  expected: UserNoteSequence,
  input: SequenceInput,
  storage: UserSequenceStorage | null = defaultStorage(),
): ReplaceUserSequenceResult => {
  const readResult = readUserSequences(storage);
  const sequences = readResult.sequences;
  if (readResult.status === "storage-error" || !storage) {
    return { status: "storage-error", sequences };
  }
  if (readResult.status === "unsupported-version") {
    return { status: "unsupported-version", sequences };
  }

  const normalizedName = normalizeUserSequenceName(expected.name);
  if (!normalizedName) return { status: "empty-name", sequences };

  const nameKey = userSequenceNameKey(normalizedName);
  const sequenceIndex = sequences.findIndex(
    (sequence) => userSequenceNameKey(sequence.name) === nameKey,
  );
  if (sequenceIndex < 0) return { status: "not-found", sequences };

  const currentSequence = sequences[sequenceIndex];
  if (!matchesUserSequenceSnapshot(currentSequence, expected)) {
    return { status: "stale-target", currentSequence, sequences };
  }

  const captured = normalizeCapturedNoteSequence(input);
  if (!captured) return { status: "invalid-sequence", sequences };

  const sequence: UserNoteSequence = {
    name: currentSequence.name,
    data: encodeValidatedEvents(captured.events),
    durationMs: captured.durationMs,
    noteCount: captured.noteCount,
    eventCount: captured.events.length,
  };
  const nextSequences = [
    ...sequences.slice(0, sequenceIndex),
    sequence,
    ...sequences.slice(sequenceIndex + 1),
  ];

  try {
    storage.setItem(USER_SEQUENCES_STORAGE_KEY, serializeUserSequences(nextSequences));
    return { status: "replaced", sequence, sequences: nextSequences };
  } catch {
    return { status: "storage-error", sequences };
  }
};

/**
 * Removes one saved take only when it still exactly matches the snapshot shown
 * to the user for confirmation. This prevents a same-name delete/recreate in
 * another tab from turning an old confirmation into authority over a new take.
 */
export const deleteUserSequence = (
  expected: UserNoteSequence,
  storage: UserSequenceStorage | null = defaultStorage(),
): DeleteUserSequenceResult => {
  const readResult = readUserSequences(storage);
  const sequences = readResult.sequences;
  if (readResult.status === "storage-error" || !storage) {
    return { status: "storage-error", sequences };
  }
  if (readResult.status === "unsupported-version") {
    return { status: "unsupported-version", sequences };
  }

  const nameKey = userSequenceNameKey(expected.name);
  if (!nameKey) return { status: "empty-name", sequences };
  const deletedIndex = sequences.findIndex(
    (sequence) => userSequenceNameKey(sequence.name) === nameKey,
  );
  if (deletedIndex < 0) return { status: "not-found", sequences };
  if (!matchesUserSequenceSnapshot(sequences[deletedIndex], expected)) {
    return { status: "stale-target", sequences };
  }

  const deletedName = sequences[deletedIndex].name;
  const nextSequences = [
    ...sequences.slice(0, deletedIndex),
    ...sequences.slice(deletedIndex + 1),
  ];
  try {
    storage.setItem(USER_SEQUENCES_STORAGE_KEY, serializeUserSequences(nextSequences));
    return { status: "deleted", deletedName, sequences: nextSequences };
  } catch {
    return { status: "storage-error", sequences };
  }
};

const runUserSequenceWriteSafely = <Result>(
  write: () => Result,
  busy: () => Result,
  lockManager: UserSequenceLockManager | null,
  signal?: AbortSignal,
): Promise<Result> => {
  if (signal?.aborted) return Promise.resolve(busy());
  if (!lockManager) return Promise.resolve(write());
  if (retiredLockManagers.has(lockManager)) return Promise.resolve(busy());
  if (pendingLockWrites.has(lockManager)) return Promise.resolve(busy());

  const authority: {
    write: (() => Result) | null;
    signal: AbortSignal | null;
  } = { write, signal: signal ?? null };
  let abortSignal: AbortSignal | null = signal ?? null;
  let retireTimer: ReturnType<typeof setTimeout> | null = null;
  let tracked: Promise<Result>;
  const requestStartedAt = Date.now();
  const guardedWrite = (): Result => {
    if (authority.signal?.aborted) {
      authority.write = null;
      authority.signal = null;
    }
    return authority.write ? authority.write() : busy();
  };
  const revokeAuthority = (): void => {
    authority.write = null;
    authority.signal = null;
    const currentSignal = abortSignal;
    abortSignal = null;
    currentSignal?.removeEventListener("abort", revokeAuthority);
    if (retireTimer !== null) return;
    const requestAge = Math.max(0, Date.now() - requestStartedAt);
    retireTimer = setTimeout(() => {
      retireTimer = null;
      if (pendingLockWrites.get(lockManager) !== tracked) return;
      pendingLockWrites.delete(lockManager);
      retiredLockManagers.add(lockManager);
    }, Math.max(0, ABORTED_LOCK_REQUEST_MAX_AGE_MS - requestAge));
  };

  let request: Promise<Result>;
  try {
    request = Promise.resolve(lockManager.request(
      `${USER_SEQUENCES_STORAGE_KEY}:write`,
      // Web Locks disallows signal together with ifAvailable. The revocable
      // authority holder below prevents any late callback from mutating data.
      { mode: "exclusive", ifAvailable: true },
      (lock): Result => lock ? guardedWrite() : busy(),
    ));
  } catch {
    authority.write = null;
    authority.signal = null;
    // Some privacy modes expose navigator.locks but reject requests. Preserve
    // normal single-tab storage behavior there.
    return Promise.resolve(signal?.aborted ? busy() : write());
  }

  tracked = request
    .catch(() => guardedWrite())
    .finally(() => {
      authority.write = null;
      authority.signal = null;
      abortSignal?.removeEventListener("abort", revokeAuthority);
      abortSignal = null;
      if (retireTimer !== null) clearTimeout(retireTimer);
      retireTimer = null;
      if (pendingLockWrites.get(lockManager) === tracked) pendingLockWrites.delete(lockManager);
      retiredLockManagers.delete(lockManager);
    });
  pendingLockWrites.set(lockManager, tracked);
  if (abortSignal?.aborted) revokeAuthority();
  else abortSignal?.addEventListener("abort", revokeAuthority, { once: true });
  return tracked;
};

/**
 * Serializes the collection's read/append/write transaction across tabs when
 * Web Locks is available. A simultaneous save must retry rather than lose a
 * take or implicitly overwrite a same-name take.
 */
export const saveUserSequenceSafely = (
  name: string,
  input: SequenceInput,
  storage: UserSequenceStorage | null = defaultStorage(),
  lockManager: UserSequenceLockManager | null = defaultLockManager(),
): Promise<SafeSaveUserSequenceResult> => runUserSequenceWriteSafely<SafeSaveUserSequenceResult>(
  () => saveUserSequence(name, input, storage),
  createUserSequenceBusyReader(storage),
  lockManager,
);

/**
 * Serializes an explicitly confirmed replacement with every other sequence
 * write. Both the confirmed target and proposed performance are snapshotted
 * before a browser-owned lock request can defer the transaction.
 */
export const replaceUserSequenceSafely = (
  expected: UserNoteSequence,
  input: SequenceInput,
  storage: UserSequenceStorage | null = defaultStorage(),
  lockManager: UserSequenceLockManager | null = defaultLockManager(),
  signal?: AbortSignal,
): Promise<SafeReplaceUserSequenceResult> => {
  const expectedSnapshot = snapshotUserSequence(expected);
  const inputSnapshot = normalizeCapturedNoteSequence(input);
  return runUserSequenceWriteSafely<SafeReplaceUserSequenceResult>(
    () => replaceUserSequence(expectedSnapshot, inputSnapshot ?? [], storage),
    createUserSequenceBusyReader(storage),
    lockManager,
    signal,
  );
};

/**
 * Serializes delete with every other sequence-library write. A contended or
 * already-pending write reports busy so callers can retry without losing a
 * concurrent save or deleting a newly replaced collection.
 */
export const deleteUserSequenceSafely = (
  expected: UserNoteSequence,
  storage: UserSequenceStorage | null = defaultStorage(),
  lockManager: UserSequenceLockManager | null = defaultLockManager(),
  signal?: AbortSignal,
): Promise<SafeDeleteUserSequenceResult> => {
  const expectedSnapshot = snapshotUserSequence(expected);
  return runUserSequenceWriteSafely<SafeDeleteUserSequenceResult>(
    () => deleteUserSequence(expectedSnapshot, storage),
    createUserSequenceBusyReader(storage),
    lockManager,
    signal,
  );
};
