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

  it("renders compact black dials with white indicators over native range inputs", () => {
    const styles = readFileSync(resolve("src/styles.css"), "utf8");

    expect(styles).toMatch(
      /\.dial-shell\s*\{[\s\S]*?width:\s*68px;[\s\S]*?height:\s*68px;[\s\S]*?flex:\s*0 0 68px;/,
    );
    expect(styles).toMatch(
      /\.dial-face\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?inset:\s*7px;[\s\S]*?width:\s*54px;[\s\S]*?height:\s*54px;[\s\S]*?border:\s*2px solid #050505;[\s\S]*?border-radius:\s*50%;[\s\S]*?background:\s*#111111;[\s\S]*?repeating-conic-gradient\(#1d1d1d/,
    );
    expect(styles).toMatch(
      /\.dial-face i\s*\{[\s\S]*?width:\s*3px;[\s\S]*?height:\s*17px;[\s\S]*?background:\s*#f7f7f7;/,
    );
    expect(styles).toMatch(
      /\.dial-shell input\[type="range"\]\s*\{[\s\S]*?width:\s*68px;[\s\S]*?height:\s*68px;[\s\S]*?opacity:\s*0;[\s\S]*?writing-mode:\s*vertical-lr;/,
    );
    expect(styles).toMatch(
      /\.dial-shell input\[type="range"\]:focus-visible ~ \.dial-face\s*\{[\s\S]*?outline:\s*3px solid #c9c9c9;/,
    );
    expect(styles).toMatch(/\.control-bank\s*\{[\s\S]*?min-height:\s*184px;/);
    expect(styles).toMatch(/@media \(max-width:\s*960px\)[\s\S]*?\.control-bank\s*\{[\s\S]*?min-height:\s*184px;/);
  });

  it("sizes dropdown-style selectors to their complete multiline text", () => {
    const styles = readFileSync(resolve("src/styles.css"), "utf8");

    expect(styles).toMatch(
      /\.parameter--choice\s*\{[\s\S]*?min-width:\s*min\(118px, 100%\);[\s\S]*?flex:\s*1 1 118px;[\s\S]*?\}/,
    );
    expect(styles).toMatch(
      /\.parameter--choice select,\s*\.choice-button\s*\{[\s\S]*?height:\s*auto;[\s\S]*?min-height:\s*44px;[\s\S]*?font-size:\s*13\.5px;[\s\S]*?line-height:\s*1\.2;[\s\S]*?\}/,
    );
    expect(styles).toMatch(
      /\.route-control\s*\{[\s\S]*?min-width:\s*min\(116px, 100%\);[\s\S]*?flex:\s*1 1 116px;[\s\S]*?\}/,
    );
    expect(styles).toMatch(
      /\.route-control \.parameter--choice select,\s*\.route-control \.choice-button\s*\{[\s\S]*?min-height:\s*44px;[\s\S]*?font-size:\s*12px;[\s\S]*?line-height:\s*1\.2;[\s\S]*?\}/,
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

  it("gives selectors adaptive space while bottom-aligning every routed dial", () => {
    const styles = readFileSync(resolve("src/styles.css"), "utf8");

    expect(styles).toMatch(
      /\.control-bank--routed > \.parameter--range,\s*\.control-bank--routed > \.route-control\s*\{[\s\S]*?justify-content:\s*flex-end;[\s\S]*?\}/,
    );
    expect(styles).toMatch(
      /\.control-bank--routed \.parameter--range \.dial-shell\s*\{[\s\S]*?flex:\s*0 0 68px;[\s\S]*?\}/,
    );
    expect(styles).toMatch(
      /\.control-bank--routed \.parameter--range output\s*\{[\s\S]*?margin-top:\s*0;[\s\S]*?\}/,
    );
    expect(styles).not.toMatch(/\.route-control \.dial-shell(?:\s|\{|::)/);
  });

  it("keeps clipboard confirmation visible, responsive, and nonblocking", () => {
    const styles = readFileSync(resolve("src/styles.css"), "utf8");
    const start = styles.indexOf(".clipboard-toast {");
    const rule = styles.slice(start, styles.indexOf("\n}", start) + 2);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(rule).toMatch(/position:\s*fixed;/);
    expect(rule).toMatch(/bottom:\s*calc\(18px \+ env\(safe-area-inset-bottom\)\);/);
    expect(rule).toMatch(/max-width:\s*calc\(100vw - 24px - env\(safe-area-inset-left\) - env\(safe-area-inset-right\)\);/);
    expect(rule).toMatch(/right:\s*calc\(12px \+ env\(safe-area-inset-right\)\);/);
    expect(rule).toMatch(/left:\s*calc\(12px \+ env\(safe-area-inset-left\)\);/);
    expect(rule).toMatch(/margin-right:\s*auto;/);
    expect(rule).toMatch(/margin-left:\s*auto;/);
    expect(rule).toMatch(/pointer-events:\s*none;/);
    expect(rule).not.toMatch(/text-overflow|max-height|white-space:\s*nowrap|overflow:\s*(?:hidden|clip)|transform:/);
  });

  it("keeps every compact control at least touch-sized", () => {
    const styles = readFileSync(resolve("src/styles.css"), "utf8");

    expect(styles).toMatch(/\.dial-shell\s*\{[\s\S]*?width:\s*68px;[\s\S]*?height:\s*68px;/);
    expect(styles).toMatch(/\.parameter--choice select,\s*\.choice-button\s*\{[\s\S]*?min-height:\s*44px;/);
    expect(styles).toMatch(/\.route-control \.parameter--choice select,\s*\.route-control \.choice-button\s*\{[\s\S]*?min-height:\s*44px;/);
    expect(styles).toMatch(/\.power-switch\s*\{[\s\S]*?width:\s*122px;[\s\S]*?min-height:\s*44px;/);
    expect(styles).toMatch(/\.sequence-icon-button\s*\{[\s\S]*?width:\s*44px;[\s\S]*?min-width:\s*44px;/);
  });

  it("keeps overflow, readable color, and dynamic-viewport fallbacks for older mobile engines", () => {
    const styles = readFileSync(resolve("src/styles.css"), "utf8");

    for (const selector of ["html", "body", ".app-shell"]) {
      const start = styles.indexOf(`${selector} {`);
      const rule = styles.slice(start, styles.indexOf("\n}", start));
      expect(rule.indexOf("overflow-x: hidden;")).toBeLessThan(rule.indexOf("overflow-x: clip;"));
    }
    expect(styles).toMatch(/\.parameter output\s*\{[\s\S]*?color:\s*#343434;[\s\S]*?color:\s*color-mix/);
    expect(styles).toMatch(/\.choice-button i\s*\{[\s\S]*?border-top:\s*5px solid #333333;[\s\S]*?border-top-color:\s*color-mix/);
    expect(styles).toMatch(/\.dial-face\s*\{[\s\S]*?background:\s*#111111;[\s\S]*?background:[\s\S]*?repeating-conic-gradient/);
    expect(styles).toMatch(/\.patch-library-list\s*\{[\s\S]*?max-height:\s*min\(310px, 42vh\);[\s\S]*?max-height:\s*min\(310px, 42dvh\);/);
  });

  it("preserves the wide help layout inside compact safe-area gutters", () => {
    const styles = readFileSync(resolve("src/styles.css"), "utf8");
    const compact = styles.slice(styles.lastIndexOf("@media (max-width: 960px)"));

    expect(compact).toMatch(/\.help-dialog\s*\{[\s\S]*?width:\s*min\(620px, calc\(100vw - 40px - env\(safe-area-inset-left\) - env\(safe-area-inset-right\)\)\);[\s\S]*?max-width:/);
  });

  it("removes continuous hardware animation when reduced motion is requested", () => {
    const styles = readFileSync(resolve("src/styles.css"), "utf8");
    const reducedMotion = styles.slice(styles.indexOf("@media (prefers-reduced-motion: reduce)"));

    expect(reducedMotion).toMatch(/transition-duration:\s*0\.01ms !important;/);
    expect(reducedMotion).toMatch(/\.power-switch\[aria-checked="false"\]:not\(:disabled\),[\s\S]*?animation:\s*none;/);
    expect(reducedMotion).not.toMatch(/animation-duration:\s*3\.2s/);
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

  it("keeps the VCF/HPF and VCA/Output panels full width throughout the tablet breakpoint", () => {
    const styles = readFileSync(resolve("src/styles.css"), "utf8");
    const tabletStart = styles.indexOf("@media (max-width: 1180px)");
    const tabletEnd = styles.indexOf("@media (max-width: 1180px)", tabletStart + 1);
    const tablet = styles.slice(tabletStart, tabletEnd);
    const mobileStart = styles.indexOf("@media (max-width: 960px)");
    const mobileEnd = styles.indexOf("@media (max-width: 700px)", mobileStart);
    const mobile = styles.slice(mobileStart, mobileEnd);

    expect(tablet).toMatch(/\.panel-grid\s*\{[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\);/);
    expect(tablet).toMatch(
      /\.module--filter,\s*\.module--amplifier,\s*\.module--envelopes\s*\{[^}]*grid-column:\s*span 2;/,
    );
    expect(mobile).toMatch(
      /\.module,\s*\.module--envelopes\s*\{[^}]*grid-column:\s*span 1;/,
    );
  });

  it("keeps the persistent sequence transport touch-sized and reflowable", () => {
    const styles = readFileSync(resolve("src/styles.css"), "utf8");

    expect(styles).toMatch(/\.library-deck\s*\{[\s\S]*?display:\s*grid;[\s\S]*?min-width:\s*0;[\s\S]*?\}/);
    expect(styles).toMatch(
      /\.utility-strip,\s*\.patch-strip,\s*\.sequence-strip\s*\{[\s\S]*?display:\s*grid;[\s\S]*?min-width:\s*0;[\s\S]*?\}/,
    );
    expect(styles).toMatch(
      /\.utility-strip,\s*\.patch-strip\s*\{[\s\S]*?grid-template-columns:\s*minmax\(190px, 0\.55fr\) minmax\(0, 1\.45fr\);[\s\S]*?\}/,
    );
    expect(styles).toMatch(
      /\.sequence-strip\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\) auto;[\s\S]*?\}/,
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
      /@media \(max-width:\s*440px\)[\s\S]*?\.utility-actions\s*\{[\s\S]*?repeat\(3, minmax\(0, 1fr\)\);[\s\S]*?\.patch-actions\s*\{[\s\S]*?repeat\(2, minmax\(0, 1fr\)\);[\s\S]*?\.sequence-actions\s*\{[\s\S]*?repeat\(5, minmax\(44px, 1fr\)\);/,
    );
    expect(styles).toMatch(
      /@media \(max-width:\s*300px\)\s*\{[\s\S]*?\.sequence-actions\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\);/,
    );
    expect(styles).not.toMatch(/\.sequence-actions\s*\{[^}]*repeat\((?:auto-fit|auto-fill),/);
    expect(styles.indexOf("@media (max-width: 300px)")).toBeGreaterThan(
      styles.indexOf("@media (max-width: 440px)"),
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
