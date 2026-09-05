import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  DirectEntryModal,
} from "./DirectEntryModal";
import { shouldRestoreDirectEntryOrigin } from "./direct-entry-focus";
import { HelpDialog } from "./HelpDialog";

describe("direct-entry focus routing", () => {
  it("returns keyboard-opened range entry to its origin but releases pointer-opened ranges", () => {
    const pointerRange = {
      matches: vi.fn((selector: string) => selector === 'input[type="range"]'),
    };
    const keyboardRange = {
      matches: vi.fn((selector: string) => (
        selector === 'input[type="range"]' || selector === ":focus-visible"
      )),
    };
    const button = { matches: vi.fn(() => false) };

    expect(shouldRestoreDirectEntryOrigin(pointerRange, "pointer")).toBe(false);
    expect(shouldRestoreDirectEntryOrigin(keyboardRange, "keyboard")).toBe(true);
    expect(shouldRestoreDirectEntryOrigin(button)).toBe(true);
  });

  it("uses explicit pointer modality even when Chromium leaves the range focus-visible", () => {
    const focusedRange = {
      matches: vi.fn((selector: string) => (
        selector === 'input[type="range"]' || selector === ":focus-visible"
      )),
    };

    expect(shouldRestoreDirectEntryOrigin(focusedRange, "pointer")).toBe(false);
    expect(focusedRange.matches).toHaveBeenCalledTimes(1);
  });

  it("fails safe when an older engine cannot match :focus-visible", () => {
    const olderEngineRange = {
      matches: vi.fn((selector: string) => {
        if (selector === ":focus-visible") throw new DOMException("Unsupported selector");
        return selector === 'input[type="range"]';
      }),
    };
    const olderEngineButton = {
      matches: vi.fn((selector: string) => {
        if (selector === ":focus-visible") throw new DOMException("Unsupported selector");
        return false;
      }),
    };

    expect(shouldRestoreDirectEntryOrigin(olderEngineRange)).toBe(false);
    expect(shouldRestoreDirectEntryOrigin(olderEngineButton)).toBe(true);
    expect(olderEngineButton.matches).toHaveBeenCalledTimes(1);
  });

  it("keeps the fallback focus contract optional for isolated modal rendering", () => {
    const markup = renderToStaticMarkup(createElement(DirectEntryModal, {
      param: "portamento",
      value: 0,
      origin: null,
      restoreOriginFocus: false,
      onApply: vi.fn(),
      onClose: vi.fn(),
    }));

    expect(markup).toContain('aria-labelledby="direct-entry-title"');
  });
});

describe("Help dialog initial focus", () => {
  it("focuses the title at the top instead of the bottom Close action", () => {
    const markup = renderToStaticMarkup(createElement(HelpDialog, {
      origin: null,
      onClose: vi.fn(),
    }));

    expect(markup).toContain('<h2 id="help-dialog-title" tabindex="-1" autofocus="">How to play</h2>');
    expect(markup).not.toMatch(/<button[^>]*autofocus/);
  });
});
