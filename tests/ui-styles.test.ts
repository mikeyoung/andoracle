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
});
