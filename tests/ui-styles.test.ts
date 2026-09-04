import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("synth control styling", () => {
  it("centers Blink and WebKit fader thumbs on their vertical tracks", () => {
    const styles = readFileSync(resolve("src/styles.css"), "utf8");

    expect(styles).toMatch(
      /\.fader-shell input\[type="range"\]::\-webkit-slider-thumb\s*\{[\s\S]*?width:\s*34px;[\s\S]*?transform:\s*translateX\(\-14px\);[\s\S]*?\}/,
    );
  });

  it("styles selector positions as touch-sized illuminated power switches", () => {
    const styles = readFileSync(resolve("src/styles.css"), "utf8");

    expect(styles).toMatch(
      /\.choice-switch-face\s*\{[\s\S]*?min-height:\s*58px;[\s\S]*?background:\s*linear-gradient\(180deg, #29221b, #15110e\);[\s\S]*?\}/,
    );
    expect(styles).toMatch(
      /\.choice-switch-position input:checked \+ \.choice-switch-face i\s*\{[\s\S]*?background:\s*var\(--accent\);[\s\S]*?\}/,
    );
    expect(styles).toMatch(
      /\.route-control \.choice-switch-face\s*\{[\s\S]*?min-height:\s*44px;[\s\S]*?\}/,
    );
    expect(styles).not.toContain(".choice-button");
  });
});
