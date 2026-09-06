export interface NoteExtremes {
  readonly low: number | null;
  readonly high: number | null;
}

/** Compares the pitch set shown by the keyboard without allocating or sorting. */
export const noteSetsMatch = (left: ReadonlySet<number>, right: ReadonlySet<number>): boolean => {
  if (left.size !== right.size) return false;
  for (const note of left) {
    if (!right.has(note)) return false;
  }
  return true;
};

/** Finds the Odyssey low/high note allocation without copying or sorting notes. */
export const findNoteExtremes = (notes: ReadonlySet<number>): NoteExtremes => {
  if (notes.size === 0) return { low: null, high: null };
  let low = Number.POSITIVE_INFINITY;
  let high = Number.NEGATIVE_INFINITY;
  for (const note of notes) {
    if (note < low) low = note;
    if (note > high) high = note;
  }
  return { low, high };
};

/**
 * Tracks how many independent keyboard, pointer, MIDI, and sequencer sources
 * own each pitch. This keeps hot note events O(1) while preserving the rule
 * that the DSP receives only the first attack and final release of a pitch.
 */
export class NoteOwnershipIndex {
  private readonly counts = new Map<number, number>();

  add(note: number): boolean {
    const owners = this.counts.get(note) ?? 0;
    this.counts.set(note, owners + 1);
    return owners === 0;
  }

  remove(note: number): boolean {
    const owners = this.counts.get(note) ?? 0;
    if (owners <= 1) {
      this.counts.delete(note);
      return owners === 1;
    }
    this.counts.set(note, owners - 1);
    return false;
  }

  count(note: number): number {
    return this.counts.get(note) ?? 0;
  }

  clear(): void {
    this.counts.clear();
  }
}
