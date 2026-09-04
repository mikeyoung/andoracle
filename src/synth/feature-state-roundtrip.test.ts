import { describe, expect, it } from "vitest";
import {
  DEFAULT_PARAMS,
  PARAM_KEYS,
  PARAM_SPECS,
  normalizedToParam,
  type SynthParams,
} from "./params";
import { decodePatch, encodePatch } from "./patch-url";
import { FACTORY_PRESETS } from "./presets";
import {
  findUserPatch,
  saveUserPatch,
  type UserPatchStorage,
} from "./user-patches";

class MemoryStorage implements UserPatchStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

const representativeValues = (key: (typeof PARAM_KEYS)[number]): readonly number[] => {
  const spec = PARAM_SPECS[key];
  if (spec.options) return spec.options.map((option) => option.value);
  return [...new Set([
    spec.min,
    normalizedToParam(key, 0.137),
    normalizedToParam(key, 0.5),
    normalizedToParam(key, 0.863),
    spec.max,
  ])];
};

describe("complete persistent patch state", () => {
  it("round-trips representative values of every control through URLs and named storage", () => {
    let caseNumber = 0;

    for (const key of PARAM_KEYS) {
      for (const value of representativeValues(key)) {
        const patch = { ...DEFAULT_PARAMS, [key]: value } as SynthParams;
        const decoded = decodePatch(encodePatch(patch));
        expect(decoded?.[key], `URL codec lost ${key}=${value}`).toBe(value);

        const name = `Route ${caseNumber}: ${key}=${value}`;
        const storage = new MemoryStorage();
        const saved = saveUserPatch(name, patch, storage);
        expect(saved.status, `named save failed for ${key}=${value}`).toBe("saved");
        expect(findUserPatch(name, storage)?.params[key], `named load lost ${key}=${value}`).toBe(value);
        caseNumber += 1;
      }
    }

    expect(caseNumber).toBeGreaterThan(PARAM_KEYS.length * 2);
  });

  it("keeps a named factory initialization patch exactly equal to the default state", () => {
    const initialization = FACTORY_PRESETS.find((preset) => preset.name === "Init Andoracle");
    expect(initialization).toBeDefined();
    expect(initialization?.params).toEqual(DEFAULT_PARAMS);
  });
});
