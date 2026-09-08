import { describe, expect, it } from "vitest";
import {
  KEEPALIVE_BITS_PER_SAMPLE,
  KEEPALIVE_CHANNELS,
  KEEPALIVE_DURATION_SECONDS,
  KEEPALIVE_SAMPLE_RATE,
  createSilentKeepaliveWav,
} from "../scripts/generate-audio-keepalive.mjs";

describe("silent audio-session keepalive asset", () => {
  it("is deterministic, valid PCM, and contains only silent samples", () => {
    const wav = createSilentKeepaliveWav();
    const bytesPerSample = KEEPALIVE_BITS_PER_SAMPLE / 8;
    const expectedDataBytes = KEEPALIVE_SAMPLE_RATE
      * KEEPALIVE_CHANNELS
      * bytesPerSample
      * KEEPALIVE_DURATION_SECONDS;

    expect(wav.length).toBe(44 + expectedDataBytes);
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.readUInt32LE(4)).toBe(wav.length - 8);
    expect(wav.toString("ascii", 8, 12)).toBe("WAVE");
    expect(wav.toString("ascii", 12, 16)).toBe("fmt ");
    expect(wav.readUInt16LE(20)).toBe(1);
    expect(wav.readUInt16LE(22)).toBe(KEEPALIVE_CHANNELS);
    expect(wav.readUInt32LE(24)).toBe(KEEPALIVE_SAMPLE_RATE);
    expect(wav.readUInt16LE(34)).toBe(KEEPALIVE_BITS_PER_SAMPLE);
    expect(wav.toString("ascii", 36, 40)).toBe("data");
    expect(wav.readUInt32LE(40)).toBe(expectedDataBytes);
    expect(wav.subarray(44).every((byte) => byte === 0)).toBe(true);
    expect(createSilentKeepaliveWav().equals(wav)).toBe(true);
  });
});
