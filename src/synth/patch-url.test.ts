import { describe, expect, it } from "vitest";
import {
  DEFAULT_PARAMS,
  PARAM_KEYS,
  PARAM_SPECS,
  type ParamKey,
  type ParamSpec,
  type SynthParams,
} from "./params";
import { FACTORY_PRESETS } from "./presets";
import {
  PATCH_CODEC_VERSION,
  PATCH_URL_PARAM,
  PATCH_V1_PARAM_KEYS,
  PATCH_V1_VALUE_SPECS,
  decodePatch,
  encodePatch,
  readPatchFromUrl,
  urlWithPatch,
} from "./patch-url";

const fingerprint = (schema: unknown): string => {
  let hash = 0x811c9dc5;
  for (const character of JSON.stringify(schema)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
};

const liveSchemaFingerprint = (): string => fingerprint(
  PATCH_V1_PARAM_KEYS.map((key) => {
    const spec = PARAM_SPECS[key];
    return [
      key,
      spec.min,
      spec.max,
      spec.step,
      spec.default,
      spec.options?.map((option) => option.value) ?? null,
    ];
  }),
);

const frozenSchemaFingerprint = (): string => fingerprint(
  PATCH_V1_PARAM_KEYS.map((key) => {
    const spec = PATCH_V1_VALUE_SPECS[key];
    return [key, spec.min, spec.max, spec.step, spec.defaultValue, spec.options ?? null];
  }),
);

const crc16 = (bytes: Uint8Array): number => {
  let crc = 0xffff;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 0x8000) !== 0 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
};

const tokenWithFirstStoredValue = (token: string, value: number): string => {
  const encoded = token.slice(token.indexOf(".") + 1);
  const standard = encoded.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(standard.padEnd(Math.ceil(standard.length / 4) * 4, "="));
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  new DataView(bytes.buffer).setFloat32(0, value, true);
  const checksum = crc16(bytes.subarray(0, -2));
  bytes[bytes.length - 2] = checksum >>> 8;
  bytes[bytes.length - 1] = checksum & 0xff;
  const mutated = btoa(String.fromCharCode(...bytes))
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  return `${PATCH_CODEC_VERSION}.${mutated}`;
};

