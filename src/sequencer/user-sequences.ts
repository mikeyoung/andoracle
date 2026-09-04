/** Storage key for the versioned collection of note-only performances. */
export const USER_SEQUENCES_STORAGE_KEY = "andoracle:user-sequences:v1";

const USER_SEQUENCES_STORAGE_VERSION = 1;
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
      readonly status: "duplicate-name";
      readonly existingName: string;
      readonly sequences: readonly UserNoteSequence[];
    };

export type SafeSaveUserSequenceResult = SaveUserSequenceResult | {
  /** Another tab currently owns the short sequence-library write lock. */
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

type SequenceInput = CapturedNoteSequence | readonly NoteSequenceEvent[];

// A host-owned Web Locks request cannot be force-settled by the page. Bound a
// broken implementation to one retained request (and one sequence snapshot).
const pendingLockSaves = new WeakMap<
  UserSequenceLockManager,
  Promise<SafeSaveUserSequenceResult>
>();

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

  const sequences: UserNoteSequence[] = [];
  const seenNames = new Set<string>();
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
    if (!name || seenNames.has(nameKey) || !inspected) {
      recovered = true;
      continue;
    }

    sequences.push({
      name,
      data: storedSequence.data,
      durationMs: inspected.durationMs,
      noteCount: inspected.noteCount,
      eventCount: inspected.eventCount,
    });
    seenNames.add(nameKey);
    if (
      name !== storedSequence.name
      || storedSequence.durationMs !== inspected.durationMs
      || storedSequence.noteCount !== inspected.noteCount
      || storedSequence.eventCount !== inspected.eventCount
    ) {
      recovered = true;
    }
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
  const nameKey = userSequenceNameKey(normalizedName);
  const duplicate = sequences.find(
    (sequence) => userSequenceNameKey(sequence.name) === nameKey,
  );
  if (duplicate) {
    return {
      status: "duplicate-name",
      existingName: duplicate.name,
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
  const storedSequences: StoredUserSequence[] = nextSequences.map((item) => ({
    name: item.name,
    data: item.data,
    durationMs: item.durationMs,
    noteCount: item.noteCount,
    eventCount: item.eventCount,
  }));
  const collection: StoredUserSequenceCollection = {
    version: USER_SEQUENCES_STORAGE_VERSION,
    sequences: storedSequences,
  };

  try {
    storage.setItem(USER_SEQUENCES_STORAGE_KEY, JSON.stringify(collection));
    return { status: "saved", sequence, sequences: nextSequences };
  } catch {
    return { status: "storage-error", sequences };
  }
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
): Promise<SafeSaveUserSequenceResult> => {
  if (!lockManager) return Promise.resolve(saveUserSequence(name, input, storage));
  if (pendingLockSaves.has(lockManager)) {
    return Promise.resolve({ status: "busy", sequences: readUserSequences(storage).sequences });
  }

  let request: Promise<SafeSaveUserSequenceResult>;
  try {
    request = Promise.resolve(lockManager.request(
      `${USER_SEQUENCES_STORAGE_KEY}:write`,
      { mode: "exclusive", ifAvailable: true },
      (lock): SafeSaveUserSequenceResult => lock
        ? saveUserSequence(name, input, storage)
        : { status: "busy", sequences: readUserSequences(storage).sequences },
    ));
  } catch {
    // Some privacy modes expose navigator.locks but reject requests. Preserve
    // normal single-tab storage behavior there.
    return Promise.resolve(saveUserSequence(name, input, storage));
  }

  let tracked: Promise<SafeSaveUserSequenceResult>;
  tracked = request
    .catch(() => saveUserSequence(name, input, storage))
    .finally(() => {
      if (pendingLockSaves.get(lockManager) === tracked) pendingLockSaves.delete(lockManager);
    });
  pendingLockSaves.set(lockManager, tracked);
  return tracked;
};
