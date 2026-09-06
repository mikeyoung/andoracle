import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("synth control styling", () => {
  it("uses the VCA output switch color for every on/off switch", () => {
    const styles = readFileSync(resolve("src/styles.css"), "utf8");
    const toggleStart = styles.indexOf(".toggle-switch {");
    const toggleEnd = styles.indexOf(".route-control {", toggleStart);
    const toggleRules = styles.slice(toggleStart, toggleEnd);

    expect(toggleRules).toContain("--toggle-accent: #808080;");
    expect(toggleRules).toContain("var(--toggle-accent)");
    expect(toggleRules).not.toContain("var(--accent)");
    expect(styles).toMatch(
      /\.toggle-switch:hover\s*\{[\s\S]*?border-color:\s*color-mix\(in srgb, var\(--toggle-accent\), var\(--cream\) 30%\);/,
    );
  });

  it("centers Blink and WebKit fader thumbs on their vertical tracks", () => {
    const styles = readFileSync(resolve("src/styles.css"), "utf8");

    expect(styles).toMatch(
      /\.fader-shell input\[type="range"\]::\-webkit-slider-thumb\s*\{[\s\S]*?width:\s*34px;[\s\S]*?transform:\s*translateX\(\-14px\);[\s\S]*?\}/,
    );
  });

  it("sizes dropdown-style selectors to their complete multiline text", () => {
    const styles = readFileSync(resolve("src/styles.css"), "utf8");

    expect(styles).toMatch(
      /\.parameter--choice\s*\{[\s\S]*?min-width:\s*min\(118px, 100%\);[\s\S]*?flex:\s*1 1 118px;[\s\S]*?\}/,
    );
    expect(styles).toMatch(
      /\.parameter--choice select,\s*\.choice-button\s*\{[\s\S]*?height:\s*auto;[\s\S]*?min-height:\s*0;[\s\S]*?font-size:\s*13\.5px;[\s\S]*?line-height:\s*1\.2;[\s\S]*?\}/,
    );
    expect(styles).toMatch(
      /\.route-control\s*\{[\s\S]*?min-width:\s*min\(116px, 100%\);[\s\S]*?flex:\s*1 1 116px;[\s\S]*?\}/,
    );
    expect(styles).toMatch(
      /\.route-control \.parameter--choice select,\s*\.route-control \.choice-button\s*\{[\s\S]*?min-height:\s*0;[\s\S]*?font-size:\s*12px;[\s\S]*?line-height:\s*1\.2;[\s\S]*?\}/,
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

  it("gives selectors adaptive space while bottom-aligning every full-length fader", () => {
    const styles = readFileSync(resolve("src/styles.css"), "utf8");

    expect(styles).toMatch(
      /\.control-bank--routed > \.parameter--range,\s*\.control-bank--routed > \.route-control\s*\{[\s\S]*?justify-content:\s*flex-end;[\s\S]*?\}/,
    );
    expect(styles).toMatch(
      /\.control-bank--routed \.parameter--range \.fader-shell\s*\{[\s\S]*?flex:\s*0 0 196px;[\s\S]*?\}/,
    );
    expect(styles).toMatch(
      /\.control-bank--routed \.parameter--range output\s*\{[\s\S]*?margin-top:\s*0;[\s\S]*?\}/,
    );
    expect(styles).not.toMatch(/\.route-control \.fader-shell(?:\s|\{|::)/);
  });

  it("keeps clipboard confirmation visible, responsive, and nonblocking", () => {
    const styles = readFileSync(resolve("src/styles.css"), "utf8");
    const start = styles.indexOf(".clipboard-toast {");
    const rule = styles.slice(start, styles.indexOf("\n}", start) + 2);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(rule).toMatch(/position:\s*fixed;/);
    expect(rule).toMatch(/bottom:\s*calc\(18px \+ env\(safe-area-inset-bottom\)\);/);
    expect(rule).toMatch(/max-width:\s*calc\(100vw - 24px - env\(safe-area-inset-left\) - env\(safe-area-inset-right\)\);/);
    expect(rule).toMatch(/pointer-events:\s*none;/);
    expect(rule).not.toMatch(/text-overflow|max-height|white-space:\s*nowrap|overflow:\s*(?:hidden|clip)/);
  });

  it("reflows every formerly horizontal strip instead of requiring sideways scrolling", () => {
    const styles = readFileSync(resolve("src/styles.css"), "utf8");

    expect(styles).not.toMatch(/overflow-x:\s*auto/);
    expect(styles).toMatch(/\.signal-flow\s*\{[\s\S]*?flex-wrap:\s*wrap;[\s\S]*?\}/);
    expect(styles).toMatch(/\.control-bank\s*\{[\s\S]*?flex-wrap:\s*wrap;[\s\S]*?\}/);
    expect(styles.match(/\.keyboard-banks\s*\{/g)).toHaveLength(3);
    expect(styles).toMatch(/\.keyboard-banks\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\);[\s\S]*?grid-template-rows:\s*224px;[\s\S]*?overflow:\s*hidden;[\s\S]*?\}/);
    expect(styles).toMatch(/\.keyboard-surface\s*\{[\s\S]*?display:\s*contents;[\s\S]*?\}/);
    expect(styles).toMatch(/\.piano-key--white\s*\{[\s\S]*?height:\s*218px;[\s\S]*?\}/);
    expect(styles).toMatch(/\.piano-key--black\s*\{[\s\S]*?min-width:\s*0;[\s\S]*?height:\s*139px;[\s\S]*?\}/);
    expect(styles).toMatch(/@media \(max-width:\s*599\.98px\)\s*\{[\s\S]*?\.keyboard-banks\s*\{[\s\S]*?grid-template-rows:\s*repeat\(2, 144px\);[\s\S]*?\.keyboard-surface\s*\{[\s\S]*?display:\s*block;[\s\S]*?grid-area:\s*auto;[\s\S]*?height:\s*144px;/);
    expect(styles).toMatch(/\.piano-key\s*\{[\s\S]*?left:\s*var\(--two-row-key-left\);[\s\S]*?width:\s*var\(--two-row-key-width\);/);
    expect(styles).toMatch(/@media \(max-width:\s*480px\)\s*\{[\s\S]*?\.keyboard-banks\s*\{[\s\S]*?grid-template-rows:\s*repeat\(3, 144px\);[\s\S]*?\.piano-key\s*\{[\s\S]*?left:\s*var\(--three-row-key-left\);[\s\S]*?width:\s*var\(--three-row-key-width\);/);
    expect(styles).toMatch(/\.status-deck\s*\{[\s\S]*?repeat\(auto-fit, minmax\(min\(112px, 100%\), 1fr\)\);[\s\S]*?\}/);
  });

  it("keeps the persistent sequence transport touch-sized and reflowable", () => {
    const styles = readFileSync(resolve("src/styles.css"), "utf8");

    expect(styles).toMatch(/\.library-deck\s*\{[\s\S]*?display:\s*grid;[\s\S]*?min-width:\s*0;[\s\S]*?\}/);
    expect(styles).toMatch(
      /\.utility-strip,\s*\.patch-strip,\s*\.sequence-strip\s*\{[\s\S]*?display:\s*grid;[\s\S]*?grid-template-columns:\s*minmax\(190px, 0\.55fr\) minmax\(0, 1\.45fr\);[\s\S]*?\}/,
    );
    expect(styles).toMatch(
      /\.sequence-record-button,\s*\.sequence-play-button,\s*\.sequence-pause-button,\s*\.sequence-stop-button\s*\{[\s\S]*?display:\s*inline-flex;[\s\S]*?\}/,
    );
    expect(styles).toMatch(/\.sequence-actions\s*\{[\s\S]*?grid-template-columns:\s*repeat\(5, 44px\);[\s\S]*?justify-content:\s*end;[\s\S]*?\}/);
    expect(styles).toMatch(/\.sequence-icon-button\s*\{[\s\S]*?width:\s*44px;[\s\S]*?min-width:\s*44px;[\s\S]*?\}/);
    expect(styles).toMatch(/\.sequence-icon-button i\s*\{[\s\S]*?width:\s*16px;[\s\S]*?height:\s*16px;[\s\S]*?\}/);
    expect(styles).toMatch(/\.sequence-delete-button svg\s*\{[\s\S]*?width:\s*18px;[\s\S]*?stroke:\s*currentColor;[\s\S]*?\}/);
    expect(styles).toMatch(/\.sequence-pause-button i\s*\{[\s\S]*?linear-gradient/);
    expect(styles).toMatch(/\.sequence-pause-button\.is-active:disabled\s*\{[\s\S]*?opacity:\s*1;[\s\S]*?filter:\s*none;/);
    expect(styles).toMatch(/\.sequence-stop-button i\s*\{[\s\S]*?border-radius/);
    expect(styles).toMatch(
      /\.utility-actions\s*\{[\s\S]*?grid-column:\s*2;[\s\S]*?grid-template-columns:\s*repeat\(3, minmax\(0, 1fr\)\);[\s\S]*?\}/,
    );
    expect(styles).toMatch(
      /\.patch-actions\s*\{[\s\S]*?grid-template-columns:\s*repeat\(4, minmax\(0, 1fr\)\);[\s\S]*?\}/,
    );
    expect(styles).toMatch(
      /@media \(max-width:\s*440px\)[\s\S]*?\.utility-actions\s*\{[\s\S]*?repeat\(3, minmax\(0, 1fr\)\);[\s\S]*?\.patch-actions\s*\{[\s\S]*?repeat\(2, minmax\(0, 1fr\)\);[\s\S]*?\.sequence-actions\s*\{[\s\S]*?repeat\(5, minmax\(0, 1fr\)\);/,
    );
    expect(styles).toMatch(
      /@media \(max-width:\s*260px\)[\s\S]*?\.utility-actions,\s*\.patch-actions,\s*\.sequence-actions\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\);/,
    );
  });

  it("sizes the desktop patch selector from its widest option without page overflow", () => {
    const styles = readFileSync(resolve("src/styles.css"), "utf8");
    const desktopRuleStart = styles.lastIndexOf("@media (min-width: 701px)");
    const desktopRule = styles.slice(desktopRuleStart, styles.indexOf("@media (hover: hover)", desktopRuleStart));

    expect(desktopRuleStart).toBeGreaterThanOrEqual(0);
    expect(desktopRule).toMatch(
      /\.patch-strip #preset\s*\{[\s\S]*?width:\s*auto;[\s\S]*?min-width:\s*0;[\s\S]*?max-width:\s*100%;[\s\S]*?flex:\s*0 1 auto;/,
    );
    expect(styles).not.toMatch(/field-sizing:\s*content/);
  });
});
