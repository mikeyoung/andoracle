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

  it("keeps dropdown-style selectors compact while retaining touch targets", () => {
    const styles = readFileSync(resolve("src/styles.css"), "utf8");

    expect(styles).toMatch(
      /\.parameter--choice\s*\{[\s\S]*?min-width:\s*min\(118px, 100%\);[\s\S]*?flex:\s*1 1 118px;[\s\S]*?\}/,
    );
    expect(styles).toMatch(
      /\.parameter--choice select,\s*\.choice-button\s*\{[\s\S]*?min-height:\s*46px;[\s\S]*?\}/,
    );
    expect(styles).toMatch(
      /\.route-control\s*\{[\s\S]*?min-width:\s*min\(116px, 100%\);[\s\S]*?flex:\s*1 1 116px;[\s\S]*?\}/,
    );
    expect(styles).toMatch(
      /\.route-control \.parameter--choice select,\s*\.route-control \.choice-button\s*\{[\s\S]*?min-height:\s*44px;[\s\S]*?\}/,
    );
    expect(styles).not.toContain(".choice-switch-bank");
  });

  it("reflows every formerly horizontal strip instead of requiring sideways scrolling", () => {
    const styles = readFileSync(resolve("src/styles.css"), "utf8");

    expect(styles).not.toMatch(/overflow-x:\s*auto/);
    expect(styles).toMatch(/\.signal-flow\s*\{[\s\S]*?flex-wrap:\s*wrap;[\s\S]*?\}/);
    expect(styles).toMatch(/\.control-bank\s*\{[\s\S]*?flex-wrap:\s*wrap;[\s\S]*?\}/);
    expect(styles).toMatch(/\.keyboard-banks\s*\{[\s\S]*?grid-template-columns:\s*repeat\(3, minmax\(0, 1fr\)\);[\s\S]*?overflow:\s*hidden;[\s\S]*?\}/);
    expect(styles).toMatch(/\.status-deck\s*\{[\s\S]*?repeat\(auto-fit, minmax\(min\(112px, 100%\), 1fr\)\);[\s\S]*?\}/);
  });
});