describe("shareable patch URL codec", () => {
  it("freezes a V1 wire order containing every persistent parameter exactly once", () => {
    expect(new Set(PATCH_V1_PARAM_KEYS).size).toBe(PATCH_V1_PARAM_KEYS.length);
    expect([...PATCH_V1_PARAM_KEYS].sort()).toEqual([...PARAM_KEYS].sort());
  });

  it("pins the complete V1 numeric schema", () => {
    // Changing this fixture requires a new codec version. It covers every
    // min/max/step/default and selector option value used by the wire format.
    expect(frozenSchemaFingerprint()).toBe("1da6a2f4");
    expect(liveSchemaFingerprint()).toBe("1da6a2f4");
  });

  it("round-trips the default and every factory patch exactly", () => {
    for (const params of [DEFAULT_PARAMS, ...FACTORY_PRESETS.map((preset) => preset.params)]) {
      expect(decodePatch(encodePatch(params))).toEqual(params);
    }
  });

  it("round-trips a patch at every parameter's maximum", () => {
    const maximums = Object.fromEntries(PARAM_KEYS.map((key) => [key, PARAM_SPECS[key].max])) as SynthParams;
    expect(decodePatch(encodePatch(maximums))).toEqual(maximums);
  });

  it("round-trips a patch at every parameter's minimum", () => {
    const minimums = Object.fromEntries(PARAM_KEYS.map((key) => [key, PARAM_SPECS[key].min])) as SynthParams;
    expect(decodePatch(encodePatch(minimums))).toEqual(minimums);
  });

  it("decodes absolute values independently of changed defaults", () => {
    const originalPatch = { ...DEFAULT_PARAMS, masterVolume: 0.321 };
    const token = encodePatch(originalPatch);
    const originalDefault = DEFAULT_PARAMS.masterVolume;
    try {
      DEFAULT_PARAMS.masterVolume = 0.111;
      expect(decodePatch(token)?.masterVolume).toBe(0.321);
    } finally {
      DEFAULT_PARAMS.masterVolume = originalDefault;
    }
  });

  it("uses frozen V1 range, step, and option semantics instead of the live schema", () => {
    const originalPatch = { ...DEFAULT_PARAMS, masterVolume: 0.321, transpose: 24 };
    const token = encodePatch(originalPatch);
    const originalVolumeSpec = PARAM_SPECS.masterVolume;
    const originalTransposeSpec = PARAM_SPECS.transpose;
    try {
      PARAM_SPECS.masterVolume = {
        ...originalVolumeSpec,
        min: 0.2,
        max: 0.4,
        step: 0.1,
        default: 0.2,
      };
      PARAM_SPECS.transpose = {
        ...originalTransposeSpec,
        min: 0,
        max: 12,
        default: 0,
        options: [
          { value: 0, label: "Normal" },
          { value: 12, label: "One octave up" },
        ],
      };

      expect(decodePatch(token)).toEqual(originalPatch);
      expect(encodePatch(originalPatch)).toBe(token);
    } finally {
      PARAM_SPECS.masterVolume = originalVolumeSpec;
      PARAM_SPECS.transpose = originalTransposeSpec;
    }
  });

  it("fills a parameter added after V1 from the current default", () => {
    const token = encodePatch(DEFAULT_PARAMS);
    const futureKey = "futureCompatibilityProbe" as ParamKey;
    const futureSpec: ParamSpec = {
      label: "Future compatibility probe",
      group: "Test",
      control: "range",
      min: 0,
      max: 1,
      step: 0.001,
      default: 0.375,
    };

    (PARAM_KEYS as ParamKey[]).push(futureKey);
    (PARAM_SPECS as Record<string, ParamSpec>)[futureKey] = futureSpec;
    (DEFAULT_PARAMS as Record<string, number>)[futureKey] = futureSpec.default;
    try {
      const decoded = decodePatch(token) as SynthParams & Record<string, number>;
      expect(decoded[futureKey]).toBe(0.375);
    } finally {
      PARAM_KEYS.splice(PARAM_KEYS.indexOf(futureKey), 1);
      delete (PARAM_SPECS as Record<string, ParamSpec>)[futureKey];
      delete (DEFAULT_PARAMS as Record<string, number>)[futureKey];
    }
  });

  it("is deterministic, URL-safe, and compact", () => {
    const first = encodePatch(DEFAULT_PARAMS);
    expect(encodePatch({ ...DEFAULT_PARAMS })).toBe(first);
    expect(first.startsWith(`${PATCH_CODEC_VERSION}.`)).toBe(true);
    expect(first).toMatch(/^v1\.[A-Za-z0-9_-]+$/);
    expect(first).toHaveLength(433);
  });

  it("rejects invalid runtime patch values", () => {
    expect(() => encodePatch({ ...DEFAULT_PARAMS, delayFeedback: Number.NaN })).toThrow(RangeError);
    expect(() => encodePatch({ ...DEFAULT_PARAMS, filterCutoff: 999_999 })).toThrow(RangeError);
    expect(() => encodePatch({ ...DEFAULT_PARAMS, transpose: 12 })).toThrow(RangeError);
  });

  it.each([
    "",
    "v1",
    "v2.AAAA",
    "v1.",
    "v1.not+url/safe",
    "v1.A",
    "v1.AAAA=",
    `v1.${"A".repeat(513)}`,
  ])("returns null for malformed or unsupported token %j", (token) => {
    expect(decodePatch(token)).toBeNull();
  });

  it("detects truncation, appended bytes, and single-character corruption", () => {
    const encoded = encodePatch(DEFAULT_PARAMS);
    expect(decodePatch(encoded.slice(0, -2))).toBeNull();
    expect(decodePatch(`${encoded}AA`)).toBeNull();

    const index = encoded.length - 3;
    const replacement = encoded[index] === "A" ? "B" : "A";
    const corrupt = `${encoded.slice(0, index)}${replacement}${encoded.slice(index + 1)}`;
    expect(decodePatch(corrupt)).toBeNull();
  });

  it("rejects checksummed non-finite, out-of-range, and off-step values", () => {
    const encoded = encodePatch(DEFAULT_PARAMS);
    expect(decodePatch(tokenWithFirstStoredValue(encoded, Number.NaN))).toBeNull();
    expect(decodePatch(tokenWithFirstStoredValue(encoded, 2))).toBeNull();
    expect(decodePatch(tokenWithFirstStoredValue(encoded, 0.7204))).toBeNull();
  });

  it("classifies absent, valid, malformed, unsupported, and duplicate fragment patches", () => {
    expect(readPatchFromUrl("https://example.test/andoracle/?patch=ignored")).toEqual({ status: "absent" });
    expect(readPatchFromUrl("https://example.test/andoracle/#panel=filter")).toEqual({ status: "absent" });

    const validUrl = `https://example.test/andoracle/#${PATCH_URL_PARAM}=${encodePatch(DEFAULT_PARAMS)}`;
    expect(readPatchFromUrl(validUrl)).toEqual({ status: "valid", params: DEFAULT_PARAMS });
    expect(readPatchFromUrl("https://example.test/andoracle/#patch=broken")).toEqual({ status: "invalid" });
    expect(readPatchFromUrl("https://example.test/andoracle/#patch=v2.AAAA")).toEqual({
      status: "unsupported",
      version: "v2",
    });
    expect(readPatchFromUrl(`https://example.test/andoracle/#patch=v2.${"A".repeat(1_000)}`)).toEqual({
      status: "unsupported",
      version: "v2",
    });
    expect(readPatchFromUrl("https://example.test/andoracle/#patch=v2.not+url/safe")).toEqual({ status: "invalid" });
    expect(readPatchFromUrl(`${validUrl}&patch=${encodePatch(DEFAULT_PARAMS)}`)).toEqual({ status: "invalid" });
    expect(readPatchFromUrl(`https://example.test/#patch=v1.${"A".repeat(513)}`)).toEqual({ status: "invalid" });
    expect(readPatchFromUrl("not a URL")).toEqual({ status: "invalid" });
  });

  it("adds a patch while preserving a nested path, query, and other fragment parameters", () => {
    const source = "https://example.test/apps/music/andoracle/?mode=embed&theme=amber#panel=delay&help=open";
    const result = urlWithPatch(source, DEFAULT_PARAMS);
    const parsed = new URL(result);
    const fragment = new URLSearchParams(parsed.hash.slice(1));

    expect(parsed.origin).toBe("https://example.test");
    expect(parsed.pathname).toBe("/apps/music/andoracle/");
    expect(parsed.search).toBe("?mode=embed&theme=amber");
    expect(fragment.get("panel")).toBe("delay");
    expect(fragment.get("help")).toBe("open");
    expect(fragment.getAll(PATCH_URL_PARAM)).toHaveLength(1);
    expect(readPatchFromUrl(result)).toEqual({ status: "valid", params: DEFAULT_PARAMS });
  });

  it("replaces duplicate old patch entries with one canonical patch", () => {
    const source = "https://example.test/andoracle/#patch=old&mode=performance&patch=older";
    const result = urlWithPatch(source, DEFAULT_PARAMS);
    const fragment = new URLSearchParams(new URL(result).hash.slice(1));
    expect(fragment.get("mode")).toBe("performance");
    expect(fragment.getAll(PATCH_URL_PARAM)).toEqual([encodePatch(DEFAULT_PARAMS)]);
  });
});
