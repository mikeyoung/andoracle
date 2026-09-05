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

  it("makes dropdown-style selector text 50% larger and safely multiline", () => {
    const styles = readFileSync(resolve("src/styles.css"), "utf8");

    expect(styles).toMatch(
      /\.parameter--choice\s*\{[\s\S]*?min-width:\s*min\(118px, 100%\);[\s\S]*?flex:\s*1 1 118px;[\s\S]*?\}/,
    );
    expect(styles).toMatch(
      /\.parameter--choice select,\s*\.choice-button\s*\{[\s\S]*?height:\s*auto;[\s\S]*?min-height:\s*64px;[\s\S]*?font-size:\s*13\.5px;[\s\S]*?line-height:\s*1\.2;[\s\S]*?\}/,
    );
    expect(styles).toMatch(
      /\.route-control\s*\{[\s\S]*?min-width:\s*min\(116px, 100%\);[\s\S]*?flex:\s*1 1 116px;[\s\S]*?\}/,
    );
    expect(styles).toMatch(
      /\.route-control \.parameter--choice select,\s*\.route-control \.choice-button\s*\{[\s\S]*?min-height:\s*56px;[\s\S]*?font-size:\s*12px;[\s\S]*?line-height:\s*1\.2;[\s\S]*?\}/,
    );
    expect(styles).toMatch(
      /\.choice-button span\s*\{[\s\S]*?flex:\s*1 1 auto;[\s\S]*?overflow:\s*visible;[\s\S]*?white-space:\s*normal;[\s\S]*?overflow-wrap:\s*normal;[\s\S]*?word-break:\s*normal;[\s\S]*?hyphens:\s*none;[\s\S]*?\}/,
    );
    expect(styles).toMatch(
      /@media \(max-width:\s*480px\)[\s\S]*?\.route-control \.parameter--choice label\s*\{[\s\S]*?font-size:\s*9px;[\s\S]*?\}[\s\S]*?\.route-control \.parameter--choice select,\s*\.route-control \.choice-button\s*\{[\s\S]*?font-size:\s*13\.5px;[\s\S]*?\}/,
    );
    const choiceButtonStart = styles.indexOf(".choice-button {");
    const choiceSpanStart = styles.indexOf(".choice-button span {", choiceButtonStart);
    const choiceButton = styles.slice(choiceButtonStart, choiceSpanStart);
    const choiceSpan = styles.slice(choiceSpanStart, styles.indexOf("\n}", choiceSpanStart) + 2);
    const mobileStart = styles.indexOf("@media (max-width: 480px)");
    const mobileEnd = styles.indexOf("@media (max-height: 480px)", mobileStart);
    const mobile = styles.slice(mobileStart, mobileEnd);

    expect(choiceButton).not.toMatch(/max-height|line-clamp|overflow:\s*(?:hidden|clip)/);
    expect(choiceSpan).not.toMatch(/max-height|line-clamp|overflow:\s*(?:hidden|clip)/);
    expect(mobile).toMatch(
      /\.route-control \.parameter--choice select,\s*\.route-control \.choice-button\s*\{[^}]*font-size:\s*13\.5px;/,
    );
    expect(styles).not.toContain(".choice-switch-bank");
  });

  it("reflows every formerly horizontal strip instead of requiring sideways scrolling", () => {
    const styles = readFileSync(resolve("src/styles.css"), "utf8");

    expect(styles).not.toMatch(/overflow-x:\s*auto/);
    expect(styles).toMatch(/\.signal-flow\s*\{[\s\S]*?flex-wrap:\s*wrap;[\s\S]*?\}/);
    expect(styles).toMatch(/\.control-bank\s*\{[\s\S]*?flex-wrap:\s*wrap;[\s\S]*?\}/);
    expect(styles.match(/\.keyboard-banks\s*\{/g)).toHaveLength(1);
    expect(styles).toMatch(/\.keyboard-banks\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\);[\s\S]*?grid-template-rows:\s*224px;[\s\S]*?overflow:\s*hidden;[\s\S]*?\}/);
    expect(styles).toMatch(/\.keyboard-surface\s*\{[\s\S]*?width:\s*100%;[\s\S]*?min-width:\s*0;[\s\S]*?height:\s*224px;[\s\S]*?overflow:\s*hidden;[\s\S]*?\}/);
    expect(styles).toMatch(/\.piano-key--white\s*\{[\s\S]*?height:\s*218px;[\s\S]*?\}/);
    expect(styles).toMatch(/\.piano-key--black\s*\{[\s\S]*?min-width:\s*0;[\s\S]*?height:\s*139px;[\s\S]*?\}/);
    expect(styles).toMatch(/\.status-deck\s*\{[\s\S]*?repeat\(auto-fit, minmax\(min\(112px, 100%\), 1fr\)\);[\s\S]*?\}/);
  });

  it("keeps the persistent sequence transport touch-sized and reflowable", () => {
    const styles = readFileSync(resolve("src/styles.css"), "utf8");

    expect(styles).toMatch(/\.library-deck\s*\{[\s\S]*?display:\s*grid;[\s\S]*?min-width:\s*0;[\s\S]*?\}/);
    expect(styles).toMatch(
      /\.patch-strip,\s*\.sequence-strip,\s*\.power-strip\s*\{[\s\S]*?flex-wrap:\s*wrap;[\s\S]*?\}/,
    );
    expect(styles).toMatch(
      /\.sequence-record-button,\s*\.sequence-play-button,\s*\.sequence-pause-button,\s*\.sequence-stop-button\s*\{[\s\S]*?display:\s*inline-flex;[\s\S]*?\}/,
    );
    expect(styles).toMatch(/\.sequence-pause-button i\s*\{[\s\S]*?linear-gradient/);
    expect(styles).toMatch(/\.sequence-pause-button\.is-active:disabled\s*\{[\s\S]*?opacity:\s*1;[\s\S]*?filter:\s*none;/);
    expect(styles).toMatch(/\.sequence-stop-button i\s*\{[\s\S]*?border-radius/);
    expect(styles).toMatch(
      /@media \(max-width:\s*700px\)[\s\S]*?\.patch-strip,\s*\.sequence-strip\s*\{[\s\S]*?grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\);[\s\S]*?\}/,
    );
    expect(styles).toMatch(
      /\.patch-strip select,\s*\.sequence-strip select\s*\{[\s\S]*?width:\s*100%;[\s\S]*?min-width:\s*0;[\s\S]*?grid-column:\s*1 \/ -1;[\s\S]*?\}/,
    );
    expect(styles).toMatch(
      /@media \(max-width:\s*260px\)[\s\S]*?\.patch-strip,\s*\.sequence-strip\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\);[\s\S]*?\}/,
    );
  });
});
