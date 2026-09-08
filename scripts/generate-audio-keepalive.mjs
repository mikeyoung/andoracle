import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const KEEPALIVE_SAMPLE_RATE = 8_000;
export const KEEPALIVE_CHANNELS = 1;
export const KEEPALIVE_BITS_PER_SAMPLE = 16;
export const KEEPALIVE_DURATION_SECONDS = 2;

export const createSilentKeepaliveWav = () => {
  const bytesPerSample = KEEPALIVE_BITS_PER_SAMPLE / 8;
  const dataLength = KEEPALIVE_SAMPLE_RATE
    * KEEPALIVE_CHANNELS
    * bytesPerSample
    * KEEPALIVE_DURATION_SECONDS;
  const wav = Buffer.alloc(44 + dataLength);
  const byteRate = KEEPALIVE_SAMPLE_RATE * KEEPALIVE_CHANNELS * bytesPerSample;
  const blockAlign = KEEPALIVE_CHANNELS * bytesPerSample;

  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVE", 8, "ascii");
  wav.write("fmt ", 12, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(KEEPALIVE_CHANNELS, 22);
  wav.writeUInt32LE(KEEPALIVE_SAMPLE_RATE, 24);
  wav.writeUInt32LE(byteRate, 28);
  wav.writeUInt16LE(blockAlign, 32);
  wav.writeUInt16LE(KEEPALIVE_BITS_PER_SAMPLE, 34);
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(dataLength, 40);
  // Buffer.alloc() deliberately leaves every PCM sample at exact digital
  // silence. The element itself remains unmuted and at volume 1 so mobile
  // browsers treat it as a real background playback session.
  return wav;
};

export const writeSilentKeepaliveWav = (
  destination = resolve(fileURLToPath(new URL("../src/assets/audio-keepalive.wav", import.meta.url))),
) => {
  const next = createSilentKeepaliveWav();
  if (existsSync(destination) && readFileSync(destination).equals(next)) return false;
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, next);
  return true;
};

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const changed = writeSilentKeepaliveWav();
  console.log(`${changed ? "Generated" : "Verified"} ${KEEPALIVE_DURATION_SECONDS}s PCM audio keepalive.`);
}
