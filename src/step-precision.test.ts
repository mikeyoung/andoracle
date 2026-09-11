import { describe, expect, it, vi } from "vitest";
import { decimalPlacesForStep } from "./step-precision";

describe("step precision cache", () => {
  it.each([
    [1, 0],
    [0.1, 1],
    [0.001, 3],
    [1e-7, 7],
  ])("derives the decimal precision of %s", (step, expected) => {
    expect(decimalPlacesForStep(step)).toBe(expected);
  });

  it("reuses a step's precision without repeating string work on hot paths", () => {
    const uncataloguedStep = 0.00000037;
    expect(decimalPlacesForStep(uncataloguedStep)).toBe(8);

    const toString = vi.spyOn(Number.prototype, "toString");
    try {
      for (let index = 0; index < 1_000; index += 1) {
        expect(decimalPlacesForStep(uncataloguedStep)).toBe(8);
      }
      expect(toString).not.toHaveBeenCalled();
    } finally {
      toString.mockRestore();
    }
  });
});
