import {
  PARAM_KEYS,
  PARAM_SPECS,
  normalizePatch,
  type ParamKey,
  type SynthParams,
} from "./params";
import { decimalPlacesForStep } from "../step-precision";

/** Fragment parameter used for a shareable patch. */
export const PATCH_URL_PARAM = "patch";

/**
 * The prefix is deliberately separate from the binary payload. Future schemas
 * can therefore get a new decoder without making existing shared links
 * ambiguous.
 */
export const PATCH_CODEC_VERSION = "v2";

/** The complete wire order for the only supported patch codec. */
export const PATCH_PARAM_KEYS = [
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
  "delayTrails",
] as const satisfies readonly ParamKey[];

interface PatchValueSpec {
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly defaultValue: number;
  readonly options?: readonly number[];
}

const v1Range = (min: number, max: number, step: number, defaultValue: number): PatchValueSpec => (
  Object.freeze({ min, max, step, defaultValue })
);

const v1Options = (defaultValue: number, ...values: number[]): PatchValueSpec => Object.freeze({
  min: Math.min(...values),
  max: Math.max(...values),
  step: 1,
  defaultValue,
  options: Object.freeze(values),
});

/** Frozen wire semantics for the current codec, independent of live controls. */
export const PATCH_VALUE_SPECS = Object.freeze({
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
  delayTrails: v1Options(0, 0, 1),
}) satisfies Readonly<Record<(typeof PATCH_PARAM_KEYS)[number], PatchValueSpec>>;

const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const MAX_ENCODED_PAYLOAD_LENGTH = 512;
const MAX_PATCH_TOKEN_LENGTH = PATCH_CODEC_VERSION.length + 1 + MAX_ENCODED_PAYLOAD_LENGTH;
const MAX_FUTURE_PATCH_TOKEN_LENGTH = 8_192;
const BYTES_PER_VALUE = 4;

interface PatchWireSchema {
  readonly version: string;
  readonly keys: readonly ParamKey[];
  readonly specs: Readonly<Partial<Record<ParamKey, PatchValueSpec>>>;
}

const PATCH_SCHEMA: PatchWireSchema = {
  version: PATCH_CODEC_VERSION,
  keys: PATCH_PARAM_KEYS,
  specs: PATCH_VALUE_SPECS,
};

const patchSchemaForVersion = (version: string): PatchWireSchema | null => {
  return version === PATCH_SCHEMA.version ? PATCH_SCHEMA : null;
};

const encodeBase64Url = (bytes: ArrayLike<number>): string => {
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

const base64UrlValues = (() => {
  const values = new Uint8Array(128);
  values.fill(255);
  for (let index = 0; index < BASE64URL_ALPHABET.length; index += 1) {
    values[BASE64URL_ALPHABET.charCodeAt(index)] = index;
  }
  return values;
})();

const base64UrlValueAt = (encoded: string, index: number): number => {
  const code = encoded.charCodeAt(index);
  return code < base64UrlValues.length ? base64UrlValues[code] : 255;
};

const decodeBase64Url = (encoded: string): Uint8Array | null => {
  if (
    !encoded
    || encoded.length > MAX_ENCODED_PAYLOAD_LENGTH
    || encoded.length % 4 === 1
  ) return null;

  // Validate before allocating, then decode directly into the exact output
  // buffer. Shared-patch navigation is allowed to receive untrusted input.
  for (let index = 0; index < encoded.length; index += 1) {
    if (base64UrlValueAt(encoded, index) === 255) return null;
  }

  const remainder = encoded.length % 4;
  const bytes = new Uint8Array(Math.floor(encoded.length * 6 / 8));
  let outputIndex = 0;
  let index = 0;
  while (index + 4 <= encoded.length) {
    const packed = base64UrlValueAt(encoded, index) * 262_144
      + base64UrlValueAt(encoded, index + 1) * 4_096
      + base64UrlValueAt(encoded, index + 2) * 64
      + base64UrlValueAt(encoded, index + 3);
    bytes[outputIndex] = Math.floor(packed / 65_536);
    bytes[outputIndex + 1] = Math.floor(packed / 256) % 256;
    bytes[outputIndex + 2] = packed % 256;
    outputIndex += 3;
    index += 4;
  }

  if (remainder === 2) {
    const first = base64UrlValueAt(encoded, index);
    const second = base64UrlValueAt(encoded, index + 1);
    if (second % 16 !== 0) return null;
    bytes[outputIndex] = first * 4 + Math.floor(second / 16);
  } else if (remainder === 3) {
    const first = base64UrlValueAt(encoded, index);
    const second = base64UrlValueAt(encoded, index + 1);
    const third = base64UrlValueAt(encoded, index + 2);
    if (third % 4 !== 0) return null;
    bytes[outputIndex] = first * 4 + Math.floor(second / 16);
    bytes[outputIndex + 1] = (second % 16) * 16 + Math.floor(third / 4);
  }
  return bytes;
};

const crc16 = (bytes: ArrayLike<number>): number => {
  let crc = 0xffff;
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index];
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 0x8000) !== 0 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
};

