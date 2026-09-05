import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("dialog source contracts", () => {
  it("keeps the submitted patch name immutable until its async save settles", () => {
    const source = readFileSync(resolve("src/components/PatchLibraryDialog.tsx"), "utf8");
    const nameFieldStart = source.indexOf('id="patch-library-name"');
    const nameFieldEnd = source.indexOf("onChange=", nameFieldStart);

    expect(nameFieldStart).toBeGreaterThanOrEqual(0);
    expect(nameFieldEnd).toBeGreaterThan(nameFieldStart);
    expect(source.slice(nameFieldStart, nameFieldEnd)).toContain("readOnly={busy}");
  });
});
