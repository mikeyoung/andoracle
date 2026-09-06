import { describe, expect, it } from "vitest";
import {
  NoteOwnershipIndex,
  findNoteExtremes,
  noteSetsMatch,
} from "./note-ownership";

describe("NoteOwnershipIndex", () => {
  it("reports only the first attack and final release of a shared pitch", () => {
    const ownership = new NoteOwnershipIndex();
    expect(ownership.add(60)).toBe(true);
    expect(ownership.add(60)).toBe(false);
    expect(ownership.count(60)).toBe(2);
    expect(ownership.remove(60)).toBe(false);
    expect(ownership.remove(60)).toBe(true);
    expect(ownership.count(60)).toBe(0);
  });

  it("keeps pitches independent and ignores orphan releases", () => {
    const ownership = new NoteOwnershipIndex();
    expect(ownership.remove(48)).toBe(false);
    expect(ownership.add(48)).toBe(true);
    expect(ownership.add(72)).toBe(true);
    expect(ownership.remove(48)).toBe(true);
    expect(ownership.count(72)).toBe(1);
  });

  it("releases all ownership without retaining pitch entries", () => {
    const ownership = new NoteOwnershipIndex();
    for (let owner = 0; owner < 10_000; owner += 1) ownership.add(owner % 128);
    ownership.clear();
    for (let note = 0; note < 128; note += 1) expect(ownership.count(note)).toBe(0);
  });

  it("compares visible pitch sets independent of insertion order", () => {
    const first = new Set([72, 48, 60]);
    const reordered = new Set([48, 60, 72]);

    expect(noteSetsMatch(first, reordered)).toBe(true);
    expect(noteSetsMatch(first, new Set([48, 60]))).toBe(false);
    expect(noteSetsMatch(first, new Set([48, 60, 71]))).toBe(false);
  });

  it("finds low/high allocation without sorting or mutating notes", () => {
    const notes = new Set([67, 36, 127, 48]);

    expect(findNoteExtremes(notes)).toEqual({ low: 36, high: 127 });
    expect([...notes]).toEqual([67, 36, 127, 48]);
    expect(findNoteExtremes(new Set())).toEqual({ low: null, high: null });
  });
});
