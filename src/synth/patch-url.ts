import {
  PARAM_KEYS,
  normalizePatch,
  type ParamKey,
  type SynthParams,
} from "./params";

/** Fragment parameter used for a shareable patch. */
export const PATCH_URL_PARAM = "patch";

/**
 * The prefix is deliberately separate from the binary payload. Future schemas
 * can therefore get a new decoder without making existing shared links
 * ambiguous.
 */
export const PATCH_CODEC_VERSION = "v1";

/**
 * V1's wire order is frozen. Do not add keys here when adding a parameter;
 * introduce a new codec version instead and keep decoding V1 links.
 */
export const PATCH_V1_PARAM_KEYS = [
  "masterVolume",
  "masterTune",
  "portamento",
  "portamentoMode",
  "portamentoFootswitch",
  "transpose",
  "autoRun",
  "autoNote",
  "ppcBendRange",
  "ppcVibratoRange",
  "pedalConnected",
  "pedalPosition",
  "vco1Mode",
  "vco1Coarse",
  "vco1Fine",
  "vco1Fm1Source",
  "vco1Fm1Amount",
  "vco1Fm2Source",
  "vco1Fm2Amount",
  "vco1PulseWidth",
  "vco1PwmSource",
  "vco1PwmAmount",
  "vco2Sync",
  "vco2Coarse",
  "vco2Fine",
  "vco2Fm1Source",
  "vco2Fm1Amount",
  "vco2Fm2Source",
  "vco2Fm2Amount",
  "vco2PulseWidth",
  "vco2PwmSource",
  "vco2PwmAmount",
  "lfoRate",
  "noiseColor",
  "shInput1Source",
  "shInput1Level",
  "shInput2Source",
  "shInput2Level",
  "shClockSource",
  "shLag",
  "mixer1Source",
  "mixer1Level",
  "mixer2Source",
  "mixer2Level",
  "mixer3Source",
  "mixer3Level",
  "externalLevel",
  "outputFeedback",
  "filterType",
  "filter4075Mode",
  "filterCutoff",
  "filterResonance",
  "filterMod1Source",
  "filterMod1Amount",
  "filterMod2Source",
  "filterMod2Amount",
  "filterMod3Source",
  "filterMod3Amount",
  "hpfCutoff",
  "driveEnabled",
  "driveAmount",
  "vcaInitialGain",
  "vcaEnvelopeSource",
  "vcaEnvelopeAmount",
  "repeatMode",
  "arSource",
  "arAttack",
  "arRelease",
  "adsrSource",
  "adsrAttack",
  "adsrDecay",
  "adsrSustain",
  "adsrRelease",
  "delayEnabled",
  "delayTime",
  "delayFeedback",
  "delayMix",
  "delayTone",
  "delaySpread",
  "delayPingPong",
] as const satisfies readonly ParamKey[];

interface V1ValueSpec {
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly defaultValue: number;
  readonly options?: readonly number[];
}

const v1Range = (min: number, max: number, step: number, defaultValue: number): V1ValueSpec => (
  Object.freeze({ min, max, step, defaultValue })
);

const v1Options = (defaultValue: number, ...values: number[]): V1ValueSpec => Object.freeze({
  min: Math.min(...values),
  max: Math.max(...values),
  step: 1,
  defaultValue,
  options: Object.freeze(values),
});

/**
 * These are V1 wire semantics, not aliases of the live control schema. They
 * must remain unchanged even after the app introduces V2 controls or ranges.
 */
