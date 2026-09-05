import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { USER_SEQUENCE_NAME_MAX_LENGTH } from "../src/sequencer/user-sequences";
import { USER_PATCH_NAME_MAX_LENGTH } from "../src/synth/user-patches";
import {
  USER_LIBRARY_NAME_MAX_LENGTH,
  allocateUserLibraryName,
  fitUserLibraryNameWithSuffix,
  truncateUserLibraryName,
} from "../src/user-library-name";

describe("user library name limits", () => {
  it("uses one 33-character invariant for patches and note sequences", () => {
    expect(USER_LIBRARY_NAME_MAX_LENGTH).toBe(33);
    expect(USER_PATCH_NAME_MAX_LENGTH).toBe(USER_LIBRARY_NAME_MAX_LENGTH);
    expect(USER_SEQUENCE_NAME_MAX_LENGTH).toBe(USER_LIBRARY_NAME_MAX_LENGTH);
  });

  it.each([
    ["PatchLibraryDialog.tsx", "USER_PATCH_NAME_MAX_LENGTH"],
    ["SequenceCommitDialog.tsx", "USER_SEQUENCE_NAME_MAX_LENGTH"],
  ] as const)("exposes the limit and its meaning in %s", (fileName, constantName) => {
    const source = readFileSync(resolve("src/components", fileName), "utf8");

    expect(source).toContain(`maxLength={${constantName}}`);
    expect(source).toContain("truncateUserLibraryName(event.target.value)");
    expect(source).toContain(`Up to {${constantName}} characters.`);
    expect(source).toContain("Leading and trailing whitespace is removed.");
    expect(source).toContain("Names must be unique, regardless of capitalization.");
  });

  it("reports defensive over-limit save failures in both app flows", () => {
    const source = readFileSync(resolve("src/App.tsx"), "utf8");

    expect(source.match(/case "name-too-long":/gu)).toHaveLength(2);
    expect(source).toContain("Sequence names can contain no more than ${result.maxLength} characters.");
    expect(source).toContain("Patch names can contain no more than ${result.maxLength} characters.");
  });

  it("never splits a surrogate pair at the migration boundary", () => {
    const candidate = fitUserLibraryNameWithSuffix(`${"A".repeat(32)}😀tail`, "");

    expect(candidate).toBe("A".repeat(32));
    expect(candidate).not.toContain("�");
    expect(candidate.length).toBeLessThanOrEqual(USER_LIBRARY_NAME_MAX_LENGTH);
  });

  it("never splits a surrogate pair when clamping live dialog input", () => {
    const exactAscii = "A".repeat(USER_LIBRARY_NAME_MAX_LENGTH);
    const splitEmoji = `${"A".repeat(USER_LIBRARY_NAME_MAX_LENGTH - 1)}😀tail`;
    const completeEmoji = `${"A".repeat(USER_LIBRARY_NAME_MAX_LENGTH - 2)}😀tail`;

    expect(truncateUserLibraryName(exactAscii)).toBe(exactAscii);
    expect(truncateUserLibraryName(splitEmoji)).toBe(
      "A".repeat(USER_LIBRARY_NAME_MAX_LENGTH - 1),
    );
    expect(truncateUserLibraryName(completeEmoji)).toBe(
      `${"A".repeat(USER_LIBRARY_NAME_MAX_LENGTH - 2)}😀`,
    );
    expect(truncateUserLibraryName(splitEmoji)).not.toContain("�");
  });

  it("allocates suffixes deterministically under canonical collisions", () => {
    const canonicalKey = (name: string): string => name.normalize("NFC").toLocaleLowerCase("en-US");
    const base = "C".repeat(40);
    const firstCandidate = "C".repeat(33);
    const secondCandidate = `${"C".repeat(29)} (2)`;
    const allocated = new Set([canonicalKey(firstCandidate), canonicalKey(secondCandidate)]);

    const first = allocateUserLibraryName(base, allocated, canonicalKey);
    const second = allocateUserLibraryName(base, new Set([...allocated, canonicalKey(first)]), canonicalKey);

    expect(first).toBe(`${"C".repeat(29)} (3)`);
    expect(second).toBe(`${"C".repeat(29)} (4)`);
    expect(first.length).toBe(USER_LIBRARY_NAME_MAX_LENGTH);
    expect(second.length).toBe(USER_LIBRARY_NAME_MAX_LENGTH);
  });

  it("keeps a large shared-prefix migration campaign unique across suffix widths", () => {
    const canonicalKey = (name: string): string => name
      .normalize("NFC")
      .toUpperCase()
      .toLowerCase()
      .normalize("NFC");
    const allocated = new Set<string>();
    const names: string[] = [];

    for (let index = 0; index < 128; index += 1) {
      const legacyName = `${"Collision prefix ".repeat(3)}${index.toString().padStart(3, "0")}`;
      const migrated = allocateUserLibraryName(legacyName, allocated, canonicalKey);
      const key = canonicalKey(migrated);
      expect(allocated.has(key)).toBe(false);
      expect(migrated.length).toBeLessThanOrEqual(USER_LIBRARY_NAME_MAX_LENGTH);
      expect(migrated.trim()).toBe(migrated);
      allocated.add(key);
      names.push(migrated);
    }

    expect(new Set(names).size).toBe(128);
    expect(names).toContain("Collision prefix Collision prefix");
    expect(names.some((name) => name.endsWith(" (10)"))).toBe(true);
    expect(names.some((name) => name.endsWith(" (100)"))).toBe(true);
  });
});
