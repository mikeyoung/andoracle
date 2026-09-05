import { describe, expect, it } from "vitest";
import { NoteOwnershipIndex } from "./note-ownership";

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
});
