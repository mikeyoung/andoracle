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
