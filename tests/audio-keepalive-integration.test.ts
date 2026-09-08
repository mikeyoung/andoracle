import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("application audio keepalive integration", () => {
  const app = readFileSync(resolve("src/App.tsx"), "utf8");

  it("starts keepalive from every UI path that can turn audio power on", () => {
    expect(app).toContain('import keepAliveAudioUrl from "./assets/audio-keepalive.wav?inline"');
    expect(app.match(/audioKeepAliveRef\.current\?\.enableFromUserGesture\(\)/g)).toHaveLength(3);
    expect(app).toContain("sourceUrl: keepAliveAudioUrl");
    expect(app).toContain("isAudioReady: () => engine.isAudioReady");
  });

  it("recovers and rehydrates current notes while preserving logical Power intent", () => {
    expect(app).toContain("const result = await engine.ensureRunning()");
    expect(app).toContain("engine.isPowerRequested");
    expect(app).toContain("audioKeepAliveRef.current?.notifyAudioInterruption()");
    expect(app).toContain("for (const note of new Set(noteSources.current.values())) engine.noteOn(note)");
  });

  it("pauses and resumes timer-driven sequences across background freezing instead of bursting overdue notes", () => {
    expect(app).toContain("sequenceLifecyclePausedRef");
    expect(app).toContain("const pauseForBackground");
    expect(app).toContain("const resumeFromBackground");
    expect(app).toContain("player.resume()");
    expect(app).not.toContain("Sequence playback stopped because the page became inactive.");
  });
});