const wireValueSpec = (schema: PatchWireSchema, key: ParamKey): PatchValueSpec => {
  const spec = schema.specs[key];
  if (!spec) throw new Error(`Missing ${schema.version} value specification for ${key}.`);
  return spec;
};

const isValidWireValue = (schema: PatchWireSchema, key: ParamKey, value: number): boolean => {
  const spec = wireValueSpec(schema, key);
  if (!Number.isFinite(value) || value < spec.min || value > spec.max) return false;
  if (spec.options) return spec.options.includes(value);
  const steps = (value - spec.min) / spec.step;
  return Math.abs(steps - Math.round(steps)) < 1e-6;
};

const normalizeWireValue = (schema: PatchWireSchema, key: ParamKey, value: number): number => {
  const spec = wireValueSpec(schema, key);
  if (spec.options) {
    return spec.options.reduce((nearest, option) => (
      Math.abs(option - value) < Math.abs(nearest - value) ? option : nearest
    ));
  }
  const clamped = Math.min(spec.max, Math.max(spec.min, value));
  const stepped = spec.min + Math.round((clamped - spec.min) / spec.step) * spec.step;
  return Number(stepped.toFixed(decimalPlacesForStep(spec.step)));
};

/**
 * Encodes every persistent synth parameter into a compact, deterministic,
 * URL-safe token. Invalid runtime values are rejected instead of silently
 * changing the patch being shared.
 */
export const encodePatch = (params: SynthParams): string => {
  const schema = PATCH_SCHEMA;
  const valueByteLength = schema.keys.length * BYTES_PER_VALUE;
  const payload = new Uint8Array(valueByteLength + 2);
  const values = new DataView(payload.buffer, payload.byteOffset, valueByteLength);

  schema.keys.forEach((key, index) => {
    const value = params[key];
    if (!isValidWireValue(schema, key, value)) {
      throw new RangeError(`Cannot encode invalid patch value for ${key}.`);
    }
    values.setFloat32(index * BYTES_PER_VALUE, normalizeWireValue(schema, key, value), true);
  });

  const checksum = crc16(payload.subarray(0, valueByteLength));
  payload[valueByteLength] = checksum >>> 8;
  payload[valueByteLength + 1] = checksum & 0xff;
  return `${PATCH_CODEC_VERSION}.${encodeBase64Url(payload)}`;
};

/**
 * Decodes a supported patch token. Unknown versions, truncated/corrupt data, invalid
 * parameter codes, and non-canonical encodings return null and never throw.
 */
export const decodePatch = (token: string): SynthParams | null => {
  try {
    if (token.length > MAX_PATCH_TOKEN_LENGTH) return null;
    const separator = token.indexOf(".");
    if (separator < 0) return null;
    const schema = patchSchemaForVersion(token.slice(0, separator));
    if (!schema) return null;
    const bytes = decodeBase64Url(token.slice(separator + 1));
    const expectedDataLength = schema.keys.length * BYTES_PER_VALUE;
    if (!bytes || bytes.length !== expectedDataLength + 2) return null;

    const dataEnd = bytes.length - 2;
    const expectedChecksum = (bytes[dataEnd] << 8) | bytes[dataEnd + 1];
    if (crc16(bytes.subarray(0, dataEnd)) !== expectedChecksum) return null;

    const values = new DataView(bytes.buffer, bytes.byteOffset, dataEnd);
    const decoded: Partial<Record<ParamKey, number>> = {};
    for (const [index, key] of schema.keys.entries()) {
      const storedValue = values.getFloat32(index * BYTES_PER_VALUE, true);
      if (!Number.isFinite(storedValue)) return null;

      const value = normalizeWireValue(schema, key, storedValue);
      // A valid wire value is exactly the Float32 representation of a legal
      // control step. This rejects finite but off-step/range payloads even when
      // an attacker has recomputed the checksum.
      if (!isValidWireValue(schema, key, value) || !Object.is(storedValue, Math.fround(value))) return null;
      decoded[key] = value;
    }

    // Start from normalized defaults, then replace every current wire value.
    const result = normalizePatch({});
    for (const key of schema.keys) {
      if (key in PARAM_SPECS) result[key] = decoded[key] as number;
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
  if (version && !patchSchemaForVersion(version)) return { status: "unsupported", version };
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
if (import.meta.env.DEV && PATCH_PARAM_KEYS.length !== PARAM_KEYS.length) {
  console.warn("The patch parameter schema changed; introduce a new URL codec version.");
}