export const PATCH_V1_VALUE_SPECS = Object.freeze({
  masterVolume: v1Range(0, 1, 0.001, 0.72),
  masterTune: v1Range(-100, 100, 1, 0),
  portamento: v1Range(0, 1.5, 0.001, 0),
  portamentoMode: v1Options(0, 0, 1),
  portamentoFootswitch: v1Options(0, 0, 1),
  transpose: v1Options(0, -24, 0, 24),
  autoRun: v1Options(0, 0, 1),
  autoNote: v1Range(36, 72, 1, 48),
  ppcBendRange: v1Range(1, 12, 1, 8),
  ppcVibratoRange: v1Range(0.1, 2, 0.01, 1),
  pedalConnected: v1Options(0, 0, 1),
  pedalPosition: v1Range(0, 1, 0.001, 0),
  vco1Mode: v1Options(1, 0, 1),
  vco1Coarse: v1Range(20, 2000, 0.01, 65.41),
  vco1Fine: v1Range(-400, 400, 1, 0),
  vco1Fm1Source: v1Options(0, 0, 1),
  vco1Fm1Amount: v1Range(0, 1, 0.001, 0),
  vco1Fm2Source: v1Options(0, 0, 1),
  vco1Fm2Amount: v1Range(0, 1, 0.001, 0),
  vco1PulseWidth: v1Range(0.05, 0.5, 0.001, 0.5),
  vco1PwmSource: v1Options(0, 0, 1),
  vco1PwmAmount: v1Range(0, 1, 0.001, 0),
  vco2Sync: v1Options(0, 0, 1),
  vco2Coarse: v1Range(20, 2000, 0.01, 65.41),
  vco2Fine: v1Range(-400, 400, 1, 0),
  vco2Fm1Source: v1Options(0, 0, 1),
  vco2Fm1Amount: v1Range(0, 1, 0.001, 0),
  vco2Fm2Source: v1Options(0, 0, 1),
  vco2Fm2Amount: v1Range(0, 1, 0.001, 0),
  vco2PulseWidth: v1Range(0.05, 0.5, 0.001, 0.5),
  vco2PwmSource: v1Options(0, 0, 1),
  vco2PwmAmount: v1Range(0, 1, 0.001, 0),
  lfoRate: v1Range(0.2, 20, 0.001, 3.2),
  noiseColor: v1Options(0, 0, 1),
  shInput1Source: v1Options(0, 0, 1),
  shInput1Level: v1Range(0, 1, 0.001, 0.55),
  shInput2Source: v1Options(0, 0, 1),
  shInput2Level: v1Range(0, 1, 0.001, 0.8),
  shClockSource: v1Options(0, 0, 1),
  shLag: v1Range(0, 5, 0.001, 0),
  mixer1Source: v1Options(0, 0, 1),
  mixer1Level: v1Range(0, 1, 0.001, 0),
  mixer2Source: v1Options(0, 0, 1),
  mixer2Level: v1Range(0, 1, 0.001, 0.72),
  mixer3Source: v1Options(0, 0, 1),
  mixer3Level: v1Range(0, 1, 0.001, 0.56),
  externalLevel: v1Range(0, 1, 0.001, 0.7),
  outputFeedback: v1Range(0, 2, 0.001, 0),
  filterType: v1Options(3, 1, 2, 3),
  filter4075Mode: v1Options(1, 0, 1),
  filterCutoff: v1Range(16, 16000, 0.1, 4200),
  filterResonance: v1Range(0, 1, 0.001, 0.18),
  filterMod1Source: v1Options(0, 0, 1),
  filterMod1Amount: v1Range(0, 1, 0.001, 0.25),
  filterMod2Source: v1Options(1, 0, 1),
  filterMod2Amount: v1Range(0, 1, 0.001, 0),
  filterMod3Source: v1Options(0, 0, 1),
  filterMod3Amount: v1Range(0, 1, 0.001, 0.22),
  hpfCutoff: v1Range(16, 16000, 0.1, 16),
  driveEnabled: v1Options(0, 0, 1),
  driveAmount: v1Range(1, 10, 0.01, 2.4),
  vcaInitialGain: v1Range(0, 1, 0.001, 0),
  vcaEnvelopeSource: v1Options(1, 0, 1),
  vcaEnvelopeAmount: v1Range(0, 1, 0.001, 0.9),
  repeatMode: v1Options(0, 0, 1),
  arSource: v1Options(0, 0, 1),
  arAttack: v1Range(0.005, 5, 0.001, 0.01),
  arRelease: v1Range(0.01, 8, 0.001, 0.3),
  adsrSource: v1Options(0, 0, 1),
  adsrAttack: v1Range(0.005, 5, 0.001, 0.015),
  adsrDecay: v1Range(0.01, 8, 0.001, 0.38),
  adsrSustain: v1Range(0, 1, 0.001, 0.62),
  adsrRelease: v1Range(0.015, 10, 0.001, 0.45),
  delayEnabled: v1Options(0, 0, 1),
  delayTime: v1Range(1, 1000, 1, 320),
  delayFeedback: v1Range(0, 0.92, 0.001, 0.38),
  delayMix: v1Range(0, 1, 0.001, 0.2),
  delayTone: v1Range(500, 18000, 1, 6200),
  delaySpread: v1Range(0, 1, 0.001, 0.35),
  delayPingPong: v1Options(1, 0, 1),
}) satisfies Readonly<Record<(typeof PATCH_V1_PARAM_KEYS)[number], V1ValueSpec>>;

