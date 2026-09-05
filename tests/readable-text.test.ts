import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const styles = readFileSync(resolve("src/styles.css"), "utf8");

const ruleFor = (selector: string): string => {
  const start = styles.indexOf(`${selector} {`);
  expect(start, `missing ${selector} rule`).toBeGreaterThanOrEqual(0);
  const end = styles.indexOf("\n}", start);
  expect(end, `unterminated ${selector} rule`).toBeGreaterThan(start);
  return styles.slice(start, end + 2);
};

describe("readable responsive text", () => {
  it("never requests visual ellipsis truncation", () => {
    expect(styles).not.toMatch(/text-overflow\s*:\s*ellipsis/);
  });

  it.each([
    ".brand-name",
    ".brand-model",
    ".status-deck strong",
    ".module-header > *",
    ".external-input-title",
    ".ppc-title",
    ".keyboard-header p",
    "footer span",
    ".direct-entry h2",
    ".help-interface-list kbd",
    ".modal-actions .button",
  ])("keeps %s on whole-word wrapping boundaries", (selector) => {
    const rule = ruleFor(selector);
    expect(rule).toMatch(/overflow-wrap:\s*normal/);
    expect(rule).toMatch(/word-break:\s*normal/);
    expect(rule).toMatch(/hyphens:\s*none/);
  });

  it("keeps parameter labels and readouts complete instead of clipping them", () => {
    const labels = styles.slice(
      styles.indexOf(".parameter label,"),
      styles.indexOf(".parameter output"),
    );
    const output = ruleFor(".parameter output");

    expect(labels).toMatch(/overflow-wrap:\s*normal/);
    expect(labels).toMatch(/word-break:\s*normal/);
    expect(labels).toMatch(/hyphens:\s*none/);
    expect(output).toMatch(/overflow:\s*visible/);
    expect(output).toMatch(/white-space:\s*normal/);
    expect(output).not.toMatch(/overflow:\s*hidden|white-space:\s*nowrap/);
  });

  it("never hides responsive patch, status, or piano-key labels", () => {
    expect(styles).not.toMatch(/\.patch-strip label\s*\{[^}]*display:\s*none/s);
    expect(styles).not.toMatch(/\.network-status\s*\{[^}]*display:\s*none/s);
    expect(styles).not.toMatch(/\.piano-key--white span\s*\{[^}]*display:\s*none/s);

    const pianoLabel = ruleFor('.piano-key--white span');
    expect(pianoLabel).toMatch(/width:\s*max-content/);
    expect(pianoLabel).toMatch(/overflow:\s*visible/);
  });

  it("limits arbitrary mid-word wrapping to custom or host-provided text", () => {
    const allowedSelectors = [
      ".system-banner--warning span",
      '.usage-note [role="status"]',
      ".external-input-control small",
      ".midi-strip-copy small",
      ".patch-library-list span",
      ".delete-target-name",
    ];

    expect(styles.match(/overflow-wrap:\s*anywhere/g)).toHaveLength(allowedSelectors.length);
    for (const selector of allowedSelectors) {
      expect(ruleFor(selector)).toMatch(/overflow-wrap:\s*anywhere/);
    }
  });

  it("places the one-column <=260px library override after the shared <=700px grid", () => {
    const sharedGrid = styles.lastIndexOf("@media (max-width: 700px)");
    const narrowGrid = styles.lastIndexOf("@media (max-width: 260px)");
    expect(narrowGrid).toBeGreaterThan(sharedGrid);
    expect(styles.slice(narrowGrid)).toMatch(
      /\.patch-strip,\s*\.sequence-strip\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\)/,
    );
    expect(styles.slice(narrowGrid)).toMatch(
      /\.direct-entry form\s*\{[\s\S]*?padding-right:\s*12px;[\s\S]*?padding-left:\s*12px;/,
    );
    expect(styles.slice(narrowGrid)).toMatch(
      /\.direct-entry h2\s*\{[\s\S]*?font-size:\s*17px;[\s\S]*?letter-spacing:\s*0\.01em;/,
    );
  });
});
