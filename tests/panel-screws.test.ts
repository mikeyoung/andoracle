import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PanelScrews } from "../src/components/PanelScrews";

const CORNERS = ["top-left", "top-right", "bottom-left", "bottom-right"] as const;

describe("panel screw coverage", () => {
  it("renders exactly one decorative fastener at every corner", () => {
    const markup = renderToStaticMarkup(createElement(PanelScrews));

    expect(markup).toContain('class="panel-screws" aria-hidden="true"');
    expect(markup.match(/<i class="panel-screw /g)).toHaveLength(4);
    for (const corner of CORNERS) {
      expect(markup.match(new RegExp(`data-panel-screw="${corner}"`, "g"))).toHaveLength(1);
    }
  });

  it("installs the shared overlay in every signal panel and both auxiliary panels", () => {
    const app = readFileSync(resolve("src/App.tsx"), "utf8");
    const panelLoopStart = app.indexOf("PANEL_SECTIONS.map");
    const panelLoopEnd = app.indexOf("</div>", panelLoopStart);
    const panelLoop = app.slice(panelLoopStart, panelLoopEnd);
    const panel = readFileSync(resolve("src/components/SynthPanel.tsx"), "utf8");
    const midi = readFileSync(resolve("src/components/MidiInputControl.tsx"), "utf8");
    const keyboard = readFileSync(resolve("src/components/Keyboard.tsx"), "utf8");

    expect(panelLoopStart).toBeGreaterThanOrEqual(0);
    expect(panelLoop.match(/<SynthPanel/g)).toHaveLength(1);
    expect(panel.match(/<PanelScrews \/>/g)).toHaveLength(1);
    expect(midi).toMatch(/<section className="midi-strip"[\s\S]*?<PanelScrews \/>/);
    expect(midi.match(/<PanelScrews \/>/g)).toHaveLength(1);
    expect(keyboard).toMatch(/<section className="keyboard-module"[\s\S]*?<PanelScrews \/>/);
    expect(keyboard.match(/<PanelScrews \/>/g)).toHaveLength(1);
  });

  it("keeps every screw above panel surfaces without intercepting controls", () => {
    const styles = readFileSync(resolve("src/styles.css"), "utf8");
    const overlayStart = styles.indexOf(".panel-screws {");
    const screwStart = styles.indexOf(".panel-screw {", overlayStart);
    const overlay = styles.slice(overlayStart, screwStart);

    expect(overlayStart).toBeGreaterThanOrEqual(0);
    expect(overlay).toMatch(/position:\s*absolute/);
    expect(overlay).toMatch(/inset:\s*0/);
    expect(overlay).toMatch(/z-index:\s*4/);
    expect(overlay).toMatch(/pointer-events:\s*none/);
    expect(overlay).toMatch(/--panel-screw-offset:\s*5px/);
    expect(styles).toContain(".module > :not(.panel-screws)");
    const moduleStart = styles.indexOf(".module {");
    const moduleEnd = styles.indexOf("\n}", moduleStart);
    const moduleRule = styles.slice(moduleStart, moduleEnd);
    expect(moduleRule.match(/radial-gradient\(circle at/g) ?? []).toHaveLength(0);
    for (const corner of CORNERS) {
      const start = styles.indexOf(`.panel-screw--${corner} {`);
      const end = styles.indexOf("}", start);
      const rule = styles.slice(start, end);
      expect(start).toBeGreaterThanOrEqual(0);
      expect(rule).toMatch(corner.startsWith("top")
        ? /top:\s*var\(--panel-screw-offset\)/
        : /bottom:\s*var\(--panel-screw-offset\)/);
      expect(rule).toMatch(corner.endsWith("left")
        ? /left:\s*var\(--panel-screw-offset\)/
        : /right:\s*var\(--panel-screw-offset\)/);
    }
    expect(moduleRule).toMatch(/border:\s*3px solid #383838/);
    expect(moduleRule).not.toMatch(/border-top|border-left/);
    const midiStart = styles.indexOf(".midi-strip {");
    const midiRule = styles.slice(midiStart, styles.indexOf("\n}", midiStart));
    const keyboardStart = styles.indexOf(".keyboard-module {");
    const keyboardRule = styles.slice(keyboardStart, styles.indexOf("\n}", keyboardStart));
    expect(midiRule).toMatch(/border:\s*3px solid #353535/);
    expect(midiRule).not.toMatch(/border-top|border-left/);
    expect(keyboardRule).toMatch(/border:\s*3px solid #282828/);
    expect(keyboardRule).not.toMatch(/border-top|border-left/);
    const headerStart = styles.indexOf(".module-header {");
    const headerRule = styles.slice(headerStart, styles.indexOf("\n}", headerStart));
    expect(headerRule).not.toContain("var(--module-accent)");
    expect(styles).toMatch(/\.module-header\s*\{[\s\S]*?padding:\s*9px 16px 8px/);
    expect(styles).toMatch(/\.control-bank\s*\{[\s\S]*?padding:\s*13px 16px 17px/);
    expect(styles).toMatch(/\.midi-strip\s*\{[\s\S]*?padding:\s*16px 18px/);
    expect(styles).toMatch(/\.keyboard-header\s*\{[\s\S]*?padding:\s*16px 18px 10px/);
  });

  it("gives every retro service dialog four unobscured corner fasteners", () => {
    const styles = readFileSync(resolve("src/styles.css"), "utf8");
    const dialogStart = styles.indexOf(".direct-entry {");
    const dialogEnd = styles.indexOf(".direct-entry::backdrop", dialogStart);
    const dialog = styles.slice(dialogStart, dialogEnd);

    expect(dialog.match(/radial-gradient\(circle at/g)).toHaveLength(4);
    expect(dialog).toContain("circle at 9px 9px");
    expect(dialog).toContain("circle at calc(100% - 22px) 9px");
    expect(dialog).toContain("circle at 9px calc(100% - 9px)");
    expect(dialog).toContain("circle at calc(100% - 22px) calc(100% - 9px)");

    for (const component of [
      "DeleteConfirmationDialog.tsx",
      "DirectEntryModal.tsx",
      "HelpDialog.tsx",
      "PatchLibraryDialog.tsx",
      "SequenceCommitDialog.tsx",
    ]) {
      expect(readFileSync(resolve("src/components", component), "utf8"), component)
        .toMatch(/className="direct-entry(?: |")/);
    }
  });
});