const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const MAX_ENCODED_PAYLOAD_LENGTH = 512;
const MAX_PATCH_TOKEN_LENGTH = PATCH_CODEC_VERSION.length + 1 + MAX_ENCODED_PAYLOAD_LENGTH;
const MAX_FUTURE_PATCH_TOKEN_LENGTH = 8_192;
const BYTES_PER_V1_VALUE = 4;

const encodeBase64Url = (bytes: readonly number[]): string => {
  let encoded = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index];
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    const packed = (first << 16) | ((second ?? 0) << 8) | (third ?? 0);
    encoded += BASE64URL_ALPHABET[(packed >>> 18) & 63];
    encoded += BASE64URL_ALPHABET[(packed >>> 12) & 63];
    if (second !== undefined) encoded += BASE64URL_ALPHABET[(packed >>> 6) & 63];
    if (third !== undefined) encoded += BASE64URL_ALPHABET[packed & 63];
  }
  return encoded;
};

const decodeBase64Url = (encoded: string): number[] | null => {
  if (
    !encoded
    || encoded.length > MAX_ENCODED_PAYLOAD_LENGTH
    || encoded.length % 4 === 1
    || !/^[A-Za-z0-9_-]+$/.test(encoded)
  ) return null;

  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const character of encoded) {
    const value = BASE64URL_ALPHABET.indexOf(character);
    if (value < 0) return null;
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >>> bits) & 0xff);
      buffer &= (1 << bits) - 1;
    }
  }

  // Reject non-zero unused bits and alternate/non-canonical encodings.
  if (buffer !== 0 || encodeBase64Url(bytes) !== encoded) return null;
  return bytes;
};

const crc16 = (bytes: readonly number[]): number => {
  let crc = 0xffff;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 0x8000) !== 0 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
};

const decimalsForStep = (step: number): number => {
  const stringValue = step.toString();
  if (stringValue.includes("e-")) return Number(stringValue.split("e-")[1]);
  return stringValue.includes(".") ? stringValue.split(".")[1].length : 0;
};

const isValidV1Value = (key: (typeof PATCH_V1_PARAM_KEYS)[number], value: number): boolean => {
  const spec = PATCH_V1_VALUE_SPECS[key];
  if (!Number.isFinite(value) || value < spec.min || value > spec.max) return false;
  if (spec.options) return spec.options.includes(value);
  const steps = (value - spec.min) / spec.step;
  return Math.abs(steps - Math.round(steps)) < 1e-6;
};

const normalizeV1Value = (key: (typeof PATCH_V1_PARAM_KEYS)[number], value: number): number => {
  const spec = PATCH_V1_VALUE_SPECS[key];
  if (spec.options) {
    return spec.options.reduce((nearest, option) => (
      Math.abs(option - value) < Math.abs(nearest - value) ? option : nearest
    ));
  }
  const clamped = Math.min(spec.max, Math.max(spec.min, value));
  const stepped = spec.min + Math.round((clamped - spec.min) / spec.step) * spec.step;
  return Number(stepped.toFixed(decimalsForStep(spec.step)));
};

/**
 * Encodes every persistent synth parameter into a compact, deterministic,
 * URL-safe token. Invalid runtime values are rejected instead of silently
 * changing the patch being shared.
 */
export const encodePatch = (params: SynthParams): string => {
  const valueBuffer = new ArrayBuffer(PATCH_V1_PARAM_KEYS.length * BYTES_PER_V1_VALUE);
  const values = new DataView(valueBuffer);

  PATCH_V1_PARAM_KEYS.forEach((key, index) => {
    const value = params[key];
    if (!isValidV1Value(key, value)) {
      throw new RangeError(`Cannot encode invalid patch value for ${key}.`);
    }
    values.setFloat32(index * BYTES_PER_V1_VALUE, normalizeV1Value(key, value), true);
  });

  const payload = Array.from(new Uint8Array(valueBuffer));
  const checksum = crc16(payload);
  payload.push(checksum >>> 8, checksum & 0xff);
  return `${PATCH_CODEC_VERSION}.${encodeBase64Url(payload)}`;
};

/**
 * Decodes a V1 patch token. Unknown versions, truncated/corrupt data, invalid
 * parameter codes, and non-canonical encodings return null and never throw.
 */
export const decodePatch = (token: string): SynthParams | null => {
  try {
    if (token.length > MAX_PATCH_TOKEN_LENGTH) return null;
    const separator = token.indexOf(".");
    if (separator < 0 || token.slice(0, separator) !== PATCH_CODEC_VERSION) return null;
    const bytes = decodeBase64Url(token.slice(separator + 1));
    const expectedDataLength = PATCH_V1_PARAM_KEYS.length * BYTES_PER_V1_VALUE;
    if (!bytes || bytes.length !== expectedDataLength + 2) return null;

    const dataEnd = bytes.length - 2;
    const expectedChecksum = (bytes[dataEnd] << 8) | bytes[dataEnd + 1];
    if (crc16(bytes.slice(0, dataEnd)) !== expectedChecksum) return null;

    const valueBytes = Uint8Array.from(bytes.slice(0, dataEnd));
    const values = new DataView(valueBytes.buffer, valueBytes.byteOffset, valueBytes.byteLength);
    const decoded: Partial<Record<ParamKey, number>> = {};
    for (const [index, key] of PATCH_V1_PARAM_KEYS.entries()) {
      const storedValue = values.getFloat32(index * BYTES_PER_V1_VALUE, true);
      if (!Number.isFinite(storedValue)) return null;

      const value = normalizeV1Value(key, storedValue);
      // A valid wire value is exactly the Float32 representation of a legal
      // control step. This rejects finite but off-step/range payloads even when
      // an attacker has recomputed the checksum.
      if (!isValidV1Value(key, value) || !Object.is(storedValue, Math.fround(value))) return null;
      decoded[key] = value;
    }

    // Newer app versions may have parameters that V1 never knew about.
    // normalizePatch supplies their then-current defaults without changing any
    // absolute V1 value stored in the link.
    const result = normalizePatch({});
    const currentKeys = new Set(PARAM_KEYS);
    for (const key of PATCH_V1_PARAM_KEYS) {
      if (currentKeys.has(key)) result[key] = decoded[key] as number;
    }
    return result;
  } catch {
    return null;
  }
};

export type PatchUrlReadResult =
  | { readonly status: "absent" }
  | { readonly status: "valid"; readonly params: SynthParams }
  | { readonly status: "invalid" }
  | { readonly status: "unsupported"; readonly version: string };

const parseUrl = (href: string): URL | null => {
  try {
    return new URL(href);
  } catch {
    return null;
  }
};

/**
 * Reads a patch exclusively from the URL fragment, keeping patch links out of
 * server logs and requests. Duplicate patch keys are ambiguous and rejected.
 */
export const readPatchFromUrl = (href: string): PatchUrlReadResult => {
  const url = parseUrl(href);
  if (!url) return { status: "invalid" };

  const fragment = new URLSearchParams(url.hash.slice(1));
  const tokens = fragment.getAll(PATCH_URL_PARAM);
  if (tokens.length === 0) return { status: "absent" };
  if (tokens.length !== 1) return { status: "invalid" };

  const token = tokens[0];
  if (token.length > MAX_FUTURE_PATCH_TOKEN_LENGTH) return { status: "invalid" };

  const version = /^(v(?:0|[1-9]\d*))\.[A-Za-z0-9_-]+$/.exec(token)?.[1];
  if (version && version !== PATCH_CODEC_VERSION) return { status: "unsupported", version };
  if (token.length > MAX_PATCH_TOKEN_LENGTH) return { status: "invalid" };

  const params = decodePatch(token);
  return params ? { status: "valid", params } : { status: "invalid" };
};

/**
 * Returns a new absolute URL containing the patch fragment. The path, query,
 * and unrelated fragment parameters are retained; any old patch entries are
 * replaced by one canonical value.
 */
export const urlWithPatch = (href: string, params: SynthParams): string => {
  const url = new URL(href);
  const fragment = new URLSearchParams(url.hash.slice(1));
  fragment.delete(PATCH_URL_PARAM);
  fragment.append(PATCH_URL_PARAM, encodePatch(params));
  url.hash = fragment.toString();
  return url.href;
};

// Keep accidental changes to the live schema visible during development. The
// corresponding test provides the hard failure in CI/builds.
if (import.meta.env.DEV && PATCH_V1_PARAM_KEYS.length !== PARAM_KEYS.length) {
  console.warn("The patch parameter schema changed; introduce a new URL codec version.");
}
